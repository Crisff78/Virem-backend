const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const pool = require('../config/db');
const {
  getUserProfileById,
  upsertUserProfileById,
  isSupportedImageUri,
  MAX_PHOTO_URL_LENGTH,
} = require('../services/user-profile.store');
const { requireAuth } = require('./middleware/auth');

const router = express.Router();
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-DO', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRelativeLastSeen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin historial';

  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffHours < 1) return 'Visto por ultima vez: Hace minutos';
  if (diffHours < 24) return `Visto por ultima vez: Hace ${diffHours} hora${diffHours === 1 ? '' : 's'}`;
  if (diffDays === 1) return 'Visto por ultima vez: Ayer';
  return `Visto por ultima vez: ${diffDays} dias`;
}

function buildPatientCode(seed) {
  const raw = String(seed || '').trim();
  if (!raw) return 'ID: #VM-0000';

  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) return `ID: #VM-${digits.slice(-4)}`;

  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) % 10000;
  }
  return `ID: #VM-${String(hash).padStart(4, '0')}`;
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = parsePositiveInt(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function getMedicoByUsuarioId(client, usuarioid, userCreatedAt) {
  const direct = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       m.fechanacimiento,
       m.genero,
       m.cedula,
       m.telefono,
       COALESCE(e.nombre, '') AS especialidad,
       m.fecharegistro
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     WHERE m.medicoid::text = $1::text
     LIMIT 1`,
    [String(usuarioid)]
  );

  if (direct.rows.length) return direct.rows[0];
  if (!userCreatedAt) return null;

  const byRank = await client.query(
    `WITH user_rank AS (
       SELECT
         u.usuarioid,
         u.fechacreacion,
         ROW_NUMBER() OVER (ORDER BY u.fechacreacion DESC, u.usuarioid DESC) AS rn
       FROM usuario u
       WHERE u.rolid = $2
     ),
     medico_rank AS (
       SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         m.fechanacimiento,
         m.genero,
         m.cedula,
         m.telefono,
         COALESCE(e.nombre, '') AS especialidad,
         m.fecharegistro,
         ROW_NUMBER() OVER (ORDER BY m.fecharegistro DESC, m.medicoid DESC) AS rn
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     )
     SELECT
       mr.*,
       ABS(EXTRACT(EPOCH FROM ((mr.fecharegistro::timestamp) - (ur.fechacreacion::timestamp)))) AS diff_seconds
     FROM user_rank ur
     JOIN medico_rank mr ON mr.rn = ur.rn
     WHERE ur.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid), MEDICO_ROLE_ID]
  );

  if (byRank.rows.length) {
    const row = byRank.rows[0];
    const diffSeconds = Number(row.diff_seconds || 0);
    if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
      return row;
    }
  }

  const byNearest = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       m.fechanacimiento,
       m.genero,
       m.cedula,
       m.telefono,
       COALESCE(e.nombre, '') AS especialidad,
       m.fecharegistro,
       ABS(EXTRACT(EPOCH FROM (m.fecharegistro - $1::timestamptz))) AS diff_seconds
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     ORDER BY diff_seconds ASC
     LIMIT 1`,
    [userCreatedAt]
  );

  if (byNearest.rows.length) {
    const row = byNearest.rows[0];
    const diffSeconds = Number(row.diff_seconds || 0);
    if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
      return row;
    }
  }

  return null;
}

async function getPacienteByUsuarioId(client, usuarioid, userCreatedAt) {
  const direct = await client.query(
    `SELECT
       p.pacienteid,
       p.nombres,
       p.apellidos,
       p.fechanacimiento,
       p.genero,
       p.cedula,
       p.telefono,
       p.fecharegistro
     FROM paciente p
     WHERE p.pacienteid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );

  if (direct.rows.length) return direct.rows[0];
  if (!userCreatedAt) return null;

  const byRank = await client.query(
    `WITH user_rank AS (
       SELECT
         u.usuarioid,
         u.fechacreacion,
         ROW_NUMBER() OVER (ORDER BY u.fechacreacion DESC, u.usuarioid DESC) AS rn
       FROM usuario u
       WHERE u.rolid = $2
     ),
     paciente_rank AS (
       SELECT
         p.pacienteid,
         p.nombres,
         p.apellidos,
         p.fechanacimiento,
         p.genero,
         p.cedula,
         p.telefono,
         p.fecharegistro,
         ROW_NUMBER() OVER (ORDER BY p.fecharegistro DESC, p.pacienteid DESC) AS rn
       FROM paciente p
     )
     SELECT
       pr.*,
       ABS(
         EXTRACT(
           EPOCH FROM ((pr.fecharegistro::timestamp) - (ur.fechacreacion::timestamp))
         )
       ) AS diff_seconds
     FROM user_rank ur
     JOIN paciente_rank pr ON pr.rn = ur.rn
     WHERE ur.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid), PACIENTE_ROLE_ID]
  );

  if (byRank.rows.length) {
    const row = byRank.rows[0];
    const diffSeconds = Number(row.diff_seconds || 0);
    if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
      return row;
    }
  }

  const byNearest = await client.query(
    `SELECT
       p.pacienteid,
       p.nombres,
       p.apellidos,
       p.fechanacimiento,
       p.genero,
       p.cedula,
       p.telefono,
       p.fecharegistro,
       ABS(EXTRACT(EPOCH FROM ((p.fecharegistro::timestamp) - ($1::timestamp)))) AS diff_seconds
     FROM paciente p
     ORDER BY diff_seconds ASC
     LIMIT 1`,
    [userCreatedAt]
  );

  if (byNearest.rows.length) {
    const row = byNearest.rows[0];
    const diffSeconds = Number(row.diff_seconds || 0);
    if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
      return row;
    }
  }

  return null;
}

async function ensureEstadoCitaBase(client) {
  const defaults = [
    { nombre: 'Pendiente', descripcion: 'Cita creada y pendiente de confirmacion.' },
    { nombre: 'Confirmada', descripcion: 'Cita confirmada por el medico.' },
    { nombre: 'Completada', descripcion: 'Cita completada satisfactoriamente.' },
    { nombre: 'Cancelada', descripcion: 'Cita cancelada.' },
  ];

  let estadoPendienteId = null;

  for (const item of defaults) {
    const existing = await client.query(
      `SELECT estadocitaid
       FROM estado_cita
       WHERE lower(nombre) = lower($1)
       ORDER BY estadocitaid ASC
       LIMIT 1`,
      [item.nombre]
    );

    if (existing.rows.length) {
      if (item.nombre.toLowerCase() === 'pendiente') {
        estadoPendienteId = Number(existing.rows[0].estadocitaid);
      }
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO estado_cita (nombre, descripcion)
       VALUES ($1, $2)
       RETURNING estadocitaid`,
      [item.nombre, item.descripcion]
    );

    if (item.nombre.toLowerCase() === 'pendiente') {
      estadoPendienteId = Number(inserted.rows[0].estadocitaid);
    }
  }

  return estadoPendienteId;
}

