const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  ACTIVE_CITA_CODES,
  normalizeText,
  normalizeComparableText,
  parsePositiveInt,
  clampInt,
  isValidIsoDate,
  normalizeModalidad,
  normalizeEstadoCode,
  parseDateInput,
  formatDateLabel,
  isClosedStatusCode,
  ensurePlatformSchema,
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
  parseDateRangeFromQuery,
  parseBlockDates,
  buildSlots,
  canJoinVideoRoom,
} = require("../services/platform-core");
const { emitCitaEvent, emitConversationEvent } = require("../realtime/socket");

const router = express.Router();

const REPROGRAMABLE_CODES = ["pendiente", "confirmada", "reprogramada"];
const ROLE_BY_ID = {
  [PACIENTE_ROLE_ID]: "paciente",
  [MEDICO_ROLE_ID]: "medico",
};

function normalizeMessageType(value) {
  const type = normalizeComparableText(value);
  if (type === "texto" || type === "imagen" || type === "archivo" || type === "sistema") {
    return type;
  }
  return "texto";
}

function isFutureDate(value) {
  const date = value instanceof Date ? value : parseDateInput(value);
  if (!date || Number.isNaN(date.getTime())) return false;
  return date.getTime() > Date.now();
}

async function fetchConversationForContext(client, { conversacionId, context, lock = false }) {
  const params = [String(conversacionId)];
  const where = ["conv.conversacionid::text = $1::text"];

  if (context.roleId === PACIENTE_ROLE_ID) {
    params.push(Number(context.paciente.pacienteid));
    where.push(`conv.pacienteid = $${params.length}`);
  } else if (context.roleId === MEDICO_ROLE_ID) {
    params.push(String(context.medico.medicoid));
    where.push(`conv.medicoid::text = $${params.length}::text`);
  } else {
    return null;
  }

  const result = await client.query(
    `SELECT
       conv.conversacionid::text AS conversacionid,
       conv.citaid::text AS citaid,
       conv.pacienteid::text AS pacienteid,
       conv.medicoid::text AS medicoid,
       conv.estado,
       conv.updated_at
     FROM conversaciones conv
     WHERE ${where.join(" AND ")}
     LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    params
  );

  return result.rows[0] || null;
}

router.use(async (_req, res, next) => {
  try {
    await ensurePlatformSchema();
    return next();
  } catch (err) {
    console.error("Error inicializando esquema platform:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo preparar el esquema de plataforma.",
    });
  }
});

router.get("/catalogos/especialidades", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.especialidadid,
         e.nombre,
         e.permite_presencial,
         e.permite_virtual,
         COUNT(m.medicoid) FILTER (WHERE m.medicoid IS NOT NULL)::int AS total_medicos
       FROM especialidad e
       LEFT JOIN medico m ON m.especialidadid = e.especialidadid
       GROUP BY e.especialidadid, e.nombre, e.permite_presencial, e.permite_virtual
       ORDER BY lower(e.nombre) ASC`
    );
    return res.json({
      success: true,
      especialidades: result.rows.map((row) => ({
        especialidadid: Number(row.especialidadid),
        nombre: normalizeText(row.nombre),
        permitePresencial: Boolean(row.permite_presencial),
        permiteVirtual: Boolean(row.permite_virtual),
        totalMedicos: Number(row.total_medicos || 0),
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/catalogos/especialidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo listar el catalogo de especialidades.",
    });
  }
});

router.get("/disponibilidades", requireAuth, async (req, res) => {
  const medicoId = normalizeText(req.query?.medicoId);
  const especialidadId = parsePositiveInt(req.query?.especialidadId, null);
  const especialidad = normalizeText(req.query?.especialidad);
  const modalidad = normalizeModalidad(req.query?.modalidad, "");
  const fecha = normalizeText(req.query?.fecha);

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId,
      especialidad,
      medicoId,
    });
    const modalidadValidation = validateModalidadForEspecialidad(
      especialidadRow,
      modalidad || "presencial"
    );
    if (modalidad && !modalidadValidation.ok) {
      return res.json({ success: true, slots: [], resumenPorMedico: [] });
    }

    const params = [];
    const where = ["h.activo = TRUE", "h.bloqueado = FALSE", "h.fechafin > NOW()"];

    if (medicoId) {
      params.push(medicoId);
      where.push(`h.medicoid::text = $${params.length}::text`);
    }

    if (especialidadRow?.especialidadid) {
      params.push(Number(especialidadRow.especialidadid));
      where.push(`COALESCE(h.especialidadid, m.especialidadid) = $${params.length}`);
    }

    if (fecha && isValidIsoDate(fecha)) {
      params.push(`${fecha}T00:00:00.000Z`);
      params.push(`${fecha}T23:59:59.999Z`);
      where.push(`h.fechainicio <= $${params.length}::timestamptz`);
      where.push(`h.fechafin >= $${params.length - 1}::timestamptz`);
    }

    const availabilityResult = await client.query(
      `SELECT
         h.horariodisponibleid,
         h.medicoid::text AS medicoid,
         h.especialidadid,
         h.fechainicio,
         h.fechafin,
         h.modalidad,
         h.slot_minutos,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre
       FROM horario_disponible h
       LEFT JOIN medico m ON m.medicoid = h.medicoid
       LEFT JOIN especialidad e ON e.especialidadid = COALESCE(h.especialidadid, m.especialidadid)
       WHERE ${where.join(" AND ")}
       ORDER BY h.fechainicio ASC
       LIMIT 600`,
      params
    );

    if (!availabilityResult.rows.length) {
      return res.json({ success: true, slots: [], resumenPorMedico: [] });
    }

    const rangeStart = availabilityResult.rows[0].fechainicio;
    const rangeEnd =
      availabilityResult.rows[availabilityResult.rows.length - 1].fechafin;

    const bookedParams = [rangeStart, rangeEnd];
    const bookedWhere = [
      "c.fechahorainicio < $2::timestamptz",
      "c.fechahorafin > $1::timestamptz",
      "lower(coalesce(c.estado_codigo, 'pendiente')) = ANY($3)",
    ];
    bookedParams.push(ACTIVE_CITA_CODES);

    if (medicoId) {
      bookedParams.push(medicoId);
      bookedWhere.push(`c.medicoid::text = $${bookedParams.length}::text`);
    }

    const bookedResult = await client.query(
      `SELECT c.medicoid::text AS medicoid, c.fechahorainicio, c.fechahorafin
       FROM cita c
       WHERE ${bookedWhere.join(" AND ")}`,
      bookedParams
    );

    const slots = buildSlots(availabilityResult.rows, bookedResult.rows, {
      modalidadFilter: modalidad,
      fechaFilter: fecha,
    });

    const resumenMap = new Map();
    for (const slot of slots) {
      const key = `${slot.medicoId}::${slot.especialidadId}`;
      if (!resumenMap.has(key)) {
        resumenMap.set(key, {
          medicoId: slot.medicoId,
          medicoNombre: slot.medicoNombre,
          especialidadId: slot.especialidadId,
          especialidad: slot.especialidad,
          totalSlots: 0,
          primerHorario: slot.horaInicio,
          ultimoHorario: slot.horaFin,
        });
      }
      const row = resumenMap.get(key);
      row.totalSlots += 1;
      if (new Date(slot.horaInicio) < new Date(row.primerHorario)) {
        row.primerHorario = slot.horaInicio;
      }
      if (new Date(slot.horaFin) > new Date(row.ultimoHorario)) {
        row.ultimoHorario = slot.horaFin;
      }
    }

    return res.json({
      success: true,
      filtros: {
        medicoId: medicoId || null,
        especialidadId: especialidadRow?.especialidadid || null,
        modalidad: modalidad || null,
        fecha: fecha || null,
      },
      slots,
      resumenPorMedico: [...resumenMap.values()],
    });
  } catch (err) {
    console.error("Error GET /agenda/disponibilidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo cargar la disponibilidad de medicos.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/medico/me/disponibilidades", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo medicos pueden acceder." });
    }

    const range = parseDateRangeFromQuery(req.query);
    const result = await client.query(
      `SELECT
         h.horariodisponibleid::text AS horariodisponibleid,
         h.medicoid::text AS medicoid,
         h.especialidadid,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
         h.zonahorariaid,
         h.fechainicio,
         h.fechafin,
         h.modalidad,
         h.slot_minutos,
         h.activo,
         h.bloqueado,
         h.nota,
         h.updated_at
       FROM horario_disponible h
       LEFT JOIN especialidad e ON e.especialidadid = h.especialidadid
       WHERE h.medicoid::text = $1::text
         AND h.fechafin >= $2::timestamptz
         AND h.fechainicio <= $3::timestamptz
       ORDER BY h.fechainicio ASC`,
      [String(context.medico.medicoid), range.fromIso, range.toIso]
    );

    return res.json({
      success: true,
      disponibilidades: result.rows.map((row) => ({
        id: String(row.horariodisponibleid || ""),
        medicoId: String(row.medicoid || ""),
        especialidadId: row.especialidadid ? Number(row.especialidadid) : null,
        especialidad: normalizeText(row.especialidad_nombre),
        zonaHorariaId: row.zonahorariaid ? Number(row.zonahorariaid) : null,
        fechaInicio: row.fechainicio || null,
        fechaFin: row.fechafin || null,
        modalidad: normalizeModalidad(row.modalidad, "ambas"),
        slotMinutos: Number(row.slot_minutos || 30),
        activo: Boolean(row.activo),
        bloqueado: Boolean(row.bloqueado),
        nota: normalizeText(row.nota),
        updatedAt: row.updated_at || null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/medico/me/disponibilidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo listar la disponibilidad del medico.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/medico/me/disponibilidades", requireAuth, async (req, res) => {
  const modalidad = normalizeModalidad(req.body?.modalidad, "ambas");
  const slotMinutos = clampInt(req.body?.slotMinutos, 15, 60, 30);
  const nota = normalizeText(req.body?.nota).slice(0, 1200);
  const especialidadId = parsePositiveInt(req.body?.especialidadId, null);
  const bloqueado = Boolean(req.body?.bloqueado);
  const activo = req.body?.activo === undefined ? true : Boolean(req.body?.activo);
  const zoneIdRaw = parsePositiveInt(req.body?.zonaHorariaId, null);
  const { start, end } = parseBlockDates(req.body || {});

  if (!start || !end || end.getTime() <= start.getTime()) {
    return res.status(400).json({
      success: false,
      message:
        "Debes enviar un rango valido: fechaInicio/fechaFin o fecha + horaInicio/horaFin.",
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden crear disponibilidad." });
    }

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId: especialidadId || context.medico.especialidadid,
      medicoId: context.medico.medicoid,
    });
    if (!especialidadRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Especialidad no encontrada." });
    }

    const modeCheck = validateModalidadForEspecialidad(especialidadRow, modalidad);
    if (!modeCheck.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: modeCheck.reason });
    }

    const zonaHorariaId = zoneIdRaw || (await resolveZonaHorariaId(client));
    const insert = await client.query(
      `INSERT INTO horario_disponible (
         medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at
       )
       VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at`,
      [
        String(context.medico.medicoid),
        zonaHorariaId,
        start.toISOString(),
        end.toISOString(),
        activo,
        nota || null,
        Number(especialidadRow.especialidadid),
        modeCheck.modalidad,
        slotMinutos,
        bloqueado,
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({ success: true, disponibilidad: insert.rows[0] });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/medico/me/disponibilidades:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo crear la disponibilidad.",
    });
  } finally {
    if (client) client.release();
  }
});

router.put("/medico/me/disponibilidades/:id", requireAuth, async (req, res) => {
  const disponibilidadId = parsePositiveInt(req.params?.id, null);
  if (!disponibilidadId) {
    return res.status(400).json({ success: false, message: "id de disponibilidad invalido." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden editar disponibilidad." });
    }

    const existing = await client.query(
      `SELECT
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         especialidadid,
         fechainicio,
         fechafin,
         modalidad,
         slot_minutos,
         activo,
         bloqueado,
         nota,
         zonahorariaid
       FROM horario_disponible
       WHERE horariodisponibleid = $1
         AND medicoid::text = $2::text
       LIMIT 1
       FOR UPDATE`,
      [disponibilidadId, String(context.medico.medicoid)]
    );

    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Disponibilidad no encontrada." });
    }

    const current = existing.rows[0];
    const parsedRange = parseBlockDates(req.body || {});
    const nextStart = parsedRange.start || new Date(current.fechainicio);
    const nextEnd = parsedRange.end || new Date(current.fechafin);
    if (
      !nextStart ||
      !nextEnd ||
      Number.isNaN(nextStart.getTime()) ||
      Number.isNaN(nextEnd.getTime()) ||
      nextEnd <= nextStart
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Rango de fechas invalido." });
    }

    const nextModalidad =
      req.body?.modalidad !== undefined
        ? normalizeModalidad(req.body?.modalidad, "ambas")
        : normalizeModalidad(current.modalidad, "ambas");
    const nextSlot = clampInt(
      req.body?.slotMinutos !== undefined ? req.body.slotMinutos : current.slot_minutos,
      15,
      60,
      30
    );
    const nextNota =
      req.body?.nota !== undefined
        ? normalizeText(req.body?.nota).slice(0, 1200)
        : normalizeText(current.nota);
    const nextActivo =
      req.body?.activo !== undefined ? Boolean(req.body.activo) : Boolean(current.activo);
    const nextBloqueado =
      req.body?.bloqueado !== undefined
        ? Boolean(req.body.bloqueado)
        : Boolean(current.bloqueado);
    const nextEspecialidadId = parsePositiveInt(
      req.body?.especialidadId !== undefined ? req.body.especialidadId : current.especialidadid,
      null
    );
    const nextZonaHorariaId = parsePositiveInt(
      req.body?.zonaHorariaId !== undefined ? req.body.zonaHorariaId : current.zonahorariaid,
      null
    );

    const especialidadRow = await resolveEspecialidad(client, {
      especialidadId: nextEspecialidadId,
      medicoId: context.medico.medicoid,
    });
    if (!especialidadRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Especialidad no encontrada." });
    }

    const modeCheck = validateModalidadForEspecialidad(especialidadRow, nextModalidad);
    if (!modeCheck.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: modeCheck.reason });
    }

    const updated = await client.query(
      `UPDATE horario_disponible
       SET zonahorariaid = COALESCE($1, zonahorariaid),
           fechainicio = $2::timestamptz,
           fechafin = $3::timestamptz,
           activo = $4,
           nota = $5,
           especialidadid = $6,
           modalidad = $7,
           slot_minutos = $8,
           bloqueado = $9,
           updated_at = NOW()
       WHERE horariodisponibleid = $10
         AND medicoid::text = $11::text
       RETURNING
         horariodisponibleid::text AS horariodisponibleid,
         medicoid::text AS medicoid,
         zonahorariaid,
         fechainicio,
         fechafin,
         activo,
         nota,
         especialidadid,
         modalidad,
         slot_minutos,
         bloqueado,
         updated_at`,
      [
        nextZonaHorariaId,
        nextStart.toISOString(),
        nextEnd.toISOString(),
        nextActivo,
        nextNota || null,
        Number(especialidadRow.especialidadid),
        modeCheck.modalidad,
        nextSlot,
        nextBloqueado,
        disponibilidadId,
        String(context.medico.medicoid),
      ]
    );

    await client.query("COMMIT");
    return res.json({ success: true, disponibilidad: updated.rows[0] || null });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error PUT /agenda/medico/me/disponibilidades/:id:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la disponibilidad.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/medico/me/disponibilidades/:id/bloquear", requireAuth, async (req, res) => {
  const disponibilidadId = parsePositiveInt(req.params?.id, null);
  const bloqueado = req.body?.bloqueado === undefined ? true : Boolean(req.body.bloqueado);

  if (!disponibilidadId) {
    return res.status(400).json({ success: false, message: "id de disponibilidad invalido." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      return res
        .status(403)
        .json({ success: false, message: "Solo medicos pueden bloquear disponibilidad." });
    }

    const result = await client.query(
      `UPDATE horario_disponible
       SET bloqueado = $1,
           updated_at = NOW()
       WHERE horariodisponibleid = $2
         AND medicoid::text = $3::text
       RETURNING horariodisponibleid::text AS horariodisponibleid, bloqueado, updated_at`,
      [bloqueado, disponibilidadId, String(context.medico.medicoid)]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Disponibilidad no encontrada." });
    }
    return res.json({ success: true, disponibilidad: result.rows[0] });
  } catch (err) {
    console.error("Error PATCH /agenda/medico/me/disponibilidades/:id/bloquear:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar el bloqueo de disponibilidad.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/citas", requireAuth, async (req, res) => {
  const scopeRaw = normalizeComparableText(req.query?.scope || "upcoming");
  const scope = ["upcoming", "history", "all"].includes(scopeRaw) ? scopeRaw : "upcoming";
  const limit = clampInt(req.query?.limit, 1, 200, 60);

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
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
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
         LEFT JOIN conversaciones conv ON conv.citaid = c.citaid
         LEFT JOIN LATERAL (
           SELECT up.foto_url
           FROM usuario_perfil up
           WHERE COALESCE(up.meta_json->>'medicoid', up.meta_json->>'medicoId', '') = m.medicoid::text
           ORDER BY up.updated_at DESC
           LIMIT 1
         ) mp ON TRUE
         WHERE c.pacienteid = $1
           AND ${scopeWhere}
         ORDER BY ${orderBy}
         LIMIT $2`,
        [Number(context.paciente.pacienteid), limit]
      );

      return res.json({
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
      });
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
         LEFT JOIN conversaciones conv ON conv.citaid = c.citaid
         WHERE c.medicoid::text = $1::text
           AND ${scopeWhere}
         ORDER BY ${orderBy}
         LIMIT $2`,
        [String(context.medico.medicoid), limit]
      );

      return res.json({
        success: true,
        scope,
        citas: result.rows.map((row) => ({
          ...buildCitaResponse(row),
          conversacionId: normalizeText(row.conversacionid) || null,
        })),
      });
    }

    return res.status(403).json({
      success: false,
      message: "Solo pacientes o medicos pueden listar citas.",
    });
  } catch (err) {
    console.error("Error GET /agenda/me/citas:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron listar las citas.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/citas/:citaId", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context });
    if (!cita) {
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
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
      [citaId]
    );

    const conversation = await client.query(
      `SELECT conversacionid::text AS conversacionid, estado, updated_at
       FROM conversaciones
       WHERE citaid = $1::uuid
       LIMIT 1`,
      [citaId]
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
      [citaId]
    );

    return res.json({
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
    });
  } catch (err) {
    console.error("Error GET /agenda/me/citas/:citaId:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo cargar el detalle de la cita.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/citas", requireAuth, async (req, res) => {
  const disponibilidadId = parsePositiveInt(req.body?.disponibilidadId, null);
  const fechaHoraInicio = parseDateInput(req.body?.fechaHoraInicio);
  const duracionMin = clampInt(req.body?.duracionMin, 15, 180, 30);
  const modalidadInput = normalizeModalidad(req.body?.modalidad, "presencial");
  const motivoConsulta = normalizeText(req.body?.motivoConsulta || req.body?.nota).slice(0, 1200);
  const especialidadId = parsePositiveInt(req.body?.especialidadId, null);
  const especialidad = normalizeText(req.body?.especialidad);
  const medicoIdRaw = normalizeText(req.body?.medicoId);
  const precioRaw = Number(req.body?.precio);
  const precio = Number.isFinite(precioRaw) && precioRaw >= 0 ? precioRaw : null;

  if (!disponibilidadId && (!fechaHoraInicio || !medicoIdRaw)) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar disponibilidadId o (medicoId + fechaHoraInicio).",
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== PACIENTE_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes pueden crear citas en este endpoint.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const estadoPendienteId = estadoMap.pendiente;
    if (!estadoPendienteId) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: "No se pudo resolver estado pendiente." });
    }

    let medicoId = medicoIdRaw;
    let slotStart = fechaHoraInicio ? new Date(fechaHoraInicio) : null;
    let slotEnd = null;
    let slotDuration = duracionMin;
    let modalidad = modalidadInput;
    let zonahorariaid = await resolveZonaHorariaId(client);
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
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "La disponibilidad seleccionada no existe.",
        });
      }

      const block = availability.rows[0];
      if (!Boolean(block.activo) || Boolean(block.bloqueado)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "La disponibilidad seleccionada no esta activa.",
        });
      }

      medicoId = String(block.medicoid || "");
      zonahorariaid = block.zonahorariaid || zonahorariaid;
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
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Horario de disponibilidad invalido." });
      }

      const diffMin = Math.round((slotStart.getTime() - blockStart.getTime()) / 60000);
      if (diffMin < 0 || diffMin % slotDuration !== 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "La hora seleccionada no coincide con los slots del medico.",
        });
      }

      slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);
      if (slotEnd.getTime() > blockEnd.getTime()) {
        await client.query("ROLLBACK");
        return res.status(409).json({
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
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: modeValidation.reason });
      }
      modalidad = modeValidation.modalidad;
    } else {
      if (!slotStart) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "fechaHoraInicio es obligatorio." });
      }
      slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

      const especialidadRow = await resolveEspecialidad(client, {
        especialidadId,
        especialidad,
        medicoId,
      });
      const modeValidation = validateModalidadForEspecialidad(especialidadRow, modalidad);
      if (!modeValidation.ok) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: modeValidation.reason });
      }
      modalidad = modeValidation.modalidad;
    }

    if (!medicoId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No se pudo resolver el medico de la cita." });
    }
    if (
      !slotStart ||
      Number.isNaN(slotStart.getTime()) ||
      !slotEnd ||
      Number.isNaN(slotEnd.getTime())
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Horario de cita invalido." });
    }
    if (slotStart.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "La cita debe ser en una fecha futura." });
    }

    const conflict = await hasCitaConflict(client, {
      medicoId,
      startIso: slotStart.toISOString(),
      endIso: slotEnd.toISOString(),
    });
    if (conflict) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ese horario ya fue tomado por otro paciente.",
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
         updated_at
       )
       VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, $6,
         $7::timestamptz, $8::timestamptz, $9, $10, NOW(),
         $11, $12, $13, NULL, NULL, $14, 'pendiente', NOW()
       )`,
      [
        citaId,
        Number(context.paciente.pacienteid),
        medicoId,
        tipoConsultaId,
        estadoPendienteId,
        zonahorariaid,
        slotStart.toISOString(),
        slotEnd.toISOString(),
        slotDuration,
        precio,
        motivoConsulta || null,
        modalidad,
        motivoConsulta || null,
        disponibilidadFinalId,
      ]
    );

    if (!insertResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: "No se pudo crear la cita." });
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

    return res.status(201).json({
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
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    const code = String(err?.code || "");
    if (code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Ese horario ya fue reservado por otro usuario.",
      });
    }

    console.error("Error POST /agenda/me/citas:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo crear la cita.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/citas/:citaId/cancelar", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const motivo = normalizeText(req.body?.motivo).slice(0, 1200);

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    if (![PACIENTE_ROLE_ID, MEDICO_ROLE_ID].includes(context.roleId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden cancelar citas.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId,
      context,
      lock: true,
    });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    if (!isFutureDate(cita.fechahorainicio)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Solo citas futuras pueden cancelarse.",
      });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (isClosedStatusCode(currentCode)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
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
      await client.query("ROLLBACK");
      return res.status(500).json({
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
      [nextEstadoId, nextEstadoCode, actorTipo, motivo || null, citaId]
    );

    await appendCitaHistorial(client, {
      citaId,
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
      citaId,
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
          contenido: `${context.paciente.nombres || "Paciente"} canceló la cita del ${formatDateLabel(
            cita.fechahorainicio
          )}.`,
          data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    } else {
      await createNotification(client, {
        usuarioid: Number(cita.pacienteid),
        tipo: "cita_cancelada",
        titulo: "Cita cancelada por el medico",
        contenido: `Tu cita del ${formatDateLabel(cita.fechahorainicio)} fue cancelada.`,
        data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
      });
    }

    await createNotification(client, {
      usuarioid: context.user.usuarioid,
      tipo: "cita_cancelada",
      titulo: "Cancelacion aplicada",
      contenido: "La cita se canceló correctamente.",
      data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_cancelada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      message: "Cita cancelada correctamente.",
      cita: citaPayload,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error PATCH /agenda/me/citas/:citaId/cancelar:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo cancelar la cita.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/citas/:citaId/reprogramar", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const disponibilidadId = parsePositiveInt(req.body?.disponibilidadId, null);
  const requestedStart = parseDateInput(req.body?.fechaHoraInicio);
  const requestedDuracion = clampInt(req.body?.duracionMin, 15, 180, 30);
  const motivo = normalizeText(req.body?.motivo).slice(0, 1200);

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (![PACIENTE_ROLE_ID, MEDICO_ROLE_ID].includes(context.roleId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden reprogramar citas.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId,
      context,
      lock: true,
    });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    if (!isFutureDate(cita.fechahorainicio)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Solo citas futuras pueden reprogramarse.",
      });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (!REPROGRAMABLE_CODES.includes(currentCode)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
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
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "La disponibilidad seleccionada no existe para ese medico.",
        });
      }

      const block = availability.rows[0];
      if (!Boolean(block.activo) || Boolean(block.bloqueado)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
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
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "El horario de disponibilidad es invalido.",
        });
      }

      const diffMin = Math.round((nextStart.getTime() - blockStart.getTime()) / 60000);
      if (diffMin < 0 || diffMin % nextDuration !== 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "La hora seleccionada no coincide con los slots de la disponibilidad.",
        });
      }

      nextEnd = new Date(nextStart.getTime() + nextDuration * 60 * 1000);
      if (nextEnd.getTime() > blockEnd.getTime()) {
        await client.query("ROLLBACK");
        return res.status(409).json({
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
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: modeValidation.reason });
      }
      nextModalidad = modeValidation.modalidad;
    } else {
      if (!nextStart) {
        const currentStart = parseDateInput(cita.fechahorainicio);
        if (!currentStart) {
          await client.query("ROLLBACK");
          return res.status(400).json({
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
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Nuevo horario invalido." });
    }
    if (nextStart.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "La nueva fecha debe ser futura.",
      });
    }

    const conflict = await hasCitaConflict(client, {
      medicoId: cita.medicoid,
      startIso: nextStart.toISOString(),
      endIso: nextEnd.toISOString(),
      excludeCitaId: citaId,
    });
    if (conflict) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ese horario ya fue tomado por otro paciente.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const estadoReprogramadaId = estadoMap.reprogramada;
    if (!estadoReprogramadaId) {
      await client.query("ROLLBACK");
      return res.status(500).json({
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
        citaId,
      ]
    );

    const actorTipo = ROLE_BY_ID[context.roleId] || "sistema";
    await appendCitaHistorial(client, {
      citaId,
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
      citaId,
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
          contenido: `${context.paciente.nombres || "Paciente"} movió una cita para ${formatDateLabel(
            nextStart
          )}.`,
          data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
        });
      }
    } else {
      await createNotification(client, {
        usuarioid: Number(cita.pacienteid),
        tipo: "cita_reprogramada",
        titulo: "Cita reprogramada por el medico",
        contenido: `Tu cita fue movida para ${formatDateLabel(nextStart)}.`,
        data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
      });
    }

    await createNotification(client, {
      usuarioid: context.user.usuarioid,
      tipo: "cita_reprogramada",
      titulo: "Reprogramacion completada",
      contenido: `La cita ahora inicia ${formatDateLabel(nextStart)}.`,
      data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_reprogramada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      message: "Cita reprogramada correctamente.",
      cita: citaPayload,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    const code = String(err?.code || "");
    if (code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Ese horario ya fue reservado por otro usuario.",
      });
    }
    console.error("Error PATCH /agenda/me/citas/:citaId/reprogramar:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo reprogramar la cita.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/citas/:citaId/estado", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const nextCode = normalizeEstadoCode(req.body?.estado, "");
  const motivo = normalizeText(req.body?.motivo).slice(0, 1200);

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }
  if (!["confirmada", "completada", "no_asistio"].includes(nextCode)) {
    return res.status(400).json({
      success: false,
      message: "estado invalido. Usa confirmada, completada o no_asistio.",
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo medicos pueden actualizar estado de cita.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, {
      citaId,
      context,
      lock: true,
    });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    const currentCode = normalizeEstadoCode(cita.estado_code || cita.estado_codigo, "pendiente");
    if (isClosedStatusCode(currentCode) && nextCode !== currentCode) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "No puedes cambiar una cita cerrada a otro estado.",
      });
    }

    const estadoMap = await ensureEstadoCatalog(client);
    const nextEstadoId = estadoMap[nextCode];
    if (!nextEstadoId) {
      await client.query("ROLLBACK");
      return res.status(500).json({
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
      [nextEstadoId, nextCode, citaId]
    );

    await appendCitaHistorial(client, {
      citaId,
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
      citaId,
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

    await createNotification(client, {
      usuarioid: Number(cita.pacienteid),
      tipo: "cita_actualizada",
      titulo: "Estado de cita actualizado",
      contenido: statusText,
      data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid, estado: nextCode },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { cita: citaPayload },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: statusText,
      },
    });

    return res.json({
      success: true,
      message: "Estado actualizado correctamente.",
      cita: citaPayload,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error PATCH /agenda/me/citas/:citaId/estado:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar el estado de la cita.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/conversaciones", requireAuth, async (req, res) => {
  const limit = clampInt(req.query?.limit, 1, 100, 40);

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const roleType = ROLE_BY_ID[context.roleId];
    if (!roleType) {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden listar conversaciones.",
      });
    }

    const params = [roleType];
    let where = "";
    if (context.roleId === PACIENTE_ROLE_ID) {
      params.push(Number(context.paciente.pacienteid));
      where = `conv.pacienteid = $${params.length}`;
    } else {
      params.push(String(context.medico.medicoid));
      where = `conv.medicoid::text = $${params.length}::text`;
    }
    params.push(limit);

    const result = await client.query(
      `SELECT
         conv.conversacionid::text AS conversacionid,
         conv.citaid::text AS citaid,
         conv.pacienteid::text AS pacienteid,
         conv.medicoid::text AS medicoid,
         conv.estado,
         conv.updated_at,
         c.fechahorainicio,
         c.modalidad,
         c.estado_codigo,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
         COALESCE(
           NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
           'Paciente'
         ) AS paciente_nombre,
         latest.mensajeid,
         latest.contenido AS ultimo_contenido,
         latest.tipo AS ultimo_tipo,
         latest.created_at AS ultimo_created_at,
         latest.emisor_tipo AS ultimo_emisor_tipo,
         unread.unread_count
       FROM conversaciones conv
       JOIN cita c ON c.citaid = conv.citaid
       LEFT JOIN medico m ON m.medicoid = conv.medicoid
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       LEFT JOIN paciente p ON p.pacienteid = conv.pacienteid
       LEFT JOIN LATERAL (
         SELECT
           msg.mensajeid::text AS mensajeid,
           msg.contenido,
           msg.tipo,
           msg.created_at,
           msg.emisor_tipo
         FROM mensajes msg
         WHERE msg.conversacionid = conv.conversacionid
         ORDER BY msg.created_at DESC
         LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
         FROM mensajes msg
         WHERE msg.conversacionid = conv.conversacionid
           AND msg.leido = FALSE
           AND lower(msg.emisor_tipo) <> $1
       ) unread ON TRUE
       WHERE ${where}
       ORDER BY conv.updated_at DESC
       LIMIT $${params.length}`,
      params
    );

    return res.json({
      success: true,
      conversaciones: result.rows.map((row) => ({
        conversacionId: normalizeText(row.conversacionid),
        citaId: normalizeText(row.citaid),
        estado: normalizeText(row.estado) || "activa",
        updatedAt: row.updated_at || null,
        unreadCount: Number(row.unread_count || 0),
        cita: {
          fechaHoraInicio: row.fechahorainicio || null,
          modalidad: normalizeModalidad(row.modalidad, "presencial"),
          estadoCodigo: normalizeEstadoCode(row.estado_codigo, "pendiente"),
        },
        paciente: {
          pacienteid: normalizeText(row.pacienteid),
          nombreCompleto: normalizeText(row.paciente_nombre) || "Paciente",
        },
        medico: {
          medicoid: normalizeText(row.medicoid),
          nombreCompleto: normalizeText(row.medico_nombre) || "Medico",
          especialidad: normalizeText(row.especialidad_nombre) || "Medicina General",
        },
        ultimoMensaje: row.mensajeid
          ? {
              mensajeId: normalizeText(row.mensajeid),
              contenido: normalizeText(row.ultimo_contenido),
              tipo: normalizeMessageType(row.ultimo_tipo),
              emisorTipo: normalizeText(row.ultimo_emisor_tipo),
              createdAt: row.ultimo_created_at || null,
            }
          : null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/me/conversaciones:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron listar las conversaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/conversaciones/:conversacionId/mensajes", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  const before = parseDateInput(req.query?.before);
  const limit = clampInt(req.query?.limit, 1, 200, 80);

  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    const params = [conversacionId, before ? before.toISOString() : null, limit];
    const result = await client.query(
      `SELECT
         m.mensajeid::text AS mensajeid,
         m.emisor_tipo,
         m.emisor_id,
         m.contenido,
         m.tipo,
         m.leido,
         m.leido_at,
         m.meta_json,
         m.created_at
       FROM mensajes m
       WHERE m.conversacionid::text = $1::text
         AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
       ORDER BY m.created_at DESC
       LIMIT $3`,
      params
    );

    const messages = result.rows
      .map((row) => ({
        mensajeId: normalizeText(row.mensajeid),
        emisorTipo: normalizeText(row.emisor_tipo),
        emisorId: normalizeText(row.emisor_id),
        contenido: normalizeText(row.contenido),
        tipo: normalizeMessageType(row.tipo),
        leido: Boolean(row.leido),
        leidoAt: row.leido_at || null,
        meta: row.meta_json || {},
        createdAt: row.created_at || null,
      }))
      .reverse();

    return res.json({
      success: true,
      conversacion: {
        conversacionId: normalizeText(conversation.conversacionid),
        citaId: normalizeText(conversation.citaid),
        pacienteId: normalizeText(conversation.pacienteid),
        medicoId: normalizeText(conversation.medicoid),
      },
      mensajes: messages,
    });
  } catch (err) {
    console.error("Error GET /agenda/me/conversaciones/:id/mensajes:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron cargar los mensajes.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/conversaciones/:conversacionId/mensajes", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  const contenido = normalizeText(req.body?.contenido).slice(0, 4000);
  const tipo = normalizeMessageType(req.body?.tipo);
  const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};

  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
  }
  if (!contenido) {
    return res.status(400).json({ success: false, message: "contenido es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const senderType = ROLE_BY_ID[context.roleId];
    if (!senderType) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden enviar mensajes.",
      });
    }

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
      lock: true,
    });
    if (!conversation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    if (normalizeComparableText(conversation.estado) === "cerrada") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "La conversacion esta cerrada.",
      });
    }

    const insert = await client.query(
      `INSERT INTO mensajes (
         mensajeid,
         conversacionid,
         emisor_tipo,
         emisor_id,
         contenido,
         tipo,
         leido,
         meta_json,
         created_at
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, FALSE, $7::jsonb, NOW())
       RETURNING
         mensajeid::text AS mensajeid,
         conversacionid::text AS conversacionid,
         emisor_tipo,
         emisor_id,
         contenido,
         tipo,
         leido,
         leido_at,
         meta_json,
         created_at`,
      [
        randomUUID(),
        conversacionId,
        senderType,
        normalizeText(context.user.usuarioid),
        contenido,
        tipo,
        JSON.stringify(meta || {}),
      ]
    );

    await client.query(
      `UPDATE conversaciones
       SET updated_at = NOW()
       WHERE conversacionid::text = $1::text`,
      [conversacionId]
    );

    const row = insert.rows[0] || {};
    const messagePayload = {
      mensajeId: normalizeText(row.mensajeid),
      conversacionId: normalizeText(row.conversacionid),
      emisorTipo: normalizeText(row.emisor_tipo),
      emisorId: normalizeText(row.emisor_id),
      contenido: normalizeText(row.contenido),
      tipo: normalizeMessageType(row.tipo),
      leido: Boolean(row.leido),
      leidoAt: row.leido_at || null,
      meta: row.meta_json || {},
      createdAt: row.created_at || null,
    };

    if (senderType === "paciente") {
      const doctorUserIds = await resolveMedicoUserIds(client, conversation.medicoid);
      for (const doctorUserId of doctorUserIds) {
        await createNotification(client, {
          usuarioid: doctorUserId,
          tipo: "mensaje_nuevo",
          titulo: "Nuevo mensaje del paciente",
          contenido,
          data: {
            conversacionId,
            citaId: conversation.citaid,
            pacienteId: conversation.pacienteid,
            medicoId: conversation.medicoid,
          },
        });
      }
    } else {
      await createNotification(client, {
        usuarioid: Number(conversation.pacienteid),
        tipo: "mensaje_nuevo",
        titulo: "Nuevo mensaje del medico",
        contenido,
        data: {
          conversacionId,
          citaId: conversation.citaid,
          pacienteId: conversation.pacienteid,
          medicoId: conversation.medicoid,
        },
      });
    }

    await client.query("COMMIT");

    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId: conversation.citaid,
      pacienteId: conversation.pacienteid,
      medicoId: conversation.medicoid,
      extraPayload: { mensaje: messagePayload },
    });

    return res.status(201).json({
      success: true,
      mensaje: messagePayload,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/me/conversaciones/:id/mensajes:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo enviar el mensaje.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/conversaciones/:conversacionId/leido", requireAuth, async (req, res) => {
  const conversacionId = normalizeText(req.params?.conversacionId);
  if (!conversacionId) {
    return res.status(400).json({ success: false, message: "conversacionId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const roleType = ROLE_BY_ID[context.roleId];
    if (!roleType) {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden marcar mensajes.",
      });
    }

    const conversation = await fetchConversationForContext(client, {
      conversacionId,
      context,
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversacion no encontrada." });
    }

    const update = await client.query(
      `UPDATE mensajes
       SET leido = TRUE,
           leido_at = NOW()
       WHERE conversacionid::text = $1::text
         AND leido = FALSE
         AND lower(emisor_tipo) <> $2
       RETURNING mensajeid::text AS mensajeid`,
      [conversacionId, roleType]
    );

    return res.json({
      success: true,
      marcados: Number(update.rowCount || 0),
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/conversaciones/:id/leido:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo marcar como leido.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/citas/:citaId/video-sala", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context });
    if (!cita) {
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }
    if (normalizeModalidad(cita.modalidad, "presencial") !== "virtual") {
      return res.status(409).json({
        success: false,
        message: "Esta cita no es virtual.",
      });
    }

    const sala = await ensureVideoSala(client, { citaId, provider: "jitsi" });
    const canJoin = canJoinVideoRoom({
      citaStart: cita.fechahorainicio,
      roomEstado: sala?.estado,
      roleId: context.roleId,
    });

    return res.json({
      success: true,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: normalizeText(sala.proveedor),
            roomName: normalizeText(sala.room_name),
            joinUrl: normalizeText(sala.token_o_url),
            estado: normalizeText(sala.estado) || "pendiente",
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
            canJoin,
          }
        : null,
    });
  } catch (err) {
    console.error("Error GET /agenda/me/citas/:id/video-sala:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo obtener la sala de video.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/citas/:citaId/video-sala/abrir", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo medicos pueden abrir la sala.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }
    if (normalizeModalidad(cita.modalidad, "presencial") !== "virtual") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Esta cita no es virtual.",
      });
    }

    await ensureVideoSala(client, { citaId, provider: "jitsi" });
    const updateSala = await client.query(
      `UPDATE video_salas
       SET estado = 'abierta',
           opened_at = COALESCE(opened_at, NOW())
       WHERE citaid::text = $1::text
       RETURNING
         videosalaid::text AS videosalaid,
         proveedor,
         room_name,
         token_o_url,
         estado,
         opened_at,
         closed_at`,
      [citaId]
    );

    const sala = updateSala.rows[0] || null;
    const conversacionId = await ensureConversation(client, {
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText = "El medico inició la videollamada.";
    await appendSystemMessage(client, { conversacionId, text: systemText });

    await createNotification(client, {
      usuarioid: Number(cita.pacienteid),
      tipo: "videollamada_disponible",
      titulo: "Videollamada disponible",
      contenido: "Tu medico ya inició la sala de consulta virtual.",
      data: { citaId, pacienteId: cita.pacienteid, medicoId: cita.medicoid },
    });

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        videoSala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
              joinUrl: normalizeText(sala.token_o_url),
            }
          : null,
      },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: normalizeText(sala.proveedor),
            roomName: normalizeText(sala.room_name),
            joinUrl: normalizeText(sala.token_o_url),
            estado: normalizeText(sala.estado),
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
          }
        : null,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/me/citas/:id/video-sala/abrir:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo abrir la videollamada.",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/me/citas/:citaId/video-sala/finalizar", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const completarCita = Boolean(req.body?.completarCita);

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo medicos pueden finalizar la sala.",
      });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    await ensureVideoSala(client, { citaId, provider: "jitsi" });
    const updateSala = await client.query(
      `UPDATE video_salas
       SET estado = 'finalizada',
           closed_at = NOW()
       WHERE citaid::text = $1::text
       RETURNING
         videosalaid::text AS videosalaid,
         proveedor,
         room_name,
         token_o_url,
         estado,
         opened_at,
         closed_at`,
      [citaId]
    );
    const sala = updateSala.rows[0] || null;

    if (completarCita) {
      const estadoMap = await ensureEstadoCatalog(client);
      if (estadoMap.completada) {
        await client.query(
          `UPDATE cita
           SET estadocitaid = $1,
               estado_codigo = 'completada',
               updated_at = NOW()
           WHERE citaid::text = $2::text`,
          [estadoMap.completada, citaId]
        );

        await appendCitaHistorial(client, {
          citaId,
          accion: "completada",
          usuarioTipo: "medico",
          usuarioId: context.user.usuarioid,
          motivo: "Consulta virtual finalizada.",
          datos: { salaFinalizada: true },
        });
      }
    }

    const conversacionId = await ensureConversation(client, {
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
    });
    const systemText = "La videollamada fue finalizada.";
    await appendSystemMessage(client, { conversacionId, text: systemText });

    await createNotification(client, {
      usuarioid: Number(cita.pacienteid),
      tipo: "cita_actualizada",
      titulo: "Videollamada finalizada",
      contenido: completarCita
        ? "La consulta virtual terminó y la cita fue marcada como completada."
        : "La videollamada finalizó.",
      data: {
        citaId,
        pacienteId: cita.pacienteid,
        medicoId: cita.medicoid,
        completarCita,
      },
    });

    const updatedCita = await fetchCitaByIdForContext(client, { citaId, context });
    const citaPayload = buildCitaResponse(updatedCita);

    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "cita_actualizada",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        cita: citaPayload,
        videoSala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
              joinUrl: normalizeText(sala.token_o_url),
            }
          : null,
      },
    });
    emitConversationEvent({
      eventName: "mensaje_nuevo",
      conversacionId,
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: {
        system: true,
        contenido: systemText,
      },
    });

    return res.json({
      success: true,
      cita: citaPayload,
      videoSala: sala
        ? {
            videoSalaId: normalizeText(sala.videosalaid),
            proveedor: normalizeText(sala.proveedor),
            roomName: normalizeText(sala.room_name),
            joinUrl: normalizeText(sala.token_o_url),
            estado: normalizeText(sala.estado),
            openedAt: sala.opened_at || null,
            closedAt: sala.closed_at || null,
          }
        : null,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error POST /agenda/me/citas/:id/video-sala/finalizar:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo finalizar la videollamada.",
    });
  } finally {
    if (client) client.release();
  }
});

router.get("/me/notificaciones", requireAuth, async (req, res) => {
  const limit = clampInt(req.query?.limit, 1, 200, 80);
  const unreadOnly = String(req.query?.soloNoLeidas || req.query?.unreadOnly || "")
    .trim()
    .toLowerCase();
  const onlyUnread = unreadOnly === "1" || unreadOnly === "true";

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const result = await client.query(
      `SELECT
         n.notificacionid::text AS notificacionid,
         n.tipo,
         n.titulo,
         n.contenido,
         n.data_json,
         n.leida,
         n.created_at,
         n.read_at
       FROM notificaciones n
       WHERE n.usuarioid = $1
         AND ($2::boolean = FALSE OR n.leida = FALSE)
       ORDER BY n.created_at DESC
       LIMIT $3`,
      [Number(context.user.usuarioid), onlyUnread, limit]
    );

    return res.json({
      success: true,
      notificaciones: result.rows.map((row) => ({
        id: normalizeText(row.notificacionid),
        tipo: normalizeText(row.tipo) || "general",
        titulo: normalizeText(row.titulo),
        contenido: normalizeText(row.contenido),
        data: row.data_json || {},
        leida: Boolean(row.leida),
        createdAt: row.created_at || null,
        readAt: row.read_at || null,
      })),
    });
  } catch (err) {
    console.error("Error GET /agenda/me/notificaciones:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron listar notificaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/notificaciones/:id/leida", requireAuth, async (req, res) => {
  const notificationId = parsePositiveInt(req.params?.id, null);
  if (!notificationId) {
    return res.status(400).json({ success: false, message: "id invalido." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const updated = await client.query(
      `UPDATE notificaciones
       SET leida = TRUE,
           read_at = COALESCE(read_at, NOW())
       WHERE notificacionid = $1
         AND usuarioid = $2
       RETURNING notificacionid::text AS notificacionid, leida, read_at`,
      [notificationId, Number(context.user.usuarioid)]
    );
    if (!updated.rows.length) {
      return res.status(404).json({ success: false, message: "Notificacion no encontrada." });
    }
    return res.json({
      success: true,
      notificacion: {
        id: normalizeText(updated.rows[0].notificacionid),
        leida: Boolean(updated.rows[0].leida),
        readAt: updated.rows[0].read_at || null,
      },
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/notificaciones/:id/leida:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la notificacion.",
    });
  } finally {
    if (client) client.release();
  }
});

router.patch("/me/notificaciones/leer-todas", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const updated = await client.query(
      `UPDATE notificaciones
       SET leida = TRUE,
           read_at = COALESCE(read_at, NOW())
       WHERE usuarioid = $1
         AND leida = FALSE`,
      [Number(context.user.usuarioid)]
    );

    return res.json({
      success: true,
      marcadas: Number(updated.rowCount || 0),
    });
  } catch (err) {
    console.error("Error PATCH /agenda/me/notificaciones/leer-todas:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudieron marcar las notificaciones.",
    });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
