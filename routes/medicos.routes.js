const express = require('express');
const pool = require('../db');
const { requireAuth } = require('./middleware/auth');

const router = express.Router();

// ===============================
// API: Listar médicos
// Endpoint: GET /api/medicos
// ===============================
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT medicoid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro
       FROM medico
       ORDER BY medicoid DESC`
    );
    return res.json({ success: true, medicos: result.rows });
  } catch (err) {
    console.error('Error GET /medicos:', err);
    return res.status(500).json({ success: false, message: 'Error interno listando médicos.' });
  }
});

// ===============================
// API: Obtener médico por ID
// Endpoint: GET /api/medicos/:id
// ===============================
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT medicoid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro
       FROM medico
       WHERE medicoid = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Médico no encontrado.' });
    }

    return res.json({ success: true, medico: result.rows[0] });
  } catch (err) {
    console.error('Error GET /medicos/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno obteniendo médico.' });
  }
});

// ===============================
// API: Crear médico
// Endpoint: POST /api/medicos
// ===============================
router.post('/', requireAuth, async (req, res) => {
  const { nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad } = req.body;

  if (!nombres || !apellidos || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO medico (nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       RETURNING medicoid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
      [
        String(nombres).trim(),
        String(apellidos).trim(),
        String(fechanacimiento).trim(),
        String(genero).trim(),
        String(cedula).trim(),
        String(telefono).trim(),
        String(especialidad || '').trim(),
      ]
    );

    return res.status(201).json({ success: true, medico: result.rows[0] });
  } catch (err) {
    console.error('Error POST /medicos:', err);
    return res.status(500).json({ success: false, message: 'Error interno creando médico.' });
  }
});

// ===============================
// API: Actualizar médico
// Endpoint: PUT /api/medicos/:id
// ===============================
router.put('/:id', requireAuth, async (req, res) => {
  const { nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad } = req.body;

  if (!nombres || !apellidos || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `UPDATE medico
       SET nombres = $1,
           apellidos = $2,
           fechanacimiento = $3,
           genero = $4,
           cedula = $5,
           telefono = $6,
           especialidad = $7
       WHERE medicoid = $8
       RETURNING medicoid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
      [
        String(nombres).trim(),
        String(apellidos).trim(),
        String(fechanacimiento).trim(),
        String(genero).trim(),
        String(cedula).trim(),
        String(telefono).trim(),
        String(especialidad || '').trim(),
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Médico no encontrado.' });
    }

    return res.json({ success: true, medico: result.rows[0] });
  } catch (err) {
    console.error('Error PUT /medicos/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando médico.' });
  }
});

// ===============================
// API: Eliminar médico
// Endpoint: DELETE /api/medicos/:id
// ===============================
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM medico
       WHERE medicoid = $1
       RETURNING medicoid`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Médico no encontrado.' });
    }

    return res.json({ success: true, message: 'Médico eliminado.' });
  } catch (err) {
    console.error('Error DELETE /medicos/:id:', err);
    return res.status(500).json({ success: false, message: 'Error interno eliminando médico.' });
  }
});

module.exports = router;