async function resolveMedicoForCita(client, { medicoId, nombreMedico, especialidad }) {
  const byId = String(medicoId || '').trim();
  if (byId) {
    const exact = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, '') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [byId]
    );
    if (exact.rows.length) return exact.rows[0];
  }

  const byName = String(nombreMedico || '').replace(/\s+/g, ' ').trim();
  if (byName) {
    const exactName = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, '') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE lower(m.nombrecompleto) = lower($1)
       ORDER BY m.fecharegistro DESC
       LIMIT 1`,
      [byName]
    );
    if (exactName.rows.length) return exactName.rows[0];
  }

  const bySpecialty = String(especialidad || '').replace(/\s+/g, ' ').trim();
  if (bySpecialty) {
    const matchBySpecialty = await client.query(
      `SELECT
         m.medicoid::text AS medicoid,
         m.nombrecompleto,
         COALESCE(e.nombre, '') AS especialidad
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE lower(COALESCE(e.nombre, '')) = lower($1)
          OR lower(COALESCE(e.nombre, '')) LIKE lower($2)
       ORDER BY m.fecharegistro DESC
       LIMIT 1`,
      [bySpecialty, `%${bySpecialty}%`]
    );
    if (matchBySpecialty.rows.length) return matchBySpecialty.rows[0];
  }

  const fallback = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       COALESCE(e.nombre, '') AS especialidad
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     ORDER BY m.fecharegistro DESC
     LIMIT 1`
  );

  return fallback.rows[0] || null;
}

