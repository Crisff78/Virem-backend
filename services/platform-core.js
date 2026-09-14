const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { emitToUser, disconnectUserSockets } = require("../realtime/socket");
const { resolveLoginAccessState } = require("./rf-core");
const { getUserProfileById } = require("./user-profile.store");

const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;
const MAX_AVAILABILITY_DAYS = 90;

function isValidDaysCount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_AVAILABILITY_DAYS;
}
const ACTIVE_CITA_CODES = ["pendiente", "confirmada", "reprogramada"];

const CITA_STATUS_DEFS = {
  pendiente: {
    nombre: "Pendiente",
    descripcion: "Cita creada y pendiente de confirmacion.",
  },
  confirmada: {
    nombre: "Confirmada",
    descripcion: "Cita confirmada por el medico.",
  },
  cancelada_por_paciente: {
    nombre: "Cancelada por paciente",
    descripcion: "Cita cancelada por el paciente.",
  },
  cancelada_por_medico: {
    nombre: "Cancelada por medico",
    descripcion: "Cita cancelada por el medico.",
  },
  reprogramada: {
    nombre: "Reprogramada",
    descripcion: "Cita reprogramada.",
  },
  completada: {
    nombre: "Completada",
    descripcion: "Cita completada satisfactoriamente.",
  },
  no_asistio: {
    nombre: "No asistio",
    descripcion: "El paciente no asistio a la consulta.",
  },
};

let estadoCatalogCache = null;

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = parsePositiveInt(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isValidIsoDate(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(raw || "").trim());
}

function normalizeModalidad(value, fallback = "presencial") {
  const mode = normalizeComparableText(value);
  if (mode === "virtual" || mode === "presencial" || mode === "ambas") return mode;
  return fallback;
}

function normalizeEstadoCode(value, fallback = "pendiente") {
  const code = normalizeComparableText(value).replace(/\s+/g, "_");
  if (CITA_STATUS_DEFS[code]) return code;
  return fallback;
}

