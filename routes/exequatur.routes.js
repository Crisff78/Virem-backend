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
// ✅ VALIDAR EXEQUÁTUR SOLO POR NOMBRE
// Endpoint: POST /api/validar-exequatur
// =======================================
router.post("/validar-exequatur", limiter, async (req, res) => {
  const { nombres, apellidos, nombreCompleto } = req.body;

  // ✅ Construir nombre completo
  const fullName =
    nombreCompleto ||
    `${nombres || ""} ${apellidos || ""}`.replace(/\s+/g, " ").trim();

  if (!fullName || fullName.length < 4) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar el nombre completo para validar Exequátur.",
    });
  }

  // ✅ CONSULTA SOLO POR NOMBRE
  const result = await consultarExequaturSNS({
    cedula: "", // 🚫 ya no se usa
    nombres: fullName,
    apellidos: "",
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
  });
});

// =======================================
// GET INFO
// =======================================
router.get("/validar-exequatur", (req, res) => {
  res.json({
    success: true,
    message:
      "Usa POST /api/validar-exequatur con JSON: { nombreCompleto: 'Juan Perez' }",
  });
});

module.exports = router;
