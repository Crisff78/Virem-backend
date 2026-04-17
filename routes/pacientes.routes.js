const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./middleware/auth');
const {
  ADMIN_ROLE_ID,
  requireRole,
  requireOwnership,
} = require('./middleware/access-control');

const router = express.Router();

async function resolvePacienteOwner(req) {
  const result = await pool.query(
    `SELECT usuarioid
     FROM paciente
     WHERE pacienteid = $1
     LIMIT 1`,
    [req.params.id]
  );

  if (!result.rows.length) {
    return {
      exists: false,
      notFoundMessage: 'Paciente no encontrado.',
    };
  }

  return {
    exists: true,
    ownerUserIds: [result.rows[0].usuarioid],
    notFoundMessage: 'Paciente no encontrado.',
    forbiddenMessage: 'No puedes acceder al perfil de otro paciente.',
  };
}

// ===============================
// API: Listar pacientes
// Endpoint: GET /api/pacientes
// ===============================
router.get('/', requireAuth, requireRole(ADMIN_ROLE_ID), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro
       FROM paciente
       ORDER BY pacienteid DESC`
    );
    return res.json({ success: true, pacientes: result.rows });
  } catch (err) {
    console.error('Error GET /pacientes:', err);
    return res.status(500).json({ success: false, message: 'Error interno listando pacientes.' });
  }
});

// ===============================
// API: Obtener paciente por ID
// Endpoint: GET /api/pacientes/:id
// ===============================
router.get(
  '/:id',
  requireAuth,
  requireOwnership(resolvePacienteOwner, { allowRoles: [ADMIN_ROLE_ID] }),
  async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro
       FROM paciente
       WHERE pacienteid = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Paciente no encontrado.' });
    }

    return res.json({ success: true, paciente: result.rows[0] });
  } catch (err) {
    console.error('Error GET /pacientes/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno obteniendo paciente.' });
  }
});

// ===============================
// API: Crear paciente
// Endpoint: POST /api/pacientes
// ===============================
router.post('/', requireAuth, requireRole(ADMIN_ROLE_ID), async (req, res) => {
  const { nombres, apellidos, fechanacimiento, genero, cedula, telefono } = req.body;

  if (!nombres || !apellidos || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO paciente (nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro`,
      [
        String(nombres).trim(),
        String(apellidos).trim(),
        String(fechanacimiento).trim(),
        String(genero).trim(),
        String(cedula).trim(),
        String(telefono).trim(),
      ]
    );

    return res.status(201).json({ success: true, paciente: result.rows[0] });
  } catch (err) {
    console.error('Error POST /pacientes:', err);
    return res.status(500).json({ success: false, message: 'Error interno creando paciente.' });
  }
});

// ===============================
// API: Actualizar paciente
// Endpoint: PUT /api/pacientes/:id
// ===============================
router.put(
  '/:id',
  requireAuth,
  requireOwnership(resolvePacienteOwner, { allowRoles: [ADMIN_ROLE_ID] }),
  async (req, res) => {
  const { nombres, apellidos, fechanacimiento, genero, cedula, telefono } = req.body;

  if (!nombres || !apellidos || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `UPDATE paciente
       SET nombres = $1,
           apellidos = $2,
           fechanacimiento = $3,
           genero = $4,
           cedula = $5,
           telefono = $6
       WHERE pacienteid = $7
       RETURNING pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro`,
      [
        String(nombres).trim(),
        String(apellidos).trim(),
        String(fechanacimiento).trim(),
        String(genero).trim(),
        String(cedula).trim(),
        String(telefono).trim(),
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Paciente no encontrado.' });
    }

    return res.json({ success: true, paciente: result.rows[0] });
  } catch (err) {
    console.error('Error PUT /pacientes/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando paciente.' });
  }
});

// ===============================
// API: Eliminar paciente
// Endpoint: DELETE /api/pacientes/:id
// ===============================
router.delete('/:id', requireAuth, requireRole(ADMIN_ROLE_ID), async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM paciente
       WHERE pacienteid = $1
       RETURNING pacienteid`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Paciente no encontrado.' });
    }

    return res.json({ success: true, message: 'Paciente eliminado.' });
  } catch (err) {
    console.error('Error DELETE /pacientes/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno eliminando paciente.' });
  }
});

module.exports = router;
