const { randomUUID } = require("crypto");
const pool = require("../config/db");
const {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  normalizeText,
  normalizeComparableText,
  parsePositiveInt,
  clampInt,
  normalizeModalidad,
  normalizeEstadoCode,
  parseDateInput,
  formatDateLabel,
  isClosedStatusCode,
  ensureEstadoCatalog,
  resolveUserContext,
  resolveTipoConsultaId,
  resolveZonaHorariaId,
  resolveEspecialidad,
  validateModalidadForEspecialidad,
  hasCitaConflict,
  resolveMedicoUserIds,
  createNotification,
  appendCitaHistorial,
  ensureConversation,
  appendSystemMessage,
  ensureVideoSala,
  fetchCitaByIdForContext,
  buildCitaResponse,
} = require("./platform-core");
const { emitCitaEvent, emitConversationEvent } = require("../realtime/socket");
const axios = require("axios");
const emailService = require("./email-service");
const invoiceService = require("./invoice-service");


const REPROGRAMABLE_CODES = ["pendiente", "confirmada", "reprogramada"];
const ROLE_BY_ID = {
  [PACIENTE_ROLE_ID]: "paciente",
  [MEDICO_ROLE_ID]: "medico",
};

function serviceResult(status, body, extra = {}) {
  return { status, body, ...extra };
}

function isFutureDate(value) {
  const date = value instanceof Date ? value : parseDateInput(value);
  if (!date || Number.isNaN(date.getTime())) return false;
  return date.getTime() > Date.now();
}

async function rollbackQuietly(client) {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch (_) {}
}

function isRoleAllowed(roleId, allowedRoleIds) {
  if (!Array.isArray(allowedRoleIds) || allowedRoleIds.length === 0) return true;
  return allowedRoleIds.includes(roleId);
}

async function resolvePacienteUserIds(client, pacienteId) {
  const cleanPacienteId = normalizeText(pacienteId);
  if (!cleanPacienteId) return [];

  const result = await client.query(
    `SELECT DISTINCT p.usuarioid::text AS usuarioid
     FROM paciente p
     WHERE p.pacienteid::text = $1::text
       AND p.usuarioid IS NOT NULL`,
    [cleanPacienteId]
  );

  const numericIds = result.rows
    .map((row) => Number.parseInt(String(row.usuarioid || ""), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return [...new Set(numericIds)];
}

async function resolveMedicoForCita(client, { medicoId, nombreMedico, especialidad, allowFallback = true }) {
  const requestedId = normalizeText(medicoId);
  const requestedName = normalizeText(nombreMedico).replace(/\s+/g, " ");
  const requestedSpecialty = normalizeText(especialidad).replace(/\s+/g, " ");

  if (requestedId) {
    const exact = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, 'Medicina General') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [requestedId]
    );
    if (exact.rows.length) return exact.rows[0];
    return null;
  }

  if (requestedName) {
    const params = [requestedName];
    let specialtyClause = "";
    if (requestedSpecialty) {
      params.push(requestedSpecialty, `%${requestedSpecialty}%`);
      specialtyClause = `
        AND (
          lower(COALESCE(e.nombre, '')) = lower($2)
          OR lower(COALESCE(e.nombre, '')) LIKE lower($3)
        )`;
    }

    const exactName = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, 'Medicina General') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE lower(m.nombrecompleto) = lower($1)
       ${specialtyClause}
       ORDER BY m.fecharegistro DESC
       LIMIT 1`,
      params
    );
    if (exactName.rows.length) return exactName.rows[0];
  }

  if (requestedSpecialty) {
    const bySpecialty = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, 'Medicina General') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE lower(COALESCE(e.nombre, '')) = lower($1)
          OR lower(COALESCE(e.nombre, '')) LIKE lower($2)
       ORDER BY m.fecharegistro DESC
       LIMIT 1`,
      [requestedSpecialty, `%${requestedSpecialty}%`]
    );
    if (bySpecialty.rows.length) return bySpecialty.rows[0];
  }

  if (requestedName) {
    const params = [`%${requestedName}%`];
    let specialtyClause = "";
    if (requestedSpecialty) {
      params.push(requestedSpecialty, `%${requestedSpecialty}%`);
      specialtyClause = `
        AND (
          lower(COALESCE(e.nombre, '')) = lower($2)
          OR lower(COALESCE(e.nombre, '')) LIKE lower($3)
        )`;
    }

    const fuzzy = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, 'Medicina General') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE lower(m.nombrecompleto) LIKE lower($1)
       ${specialtyClause}
       ORDER BY m.fecharegistro DESC
       LIMIT 1`,
      params
    );
    if (fuzzy.rows.length) return fuzzy.rows[0];
  }

  if (requestedId || requestedName || requestedSpecialty) {
    return null;
  }

  if (!allowFallback) {
    return null;
  }

  const fallback = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       COALESCE(e.nombre, 'Medicina General') AS especialidad
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     ORDER BY m.fecharegistro DESC
     LIMIT 1`
  );

  return fallback.rows[0] || null;
}

