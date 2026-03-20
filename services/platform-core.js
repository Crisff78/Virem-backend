const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { getUserProfileById } = require("./user-profile.store");
const { emitToUser } = require("../realtime/socket");

const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;
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

let ensurePlatformSchemaPromise = null;
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

async function ensurePlatformSchema() {
  if (ensurePlatformSchemaPromise) return ensurePlatformSchemaPromise;

  ensurePlatformSchemaPromise = (async () => {
    await pool.query(
      `ALTER TABLE especialidad
       ADD COLUMN IF NOT EXISTS permite_presencial BOOLEAN NOT NULL DEFAULT TRUE`
    );
    await pool.query(
      `ALTER TABLE especialidad
       ADD COLUMN IF NOT EXISTS permite_virtual BOOLEAN NOT NULL DEFAULT TRUE`
    );

    await pool.query(
      `ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS especialidadid INTEGER`
    );
    await pool.query(
      `ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS modalidad VARCHAR(16) NOT NULL DEFAULT 'ambas'`
    );
    await pool.query(
      `ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS slot_minutos INTEGER NOT NULL DEFAULT 30`
    );
    await pool.query(
      `ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await pool.query(
      `ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    );

    await pool.query(
      `ALTER TABLE estado_cita
       ADD COLUMN IF NOT EXISTS codigo VARCHAR(40)`
    );

    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS modalidad VARCHAR(16) NOT NULL DEFAULT 'presencial'`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS motivo_consulta TEXT`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS cancelada_por VARCHAR(16)`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS cancelacion_motivo TEXT`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS reprogramada_desde_citaid UUID`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS disponibilidadid INTEGER`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS estado_codigo VARCHAR(40) NOT NULL DEFAULT 'pendiente'`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    );
    await pool.query(
      `ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS videosalaid UUID`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS medico_especialidad (
        id BIGSERIAL PRIMARY KEY,
        medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
        especialidadid INTEGER NOT NULL REFERENCES especialidad(especialidadid) ON DELETE RESTRICT,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (medicoid, especialidadid)
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS cita_historial (
        id BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
        accion VARCHAR(32) NOT NULL,
        usuario_tipo VARCHAR(16) NOT NULL,
        usuario_id TEXT,
        motivo TEXT,
        datos_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        fecha_evento TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS conversaciones (
        conversacionid UUID PRIMARY KEY,
        citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
        pacienteid INTEGER NOT NULL REFERENCES paciente(pacienteid) ON DELETE CASCADE,
        medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
        estado VARCHAR(16) NOT NULL DEFAULT 'activa',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (citaid)
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS mensajes (
        mensajeid UUID PRIMARY KEY,
        conversacionid UUID NOT NULL REFERENCES conversaciones(conversacionid) ON DELETE CASCADE,
        emisor_tipo VARCHAR(16) NOT NULL,
        emisor_id TEXT NOT NULL,
        contenido TEXT NOT NULL,
        tipo VARCHAR(16) NOT NULL DEFAULT 'texto',
        leido BOOLEAN NOT NULL DEFAULT FALSE,
        leido_at TIMESTAMPTZ,
        meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS video_salas (
        videosalaid UUID PRIMARY KEY,
        citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
        proveedor VARCHAR(20) NOT NULL DEFAULT 'jitsi',
        room_name VARCHAR(120) NOT NULL,
        token_o_url TEXT,
        estado VARCHAR(16) NOT NULL DEFAULT 'pendiente',
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (citaid)
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS notificaciones (
        notificacionid BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        tipo VARCHAR(40) NOT NULL,
        titulo VARCHAR(180) NOT NULL,
        contenido TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        leida BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at TIMESTAMPTZ
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_horario_disponible_busqueda
       ON horario_disponible (medicoid, especialidadid, fechainicio, fechafin, activo, bloqueado)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_horario_disponible_modalidad
       ON horario_disponible (modalidad, activo, bloqueado)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_estado_codigo
       ON cita (estado_codigo)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_fecha_inicio
       ON cita (fechahorainicio)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_medico_estado_fecha
       ON cita (medicoid, estado_codigo, fechahorainicio)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_paciente_estado_fecha
       ON cita (pacienteid, estado_codigo, fechahorainicio)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_disponibilidadid
       ON cita (disponibilidadid)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_cita_historial_cita_fecha
       ON cita_historial (citaid, fecha_evento DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conversaciones_paciente
       ON conversaciones (pacienteid, updated_at DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conversaciones_medico
       ON conversaciones (medicoid, updated_at DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_fecha
       ON mensajes (conversacionid, created_at DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_leido
       ON mensajes (conversacionid, leido, created_at DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_video_salas_estado
       ON video_salas (estado, created_at DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_leida_fecha
       ON notificaciones (usuarioid, leida, created_at DESC)`
    );

    await pool.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'uq_cita_medico_inicio_activa'
         ) THEN
           IF NOT EXISTS (
             SELECT 1
             FROM (
               SELECT medicoid, fechahorainicio
               FROM cita
               WHERE lower(coalesce(estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')
               GROUP BY medicoid, fechahorainicio
               HAVING COUNT(*) > 1
             ) d
           ) THEN
             CREATE UNIQUE INDEX uq_cita_medico_inicio_activa
             ON cita (medicoid, fechahorainicio)
             WHERE lower(estado_codigo) IN ('pendiente', 'confirmada', 'reprogramada');
           END IF;
         END IF;
       END $$`
    );
  })().catch((err) => {
    ensurePlatformSchemaPromise = null;
    throw err;
  });

  return ensurePlatformSchemaPromise;
}

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
    `SELECT usuarioid, rolid, email, activo, fechacreacion
     FROM usuario
     WHERE usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  return result.rows[0] || null;
}

async function getPacienteByUsuarioId(client, usuarioid, userCreatedAt) {
  const direct = await client.query(
    `SELECT
       p.pacienteid::text AS pacienteid,
       p.nombres,
       p.apellidos
     FROM paciente p
     WHERE p.pacienteid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  if (direct.rows.length) return direct.rows[0];

  if (!userCreatedAt) return null;

  const byNearest = await client.query(
    `SELECT
       p.pacienteid::text AS pacienteid,
       p.nombres,
       p.apellidos,
       ABS(EXTRACT(EPOCH FROM ((p.fecharegistro::timestamp) - ($1::timestamp)))) AS diff_seconds
     FROM paciente p
     ORDER BY diff_seconds ASC
     LIMIT 1`,
    [userCreatedAt]
  );
  if (!byNearest.rows.length) return null;
  const diffSeconds = Number(byNearest.rows[0].diff_seconds || 0);
  if (!Number.isFinite(diffSeconds) || diffSeconds > 86400) return null;
  return byNearest.rows[0];
}

async function getMedicoByUsuarioId(client, usuarioid, userCreatedAt) {
  const profile = await getUserProfileById(client, usuarioid);
  const meta = profile?.meta && typeof profile.meta === "object" ? profile.meta : {};
  const knownMedicoId = normalizeText(meta.medicoid || meta.medicoId);

  if (knownMedicoId) {
    const byKnown = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, 'Medicina General') AS especialidad,
         m.especialidadid
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [knownMedicoId]
    );
    if (byKnown.rows.length) return byKnown.rows[0];
  }

  const byDirect = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       COALESCE(e.nombre, 'Medicina General') AS especialidad,
       m.especialidadid
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     WHERE m.medicoid::text = $1::text
     LIMIT 1`,
    [String(usuarioid)]
  );
  if (byDirect.rows.length) return byDirect.rows[0];

  if (!userCreatedAt) return null;
  const byNearest = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       COALESCE(e.nombre, 'Medicina General') AS especialidad,
       m.especialidadid,
       ABS(EXTRACT(EPOCH FROM (m.fecharegistro - $1::timestamptz))) AS diff_seconds
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     ORDER BY diff_seconds ASC
     LIMIT 1`,
    [userCreatedAt]
  );
  if (!byNearest.rows.length) return null;
  const diffSeconds = Number(byNearest.rows[0].diff_seconds || 0);
  if (!Number.isFinite(diffSeconds) || diffSeconds > 86400) return null;
  return byNearest.rows[0];
}

async function resolveUserContext(client, reqUser) {
  const user = await getUserById(client, reqUser?.usuarioid);
  if (!user) {
    return { error: { status: 404, message: "Usuario no encontrado." } };
  }
  if (!Boolean(user.activo)) {
    return { error: { status: 403, message: "Usuario inactivo." } };
  }

  const roleId = Number(user.rolid || 0);

  if (roleId === PACIENTE_ROLE_ID) {
    const paciente = await getPacienteByUsuarioId(client, user.usuarioid, user.fechacreacion);
    if (!paciente) {
      return { error: { status: 404, message: "Perfil de paciente no encontrado." } };
    }
    return { user, roleId, paciente, medico: null };
  }

  if (roleId === MEDICO_ROLE_ID) {
    const medico = await getMedicoByUsuarioId(client, user.usuarioid, user.fechacreacion);
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
       WHERE lower(nombre) = lower($1)
          OR lower(nombre) LIKE lower($2)
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
  { medicoId, startIso, endIso, excludeCitaId = "" }
) {
  const result = await client.query(
    `SELECT c.citaid::text AS citaid
     FROM cita c
     WHERE c.medicoid::text = $1::text
       AND c.fechahorainicio < $3::timestamptz
       AND c.fechahorafin > $2::timestamptz
       AND lower(coalesce(c.estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')
       AND ($4::text = '' OR c.citaid::text <> $4::text)
     LIMIT 1
     FOR UPDATE`,
    [String(medicoId), startIso, endIso, String(excludeCitaId || "")]
  );
  return Boolean(result.rows.length);
}

async function resolveMedicoUserIds(client, medicoId) {
  const cleanMedicoId = normalizeText(medicoId);
  if (!cleanMedicoId) return [];

  const result = await client.query(
    `SELECT DISTINCT up.usuarioid::text AS usuarioid
     FROM usuario_perfil up
     WHERE COALESCE(up.meta_json->>'medicoid', up.meta_json->>'medicoId', '') = $1::text`,
    [cleanMedicoId]
  );

  const numericIds = result.rows
    .map((row) => Number.parseInt(String(row.usuarioid || ""), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return [...new Set(numericIds)];
}

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
  emitToUser(userId, "notificacion_nueva", payload);
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
  const existing = await client.query(
    `SELECT conversacionid::text AS conversacionid
     FROM conversaciones
     WHERE citaid = $1::uuid
     LIMIT 1`,
    [String(citaId)]
  );
  if (existing.rows.length) return String(existing.rows[0].conversacionid);

  const newId = randomUUID();
  await client.query(
    `INSERT INTO conversaciones (
       conversacionid,
       citaid,
       pacienteid,
       medicoid,
       estado,
       created_at,
       updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'activa', NOW(), NOW())`,
    [newId, String(citaId), Number(pacienteId), String(medicoId)]
  );
  return newId;
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
  const roomName = `virem-${String(citaId).slice(0, 8)}-${Date.now().toString(36)}`;
  const jitsiBase = normalizeText(process.env.JITSI_BASE_URL) || "https://meet.jit.si";
  const joinUrl = `${jitsiBase.replace(/\/+$/, "")}/${roomName}`;

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
      ) AS paciente_nombre
    FROM cita c
    LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
    LEFT JOIN medico m ON m.medicoid = c.medicoid
    LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
    LEFT JOIN paciente p ON p.pacienteid = c.pacienteid
    WHERE ${conditions.join(" AND ")}
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}`;

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

  const start = new Date(`${cleanDate}T${cleanStart}:00`);
  const end = new Date(`${cleanDate}T${cleanEnd}:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { start: null, end: null };
  return { start, end };
}

function buildSlots(availabilityRows, bookedRows, { modalidadFilter, fechaFilter }) {
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
        const candidateDate = pointer.toISOString().slice(0, 10);
        if (!hasFechaFilter || candidateDate === fechaFilter) {
          const overlaps = bookedForMedico.some((b) =>
            slotOverlaps(pointer, next, b.start, b.end)
          );
          if (!overlaps) {
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
  if (normalizeComparableText(roomEstado) === "finalizada") return false;

  const now = Date.now();
  const startMs = start.getTime();
  const preJoinWindowMs = 15 * 60 * 1000;
  const postWindowMs = 6 * 60 * 60 * 1000;

  if (roleId === MEDICO_ROLE_ID) return now <= startMs + postWindowMs;
  return now >= startMs - preJoinWindowMs && now <= startMs + postWindowMs;
}

module.exports = {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
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
