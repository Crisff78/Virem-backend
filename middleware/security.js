const helmet = require("helmet");

/**
 * Middleware de seguridad mejorado con Helmet.
 * Protege contra inyecciones, clickjacking y establece políticas de privacidad.
 */
const securityHeaders = [
  helmet({
    contentSecurityPolicy: false, // Desactivado por ahora para evitar problemas con assets externos (puedes activarlo y configurarlo luego)
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
  (req, res, next) => {
    // Políticas adicionales de privacidad para hardware
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  },
];

module.exports = {
  securityHeaders,
};