async function listMyCitas({
  reqUser,
  query = {},
  defaultLimit = 60,
  maxLimit = 200,
  allowedRoleIds = [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
  forbiddenRoleMessage = "Solo pacientes o medicos pueden listar citas.",
}) {
  const scopeRaw = normalizeComparableText(query?.scope || "upcoming");
  const scope = ["upcoming", "history", "all"].includes(scopeRaw) ? scopeRaw : "upcoming";
  const limit = clampInt(query?.limit, 1, maxLimit, defaultLimit);
  const scopeWhere =
    scope === "history"
      ? "c.fechahorainicio < NOW()"
      : scope === "all"
        ? "TRUE"
        : "c.fechahorainicio >= NOW()";
  const orderBy = scope === "history" ? "c.fechahorainicio DESC" : "c.fechahorainicio ASC";

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    if (context.roleId === PACIENTE_ROLE_ID) {
      const result = await client.query(
        `SELECT
           c.citaid::text AS citaid,
           c.pacienteid::text AS pacienteid,
           c.medicoid::text AS medicoid,
           c.fechahorainicio,
           c.fechahorafin,
           c.duracionmin,
           c.nota,
           c.precio,
           c.modalidad,
           c.motivo_consulta,
           c.estado_codigo,
           c.cancelada_por,
           c.cancelacion_motivo,
           c.disponibilidadid::text AS disponibilidadid,
           c.videosalaid::text AS videosalaid,
           c.pago_completado,
           c.pago_metodo,
           c.pago_referencia,
           c.pago_fecha,
           c.updated_at,
           COALESCE(ec.nombre, 'Pendiente') AS estado_nombre,
           COALESCE(ec.codigo, c.estado_codigo, 'pendiente') AS estado_code,
           COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
           COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
           mp.foto_url AS medico_foto_url,
           conv.conversacionid::text AS conversacionid
         FROM cita c
         LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
         LEFT JOIN medico m ON m.medicoid = c.medicoid
         LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
         LEFT JOIN conversaciones conv
           ON conv.pacienteid = c.pacienteid
          AND conv.medicoid::text = c.medicoid::text
         LEFT JOIN LATERAL (
           SELECT up.foto_url
           FROM usuario_perfil up
           WHERE up.usuarioid::text = m.usuarioid::text
           ORDER BY up.updated_at DESC
           LIMIT 1
         ) mp ON TRUE
         WHERE c.pacienteid = $1
           AND ${scopeWhere}
         ORDER BY ${orderBy}
         LIMIT $2`,
        [Number(context.paciente.pacienteid), limit]
      );

      return serviceResult(
        200,
        {
          success: true,
          scope,
          citas: result.rows.map((row) => {
            const cita = buildCitaResponse(row);
            return {
              ...cita,
              conversacionId: normalizeText(row.conversacionid) || null,
              medico: {
                ...cita.medico,
                fotoUrl: normalizeText(row.medico_foto_url) || null,
              },
            };
          }),
        },
        { context: { roleId: context.roleId } }
      );
    }

    if (context.roleId === MEDICO_ROLE_ID) {
      const result = await client.query(
        `SELECT
           c.citaid::text AS citaid,
           c.pacienteid::text AS pacienteid,
           c.medicoid::text AS medicoid,
           c.fechahorainicio,
           c.fechahorafin,
           c.duracionmin,
           c.nota,
           c.precio,
           c.modalidad,
           c.motivo_consulta,
           c.estado_codigo,
           c.cancelada_por,
           c.cancelacion_motivo,
           c.disponibilidadid::text AS disponibilidadid,
           c.videosalaid::text AS videosalaid,
           c.pago_completado,
           c.pago_metodo,
           c.pago_referencia,
           c.pago_fecha,
           c.updated_at,
           COALESCE(ec.nombre, 'Pendiente') AS estado_nombre,
           COALESCE(ec.codigo, c.estado_codigo, 'pendiente') AS estado_code,
           COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
           COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
           COALESCE(
             NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
             'Paciente'
           ) AS paciente_nombre,
           conv.conversacionid::text AS conversacionid
         FROM cita c
         LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
         LEFT JOIN medico m ON m.medicoid = c.medicoid
         LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
         LEFT JOIN paciente p ON p.pacienteid = c.pacienteid
         LEFT JOIN conversaciones conv
           ON conv.pacienteid = c.pacienteid
          AND conv.medicoid::text = c.medicoid::text
         WHERE c.medicoid::text = $1::text
           AND ${scopeWhere}
         ORDER BY ${orderBy}
         LIMIT $2`,
        [String(context.medico.medicoid), limit]
      );

      return serviceResult(
        200,
        {
          success: true,
          scope,
          citas: result.rows.map((row) => ({
            ...buildCitaResponse(row),
            conversacionId: normalizeText(row.conversacionid) || null,
          })),
        },
        { context: { roleId: context.roleId } }
      );
    }

    return serviceResult(403, { success: false, message: forbiddenRoleMessage });
  } catch (err) {
    console.error("Error listMyCitas:", err);
    return serviceResult(500, {
      success: false,
      message: "No se pudieron listar las citas.",
    });
  } finally {
    if (client) client.release();
  }
}

