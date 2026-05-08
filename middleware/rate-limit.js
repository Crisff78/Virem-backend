const rateLimit = require("express-rate-limit");

/**
 * Limitador para intentos de inicio de sesión y registro.
 * Previene ataques de fuerza bruta.
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    limit: 15, // Máximo 15 intentos por IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Demasiados intentos desde esta dirección. Intenta nuevamente en 15 minutos.",
    },
});

/**
 * Limitador para envío de correos de recuperación.
 */
const recoveryLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    limit: 5, // 5 solicitudes por hora
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Límite de recuperación excedido. Intenta más tarde.",
    },
});

module.exports = {
    authLimiter,
    recoveryLimiter,
};