async function getMedicoDashboardData(client, medicoid) {
  const statsResult = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE COALESCE(LOWER(ec.nombre), '') LIKE '%complet%'
            OR COALESCE(LOWER(ec.nombre), '') LIKE '%finaliz%'
            OR COALESCE(LOWER(ec.nombre), '') LIKE '%realiz%'
       ) AS citas_completadas,
       COUNT(*) FILTER (
         WHERE c.fechahorainicio::date = CURRENT_DATE
       ) AS citas_hoy,
       COUNT(DISTINCT c.pacienteid::text) FILTER (
         WHERE date_trunc('month', c.fechahorainicio) = date_trunc('month', NOW())
       ) AS nuevos_pacientes_mes
     FROM cita c
     LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
     WHERE c.medicoid::text = $1::text`,
    [String(medicoid)]
  );

  const statsRow = statsResult.rows[0] || {};

  const agendaResult = await client.query(
    `SELECT
       c.citaid::text AS citaid,
       c.fechahorainicio,
       c.nota,
       c.pacienteid::text AS pacienteid,
       COALESCE(ec.nombre, '') AS estado_nombre,
       COALESCE(
         NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
         'Paciente'
       ) AS paciente_nombre
     FROM cita c
     LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
     LEFT JOIN paciente p ON p.pacienteid::text = c.pacienteid::text
     WHERE c.medicoid::text = $1::text
       AND c.fechahorainicio::date = CURRENT_DATE
     ORDER BY c.fechahorainicio ASC
     LIMIT 20`,
    [String(medicoid)]
  );

  const recentResult = await client.query(
    `WITH latest_by_patient AS (
       SELECT
         c.pacienteid::text AS pacienteid_text,
         MAX(c.fechahorainicio) AS last_seen
       FROM cita c
       WHERE c.medicoid::text = $1::text
       GROUP BY c.pacienteid::text
     )
     SELECT
       l.pacienteid_text,
       l.last_seen,
       COALESCE(
         NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
         'Paciente'
       ) AS paciente_nombre
     FROM latest_by_patient l
     LEFT JOIN paciente p ON p.pacienteid::text = l.pacienteid_text
     ORDER BY l.last_seen DESC
     LIMIT 8`,
    [String(medicoid)]
  );

  const agendaHoy = agendaResult.rows.map((row) => {
    const detailRaw = String(row.nota || row.estado_nombre || '').trim();
    return {
      id: String(row.citaid || ''),
      fechaHoraInicio: row.fechahorainicio || null,
      time: formatTime(row.fechahorainicio),
      name: String(row.paciente_nombre || 'Paciente'),
      detail: detailRaw || 'Consulta programada',
      patientCode: buildPatientCode(row.pacienteid),
    };
  });

  const expedientesRecientes = recentResult.rows.map((row) => ({
    id: String(row.pacienteid_text || ''),
    name: String(row.paciente_nombre || 'Paciente'),
    code: buildPatientCode(row.pacienteid_text),
    lastSeenAt: row.last_seen || null,
    lastSeenText: formatRelativeLastSeen(row.last_seen),
  }));

  return {
    stats: {
      citasCompletadas: toInt(statsRow.citas_completadas),
      citasHoy: toInt(statsRow.citas_hoy),
      nuevosPacientesMes: toInt(statsRow.nuevos_pacientes_mes),
      mensajesPendientes: 0,
    },
    agendaHoy,
    expedientesRecientes,
  };
}

// ===============================
// API: Perfil del usuario autenticado
// Endpoint: GET /api/users/me
// ===============================
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT usuarioid, rolid, email, fechacreacion, activo
       FROM usuario
       WHERE usuarioid = $1`,
      [req.user.usuarioid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const profile = await getUserProfileById(pool, req.user.usuarioid);
    return res.json({
      success: true,
      user: {
        ...result.rows[0],
        fotoUrl: profile?.fotoUrl || null,
      },
    });
  } catch (err) {
    console.error('Error GET /users/me:', err);
    return res.status(500).json({ success: false, message: 'Error interno obteniendo usuario.' });
  }
});

// ===============================
// API: Actualizar email del usuario autenticado
// Endpoint: PUT /api/users/me
// ===============================
router.put('/me', requireAuth, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email es obligatorio.' });
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await pool.query(
      `SELECT usuarioid FROM usuario WHERE email = $1 AND usuarioid <> $2`,
      [normalizedEmail, req.user.usuarioid]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Ese correo ya está registrado.' });
    }

    const result = await pool.query(
      `UPDATE usuario
       SET email = $1
       WHERE usuarioid = $2
       RETURNING usuarioid, rolid, email, fechacreacion, activo`,
      [normalizedEmail, req.user.usuarioid]
    );

    const profile = await getUserProfileById(pool, req.user.usuarioid);
    return res.json({
      success: true,
      user: {
        ...result.rows[0],
        fotoUrl: profile?.fotoUrl || null,
      },
    });
  } catch (err) {
    console.error('Error PUT /users/me:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando usuario.' });
  }
});

