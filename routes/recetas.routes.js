const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

const router = express.Router();

// MEDICO: Emitir receta
router.post("/medico/me/recetas", requireAuth, async (req, res) => {
  try {
    if (req.user.rolid !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo médicos pueden emitir recetas" });
    }

    const { pacienteid, citaid, diagnostico, medicamentos, instrucciones } = req.body;
    
    if (!pacienteid || !diagnostico || !medicamentos) {
      return res.status(400).json({ success: false, message: "Faltan datos obligatorios" });
    }

    const medicoid = String(req.user.medicoid || req.user.usuarioid);

    const result = await pool.query(
      `INSERT INTO receta_medica (pacienteid, citaid, medicoid_text, diagnostico, medicamentos_json, instrucciones)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING recetaid::text, created_at`,
      [pacienteid, citaid, medicoid, diagnostico, JSON.stringify(medicamentos), instrucciones]
    );

    return res.json({ success: true, receta: result.rows[0] });
  } catch (error) {
    console.error("Error al emitir receta:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// MEDICO: Listar sus recetas emitidas
router.get("/medico/me/recetas", requireAuth, async (req, res) => {
  try {
    if (req.user.rolid !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo médicos" });
    }

    const medicoid = String(req.user.medicoid || req.user.usuarioid);
    const result = await pool.query(
      `SELECT r.recetaid::text, r.diagnostico, r.medicamentos_json, r.instrucciones, r.created_at,
              COALESCE(p.nombres || ' ' || p.apellidos, 'Paciente') AS paciente_nombre
       FROM receta_medica r
       LEFT JOIN paciente p ON p.usuarioid = r.pacienteid
       WHERE r.medicoid_text = $1
       ORDER BY r.created_at DESC`,
      [medicoid]
    );

    return res.json({ success: true, recetas: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

// PACIENTE: Listar sus recetas recibidas
router.get("/paciente/me/recetas", requireAuth, async (req, res) => {
  try {
    if (req.user.rolid !== PACIENTE_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo pacientes" });
    }

    const result = await pool.query(
      `SELECT r.recetaid::text, r.diagnostico, r.medicamentos_json, r.instrucciones, r.created_at,
              COALESCE(m.nombrecompleto, 'Médico') AS medico_nombre
       FROM receta_medica r
       LEFT JOIN medico m ON m.usuarioid::text = r.medicoid_text
       WHERE r.pacienteid = $1
       ORDER BY r.created_at DESC`,
      [req.user.usuarioid]
    );

    return res.json({ success: true, recetas: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

module.exports = router;
