const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const {
  ensureUserProfileTable,
  getUserProfileById,
  upsertUserProfileById,
  isSupportedImageUri,
  MAX_PHOTO_URL_LENGTH,
} = require('../services/user-profile.store');
const {
  ensureRfCoreSchema,
  recordUserModification,
} = require('../services/rf-core');
const {
  listMyCitas,
  createMyCita,
  cancelMyCita,
  rescheduleMyCita,
  updateMyCitaEstado,
} = require('../services/agenda-service');
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

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mapAgendaCitaToLegacyListItem(cita, roleId) {
  const payload = {
    citaid: String(cita?.citaid || ''),
    fechaHoraInicio: cita?.fechaHoraInicio || null,
    fechaHoraFin: cita?.fechaHoraFin || null,
    duracionMin: toInt(cita?.duracionMin, 30),
    nota: String(cita?.nota || ''),
    precio: cita?.precio ?? null,
    estado: String(cita?.estado || 'Pendiente'),
  };

  if (Number(roleId) === PACIENTE_ROLE_ID) {
    payload.medico = {
      medicoid: String(cita?.medico?.medicoid || cita?.medicoid || ''),
      nombreCompleto: String(cita?.medico?.nombreCompleto || 'Medico'),
      especialidad: String(cita?.medico?.especialidad || ''),
      fotoUrl: cita?.medico?.fotoUrl || null,
    };
    return payload;
  }

  payload.paciente = {
    pacienteid: String(cita?.paciente?.pacienteid || cita?.pacienteid || ''),
    nombreCompleto: String(cita?.paciente?.nombreCompleto || 'Paciente'),
  };
  return payload;
}

function mapAgendaCreateToLegacy(body) {
  const cita = body?.cita || {};
  return {
    success: true,
    message: String(body?.message || 'Cita creada correctamente.'),
    cita: {
      citaid: String(cita.citaid || ''),
      fechaHoraInicio: cita.fechaHoraInicio || null,
      fechaHoraFin: cita.fechaHoraFin || null,
      duracionMin: toInt(cita.duracionMin, 30),
      precio: cita.precio ?? null,
      nota: String(cita.nota || ''),
      estado: String(cita.estado || 'Pendiente'),
    },
    medico: {
      medicoid: String(cita?.medico?.medicoid || cita.medicoid || ''),
      nombreCompleto: String(cita?.medico?.nombreCompleto || 'Medico'),
      especialidad: String(cita?.medico?.especialidad || ''),
    },
    paciente: {
      pacienteid: String(cita?.paciente?.pacienteid || cita.pacienteid || ''),
    },
  };
}

function mapAgendaRescheduleToLegacy(body) {
  const cita = body?.cita || {};
  return {
    success: true,
    message: String(body?.message || 'Cita pospuesta correctamente.'),
    cita: {
      citaid: String(cita.citaid || ''),
      fechaHoraInicio: cita.fechaHoraInicio || null,
      fechaHoraFin: cita.fechaHoraFin || null,
      duracionMin: toInt(cita.duracionMin, 30),
    },
  };
}

function mapAgendaManageToLegacy(body, fallbackMessage) {
  const cita = body?.cita || {};
  return {
    success: true,
    message: String(body?.message || fallbackMessage || 'Cita actualizada correctamente.'),
    cita: {
      citaid: String(cita.citaid || ''),
      fechaHoraInicio: cita.fechaHoraInicio || null,
      fechaHoraFin: cita.fechaHoraFin || null,
      duracionMin: toInt(cita.duracionMin, 30),
      nota: String(cita.nota || ''),
      precio: cita.precio ?? null,
      estado: String(cita.estado || 'Pendiente'),
      paciente: {
        pacienteid: String(cita?.paciente?.pacienteid || cita.pacienteid || ''),
        nombreCompleto: String(cita?.paciente?.nombreCompleto || 'Paciente'),
      },
    },
  };
}

