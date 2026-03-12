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
// VALIDAR EXEQUATUR SOLO POR NOMBRE COMPLETO
// Endpoint: POST /api/validar-exequatur
// =======================================
router.post("/validar-exequatur", limiter, async (req, res) => {
  const { nombreCompleto } = req.body || {};
  const nombre = String(nombreCompleto || "").replace(/\s+/g, " ").trim();

  if (!nombre) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar nombreCompleto para validar exequatur.",
    });
  }

  console.log(`[SNS] Validando exequatur para: ${nombre}`);

  const result = await consultarExequaturSNS({
    nombreCompleto: nombre,
  });

  if (!result.ok) {
    console.log("[SNS] Consulta fallida:", {
      nombre,
      serviceUnavailable: Boolean(result.serviceUnavailable),
      reason: result.reason,
      fastFailCached: Boolean(result.fastFailCached),
    });

    const statusCode = result.serviceUnavailable ? 503 : 400;
    return res.status(statusCode).json({
      success: false,
      serviceUnavailable: Boolean(result.serviceUnavailable),
      message: result.reason,
    });
  }

  if (!result.exists) {
    console.log(`[SNS] No se encontraron coincidencias para: ${nombre}`);

    return res.json({
      success: true,
      exists: false,
      message: "No se encontro coincidencia en el Exequatur del SNS.",
      match: result.match || null,
    });
  }

  const records = Array.isArray(result.data) ? result.data : [];
  const doctor = records.length > 0 ? records[0] : null;

  console.log(`[SNS] Coincidencias encontradas para "${nombre}": ${records.length}`);
  console.log("[SNS] Datos encontrados:", records);

  return res.json({
    success: true,
    exists: true,
    doctor,
    records,
    match: result.match || null,
  });
});

module.exports = router;
