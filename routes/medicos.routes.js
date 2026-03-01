const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./middleware/auth');

const router = express.Router();

// ===============================
// API: Listar médicos
// Endpoint: GET /api/medicos
// ===============================
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro
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
      `SELECT medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro
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
  const { nombreCompleto, fechanacimiento, genero, cedula, telefono, especialidad } = req.body;
  const nombreCompletoTrim = String(nombreCompleto || '').trim();

  if (!nombreCompletoTrim || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO medico (nombrecompleto, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
      [
        nombreCompletoTrim,
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
  const { nombreCompleto, fechanacimiento, genero, cedula, telefono, especialidad } = req.body;
  const nombreCompletoTrim = String(nombreCompleto || '').trim();

  if (!nombreCompletoTrim || !fechanacimiento || !genero || !cedula || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios.' });
  }

  try {
    const result = await pool.query(
      `UPDATE medico
       SET nombrecompleto = $1,
           fechanacimiento = $2,
           genero = $3,
           cedula = $4,
           telefono = $5,
           especialidad = $6
       WHERE medicoid = $7
       RETURNING medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
      [
        nombreCompletoTrim,
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
