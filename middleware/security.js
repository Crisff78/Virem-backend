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
    // Permitir acceso a hardware necesario para videollamadas (camera, microphone)
    // Se establece (self) para permitirlo solo en el origen de la app
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
    next();
  },
];

module.exports = {
  securityHeaders,
};

