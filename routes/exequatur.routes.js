const express = require("express");
const rateLimit = require("express-rate-limit");
const { consultarExequaturSNS } = require("../services/exequatur.provider.js");

const router = express.Router();

// Anti abuso (porque es scraping)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
});

router.post("/validar-exequatur", limiter, async (req, res) => {
  const { cedula, nombres, apellidos } = req.body;

  const result = await consultarExequaturSNS({
    cedula,
    nombres,
    apellidos,
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

router.get("/validar-exequatur", (req, res) => {
  res.json({
    success: true,
    message: "Usa POST /api/validar-exequatur con JSON: { cedula } o { nombres, apellidos }",
  });
});


module.exports = router;
