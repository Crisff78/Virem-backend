const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { requireAuth } = require('./middleware/auth');

const router = express.Router();

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

    return res.json({ success: true, user: result.rows[0] });
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

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error PUT /users/me:', err);
    return res.status(500).json({ success: false, message: 'Error interno actualizando usuario.' });
  }
});

// ===============================
// API: Cambiar contraseña
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