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
// ✅ VALIDAR EXEQUÁTUR POR CÉDULA + NOMBRE COMPLETO
// Endpoint: POST /api/validar-exequatur
// =======================================
router.post("/validar-exequatur", limiter, async (req, res) => {
  const { cedula, nombreCompleto } = req.body;
  const nombre = String(nombreCompleto || "").replace(/\s+/g, " ").trim();

  if (!cedula && !nombre) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar cédula o nombreCompleto para validar exequátur.",
    });
  }

  const result = await consultarExequaturSNS({
    cedula: String(cedula || "").trim(),
    nombreCompleto: nombre,
  });

  if (!result.ok) {
    return res.status(400).json({
      success: false,
      message: result.reason,
    });
  }

  return res.json({
    success: true,
    exists: result.exists,
    doctor: result.exists ? result.doctor : null,
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
      "Usa POST /api/validar-exequatur con JSON: { cedula: '00112345678', nombreCompleto: 'Juan Perez' }",
  });
});

module.exports = router;
