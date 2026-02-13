const express = require("express");
const rateLimit = require("express-rate-limit");
const { consultarExequaturSNS } = require("../services/exequatur.provider.js");

const router = express.Router();

// Anti abuso (porque es scraping)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
});

// =======================================
// ✅ VALIDAR EXEQUÁTUR SOLO POR NOMBRE COMPLETO
// Endpoint: POST /api/validar-exequatur
// =======================================
router.post("/validar-exequatur", limiter, async (req, res) => {
  const { nombreCompleto } = req.body;
  const nombre = String(nombreCompleto || "").replace(/\s+/g, " ").trim();

  if (!nombre) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar nombreCompleto para validar exequátur.",
    });
  }

  const result = await consultarExequaturSNS({
    nombreCompleto: nombre,
  });

  if (!result.ok) {
    return res.status(400).json({
      success: false,
      message: result.reason,
    });
  }

  if (!result.exists) {
    return res.json({
      success: true,
      exists: false,
      message: "No se encontró coincidencia en el Exequátur del SNS.",
      match: result.match || null,
    });
  }

  return res.json({
    success: true,
    exists: true,
    doctor: result.doctor,
    match: result.match || null,
  });
});

// =======================================
// GET INFO
// =======================================
router.get("/validar-exequatur", (req, res) => {
  res.json({
    success: true,
    message:
      "Usa POST /api/validar-exequatur con JSON: { nombreCompleto: 'Esperanza Morales de la Cruz' }",
  });
});

module.exports = router;