function isStrongPassword(password) {
  const value = String(password || '');
  return (
    value.length >= 8 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

function toSqlDate(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (isoPrefix?.[1]) return isoPrefix[1];

  const parts = raw.split("/");
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts;
    if (/^\d+$/.test(dd) && /^\d+$/.test(mm) && /^\d+$/.test(yyyy)) {
      return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function getMedicoByUsuarioId(client, usuarioid, userCreatedAt, knownMedicoId = '') {
  const result = await client.query(
    `SELECT
       m.medicoid::text AS medicoid,
       m.nombrecompleto,
       m.fechanacimiento,
       m.genero,
       m.cedula,
       m.telefono,
       COALESCE(e.nombre, 'Medicina General') AS especialidad,
       m.fecharegistro
     FROM medico m
     LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
     WHERE m.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  return result.rows[0] || null;
}

async function getPacienteByUsuarioId(client, usuarioid, userCreatedAt) {
  const result = await client.query(
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
     WHERE p.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );
  return result.rows[0] || null;
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
      patientId: String(row.pacienteid || ''),
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
  const { email, confirmPassword, motivo } = req.body || {};

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email es obligatorio.' });
  }
  if (!confirmPassword) {
    return res.status(400).json({
      success: false,
      message: 'Debes confirmar tu contrasena actual para cambiar el correo.',
    });
  }

  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const normalizedEmail = String(email).toLowerCase().trim();
    const currentUser = await client.query(
      `SELECT usuarioid, email, passwordhash, rolid, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1
       FOR UPDATE`,
      [req.user.usuarioid]
    );
    if (!currentUser.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const userRow = currentUser.rows[0];
    if (!Boolean(userRow.activo)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
    }

    const passwordOk = await bcrypt.compare(
      String(confirmPassword),
      String(userRow.passwordhash || '')
    );
    if (!passwordOk) {
      await client.query('ROLLBACK');
      return res.status(401).json({
        success: false,
        message: 'Contrasena de confirmacion invalida.',
      });
    }

    const existing = await client.query(
      `SELECT usuarioid FROM usuario WHERE email = $1 AND usuarioid <> $2`,
      [normalizedEmail, req.user.usuarioid]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Ese correo ya está registrado.' });
    }

    const result = await client.query(
      `UPDATE usuario
       SET email = $1
       WHERE usuarioid = $2
       RETURNING usuarioid, rolid, email, fechacreacion, activo, account_status, email_verificado`,
      [normalizedEmail, req.user.usuarioid]
    );

    const previousEmail = String(userRow.email || '').trim();
    if (previousEmail.toLowerCase() !== normalizedEmail.toLowerCase()) {
      await recordUserModification(client, {
        usuarioid: Number(req.user.usuarioid),
        actorUsuarioid: Number(req.user.usuarioid),
        scope: 'email_sensible',
        motivo: String(motivo || '').trim(),
        changes: {
          email: {
            before: previousEmail,
            after: normalizedEmail,
          },
        },
      });
    }

    await client.query('COMMIT');

    const profile = await getUserProfileById(client, req.user.usuarioid);
    return res.json({
      success: true,
      user: {
        ...result.rows[0],
        fotoUrl: profile?.fotoUrl || null,
      },
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error PUT /users/me:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando usuario.' });
  } finally {
    if (client) client.release();
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
        'fotoUrl debe iniciar con http://, https://, file:// o data:image/.',
    });
  }

  try {
    await ensureRfCoreSchema();
    const currentProfile = await getUserProfileById(pool, req.user.usuarioid);
    const profile = await upsertUserProfileById(pool, req.user.usuarioid, {
      fotoUrl: fotoUrl || null,
    });

    const before = String(currentProfile?.fotoUrl || '').trim();
    const after = String(profile?.fotoUrl || '').trim();
    if (before !== after) {
      await recordUserModification(pool, {
        usuarioid: Number(req.user.usuarioid),
        actorUsuarioid: Number(req.user.usuarioid),
        scope: 'foto_perfil',
        changes: {
          fotoUrl: {
            before: before || null,
            after: after || null,
          },
        },
      });
    }

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
// API: Perfil de paciente autenticado (core + extras)
// Endpoint: GET /api/users/me/paciente-profile
// ===============================
router.get('/me/paciente-profile', requireAuth, async (req, res) => {
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
        message: 'Este endpoint es exclusivo para cuentas de paciente.',
      });
    }

    const paciente = await getPacienteByUsuarioId(client, user.usuarioid, user.fechacreacion);
    if (!paciente) {
      return res.status(404).json({
        success: false,
        message: 'No se encontro el perfil de paciente asociado.',
      });
    }

    const profileDb = await getUserProfileById(client, user.usuarioid);
    const meta = profileDb?.meta && typeof profileDb.meta === 'object' ? profileDb.meta : {};

    return res.json({
      success: true,
      profile: {
        usuarioid: user.usuarioid,
        pacienteid: paciente.pacienteid,
        email: user.email,
        nombres: paciente.nombres || '',
        apellidos: paciente.apellidos || '',
        fechanacimiento: paciente.fechanacimiento || null,
        genero: paciente.genero || '',
        cedula: paciente.cedula || '',
        telefono: paciente.telefono || '',
        fotoUrl: profileDb?.fotoUrl || null,
        direccion: String(meta.direccion || ''),
        tipoSangre: String(meta.tipoSangre || ''),
        alergias: String(meta.alergias || ''),
        medicamentos: String(meta.medicamentos || ''),
        antecedentes: String(meta.antecedentes || ''),
        contactoEmergenciaNombre: String(meta.contactoEmergenciaNombre || ''),
        contactoEmergenciaTelefono: String(meta.contactoEmergenciaTelefono || ''),
        contactoEmergenciaParentesco: String(meta.contactoEmergenciaParentesco || ''),
        recibirEmail: Boolean(
          Object.prototype.hasOwnProperty.call(meta, 'recibirEmail') ? meta.recibirEmail : true
        ),
        recibirSMS: Boolean(
          Object.prototype.hasOwnProperty.call(meta, 'recibirSMS') ? meta.recibirSMS : true
        ),
        compartirHistorial: Boolean(meta.compartirHistorial || false),
      },
    });
  } catch (err) {
    console.error('Error GET /users/me/paciente-profile:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error interno cargando perfil de paciente.' });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Actualizar perfil de paciente autenticado
// Endpoint: PUT /api/users/me/paciente-profile
// ===============================
router.put('/me/paciente-profile', requireAuth, async (req, res) => {
  const body = req.body || {};
  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT usuarioid, rolid, email, activo, fechacreacion, passwordhash
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1`,
      [req.user.usuarioid]
    );

    if (!userResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const user = userResult.rows[0];
    if (!Boolean(user.activo)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Usuario inactivo.' });
    }
    if (Number(user.rolid) !== PACIENTE_ROLE_ID) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Este endpoint es exclusivo para cuentas de paciente.',
      });
    }

    const paciente = await getPacienteByUsuarioId(client, user.usuarioid, user.fechacreacion);
    if (!paciente) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'No se encontro el perfil de paciente asociado.',
      });
    }

    const nextNombres = String(
      Object.prototype.hasOwnProperty.call(body, 'nombres') ? body.nombres : paciente.nombres
    )
      .replace(/\s+/g, ' ')
      .trim();
    const nextApellidos = String(
      Object.prototype.hasOwnProperty.call(body, 'apellidos') ? body.apellidos : paciente.apellidos
    )
      .replace(/\s+/g, ' ')
      .trim();
    const nextGenero = String(
      Object.prototype.hasOwnProperty.call(body, 'genero') ? body.genero : paciente.genero
    )
      .replace(/\s+/g, ' ')
      .trim();
    const nextCedula = String(
      Object.prototype.hasOwnProperty.call(body, 'cedula') ? body.cedula : paciente.cedula
    )
      .replace(/\D/g, '')
      .slice(0, 11);
    const nextTelefono = String(
      Object.prototype.hasOwnProperty.call(body, 'telefono') ? body.telefono : paciente.telefono
    )
      .replace(/\D/g, '')
      .slice(0, 15);
    const nextFechaNacimiento = toSqlDate(
      Object.prototype.hasOwnProperty.call(body, 'fechanacimiento')
        ? body.fechanacimiento
        : paciente.fechanacimiento
    );

    if (!nextNombres || !nextApellidos || !nextGenero || !nextCedula || !nextTelefono || !nextFechaNacimiento) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'nombres, apellidos, fechanacimiento, genero, cedula y telefono son obligatorios.',
      });
    }

    const previousEmail = String(user.email || '').toLowerCase().trim();
    const previousCedula = String(paciente.cedula || '')
      .replace(/\D/g, '')
      .slice(0, 11);
    const previousTelefono = String(paciente.telefono || '')
      .replace(/\D/g, '')
      .slice(0, 15);
    const previousFechaNacimiento = toSqlDate(paciente.fechanacimiento);

    const sensitiveChanges = {};
    const registerSensitiveChange = (field, before, after) => {
      if (String(before || '') === String(after || '')) return;
      sensitiveChanges[field] = { before, after };
    };

    registerSensitiveChange('cedula', previousCedula, nextCedula);
    registerSensitiveChange('telefono', previousTelefono, nextTelefono);
    registerSensitiveChange(
      'fechanacimiento',
      previousFechaNacimiento,
      nextFechaNacimiento
    );

    const emailProvided = Object.prototype.hasOwnProperty.call(body, 'email');
    let nextEmail = String(user.email || '').toLowerCase().trim();
    if (emailProvided) {
      nextEmail = String(body.email || '').toLowerCase().trim();
      if (!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Email invalido.' });
      }

      const existing = await client.query(
        `SELECT usuarioid
         FROM usuario
         WHERE email = $1 AND usuarioid <> $2
         LIMIT 1`,
        [nextEmail, user.usuarioid]
      );
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Ese correo ya esta registrado.' });
      }

      await client.query(
        `UPDATE usuario
         SET email = $1
         WHERE usuarioid = $2`,
        [nextEmail, user.usuarioid]
      );
    }

    registerSensitiveChange('email', previousEmail, nextEmail);

    const hasSensitiveChanges = Object.keys(sensitiveChanges).length > 0;
    if (hasSensitiveChanges) {
      const confirmPassword = String(body.confirmPassword || '').trim();
      if (!confirmPassword) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message:
            'Debes confirmar tu contrasena actual para guardar cambios sensibles.',
        });
      }

      const passwordOk = await bcrypt.compare(
        confirmPassword,
        String(user.passwordhash || '')
      );
      if (!passwordOk) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          message: 'Contrasena de confirmacion invalida.',
        });
      }
    }

    const updatePaciente = await client.query(
      `UPDATE paciente
       SET nombres = $1,
           apellidos = $2,
           fechanacimiento = $3,
           genero = $4,
           cedula = $5,
           telefono = $6
       WHERE pacienteid = $7
       RETURNING pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono`,
      [
        nextNombres,
        nextApellidos,
        nextFechaNacimiento,
        nextGenero,
        nextCedula,
        nextTelefono,
        Number(paciente.pacienteid),
      ]
    );

    const updatedPaciente = updatePaciente.rows[0];

    const currentProfile = await getUserProfileById(client, user.usuarioid);
    const currentMeta =
      currentProfile?.meta && typeof currentProfile.meta === 'object' ? currentProfile.meta : {};

    const mergedMeta = {
      ...currentMeta,
      direccion: String(body.direccion ?? currentMeta.direccion ?? '').trim(),
      tipoSangre: String(body.tipoSangre ?? currentMeta.tipoSangre ?? '').trim(),
      alergias: String(body.alergias ?? currentMeta.alergias ?? '').trim(),
      medicamentos: String(body.medicamentos ?? currentMeta.medicamentos ?? '').trim(),
      antecedentes: String(body.antecedentes ?? currentMeta.antecedentes ?? '').trim(),
      contactoEmergenciaNombre: String(
        body.contactoEmergenciaNombre ?? currentMeta.contactoEmergenciaNombre ?? ''
      ).trim(),
      contactoEmergenciaTelefono: String(
        body.contactoEmergenciaTelefono ?? currentMeta.contactoEmergenciaTelefono ?? ''
      )
        .replace(/\D/g, '')
        .slice(0, 15),
      contactoEmergenciaParentesco: String(
        body.contactoEmergenciaParentesco ?? currentMeta.contactoEmergenciaParentesco ?? ''
      ).trim(),
      recibirEmail:
        Object.prototype.hasOwnProperty.call(body, 'recibirEmail')
          ? Boolean(body.recibirEmail)
          : Boolean(
              Object.prototype.hasOwnProperty.call(currentMeta, 'recibirEmail')
                ? currentMeta.recibirEmail
                : true
            ),
      recibirSMS:
        Object.prototype.hasOwnProperty.call(body, 'recibirSMS')
          ? Boolean(body.recibirSMS)
          : Boolean(
              Object.prototype.hasOwnProperty.call(currentMeta, 'recibirSMS')
                ? currentMeta.recibirSMS
                : true
            ),
      compartirHistorial:
        Object.prototype.hasOwnProperty.call(body, 'compartirHistorial')
          ? Boolean(body.compartirHistorial)
          : Boolean(currentMeta.compartirHistorial || false),
    };

    const savedProfile = await upsertUserProfileById(client, user.usuarioid, {
      meta: mergedMeta,
    });

    const profileChanges = {
      ...sensitiveChanges,
    };
    const addChange = (field, before, after) => {
      if (String(before || '') === String(after || '')) return;
      profileChanges[field] = { before, after };
    };

    addChange('nombres', paciente.nombres, nextNombres);
    addChange('apellidos', paciente.apellidos, nextApellidos);
    addChange('genero', paciente.genero, nextGenero);
    addChange('direccion', currentMeta.direccion, mergedMeta.direccion);
    addChange('tipoSangre', currentMeta.tipoSangre, mergedMeta.tipoSangre);
    addChange('alergias', currentMeta.alergias, mergedMeta.alergias);
    addChange('medicamentos', currentMeta.medicamentos, mergedMeta.medicamentos);
    addChange('antecedentes', currentMeta.antecedentes, mergedMeta.antecedentes);
    addChange(
      'contactoEmergenciaNombre',
      currentMeta.contactoEmergenciaNombre,
      mergedMeta.contactoEmergenciaNombre
    );
    addChange(
      'contactoEmergenciaTelefono',
      currentMeta.contactoEmergenciaTelefono,
      mergedMeta.contactoEmergenciaTelefono
    );
    addChange(
      'contactoEmergenciaParentesco',
      currentMeta.contactoEmergenciaParentesco,
      mergedMeta.contactoEmergenciaParentesco
    );
    addChange('recibirEmail', currentMeta.recibirEmail, mergedMeta.recibirEmail);
    addChange('recibirSMS', currentMeta.recibirSMS, mergedMeta.recibirSMS);
    addChange(
      'compartirHistorial',
      currentMeta.compartirHistorial,
      mergedMeta.compartirHistorial
    );

    if (Object.keys(profileChanges).length > 0) {
      await recordUserModification(client, {
        usuarioid: Number(user.usuarioid),
        actorUsuarioid: Number(req.user.usuarioid),
        scope: 'paciente_profile',
        motivo: String(body.motivo || '').trim(),
        changes: profileChanges,
      });
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Perfil de paciente actualizado.',
      profile: {
        usuarioid: user.usuarioid,
        pacienteid: updatedPaciente?.pacienteid || paciente.pacienteid,
        email: nextEmail,
        nombres: updatedPaciente?.nombres || nextNombres,
        apellidos: updatedPaciente?.apellidos || nextApellidos,
        fechanacimiento: updatedPaciente?.fechanacimiento || nextFechaNacimiento,
        genero: updatedPaciente?.genero || nextGenero,
        cedula: updatedPaciente?.cedula || nextCedula,
        telefono: updatedPaciente?.telefono || nextTelefono,
        fotoUrl: savedProfile?.fotoUrl || currentProfile?.fotoUrl || null,
        ...mergedMeta,
      },
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error PUT /users/me/paciente-profile:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error interno actualizando perfil de paciente.' });
  } finally {
    if (client) client.release();
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

    const profileDb = await getUserProfileById(client, user.usuarioid);
    const profileMeta =
      profileDb?.meta && typeof profileDb.meta === 'object' ? profileDb.meta : {};
    const medico = await getMedicoByUsuarioId(client, user.usuarioid);

    if (!medico) {
      return res.json({
        success: true,
        dashboard: {
          profile: {
            usuarioid: user.usuarioid,
            email: user.email,
            medicoid: null,
            nombreCompleto: String(profileMeta.nombreCompleto || '').trim() || null,
            especialidad: String(profileMeta.especialidad || '').trim() || null,
            cedula: String(profileMeta.cedula || '').trim() || null,
            telefono: String(profileMeta.telefono || '').trim() || null,
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
  const result = await listMyCitas({
    reqUser: req.user,
    query: req.query,
    defaultLimit: 25,
    maxLimit: 100,
    allowedRoleIds: [PACIENTE_ROLE_ID, MEDICO_ROLE_ID],
    forbiddenRoleMessage: 'Este endpoint solo aplica para pacientes y medicos.',
  });

  if (result.status >= 400) {
    return res.status(result.status).json(result.body);
  }

  return res.status(result.status).json({
    success: true,
    scope: String(result.body?.scope || 'upcoming'),
    citas: (result.body?.citas || []).map((cita) =>
      mapAgendaCitaToLegacyListItem(cita, result.context?.roleId)
    ),
  });
});

// ===============================
// API: Crear cita para paciente autenticado
// Endpoint: POST /api/users/me/citas
// ===============================
router.post('/me/citas', requireAuth, async (req, res) => {
  const result = await createMyCita({
    reqUser: req.user,
    body: req.body,
    allowedRoleIds: [PACIENTE_ROLE_ID],
    forbiddenRoleMessage: 'Solo los pacientes pueden crear citas desde este endpoint.',
    allowMedicoFallback: true,
  });

  if (result.status >= 400) {
    return res.status(result.status).json(result.body);
  }

  return res.status(result.status).json(mapAgendaCreateToLegacy(result.body));
});

// ===============================
// API: Posponer cita del paciente autenticado
// Endpoint: PATCH /api/users/me/citas/:citaId/postpone
// Body opcional: { fechaHoraInicio: string (ISO) }
// ===============================
router.patch('/me/citas/:citaId/postpone', requireAuth, async (req, res) => {
  const result = await rescheduleMyCita({
    reqUser: req.user,
    citaId: req.params?.citaId,
    body: req.body,
    allowedRoleIds: [PACIENTE_ROLE_ID],
    forbiddenRoleMessage: 'Solo los pacientes pueden posponer sus citas.',
  });

  if (result.status >= 400) {
    return res.status(result.status).json(result.body);
  }

  return res.status(result.status).json(
    mapAgendaRescheduleToLegacy({
      ...result.body,
      message: 'Cita pospuesta correctamente.',
    })
  );
});

// ===============================
// API: Gestion de cita por medico autenticado
// Endpoint: PATCH /api/users/me/citas/:citaId/manage
// Body:
//   - { action: "complete" | "cancel" }
//   - { action: "reschedule", fechaHoraInicio?: ISO, duracionMin?: number }
// ===============================
router.patch('/me/citas/:citaId/manage', requireAuth, async (req, res) => {
  const citaId = String(req.params?.citaId || '').trim();
  const action = String(req.body?.action || '').trim().toLowerCase();

  if (!citaId) {
    return res.status(400).json({ success: false, message: 'citaId es obligatorio.' });
  }
  if (!['complete', 'cancel', 'reschedule'].includes(action)) {
    return res.status(400).json({
      success: false,
      message: 'action debe ser complete, cancel o reschedule.',
    });
  }

  let result;
  if (action === 'cancel') {
    result = await cancelMyCita({
      reqUser: req.user,
      citaId,
      body: req.body,
      allowedRoleIds: [MEDICO_ROLE_ID],
      forbiddenRoleMessage: 'Solo los medicos pueden gestionar esta cita.',
    });
  } else if (action === 'reschedule') {
    result = await rescheduleMyCita({
      reqUser: req.user,
      citaId,
      body: req.body,
      allowedRoleIds: [MEDICO_ROLE_ID],
      forbiddenRoleMessage: 'Solo los medicos pueden gestionar esta cita.',
    });
  } else {
    result = await updateMyCitaEstado({
      reqUser: req.user,
      citaId,
      body: { ...req.body, estado: 'completada' },
      allowedRoleIds: [MEDICO_ROLE_ID],
      forbiddenRoleMessage: 'Solo los medicos pueden gestionar esta cita.',
    });
  }

  if (result.status >= 400) {
    return res.status(result.status).json(result.body);
  }

  const fallbackMessage =
    action === 'reschedule'
      ? 'Cita reprogramada correctamente.'
      : action === 'complete'
        ? 'Cita marcada como completada.'
        : 'Cita cancelada correctamente.';

  return res.status(result.status).json(
    mapAgendaManageToLegacy({
      ...result.body,
      message: fallbackMessage,
    }, fallbackMessage)
  );
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
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      success: false,
      message:
        'La contrasena debe tener al menos 8 caracteres, mayuscula, minuscula, numero y simbolo.',
    });
  }

  try {
    await ensureRfCoreSchema();
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

    await recordUserModification(pool, {
      usuarioid: Number(req.user.usuarioid),
      actorUsuarioid: Number(req.user.usuarioid),
      scope: 'password',
      changes: {
        password: {
          before: '***',
          after: '***',
        },
      },
    });

    return res.json({ success: true, message: 'Contraseña actualizada.' });
  } catch (err) {
    console.error('Error PUT /users/me/password:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando password.' });
  }
});

module.exports = router;
