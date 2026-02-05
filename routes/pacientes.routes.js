const express = require('express');
const pool = require('../db');
const { requireAuth } = require('./middleware/auth');

const router = express.Router();

// ===============================
// API: Listar pacientes
// Endpoint: GET /api/pacientes
// ===============================
router.get('/', requireAuth, async (req, res) => {
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
router.get('/:id', requireAuth, async (req, res) => {
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
router.post('/', requireAuth, async (req, res) => {
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
router.put('/:id', requireAuth, async (req, res) => {
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
router.delete('/:id', requireAuth, async (req, res) => {
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