async function getMyCitaDetail({
  reqUser,
  citaId,
  allowedRoleIds = [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
  forbiddenRoleMessage = "Solo pacientes o medicos pueden consultar citas.",
}) {
  const cleanCitaId = normalizeText(citaId);
  if (!cleanCitaId) {
    return serviceResult(400, { success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId: cleanCitaId, context });
    if (!cita) {
      return serviceResult(404, { success: false, message: "Cita no encontrada." });
    }

    const history = await client.query(
      `SELECT
         id::text AS id,
         accion,
         usuario_tipo,
         usuario_id,
         motivo,
         datos_json,
         fecha_evento
       FROM cita_historial
       WHERE citaid = $1::uuid
       ORDER BY fecha_evento DESC`,
      [cleanCitaId]
    );

    const conversation = await client.query(
      `SELECT conversacionid::text AS conversacionid, estado, updated_at
       FROM conversaciones
       WHERE citaid = $1::uuid
       LIMIT 1`,
      [cleanCitaId]
    );

    const sala = await client.query(
      `SELECT
         videosalaid::text AS videosalaid,
         proveedor,
         room_name,
         token_o_url,
         estado,
         opened_at,
         closed_at,
         created_at
       FROM video_salas
       WHERE citaid = $1::uuid
       LIMIT 1`,
      [cleanCitaId]
    );

    return serviceResult(
      200,
      {
        success: true,
        cita: buildCitaResponse(cita),
        historial: history.rows.map((row) => ({
          id: String(row.id || ""),
          accion: normalizeText(row.accion),
          usuarioTipo: normalizeText(row.usuario_tipo),
          usuarioId: normalizeText(row.usuario_id),
          motivo: normalizeText(row.motivo),
          datos: row.datos_json || {},
          fechaEvento: row.fecha_evento || null,
        })),
        conversacion: conversation.rows[0]
          ? {
              conversacionId: normalizeText(conversation.rows[0].conversacionid),
              estado: normalizeText(conversation.rows[0].estado),
              updatedAt: conversation.rows[0].updated_at || null,
            }
          : null,
        videoSala: sala.rows[0]
          ? {
              videoSalaId: normalizeText(sala.rows[0].videosalaid),
              proveedor: normalizeText(sala.rows[0].proveedor),
              roomName: normalizeText(sala.rows[0].room_name),
              joinUrl: normalizeText(sala.rows[0].token_o_url),
              estado: normalizeText(sala.rows[0].estado),
              openedAt: sala.rows[0].opened_at || null,
              closedAt: sala.rows[0].closed_at || null,
              createdAt: sala.rows[0].created_at || null,
            }
          : null,
      },
      { context: { roleId: context.roleId } }
    );
  } catch (err) {
    console.error("Error getMyCitaDetail:", err);
    return serviceResult(500, {
      success: false,
      message: "No se pudo cargar el detalle de la cita.",
    });
  } finally {
    if (client) client.release();
  }
}

async function createMyCita({
  reqUser,
  body = {},
  allowedRoleIds = [PACIENTE_ROLE_ID],
  forbiddenRoleMessage = "Solo pacientes pueden crear citas en este endpoint.",
  allowMedicoFallback = false,
}) {
  const disponibilidadId = parsePositiveInt(body?.disponibilidadId, null);
  const fechaHoraInicio = parseDateInput(body?.fechaHoraInicio);
  const duracionMin = clampInt(body?.duracionMin, 15, 180, 30);
  const modalidadInput = normalizeModalidad(body?.modalidad, "presencial");
  const motivoConsulta = normalizeText(body?.motivoConsulta || body?.nota).slice(0, 1200);
  const especialidadId = parsePositiveInt(body?.especialidadId, null);
  const especialidad = normalizeText(body?.especialidad);
  const nombreMedico = normalizeText(body?.nombreMedico);
  const medicoIdRaw = normalizeText(body?.medicoId);
  const precioRaw = Number(body?.precio);
  const precio = Number.isFinite(precioRaw) && precioRaw >= 0 ? precioRaw : null;
  const pagoInfo = body?.pagoInfo; // { metodo: 'tarjeta', titular: '...', terminacion: '...' }

  if (!disponibilidadId && !fechaHoraInicio) {
    return serviceResult(400, {
      success: false,
      message: "Debes enviar disponibilidadId o fechaHoraInicio.",
    });
  }

  if (!disponibilidadId && !allowMedicoFallback && !medicoIdRaw && !nombreMedico && !especialidad) {
    return serviceResult(400, {
      success: false,
      message: "Debes enviar disponibilidadId o un criterio para resolver el medico.",
    });
  }

  let client;
  try {
    const citaId = randomUUID();
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      await rollbackQuietly(client);
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      await rollbackQuietly(client);
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const estadoPendienteId = estadoMap.pendiente;
    if (!estadoPendienteId) {
      await rollbackQuietly(client);
      return serviceResult(500, {
        success: false,
        message: "No se pudo resolver estado pendiente.",
      });
    }

    let medicoId = medicoIdRaw;
    let slotStart = fechaHoraInicio ? new Date(fechaHoraInicio) : null;
    let slotEnd = null;
    let slotDuration = duracionMin;
    let modalidad = modalidadInput;
    let zonaHorariaId = await resolveZonaHorariaId(client);
    let disponibilidadFinalId = disponibilidadId ? Number(disponibilidadId) : null;

    if (disponibilidadFinalId) {
      const availability = await client.query(
        `SELECT
           h.horariodisponibleid,
           h.medicoid::text AS medicoid,
           h.especialidadid,
           h.zonahorariaid,
           h.fechainicio,
           h.fechafin,
           h.modalidad,
           h.slot_minutos,
           h.activo,
           h.bloqueado
         FROM horario_disponible h
         WHERE h.horariodisponibleid = $1
         LIMIT 1
         FOR UPDATE`,
        [disponibilidadFinalId]
      );
      if (!availability.rows.length) {
        await rollbackQuietly(client);
        return serviceResult(404, {
          success: false,
          message: "La disponibilidad seleccionada no existe.",
        });
      }

      const block = availability.rows[0];
      if (!Boolean(block.activo) || Boolean(block.bloqueado)) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La disponibilidad seleccionada no esta activa.",
        });
      }

      medicoId = String(block.medicoid || "");
      zonaHorariaId = block.zonahorariaid || zonaHorariaId;
      slotDuration = clampInt(block.slot_minutos, 15, 60, 30);

      if (!slotStart) {
        slotStart = new Date(block.fechainicio);
      }
      const blockStart = new Date(block.fechainicio);
      const blockEnd = new Date(block.fechafin);
      if (
        Number.isNaN(slotStart.getTime()) ||
        Number.isNaN(blockStart.getTime()) ||
        Number.isNaN(blockEnd.getTime())
      ) {
        await rollbackQuietly(client);
        return serviceResult(400, {
          success: false,
          message: "Horario de disponibilidad invalido.",
        });
      }

      const diffMin = Math.round((slotStart.getTime() - blockStart.getTime()) / 60000);
      if (diffMin < 0 || diffMin % slotDuration !== 0) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La hora seleccionada no coincide con los slots del medico.",
        });
      }

      slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);
      if (slotEnd.getTime() > blockEnd.getTime()) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La hora seleccionada excede el bloque de disponibilidad.",
        });
      }

      const blockModalidad = normalizeModalidad(block.modalidad, "ambas");
      if (blockModalidad !== "ambas" && modalidad !== blockModalidad) {
        modalidad = blockModalidad;
      }

      const especialidadRow = await resolveEspecialidad(client, {
        especialidadId: block.especialidadid || especialidadId,
        especialidad,
        medicoId,
      });
      const modeValidation = validateModalidadForEspecialidad(especialidadRow, modalidad);
      if (!modeValidation.ok) {
        await rollbackQuietly(client);
        return serviceResult(409, { success: false, message: modeValidation.reason });
      }
      modalidad = modeValidation.modalidad;
    } else {
      const medico = await resolveMedicoForCita(client, {
        medicoId: medicoIdRaw,
        nombreMedico,
        especialidad,
        allowFallback: allowMedicoFallback,
      });
      if (!medico?.medicoid) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "No hay medicos disponibles para agendar en este momento.",
        });
      }

      medicoId = String(medico.medicoid);
      slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

      const especialidadRow = await resolveEspecialidad(client, {
        especialidadId,
        especialidad,
        medicoId,
      });
      const modeValidation = validateModalidadForEspecialidad(especialidadRow, modalidad);
      if (!modeValidation.ok) {
        await rollbackQuietly(client);
        return serviceResult(409, { success: false, message: modeValidation.reason });
      }
      modalidad = modeValidation.modalidad;
    }

    // --- BUSINESS LOGIC: Calculate commission split and validate pricing ---
    const medicoBusinessResult = await client.query(
      `SELECT tipo_plan, comision_porcentaje, membresia_activa, precio, precio_videollamada 
       FROM medico WHERE medicoid::text = $1::text LIMIT 1`,
      [medicoId]
    );
    const medicoBusiness = medicoBusinessResult.rows[0] || {};
    
    // Determine base price based on modality subtype
    let basePrecio = 0;
    const virtualSubtype = body?.virtualSubtype || 'videollamada'; 

    if (modalidad === 'virtual') {
      if (virtualSubtype === 'chat') {
        // Chat is ALWAYS FREE as per new requirements
        basePrecio = 0;
      } else {
        // Videollamada is the PAID consultation
        basePrecio = Number(medicoBusiness.precio_videollamada || medicoBusiness.precio || 1000);
      }
    } else {
      // Presencial uses the general 'precio'
      basePrecio = Number(medicoBusiness.precio || 1000);
    }

    const finalPrecio = virtualSubtype === 'chat' ? 0 : (precio !== null ? precio : basePrecio);

    // VALIDATION: Only for paid consultations (not for free chat)
    if (virtualSubtype !== 'chat') {
      if (finalPrecio < 500 || finalPrecio > 5000) {
        await rollbackQuietly(client);
        return serviceResult(400, {
          success: false,
          message: `El precio de la consulta (${finalPrecio}) está fuera del rango permitido (RD$500 - RD$5000).`,
        });
      }
    }

    // COMMISSION: Mandatory 15% for paid consultations
    const comisionPje = virtualSubtype === 'chat' ? 0 : 15; 
    
    const montoPlataforma = Number((finalPrecio * (comisionPje / 100)).toFixed(2));
    const montoMedico = Number((finalPrecio - montoPlataforma).toFixed(2));
    // --- END BUSINESS LOGIC ---

    if (!medicoId) {
      await rollbackQuietly(client);
      return serviceResult(400, {
        success: false,
        message: "No se pudo resolver el medico de la cita.",
      });
    }
    if (
      !slotStart ||
      Number.isNaN(slotStart.getTime()) ||
      !slotEnd ||
      Number.isNaN(slotEnd.getTime())
    ) {
      await rollbackQuietly(client);
      return serviceResult(400, { success: false, message: "Horario de cita invalido." });
    }
    if (slotStart.getTime() <= Date.now()) {
      await rollbackQuietly(client);
      return serviceResult(400, {
        success: false,
        message: "La cita debe ser en una fecha futura.",
      });
    }

    const conflict = await hasCitaConflict(client, {
      medicoId,
      pacienteId: Number(context.paciente.pacienteid),
      startIso: slotStart.toISOString(),
      endIso: slotEnd.toISOString(),
    });
    if (conflict) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "No se puede agendar: El médico ya tiene una cita a esa hora o tú ya tienes otra cita programada para este mismo horario.",
      });
    }

    const tipoConsultaId = await resolveTipoConsultaId(client, modalidad);
    const citaId = randomUUID();
    const insertResult = await client.query(
      `INSERT INTO cita (
         citaid,
         pacienteid,
         medicoid,
         tipoconsultaid,
         estadocitaid,
         zonahorariaid,
         fechahorainicio,
         fechahorafin,
         duracionmin,
         precio,
         fechacreacion,
         nota,
         modalidad,
         motivo_consulta,
         cancelada_por,
         cancelacion_motivo,
         disponibilidadid,
         estado_codigo,
         pago_completado,
         pago_metodo,
         pago_referencia,
         pago_fecha,
         monto_total,
         monto_plataforma,
         monto_medico,
         comision_aplicada,
         updated_at
       )
       VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, $6,
         $7::timestamptz, $8::timestamptz, $9, $10, NOW(),
         $11, $12, $13, NULL, NULL, $14, 'pendiente', $15, $16, $17, $18, $19, $20, $21, $22, NOW()
       )`,
      [
        citaId,
        Number(context.paciente.pacienteid),
        medicoId,
        tipoConsultaId,
        estadoPendienteId,
        zonaHorariaId,
        slotStart.toISOString(),
        slotEnd.toISOString(),
        slotDuration,
        finalPrecio,
        motivoConsulta || null,
        modalidad,
        motivoConsulta || null,
        disponibilidadFinalId,
        Boolean(pagoInfo),
        pagoInfo ? (pagoInfo.metodo || 'tarjeta') : null,
        pagoInfo ? `SIM-${randomUUID().slice(0, 8).toUpperCase()}` : null,
        pagoInfo ? new Date().toISOString() : null,
        finalPrecio,
        montoPlataforma,
        montoMedico,
        comisionPje
      ]
    );

    if (!insertResult.rowCount) {
      await rollbackQuietly(client);
      return serviceResult(500, { success: false, message: "No se pudo crear la cita." });
    }

    await appendCitaHistorial(client, {
      citaId,
      accion: "creada",
      usuarioTipo: "paciente",
      usuarioId: context.user.usuarioid,
      motivo: motivoConsulta,
      datos: {
        modalidad,
        fechaHoraInicio: slotStart.toISOString(),
        fechaHoraFin: slotEnd.toISOString(),
      },
    });

    const conversacionId = await ensureConversation(client, {
      citaId,
      pacienteId: context.paciente.pacienteid,
      medicoId,
    });

    await appendSystemMessage(client, {
      conversacionId,
      text: "Este chat es para coordinación previa (ej: 'ya estoy listo'). Las consultas médicas se realizan únicamente por videollamada.",
    });

    let sala = null;
    if (modalidad === "virtual") {
      sala = await ensureVideoSala(client, { citaId, provider: "jitsi" });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId,
      context: { ...context, roleId: PACIENTE_ROLE_ID },
    });
    const citaPayload = buildCitaResponse(cita);

    const doctorUserIds = await resolveMedicoUserIds(client, medicoId);
    for (const doctorUserId of doctorUserIds) {
      await createNotification(client, {
        usuarioid: doctorUserId,
        tipo: "cita_creada",
        titulo: "Nueva cita agendada",
        contenido: `${context.paciente.nombres || "Paciente"} agendo una cita para ${formatDateLabel(
          slotStart
        )}.`,
        data: { citaId, medicoId, pacienteId: context.paciente.pacienteid },
      });
    }

    await createNotification(client, {
      usuarioid: context.user.usuarioid,
      tipo: "cita_creada",
      titulo: "Cita creada",
      contenido: `Tu cita fue creada para ${formatDateLabel(slotStart)}.`,
      data: { citaId, medicoId, pacienteId: context.paciente.pacienteid },
    });

    await client.query("COMMIT");

    // --- Post-creation Automation: Invoice & Email ---
    try {
      if (citaPayload) {
        const invoiceData = {
          citaId: citaPayload.citaid,
          pacienteNombre: citaPayload.paciente.nombreCompleto,
          medicoNombre: citaPayload.medico.nombreCompleto,
          especialidad: citaPayload.medico.especialidad,
          fecha: citaPayload.fechaHoraInicio,
          montoTotal: citaPayload.montoTotal,
          referencia: citaPayload.pagoReferencia,
          modalidad: citaPayload.modalidad,
        };

        const html = invoiceService.generateInvoiceHTML(invoiceData);
        
        // 1. Internal Email delivery
        if (context.user.email) {
          emailService.sendEmail({
            to: context.user.email,
            subject: `Tu Comprobante de Pago - VIREM (${invoiceData.citaId.slice(0, 8).toUpperCase()})`,
            html,
          }).catch(e => console.error("[EmailService] Background sending failed:", e));
        }

        // 2. Make.com / n8n Webhook trigger
        if (process.env.MAKE_WEBHOOK_URL) {
          axios.post(process.env.MAKE_WEBHOOK_URL, {
            type: "invoice_generated",
            ...invoiceData,
            pacienteEmail: context.user.email,
          }).catch(e => console.warn("[Webhook] Invoice webhook failed:", e.message));
        }
      } else {
        console.warn("[Automation] Skip invoice generation: citaPayload is null");
      }
    } catch (err) {
      console.error("[Automation] Error in post-creation flow:", err);
    }


    emitCitaEvent({
      eventName: "cita_creada",
      citaId,
      pacienteId: context.paciente.pacienteid,
      medicoId,
      extraPayload: {
        cita: citaPayload,
        conversacionId,
        videoSalaId: sala?.videosalaid || null,
      },
    });

    return serviceResult(
      201,
      {
        success: true,
        message: "Cita creada correctamente.",
        cita: citaPayload,
        conversacionId,
        videoSala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              proveedor: normalizeText(sala.proveedor),
              roomName: normalizeText(sala.room_name),
              joinUrl: normalizeText(sala.token_o_url),
              estado: normalizeText(sala.estado),
            }
          : null,
      },
      { context: { roleId: context.roleId } }
    );
  } catch (err) {
    await rollbackQuietly(client);

    if (String(err?.code || "") === "23505") {
      return serviceResult(409, {
        success: false,
        message: "Ese horario ya fue reservado por otro usuario.",
      });
    }

    console.error("Error createMyCita:", err);
    if (err.detail) console.error("[DB Detail]:", err.detail);
    if (err.hint) console.error("[DB Hint]:", err.hint);
    if (err.stack) console.error("[Stack]:", err.stack);
    return serviceResult(500, {
      success: false,
      message: "No se pudo crear la cita.",
    });
  } finally {
    if (client) client.release();
  }
}

