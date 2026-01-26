const express = require('express');

const router = express.Router();
const fetch = require('node-fetch');


const VERIPHONE_API_KEY = process.env.VERIPHONE_API_KEY;
const VERIPHONE_URL = 'https://api.veriphone.io/v2/verify';


// Helper: normalizar teléfono a E.164 simple (+1809xxxxxxx, +34..., etc.)
function toE164(prefix, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const cleanPrefix = String(prefix || '').trim(); // ejemplo "+1"
  if (!cleanPrefix.startsWith('+')) return `+${cleanPrefix}${digits}`;
  return `${cleanPrefix}${digits}`;
}

// ===============================
// API para validar teléfono (BACKEND -> VERIPHONE)
// Endpoint: POST /api/validar-telefono
// ===============================
router.post('/validar-telefono', async (req, res) => {
  try {
    if (!VERIPHONE_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Falta VERIPHONE_API_KEY en el .env',
      });
    }

    const { countryCode, phone } = req.body;

    if (!countryCode || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Debes enviar countryCode y phone.',
      });
    }

    const phoneE164 = toE164(countryCode, phone);

    // API para validar número con Veriphone
    const url =
      `${VERIPHONE_URL}?key=${encodeURIComponent(VERIPHONE_API_KEY)}` +
      `&phone=${encodeURIComponent(phoneE164)}`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: `Veriphone respondió HTTP ${response.status}`,
      });
    }

    const data = await response.json();
    const isValid = data?.phone_valid === true;

    return res.json({
      success: true,
      valid: isValid,
      // meta para explicarlo a tu maestra:
      e164: data?.e164,
      carrier: data?.carrier,
      phone_type: data?.phone_type,
      country: data?.country,
    });
  } catch (err) {
    console.error('Error /validar-telefono:', err);
    return res.status(500).json({
      success: false,
      message: 'Error interno validando teléfono.',
    });
  }
});

module.exports = router;