// ===============================
// API: Perfil extendido (foto) del usuario autenticado
// Endpoint: GET /api/users/me/profile
// ===============================
router.get('/me/profile', requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfileById(pool, req.user.usuarioid);
    return res.json({
      success: true,
      profile: {
        usuarioid: String(req.user.usuarioid),
        fotoUrl: profile?.fotoUrl || null,
        updatedAt: profile?.updatedAt || null,
      },
    });
  } catch (err) {
    console.error('Error GET /users/me/profile:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error interno obteniendo perfil extendido.' });
  }
});

// ===============================
// API: Actualizar foto de perfil del usuario autenticado
// Endpoint: PUT /api/users/me/profile
// Body: { fotoUrl: string | null }
// ===============================
router.put('/me/profile', requireAuth, async (req, res) => {
  const hasFotoUrl = Object.prototype.hasOwnProperty.call(req.body || {}, 'fotoUrl');
  if (!hasFotoUrl) {
    return res
      .status(400)
      .json({ success: false, message: 'fotoUrl es obligatorio en el body.' });
  }

  const fotoUrlRaw = req.body?.fotoUrl;
  const fotoUrl = String(fotoUrlRaw || '').trim();

  if (fotoUrl.length > MAX_PHOTO_URL_LENGTH) {
    return res.status(400).json({
      success: false,
      message: `fotoUrl supera ${MAX_PHOTO_URL_LENGTH} caracteres.`,
    });
  }

  if (!isSupportedImageUri(fotoUrl || null)) {
    return res.status(400).json({
      success: false,
      message:
        'fotoUrl debe iniciar con http://, https://, file://, blob: o data:image/.',
    });
  }

  try {
    const profile = await upsertUserProfileById(pool, req.user.usuarioid, {
      fotoUrl: fotoUrl || null,
    });
    return res.json({
      success: true,
      message: 'Foto de perfil actualizada.',
      profile,
    });
  } catch (err) {
    console.error('Error PUT /users/me/profile:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error interno guardando foto de perfil.' });
  }
});