async function cancelMyCita({
  reqUser,
  citaId,
  body = {},
  allowedRoleIds = [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
  forbiddenRoleMessage = "Solo pacientes o medicos pueden cancelar citas.",
}) {
  const cleanCitaId = normalizeText(citaId);
  const motivo = normalizeText(body?.motivo).slice(0, 1200);

  if (!cleanCitaId) {
    return serviceResult(400, { success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      await rollbackQuietly(client);
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      await rollbackQuietly(client);
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId: cleanCitaId,
      context,
      lock: true,
    });
    if (!cita) {
      await rollbackQuietly(client);
      return serviceResult(404, { success: false, message: "Cita no encontrada." });
    }

    if (!isFutureDate(cita.fechahorainicio)) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "Solo citas futuras pueden cancelarse.",
      });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (isClosedStatusCode(currentCode)) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "La cita ya no puede cancelarse por su estado actual.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const actorTipo = ROLE_BY_ID[context.roleId] || "sistema";
    const nextEstadoCode =
      context.roleId === PACIENTE_ROLE_ID ? "cancelada_por_paciente" : "cancelada_por_medico";
    const nextEstadoId = estadoMap[nextEstadoCode];

    if (!nextEstadoId) {
      await rollbackQuietly(client);
      return serviceResult(500, {
        success: false,
        message: "No se pudo resolver el estado de cancelacion.",
      });
    }

    await client.query(
      `UPDATE cita
       SET estadocitaid = $1,
           estado_codigo = $2,
           cancelada_por = $3,
           cancelacion_motivo = $4,
           updated_at = NOW()
       WHERE citaid::text = $5::text`,
      [nextEstadoId, nextEstadoCode, actorTipo, motivo || null, cleanCitaId]
    );

    await appendCitaHistorial(client, {
      citaId: cleanCitaId,
      accion: "cancelada",
      usuarioTipo: actorTipo,
      usuarioId: context.user.usuarioid,
      motivo,
      datos: {
        estadoAnterior: currentCode,
        estadoNuevo: nextEstadoCode,
      },
    });

    const conversacionId = await ensureConversation(client, {
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText =
      actorTipo === "paciente"
        ? "Tu cita fue cancelada por el paciente."
        : "Tu cita fue cancelada por el medico.";
    await appendSystemMessage(client, { conversacionId, text: systemText });

    if (context.roleId === PACIENTE_ROLE_ID) {
      const doctorUserIds = await resolveMedicoUserIds(client, cita.medicoid);
      for (const doctorUserId of doctorUserIds) {
        await createNotification(client, {
          usuarioid: doctorUserId,
          tipo: "cita_cancelada",
          titulo: "Cita cancelada",
          contenido: `${context.paciente.nombres || "Paciente"} cancelo la cita del ${formatDateLabel(
            cita.fechahorainicio
          )}.`,
          data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    } else {
      const pacienteUserIds = await resolvePacienteUserIds(client, cita.pacienteid);
      for (const pacienteUserId of pacienteUserIds) {
        await createNotification(client, {
          usuarioid: pacienteUserId,
          tipo: "cita_cancelada",
          titulo: "Cita cancelada por el medico",
          contenido: `Tu cita del ${formatDateLabel(cita.fechahorainicio)} fue cancelada.`,
          data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    }

    await createNotification(client, {
      usuarioid: context.user.usuarioid,
      tipo: "cita_cancelada",
      titulo: "Cancelacion aplicada",
      contenido: "La cita se cancelo correctamente.",
      data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId: cleanCitaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_cancelada",
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return serviceResult(
      200,
      {
        success: true,
        message: "Cita cancelada correctamente.",
        cita: citaPayload,
      },
      { context: { roleId: context.roleId } }
    );
  } catch (err) {
    await rollbackQuietly(client);
    console.error("Error cancelMyCita:", err);
    return serviceResult(500, {
      success: false,
      message: "No se pudo cancelar la cita.",
    });
  } finally {
    if (client) client.release();
  }
}

async function rescheduleMyCita({
  reqUser,
  citaId,
  body = {},
  allowedRoleIds = [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
  forbiddenRoleMessage = "Solo pacientes o medicos pueden reprogramar citas.",
}) {
  const cleanCitaId = normalizeText(citaId);
  const disponibilidadId = parsePositiveInt(body?.disponibilidadId, null);
  const requestedStart = parseDateInput(body?.fechaHoraInicio);
  const requestedDuracion = clampInt(body?.duracionMin, 15, 180, 30);
  const motivo = normalizeText(body?.motivo).slice(0, 1200);

  if (!cleanCitaId) {
    return serviceResult(400, { success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      await rollbackQuietly(client);
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      await rollbackQuietly(client);
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId: cleanCitaId,
      context,
      lock: true,
    });
    if (!cita) {
      await rollbackQuietly(client);
      return serviceResult(404, { success: false, message: "Cita no encontrada." });
    }

    if (!isFutureDate(cita.fechahorainicio)) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "Solo citas futuras pueden reprogramarse.",
      });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (!REPROGRAMABLE_CODES.includes(currentCode)) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "La cita no admite reprogramacion por su estado actual.",
      });
    }

    let nextStart = requestedStart ? new Date(requestedStart) : null;
    let nextDuration = clampInt(cita.duracionmin, 15, 180, requestedDuracion);
    let nextEnd = null;
    let nextModalidad = normalizeModalidad(cita.modalidad, "presencial");
    let nextZonaHorariaId = cita.zonahorariaid ? Number(cita.zonahorariaid) : null;
    let nextDisponibilidadId = disponibilidadId || null;

    if (nextDisponibilidadId) {
      const availability = await client.query(
        `SELECT
           h.horariodisponibleid,
           h.medicoid::text AS medicoid,
           h.especialidadid,
           h.zonahorariaid,
           h.fechainicio,
           h.fechafin,
           h.modalidad,
           h.slot_minutos,
           h.activo,
           h.bloqueado
         FROM horario_disponible h
         WHERE h.horariodisponibleid = $1
           AND h.medicoid::text = $2::text
         LIMIT 1
         FOR UPDATE`,
        [nextDisponibilidadId, cita.medicoid]
      );

      if (!availability.rows.length) {
        await rollbackQuietly(client);
        return serviceResult(404, {
          success: false,
          message: "La disponibilidad seleccionada no existe para ese medico.",
        });
      }

      const block = availability.rows[0];
      if (!Boolean(block.activo) || Boolean(block.bloqueado)) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La disponibilidad seleccionada no esta activa.",
        });
      }

      nextZonaHorariaId = block.zonahorariaid ? Number(block.zonahorariaid) : nextZonaHorariaId;
      nextDuration = clampInt(block.slot_minutos, 15, 60, nextDuration);

      const blockStart = new Date(block.fechainicio);
      const blockEnd = new Date(block.fechafin);
      if (!nextStart) {
        nextStart = new Date(blockStart);
      }
      if (
        Number.isNaN(blockStart.getTime()) ||
        Number.isNaN(blockEnd.getTime()) ||
        Number.isNaN(nextStart.getTime())
      ) {
        await rollbackQuietly(client);
        return serviceResult(400, {
          success: false,
          message: "El horario de disponibilidad es invalido.",
        });
      }

      const diffMin = Math.round((nextStart.getTime() - blockStart.getTime()) / 60000);
      if (diffMin < 0 || diffMin % nextDuration !== 0) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La hora seleccionada no coincide con los slots de la disponibilidad.",
        });
      }

      nextEnd = new Date(nextStart.getTime() + nextDuration * 60 * 1000);
      if (nextEnd.getTime() > blockEnd.getTime()) {
        await rollbackQuietly(client);
        return serviceResult(409, {
          success: false,
          message: "La hora seleccionada excede la disponibilidad elegida.",
        });
      }

      const blockMode = normalizeModalidad(block.modalidad, "ambas");
      if (blockMode !== "ambas" && nextModalidad !== blockMode) {
        nextModalidad = blockMode;
      }

      const especialidadRow = await resolveEspecialidad(client, {
        especialidadId: block.especialidadid,
        medicoId: cita.medicoid,
      });
      const modeValidation = validateModalidadForEspecialidad(especialidadRow, nextModalidad);
      if (!modeValidation.ok) {
        await rollbackQuietly(client);
        return serviceResult(409, { success: false, message: modeValidation.reason });
      }
      nextModalidad = modeValidation.modalidad;
    } else {
      if (!nextStart) {
        const currentStart = parseDateInput(cita.fechahorainicio);
        if (!currentStart) {
          await rollbackQuietly(client);
          return serviceResult(400, {
            success: false,
            message: "No se pudo calcular un nuevo horario. Envia fechaHoraInicio.",
          });
        }
        nextStart = new Date(currentStart.getTime() + 24 * 60 * 60 * 1000);
      }
      nextEnd = new Date(nextStart.getTime() + nextDuration * 60 * 1000);
      nextDisponibilidadId = null;
    }

    if (
      !nextStart ||
      Number.isNaN(nextStart.getTime()) ||
      !nextEnd ||
      Number.isNaN(nextEnd.getTime())
    ) {
      await rollbackQuietly(client);
      return serviceResult(400, { success: false, message: "Nuevo horario invalido." });
    }
    if (nextStart.getTime() <= Date.now()) {
      await rollbackQuietly(client);
      return serviceResult(400, {
        success: false,
        message: "La nueva fecha debe ser futura.",
      });
    }

    const conflict = await hasCitaConflict(client, {
      medicoId: cita.medicoid,
      startIso: nextStart.toISOString(),
      endIso: nextEnd.toISOString(),
      excludeCitaId: cleanCitaId,
    });
    if (conflict) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "Ese horario ya fue tomado por otro paciente.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const estadoReprogramadaId = estadoMap.reprogramada;
    if (!estadoReprogramadaId) {
      await rollbackQuietly(client);
      return serviceResult(500, {
        success: false,
        message: "No se pudo resolver el estado reprogramada.",
      });
    }

    const tipoConsultaId = await resolveTipoConsultaId(client, nextModalidad);
    await client.query(
      `UPDATE cita
       SET tipoconsultaid = $1,
           estadocitaid = $2,
           zonahorariaid = COALESCE($3, zonahorariaid),
           fechahorainicio = $4::timestamptz,
           fechahorafin = $5::timestamptz,
           duracionmin = $6,
           modalidad = $7,
           disponibilidadid = $8,
           estado_codigo = 'reprogramada',
           cancelada_por = NULL,
           cancelacion_motivo = NULL,
           updated_at = NOW()
       WHERE citaid::text = $9::text`,
      [
        tipoConsultaId,
        estadoReprogramadaId,
        nextZonaHorariaId,
        nextStart.toISOString(),
        nextEnd.toISOString(),
        nextDuration,
        nextModalidad,
        nextDisponibilidadId,
        cleanCitaId,
      ]
    );

    const actorTipo = ROLE_BY_ID[context.roleId] || "sistema";
    await appendCitaHistorial(client, {
      citaId: cleanCitaId,
      accion: "reprogramada",
      usuarioTipo: actorTipo,
      usuarioId: context.user.usuarioid,
      motivo,
      datos: {
        fechaAnteriorInicio: cita.fechahorainicio,
        fechaAnteriorFin: cita.fechahorafin,
        fechaNuevaInicio: nextStart.toISOString(),
        fechaNuevaFin: nextEnd.toISOString(),
        disponibilidadId: nextDisponibilidadId,
      },
    });

    const conversacionId = await ensureConversation(client, {
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText = `Tu cita fue reprogramada para ${formatDateLabel(nextStart)}.`;
    await appendSystemMessage(client, { conversacionId, text: systemText });

    if (context.roleId === PACIENTE_ROLE_ID) {
      const doctorUserIds = await resolveMedicoUserIds(client, cita.medicoid);
      for (const doctorUserId of doctorUserIds) {
        await createNotification(client, {
          usuarioid: doctorUserId,
          tipo: "cita_reprogramada",
          titulo: "Cita reprogramada",
          contenido: `${context.paciente.nombres || "Paciente"} movio una cita para ${formatDateLabel(
            nextStart
          )}.`,
          data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    } else {
      const pacienteUserIds = await resolvePacienteUserIds(client, cita.pacienteid);
      for (const pacienteUserId of pacienteUserIds) {
        await createNotification(client, {
          usuarioid: pacienteUserId,
          tipo: "cita_reprogramada",
          titulo: "Cita reprogramada por el medico",
          contenido: `Tu cita fue movida para ${formatDateLabel(nextStart)}.`,
          data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    }

    await createNotification(client, {
      usuarioid: context.user.usuarioid,
      tipo: "cita_reprogramada",
      titulo: "Reprogramacion completada",
      contenido: `La cita ahora inicia ${formatDateLabel(nextStart)}.`,
      data: { citaId: cleanCitaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId: cleanCitaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_reprogramada",
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return serviceResult(
      200,
      {
        success: true,
        message: "Cita reprogramada correctamente.",
        cita: citaPayload,
      },
      { context: { roleId: context.roleId } }
    );
  } catch (err) {
    await rollbackQuietly(client);

    if (String(err?.code || "") === "23505") {
      return serviceResult(409, {
        success: false,
        message: "Ese horario ya fue reservado por otro usuario.",
      });
    }

    console.error("Error rescheduleMyCita:", err);
    return serviceResult(500, {
      success: false,
      message: "No se pudo reprogramar la cita.",
    });
  } finally {
    if (client) client.release();
  }
}

async function updateMyCitaEstado({
  reqUser,
  citaId,
  body = {},
  allowedRoleIds = [MEDICO_ROLE_ID],
  forbiddenRoleMessage = "Solo medicos pueden actualizar estado de cita.",
}) {
  const cleanCitaId = normalizeText(citaId);
  const nextCode = normalizeEstadoCode(body?.estado, "");
  const motivo = normalizeText(body?.motivo).slice(0, 1200);

  if (!cleanCitaId) {
    return serviceResult(400, { success: false, message: "citaId es obligatorio." });
  }
  if (!["confirmada", "completada", "no_asistio"].includes(nextCode)) {
    return serviceResult(400, {
      success: false,
      message: "estado invalido. Usa confirmada, completada o no_asistio.",
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, reqUser);
    if (context.error) {
      await rollbackQuietly(client);
      return serviceResult(context.error.status, {
        success: false,
        message: context.error.message,
      });
    }
    if (!isRoleAllowed(context.roleId, allowedRoleIds)) {
      await rollbackQuietly(client);
      return serviceResult(403, { success: false, message: forbiddenRoleMessage });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId: cleanCitaId,
      context,
      lock: true,
    });
    if (!cita) {
      await rollbackQuietly(client);
      return serviceResult(404, { success: false, message: "Cita no encontrada." });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (isClosedStatusCode(currentCode) && nextCode !== currentCode) {
      await rollbackQuietly(client);
      return serviceResult(409, {
        success: false,
        message: "No puedes cambiar una cita cerrada a otro estado.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const nextEstadoId = estadoMap[nextCode];
    if (!nextEstadoId) {
      await rollbackQuietly(client);
      return serviceResult(500, {
        success: false,
        message: "No se pudo resolver el estado solicitado.",
      });
    }

    await client.query(
      `UPDATE cita
       SET estadocitaid = $1,
           estado_codigo = $2,
           updated_at = NOW()
       WHERE citaid::text = $3::text`,
      [nextEstadoId, nextCode, cleanCitaId]
    );

    await appendCitaHistorial(client, {
      citaId: cleanCitaId,
      accion: nextCode === "confirmada" ? "confirmada" : nextCode,
      usuarioTipo: "medico",
      usuarioId: context.user.usuarioid,
      motivo,
      datos: {
        estadoAnterior: currentCode,
        estadoNuevo: nextCode,
      },
    });

    const conversacionId = await ensureConversation(client, {
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });

    const statusText =
      nextCode === "confirmada"
        ? "Tu cita fue confirmada."
        : nextCode === "completada"
          ? "La consulta fue marcada como completada."
          : "La cita fue marcada como no asistida.";
    await appendSystemMessage(client, { conversacionId, text: statusText });

    const pacienteUserIds = await resolvePacienteUserIds(client, cita.pacienteid);
    for (const pacienteUserId of pacienteUserIds) {
      await createNotification(client, {
        usuarioid: pacienteUserId,
        tipo: "cita_actualizada",
        titulo: "Estado de cita actualizado",
        contenido: statusText,
        data: {
          citaId: cleanCitaId,
          pacienteId: cita.pacienteid,
          medicoId: cita.medicoid,
          estado: nextCode,
        },
      });
    }

    const updatedCita = await fetchCitaByIdForContext(client, { citaId: cleanCitaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId: cleanCitaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: statusText,
      },
    });

    return serviceResult(
      200,
      {
        success: true,
        message: "Estado actualizado correctamente.",
        cita: citaPayload,
      },
      { context: { roleId: context.roleId } }
    );
  } catch (err) {
    await rollbackQuietly(client);
    console.error("Error updateMyCitaEstado:", err);
    return serviceResult(500, {
      success: false,
      message: "No se pudo actualizar el estado de la cita.",
    });
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  listMyCitas,
  getMyCitaDetail,
  createMyCita,
  cancelMyCita,
  rescheduleMyCita,
  updateMyCitaEstado,
};