function parseDateInput(rawValue) {
  const raw = normalizeText(rawValue);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatDateLabel(value) {
  const date = value instanceof Date ? value : parseDateInput(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-DO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function slotOverlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function isClosedStatusCode(code) {
  return [
    "cancelada_por_paciente",
    "cancelada_por_medico",
    "completada",
    "no_asistio",
  ].includes(normalizeEstadoCode(code, ""));
}

function isActiveStatusCode(code) {
  return ACTIVE_CITA_CODES.includes(normalizeEstadoCode(code, ""));
}

// Compatibility export: schema changes run only through scripts/migrations.js.
async function ensurePlatformSchema() {}

async function ensureEstadoCatalog(client) {
  if (estadoCatalogCache) return estadoCatalogCache;

  const map = {};
  for (const [code, def] of Object.entries(CITA_STATUS_DEFS)) {
    const existing = await client.query(
      `SELECT estadocitaid, codigo
       FROM estado_cita
       WHERE lower(coalesce(codigo, '')) = $1
          OR lower(nombre) = lower($2)
       ORDER BY estadocitaid ASC
       LIMIT 1`,
      [code, def.nombre]
    );

    if (existing.rows.length) {
      const estadoId = Number(existing.rows[0].estadocitaid);
      map[code] = estadoId;
      if (!existing.rows[0].codigo) {
        await client.query(
          `UPDATE estado_cita
           SET codigo = $1
           WHERE estadocitaid = $2`,
          [code, estadoId]
        );
      }
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO estado_cita (nombre, descripcion, codigo)
       VALUES ($1, $2, $3)
       RETURNING estadocitaid`,
      [def.nombre, def.descripcion, code]
    );
    map[code] = Number(inserted.rows[0].estadocitaid);
  }

  estadoCatalogCache = map;
  return map;
}

async function getUserById(client, usuarioid) {
  const result = await client.query(
    `SELECT usuarioid, rolid, email, activo, fechacreacion, account_status, email_verificado
     FROM usuario
     WHERE usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  return result.rows[0] || null;
}

async function getPacienteByUsuarioId(client, usuarioid) {
  const result = await client.query(
    `SELECT
       p.pacienteid::text AS pacienteid,
       p.nombres,
       p.apellidos
     FROM paciente p
     WHERE p.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  return result.rows[0] || null;
}

async function getFallbackMedicoByUserProfile(client, usuarioid) {
  const userProfile = await getUserProfileById(client, usuarioid);
  const meta =
    userProfile?.meta && typeof userProfile.meta === "object" && !Array.isArray(userProfile.meta)
      ? userProfile.meta
      : {};

  const medicoId = String(meta.medicoid || meta.medicoId || "").trim();
  if (!medicoId) return null;

  const especialidadId = Number.parseInt(
    String(meta.especialidadid || meta.especialidadId || ""),
    10
  );
  const nombreCompleto = String(meta.nombreCompleto || meta.nombre || "").trim();
  const especialidad = String(meta.especialidad || "").trim();

  return {
    medicoid: medicoId,
    nombrecompleto: nombreCompleto || null,
    especialidad: especialidad || "Medicina General",
    especialidadid:
      Number.isFinite(especialidadId) && especialidadId > 0 ? especialidadId : null,
    recoveredFromProfileMeta: true,
  };
}

async function getMedicoByUsuarioId(client, usuarioid) {
  const result = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       COALESCE(e.nombre, 'Medicina General') AS especialidad,
       m.especialidadid
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     WHERE m.usuarioid = $1
      LIMIT 1`,
    [Number(usuarioid)]
  );
  if (result.rows.length) {
    return result.rows[0];
  }
  return getFallbackMedicoByUserProfile(client, usuarioid);
}

async function resolveUserContext(client, reqUser) {
  const user = await getUserById(client, reqUser?.usuarioid);
  if (!user) {
    disconnectUserSockets(reqUser?.usuarioid);
    return { error: { status: 404, message: "Usuario no encontrado." } };
  }
  const access = resolveLoginAccessState(user);
  if (!access.ok) {
    disconnectUserSockets(user.usuarioid);
    return { error: { status: 403, message: access.message } };
  }
  if (reqUser?.rolid !== undefined && Number(reqUser.rolid) !== Number(user.rolid)) {
    return { error: { status: 403, message: "Tus permisos cambiaron. Inicia sesion nuevamente." } };
  }

  const roleId = Number(user.rolid || 0);

  if (roleId === PACIENTE_ROLE_ID) {
    const paciente = await getPacienteByUsuarioId(client, user.usuarioid);
    if (!paciente) {
      return { error: { status: 404, message: "Perfil de paciente no encontrado." } };
    }
    return { user, roleId, paciente, medico: null };
  }

  if (roleId === MEDICO_ROLE_ID) {
    const medico = await getMedicoByUsuarioId(client, user.usuarioid);
    if (!medico) {
      return { error: { status: 404, message: "Perfil de medico no encontrado." } };
    }
    return { user, roleId, paciente: null, medico };
  }

  return { user, roleId, paciente: null, medico: null };
}

async function resolveTipoConsultaId(client, modalidad) {
  const mode = normalizeModalidad(modalidad, "presencial");
  if (mode === "virtual") {
    const virtualResult = await client.query(
      `SELECT tipoconsultaid
       FROM tipos_consulta
       WHERE lower(nombre) LIKE '%video%'
       ORDER BY tipoconsultaid ASC
       LIMIT 1`
    );
    if (virtualResult.rows.length) return Number(virtualResult.rows[0].tipoconsultaid);
  }

  if (mode === "presencial") {
    const presencialResult = await client.query(
      `SELECT tipoconsultaid
       FROM tipos_consulta
       WHERE lower(nombre) LIKE '%presencial%'
       ORDER BY tipoconsultaid ASC
       LIMIT 1`
    );
    if (presencialResult.rows.length) return Number(presencialResult.rows[0].tipoconsultaid);
  }

  const fallback = await client.query(
    `SELECT tipoconsultaid
     FROM tipos_consulta
     ORDER BY tipoconsultaid ASC
     LIMIT 1`
  );
  if (!fallback.rows.length) return null;
  return Number(fallback.rows[0].tipoconsultaid);
}

async function resolveZonaHorariaId(client) {
  const byUtc = await client.query(
    `SELECT zonahorariaid
     FROM zonas_horarias
     WHERE lower(nombre) = 'utc'
     ORDER BY zonahorariaid ASC
     LIMIT 1`
  );
  if (byUtc.rows.length) return Number(byUtc.rows[0].zonahorariaid);

  const fallback = await client.query(
    `SELECT zonahorariaid
     FROM zonas_horarias
     ORDER BY zonahorariaid ASC
     LIMIT 1`
  );
  if (!fallback.rows.length) return null;
  return Number(fallback.rows[0].zonahorariaid);
}

async function resolveEspecialidad(client, { especialidadId, especialidad, medicoId }) {
  const byId = parsePositiveInt(especialidadId, null);
  if (byId) {
    const result = await client.query(
      `SELECT especialidadid, nombre, permite_presencial, permite_virtual
       FROM especialidad
       WHERE especialidadid = $1
       LIMIT 1`,
      [byId]
    );
    if (result.rows.length) return result.rows[0];
  }

  const byName = normalizeText(especialidad);
  if (byName) {
    const result = await client.query(
      `SELECT especialidadid, nombre, permite_presencial, permite_virtual
       FROM especialidad
       WHERE lower(f_unaccent(nombre)) = lower(f_unaccent($1))
          OR lower(f_unaccent(nombre)) LIKE lower(f_unaccent($2))
       ORDER BY especialidadid ASC
       LIMIT 1`,
      [byName, `%${byName}%`]
    );
    if (result.rows.length) return result.rows[0];
  }

  const cleanMedicoId = normalizeText(medicoId);
  if (cleanMedicoId) {
    const result = await client.query(
      `SELECT e.especialidadid, e.nombre, e.permite_presencial, e.permite_virtual
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [cleanMedicoId]
    );
    if (result.rows.length) return result.rows[0];
  }

  return null;
}

function validateModalidadForEspecialidad(especialidadRow, modalidad) {
  const mode = normalizeModalidad(modalidad, "presencial");
  if (!especialidadRow) return { ok: true, modalidad: mode };

  const allowsPresencial = Boolean(especialidadRow.permite_presencial);
  const allowsVirtual = Boolean(especialidadRow.permite_virtual);

  if (mode === "presencial" && !allowsPresencial) {
    return { ok: false, reason: "La especialidad seleccionada no permite consulta presencial." };
  }
  if (mode === "virtual" && !allowsVirtual) {
    return { ok: false, reason: "La especialidad seleccionada no permite consulta virtual." };
  }
  return { ok: true, modalidad: mode };
}

async function hasCitaConflict(
  client,
  { medicoId, pacienteId, startIso, endIso, excludeCitaId = "" }
) {
  // All reservation writers must call this in a READ COMMITTED transaction.
  // A transaction-scoped lock exists even when no appointment row exists yet.
  // Stable ordering also protects one patient booking different doctors at once.
  const keys = [];
  if (medicoId) keys.push(`virem:booking:medico:${String(medicoId).trim().toLowerCase()}`);
  if (pacienteId) keys.push(`virem:booking:paciente:${Number(pacienteId)}`);
  for (const key of keys.sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) LIMIT 1', [key]);
  }
  const params = [startIso, endIso, String(excludeCitaId || "")];
  const conditions = [
    "c.fechahorainicio < $2::timestamptz",
    "c.fechahorafin > $1::timestamptz",
    "lower(coalesce(c.estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')",
    "($3::text = '' OR c.citaid::text <> $3::text)"
  ];

  if (medicoId && pacienteId) {
    params.push(String(medicoId), Number(pacienteId));
    conditions.push(`(c.medicoid::text = $4::text OR c.pacienteid = $5)`);
  } else if (medicoId) {
    params.push(String(medicoId));
    conditions.push(`c.medicoid::text = $4::text`);
  } else if (pacienteId) {
    params.push(Number(pacienteId));
    conditions.push(`c.pacienteid = $4`);
  } else {
    return false;
  }

  const result = await client.query(
    `SELECT c.citaid::text AS citaid
     FROM cita c
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    params
  );
  return Boolean(result.rows.length);
}

async function resolveMedicoUserIds(client, medicoId) {
  const cleanMedicoId = normalizeText(medicoId);
  if (!cleanMedicoId) return [];

  const result = await client.query(
    `SELECT DISTINCT m.usuarioid::text AS usuarioid
     FROM medico m
     WHERE m.medicoid::text = $1::text
       AND m.usuarioid IS NOT NULL
     LIMIT 1`,
    [cleanMedicoId]
  );

  const numericIds = result.rows
    .map((row) => Number.parseInt(String(row.usuarioid || ""), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return [...new Set(numericIds)];
}

const axios = require("axios");

async function createNotification(
  client,
  { usuarioid, tipo, titulo, contenido = "", data = {} }
) {
  const userId = Number.parseInt(String(usuarioid || ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) return null;

  const result = await client.query(
    `INSERT INTO notificaciones (
       usuarioid,
       tipo,
       titulo,
       contenido,
       data_json,
       leida,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, FALSE, NOW())
     RETURNING notificacionid::text AS notificacionid, created_at`,
    [
      userId,
      normalizeText(tipo) || "general",
      normalizeText(titulo) || "Notificacion",
      normalizeText(contenido),
      JSON.stringify(data || {}),
    ]
  );

  const row = result.rows[0] || null;
  if (!row) return null;

  const payload = {
    id: String(row.notificacionid || ""),
    tipo: normalizeText(tipo) || "general",
    titulo: normalizeText(titulo) || "Notificacion",
    contenido: normalizeText(contenido),
    data: data || {},
    createdAt: row.created_at || null,
    leida: false,
  };

  // 1. Emit to Socket for Real-time UI
  emitToUser(userId, "notificacion_nueva", payload);

  // 2. Call Webhook for External Automation (Make/n8n)
  if (process.env.MAKE_WEBHOOK_URL) {
    // Try to get user contact info for the webhook
    try {
      const userResult = await client.query(
        "SELECT email FROM usuario WHERE usuarioid = $1 LIMIT 1",
        [userId]
      );
      const userContact = userResult.rows[0] || {};
      
      const targetEmail = String(userContact.email || "").trim();
      if (targetEmail) {
        axios.post(process.env.MAKE_WEBHOOK_URL, {
          event: "notification",
          userId,
          email: targetEmail,
          to: targetEmail, // Alias for easier mapping
          pacienteEmail: targetEmail, // Added for compatibility with Make.com invoice scenarios
          telefono: userContact.telefono,
          ...payload
        }).catch(e => {
          const errorMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          console.warn(`[Webhook] Global webhook failed for user ${userId}:`, errorMsg);
        });
      } else {
        console.warn(`[Webhook] Skipping notification webhook for user ${userId}: email is missing.`);
      }
    } catch (err) {
      console.warn("[Webhook] Failed to fetch user contact for webhook:", err.message);
    }
  }

  return payload;
}

async function appendCitaHistorial(
  client,
  { citaId, accion, usuarioTipo, usuarioId, motivo = "", datos = {} }
) {
  await client.query(
    `INSERT INTO cita_historial (
       citaid,
       accion,
       usuario_tipo,
       usuario_id,
       motivo,
       datos_json,
       fecha_evento
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [
      String(citaId),
      normalizeComparableText(accion),
      normalizeComparableText(usuarioTipo),
      normalizeText(usuarioId),
      normalizeText(motivo),
      JSON.stringify(datos || {}),
    ]
  );
}

async function ensureConversation(client, { citaId, pacienteId, medicoId }) {
  const cleanPacienteId = Number.parseInt(String(pacienteId || ""), 10);
  const cleanMedicoId = String(medicoId || "").trim();
  const cleanCitaId = String(citaId || "").trim();

  if (!Number.isFinite(cleanPacienteId) || cleanPacienteId <= 0 || !cleanMedicoId) {
    throw new Error("ensureConversation: pacienteId y medicoId son obligatorios.");
  }

  const existing = await client.query(
    `SELECT conversacionid::text AS conversacionid
     FROM conversaciones
     WHERE pacienteid = $1
       AND medicoid::text = $2::text
     LIMIT 1`,
    [cleanPacienteId, cleanMedicoId]
  );
  if (existing.rows.length) {
    if (cleanCitaId) {
      await client.query(
        `UPDATE conversaciones
            SET citaid_origen = COALESCE(citaid_origen, $1::uuid)
          WHERE conversacionid::text = $2::text`,
        [cleanCitaId, existing.rows[0].conversacionid]
      );
    }
    return String(existing.rows[0].conversacionid);
  }

  const newId = randomUUID();
  await client.query(
    `INSERT INTO conversaciones (
       conversacionid,
       citaid_origen,
       pacienteid,
       medicoid,
       estado,
       created_at,
       updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'activa', NOW(), NOW())
     ON CONFLICT (pacienteid, medicoid) DO UPDATE
       SET updated_at = NOW(),
           citaid_origen = COALESCE(conversaciones.citaid_origen, EXCLUDED.citaid_origen)
     RETURNING conversacionid::text AS conversacionid`,
    [newId, cleanCitaId || null, cleanPacienteId, cleanMedicoId]
  );

  const recheck = await client.query(
    `SELECT conversacionid::text AS conversacionid
     FROM conversaciones
     WHERE pacienteid = $1
       AND medicoid::text = $2::text
     LIMIT 1`,
    [cleanPacienteId, cleanMedicoId]
  );
  return String(recheck.rows[0]?.conversacionid || newId);
}

async function appendSystemMessage(client, { conversacionId, text }) {
  await client.query(
    `INSERT INTO mensajes (
       mensajeid,
       conversacionid,
       emisor_tipo,
       emisor_id,
       contenido,
       tipo,
       leido,
       created_at
     )
     VALUES ($1::uuid, $2::uuid, 'sistema', 'sistema', $3, 'sistema', FALSE, NOW())`,
    [randomUUID(), String(conversacionId), normalizeText(text)]
  );
  await client.query(
    `UPDATE conversaciones
     SET updated_at = NOW()
     WHERE conversacionid = $1::uuid`,
    [String(conversacionId)]
  );
}

async function ensureVideoSala(client, { citaId, provider = "jitsi" }) {
  const existing = await client.query(
    `SELECT
       videosalaid::text AS videosalaid,
       citaid::text AS citaid,
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
    [String(citaId)]
  );
  if (existing.rows.length) return existing.rows[0];

  const videosalaid = randomUUID();
  // Room name based on citaId
  const roomName = `room_${String(citaId)}`;
  
  // For LiveKit, we don't store a static joinUrl, tokens are generated per-user.
  const joinUrl = ""; 

  const inserted = await client.query(
    `INSERT INTO video_salas (
       videosalaid,
       citaid,
       proveedor,
       room_name,
       token_o_url,
       estado,
       created_at
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pendiente', NOW())
     RETURNING
       videosalaid::text AS videosalaid,
       citaid::text AS citaid,
       proveedor,
       room_name,
       token_o_url,
       estado,
       opened_at,
       closed_at,
       created_at`,
    [videosalaid, String(citaId), provider, roomName, joinUrl]
  );

  await client.query(
    `UPDATE cita
     SET videosalaid = $1::uuid
     WHERE citaid = $2::uuid`,
    [videosalaid, String(citaId)]
  );

  return inserted.rows[0] || null;
}

async function fetchCitaByIdForContext(client, { citaId, context, lock = false }) {
  const conditions = [`c.citaid::text = $1::text`];
  const params = [String(citaId)];

  if (context.roleId === PACIENTE_ROLE_ID) {
    params.push(Number(context.paciente.pacienteid));
    conditions.push(`c.pacienteid = $${params.length}`);
  } else if (context.roleId === MEDICO_ROLE_ID) {
    params.push(String(context.medico.medicoid));
    conditions.push(`c.medicoid::text = $${params.length}::text`);
  }

  const sql = `SELECT
      c.citaid::text AS citaid,
      c.pacienteid::text AS pacienteid,
      p.usuarioid AS paciente_usuarioid,
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
      c.monto_total,
      c.monto_plataforma,
      c.monto_medico,
      c.comision_aplicada,
      c.updated_at,
      COALESCE(ec.nombre, 'Pendiente') AS estado_nombre,
      COALESCE(ec.codigo, c.estado_codigo, 'pendiente') AS estado_code,
      COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
      COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre,
      COALESCE(
        NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
        'Paciente'
      ) AS paciente_nombre
    FROM cita c
    LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
    LEFT JOIN medico m ON m.medicoid = c.medicoid
    LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
    LEFT JOIN paciente p ON p.pacienteid = c.pacienteid
    WHERE ${conditions.join(" AND ")}
    LIMIT 1
    ${lock ? "FOR UPDATE OF c" : ""}`;

  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

function buildCitaResponse(row) {
  if (!row) return null;
  return {
    citaid: String(row.citaid || ""),
    pacienteid: String(row.pacienteid || ""),
    medicoid: String(row.medicoid || ""),
    fechaHoraInicio: row.fechahorainicio || null,
    fechaHoraFin: row.fechahorafin || null,
    duracionMin: Number(row.duracionmin || 0),
    nota: normalizeText(row.nota),
    precio: row.precio ?? null,
    modalidad: normalizeModalidad(row.modalidad, "presencial"),
    motivoConsulta: normalizeText(row.motivo_consulta),
    estado: normalizeText(row.estado_nombre || "Pendiente"),
    estadoCodigo: normalizeEstadoCode(row.estado_code || row.estado_codigo || "pendiente"),
    canceladaPor: normalizeText(row.cancelada_por),
    cancelacionMotivo: normalizeText(row.cancelacion_motivo),
    disponibilidadId: normalizeText(row.disponibilidadid),
    videoSalaId: normalizeText(row.videosalaid),
    pagoCompletado: Boolean(row.pago_completado),
    pagoMetodo: normalizeText(row.pago_metodo),
    pagoReferencia: normalizeText(row.pago_referencia),
    pagoFecha: row.pago_fecha || null,
    montoTotal: Number(row.monto_total || 0),
    montoPlataforma: Number(row.monto_plataforma || 0),
    montoMedico: Number(row.monto_medico || 0),
    comisionAplicada: Number(row.comision_aplicada || 0),
    updatedAt: row.updated_at || null,
    medico: {
      medicoid: String(row.medicoid || ""),
      nombreCompleto: normalizeText(row.medico_nombre) || "Medico",
      especialidad: normalizeText(row.especialidad_nombre) || "Medicina General",
    },
    paciente: {
      pacienteid: String(row.pacienteid || ""),
      nombreCompleto: normalizeText(row.paciente_nombre) || "Paciente",
    },
  };
}

function parseDateRangeFromQuery(query) {
  const fromRaw = normalizeText(query?.from || query?.desde);
  const toRaw = normalizeText(query?.to || query?.hasta);
  const now = new Date();

  const fromDate = parseDateInput(fromRaw) || now;
  const toDate =
    parseDateInput(toRaw) || new Date(fromDate.getTime() + 30 * 24 * 60 * 60 * 1000);

  return {
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
  };
}

function parseBlockDates({ fecha, horaInicio, horaFin, fechaInicio, fechaFin }) {
  const fullStart = parseDateInput(fechaInicio);
  const fullEnd = parseDateInput(fechaFin);
  if (fullStart && fullEnd) {
    return { start: fullStart, end: fullEnd };
  }

  const cleanDate = normalizeText(fecha);
  const cleanStart = normalizeText(horaInicio);
  const cleanEnd = normalizeText(horaFin);
  if (!isValidIsoDate(cleanDate) || !/^\d{2}:\d{2}$/.test(cleanStart) || !/^\d{2}:\d{2}$/.test(cleanEnd)) {
    return { start: null, end: null };
  }

  // NOTE: For es-DO project, we assume America/Santo_Domingo (UTC-4)
  // This ensures that when a doctor types 08:00, it's stored and retrieved as 08:00 local.
  const start = new Date(`${cleanDate}T${cleanStart}:00-04:00`);
  const end = new Date(`${cleanDate}T${cleanEnd}:00-04:00`);
  
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { start: null, end: null };
  return { start, end };
}

function buildSlots(availabilityRows, bookedRows, { modalidadFilter, fechaFilter, patientBookedRows = [] }) {
  const slots = [];
  const nowMs = Date.now();
  const normalizedFilterModalidad = normalizeModalidad(modalidadFilter, "");
  const hasFechaFilter = isValidIsoDate(fechaFilter);

  const bookedByMedico = new Map();
  for (const row of bookedRows) {
    const key = String(row.medicoid || "");
    const list = bookedByMedico.get(key) || [];
    list.push({
      start: new Date(row.fechahorainicio),
      end: new Date(row.fechahorafin),
    });
    bookedByMedico.set(key, list);
  }

  const patientBusy = patientBookedRows.map(row => ({
    start: new Date(row.fechahorainicio),
    end: new Date(row.fechahorafin)
  }));

  for (const row of availabilityRows) {
    const rowStart = new Date(row.fechainicio);
    const rowEnd = new Date(row.fechafin);
    if (Number.isNaN(rowStart.getTime()) || Number.isNaN(rowEnd.getTime())) continue;
    if (rowEnd.getTime() <= nowMs) continue;

    const modalidad = normalizeModalidad(row.modalidad, "ambas");
    if (
      normalizedFilterModalidad &&
      normalizedFilterModalidad !== "ambas" &&
      modalidad !== "ambas" &&
      modalidad !== normalizedFilterModalidad
    ) {
      continue;
    }

    const slotMin = clampInt(row.slot_minutos, 15, 60, 30);
    const bookedForMedico = bookedByMedico.get(String(row.medicoid || "")) || [];
    let pointer = new Date(rowStart);

    while (pointer.getTime() + slotMin * 60 * 1000 <= rowEnd.getTime()) {
      const next = new Date(pointer.getTime() + slotMin * 60 * 1000);

      if (pointer.getTime() > nowMs) {
        // Calculate candidate date in -04:00 offset (Santo Domingo)
        const localPointer = new Date(pointer.getTime() - 4 * 60 * 60 * 1000);
        const candidateDate = localPointer.toISOString().slice(0, 10);
        
        if (!hasFechaFilter || candidateDate === fechaFilter) {
          const overlapsMedico = bookedForMedico.some((b) =>
            slotOverlaps(pointer, next, b.start, b.end)
          );
          
          const overlapsPatient = patientBusy.some(b => 
            slotOverlaps(pointer, next, b.start, b.end)
          );

          if (!overlapsMedico && !overlapsPatient) {
            slots.push({
              disponibilidadId: String(row.horariodisponibleid || ""),
              medicoId: String(row.medicoid || ""),
              medicoNombre: normalizeText(row.medico_nombre) || "Medico",
              especialidadId: String(row.especialidadid || ""),
              especialidad: normalizeText(row.especialidad_nombre) || "Medicina General",
              modalidad: modalidad === "ambas" ? normalizedFilterModalidad || "presencial" : modalidad,
              horaInicio: pointer.toISOString(),
              horaFin: next.toISOString(),
              slotMinutos: slotMin,
            });
          }
        }
      }

      pointer = next;
    }
  }

  slots.sort((a, b) => new Date(a.horaInicio).getTime() - new Date(b.horaInicio).getTime());
  return slots;
}

function canJoinVideoRoom({ citaStart, roomEstado, roleId }) {
  const start = parseDateInput(citaStart);
  if (!start) return false;
  const normalizedRoomEstado = normalizeComparableText(roomEstado);
  if (normalizedRoomEstado === "finalizada") return false;

  const now = Date.now();
  const startMs = start.getTime();
  
  // New: Patients can join up to 10 minutes before start
  const preJoinWindowMs = 10 * 60 * 1000; 
  const postWindowMs = 6 * 60 * 60 * 1000; // 6 hours window

  if (roleId === MEDICO_ROLE_ID) return now <= startMs + postWindowMs;
  if (roleId === PACIENTE_ROLE_ID) {
    // Also allow if room is already active regardless of time (handled by status check usually, but buffer helps)
    return (now >= startMs - preJoinWindowMs) && (now <= startMs + postWindowMs);
  }
  return now >= startMs - preJoinWindowMs && now <= startMs + postWindowMs;
}

module.exports = {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  MAX_AVAILABILITY_DAYS,
  isValidDaysCount,
  ACTIVE_CITA_CODES,
  CITA_STATUS_DEFS,
  normalizeText,
  normalizeComparableText,
  parsePositiveInt,
  clampInt,
  isValidIsoDate,
  normalizeModalidad,
  normalizeEstadoCode,
  parseDateInput,
  formatDateLabel,
  slotOverlaps,
  isClosedStatusCode,
  isActiveStatusCode,
  ensurePlatformSchema,
  ensureEstadoCatalog,
  getUserById,
  getPacienteByUsuarioId,
  getMedicoByUsuarioId,
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
};