// ===============================
// API: Dashboard medico (datos reales)
// Endpoint: GET /api/users/me/dashboard-medico
// ===============================
router.get('/me/dashboard-medico', requireAuth, async (req, res) => {
  let client;

  try {
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT usuarioid, rolid, email, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1`,
      [req.user.usuarioid]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const user = userResult.rows[0];
    if (!Boolean(user.activo)) {
      return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
    }

    if (Number(user.rolid) !== MEDICO_ROLE_ID) {
      return res.status(403).json({
        success: false,
        message: 'Este endpoint es exclusivo para cuentas medicas.',
      });
    }

    const medico = await getMedicoByUsuarioId(client, user.usuarioid, user.fechacreacion);
    const profileDb = await getUserProfileById(client, user.usuarioid);

    if (!medico) {
      return res.json({
        success: true,
        dashboard: {
          profile: {
            usuarioid: user.usuarioid,
            email: user.email,
            medicoid: null,
            nombreCompleto: null,
            especialidad: null,
            cedula: null,
            telefono: null,
            fotoUrl: profileDb?.fotoUrl || null,
          },
          stats: {
            citasCompletadas: 0,
            citasHoy: 0,
            nuevosPacientesMes: 0,
            mensajesPendientes: 0,
          },
          agendaHoy: [],
          expedientesRecientes: [],
        },
      });
    }

    const dashboardData = await getMedicoDashboardData(client, medico.medicoid);

    return res.json({
      success: true,
      dashboard: {
        profile: {
          usuarioid: user.usuarioid,
          email: user.email,
          medicoid: medico.medicoid || null,
          nombreCompleto: medico.nombrecompleto || null,
          especialidad: medico.especialidad || null,
          cedula: medico.cedula || null,
          telefono: medico.telefono || null,
          fotoUrl: profileDb?.fotoUrl || null,
        },
        ...dashboardData,
      },
    });
  } catch (err) {
    console.error('Error GET /users/me/dashboard-medico:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error interno cargando dashboard medico.' });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Listar citas del usuario autenticado
// Endpoint: GET /api/users/me/citas?scope=upcoming|history|all&limit=25
// ===============================
router.get('/me/citas', requireAuth, async (req, res) => {
  const scopeRaw = String(req.query?.scope || 'upcoming').toLowerCase();
  const scope = ['upcoming', 'history', 'all'].includes(scopeRaw) ? scopeRaw : 'upcoming';
  const limit = clampInt(req.query?.limit, 1, 100, 25);

  const scopeWhere =
    scope === 'history'
      ? 'c.fechahorainicio < NOW()'
      : scope === 'all'
        ? 'TRUE'
        : 'c.fechahorainicio >= NOW()';

  let client;
  try {
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT usuarioid, rolid, email, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1`,
      [req.user.usuarioid]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const user = userResult.rows[0];
    if (!Boolean(user.activo)) {
      return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
    }

    if (Number(user.rolid) === PACIENTE_ROLE_ID) {
      const paciente = await getPacienteByUsuarioId(client, user.usuarioid, user.fechacreacion);
      if (!paciente) {
        return res.status(404).json({ success: false, message: 'Perfil de paciente no encontrado.' });
      }

      const citasResult = await client.query(
        `SELECT
           c.citaid::text AS citaid,
           c.fechahorainicio,
           c.fechahorafin,
           c.duracionmin,
           c.nota,
           c.precio,
           COALESCE(ec.nombre, 'Pendiente') AS estado,
           m.medicoid::text AS medicoid,
           m.nombrecompleto AS medico_nombre,
           COALESCE(e.nombre, '') AS medico_especialidad
         FROM cita c
         LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
         LEFT JOIN medico m ON m.medicoid::text = c.medicoid::text
         LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
         WHERE c.pacienteid = $1
           AND ${scopeWhere}
         ORDER BY c.fechahorainicio DESC
         LIMIT $2`,
        [Number(paciente.pacienteid), limit]
      );

      return res.json({
        success: true,
        scope,
        citas: citasResult.rows.map((row) => ({
          citaid: String(row.citaid || ''),
          fechaHoraInicio: row.fechahorainicio || null,
          fechaHoraFin: row.fechahorafin || null,
          duracionMin: toInt(row.duracionmin, 30),
          nota: String(row.nota || ''),
          precio: row.precio ?? null,
          estado: String(row.estado || 'Pendiente'),
          medico: {
            medicoid: String(row.medicoid || ''),
            nombreCompleto: String(row.medico_nombre || 'Medico'),
            especialidad: String(row.medico_especialidad || ''),
          },
        })),
      });
    }

    if (Number(user.rolid) === MEDICO_ROLE_ID) {
      const medico = await getMedicoByUsuarioId(client, user.usuarioid, user.fechacreacion);
      if (!medico) {
        return res.status(404).json({ success: false, message: 'Perfil de medico no encontrado.' });
      }

      const citasResult = await client.query(
        `SELECT
           c.citaid::text AS citaid,
           c.fechahorainicio,
           c.fechahorafin,
           c.duracionmin,
           c.nota,
           c.precio,
           COALESCE(ec.nombre, 'Pendiente') AS estado,
           p.pacienteid::text AS pacienteid,
           COALESCE(
             NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
             'Paciente'
           ) AS paciente_nombre
         FROM cita c
         LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
         LEFT JOIN paciente p ON p.pacienteid = c.pacienteid
         WHERE c.medicoid::text = $1::text
           AND ${scopeWhere}
         ORDER BY c.fechahorainicio DESC
         LIMIT $2`,
        [String(medico.medicoid), limit]
      );

      return res.json({
        success: true,
        scope,
        citas: citasResult.rows.map((row) => ({
          citaid: String(row.citaid || ''),
          fechaHoraInicio: row.fechahorainicio || null,
          fechaHoraFin: row.fechahorafin || null,
          duracionMin: toInt(row.duracionmin, 30),
          nota: String(row.nota || ''),
          precio: row.precio ?? null,
          estado: String(row.estado || 'Pendiente'),
          paciente: {
            pacienteid: String(row.pacienteid || ''),
            nombreCompleto: String(row.paciente_nombre || 'Paciente'),
          },
        })),
      });
    }

    return res.status(403).json({
      success: false,
      message: 'Este endpoint solo aplica para pacientes y medicos.',
    });
  } catch (err) {
    console.error('Error GET /users/me/citas:', err);
    return res.status(500).json({ success: false, message: 'Error interno listando citas.' });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Crear cita para paciente autenticado
// Endpoint: POST /api/users/me/citas
// ===============================
router.post('/me/citas', requireAuth, async (req, res) => {
  const fechaHoraInicioRaw = String(req.body?.fechaHoraInicio || '').trim();
  const duracionMin = clampInt(req.body?.duracionMin, 15, 180, 30);
  const especialidad = String(req.body?.especialidad || '').trim();
  const nombreMedico = String(req.body?.nombreMedico || '').trim();
  const medicoId = String(req.body?.medicoId || '').trim();
  const nota = String(req.body?.nota || '').trim().slice(0, 1200);
  const precioRaw = Number(req.body?.precio);
  const precio = Number.isFinite(precioRaw) && precioRaw >= 0 ? precioRaw : null;

  if (!fechaHoraInicioRaw) {
    return res
      .status(400)
      .json({ success: false, message: 'fechaHoraInicio es obligatorio.' });
  }

  const fechaHoraInicio = new Date(fechaHoraInicioRaw);
  if (Number.isNaN(fechaHoraInicio.getTime())) {
    return res.status(400).json({
      success: false,
      message: 'fechaHoraInicio debe venir en formato ISO valido.',
    });
  }

  if (fechaHoraInicio.getTime() < Date.now()) {
    return res.status(400).json({
      success: false,
      message: 'No puedes agendar una cita en el pasado.',
    });
  }

  const fechaHoraFin = new Date(fechaHoraInicio.getTime() + duracionMin * 60 * 1000);

  let client;
  try {
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT usuarioid, rolid, email, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1`,
      [req.user.usuarioid]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const user = userResult.rows[0];
    if (!Boolean(user.activo)) {
      return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
    }

    if (Number(user.rolid) !== PACIENTE_ROLE_ID) {
      return res.status(403).json({
        success: false,
        message: 'Solo los pacientes pueden crear citas desde este endpoint.',
      });
    }

    const paciente = await getPacienteByUsuarioId(client, user.usuarioid, user.fechacreacion);
    if (!paciente) {
      return res.status(404).json({
        success: false,
        message: 'No se encontro un perfil de paciente asociado a este usuario.',
      });
    }

    const medico = await resolveMedicoForCita(client, {
      medicoId,
      nombreMedico,
      especialidad,
    });
    if (!medico) {
      return res.status(409).json({
        success: false,
        message: 'No hay medicos disponibles para agendar en este momento.',
      });
    }

    await client.query('BEGIN');

    const estadoPendienteId = await ensureEstadoCitaBase(client);
    if (!estadoPendienteId) {
      throw new Error('No fue posible inicializar catalogo estado_cita.');
    }

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
         nota
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
       RETURNING
         citaid::text AS citaid,
         pacienteid::text AS pacienteid,
         medicoid::text AS medicoid,
         fechahorainicio,
         fechahorafin,
         duracionmin,
         precio,
         nota`,
      [
        randomUUID(),
        Number(paciente.pacienteid),
        String(medico.medicoid),
        null,
        estadoPendienteId,
        null,
        fechaHoraInicio.toISOString(),
        fechaHoraFin.toISOString(),
        duracionMin,
        precio,
        nota || null,
      ]
    );

    await client.query('COMMIT');

    const cita = insertResult.rows[0] || {};
    return res.status(201).json({
      success: true,
      message: 'Cita creada correctamente.',
      cita: {
        citaid: String(cita.citaid || ''),
        fechaHoraInicio: cita.fechahorainicio || null,
        fechaHoraFin: cita.fechahorafin || null,
        duracionMin: toInt(cita.duracionmin, duracionMin),
        precio: cita.precio ?? null,
        nota: String(cita.nota || ''),
        estado: 'Pendiente',
      },
      medico: {
        medicoid: String(medico.medicoid || ''),
        nombreCompleto: String(medico.nombrecompleto || 'Medico'),
        especialidad: String(medico.especialidad || ''),
      },
      paciente: {
        pacienteid: String(paciente.pacienteid || ''),
      },
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error POST /users/me/citas:', err);
    return res.status(500).json({ success: false, message: 'Error interno creando cita.' });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Cambiar contrasena
// Endpoint: PUT /api/users/me/password
// ===============================
router.put('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ success: false, message: 'currentPassword y newPassword son obligatorios.' });
  }

  try {
    const result = await pool.query(
      `SELECT passwordhash FROM usuario WHERE usuarioid = $1`,
      [req.user.usuarioid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const ok = await bcrypt.compare(currentPassword, result.rows[0].passwordhash);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Contraseña actual inválida.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE usuario SET passwordhash = $1 WHERE usuarioid = $2`, [
      newHash,
      req.user.usuarioid,
    ]);

    return res.json({ success: true, message: 'Contraseña actualizada.' });
  } catch (err) {
    console.error('Error PUT /users/me/password:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando password.' });
  }
});

module.exports = router;
