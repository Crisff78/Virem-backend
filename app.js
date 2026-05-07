const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const {
    getAllowedCorsOrigins,
    getGlobalRateLimitConfig,
    getJsonBodyLimit,
} = require("./config/env");
const { requestContext, requestLogger } = require("./middleware/request-context");
const { securityHeaders } = require("./middleware/security");
const { notFoundHandler, errorHandler } = require("./middleware/error-handler");
const { systemRequestLogger } = require("./middleware/system-logger");

function buildCorsOriginError(origin) {
    const err = new Error("Origin no permitido por CORS.");
    err.statusCode = 403;
    err.code = "origin_not_allowed";
    err.origin = origin || null;
    return err;
}

function createApp() {
    const app = express();

    const allowedOrigins = getAllowedCorsOrigins();
    const corsOptions = {
        origin(origin, callback) {
            if (!origin) return callback(null, true);
            if (!allowedOrigins.length) {
                return callback(buildCorsOriginError(origin));
            }
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(buildCorsOriginError(origin));
        },
        credentials: true,
        optionsSuccessStatus: 204,
    };

    const globalRateLimitConfig = getGlobalRateLimitConfig();
    const globalLimiter = rateLimit({
        windowMs: globalRateLimitConfig.windowMs,
        limit: globalRateLimitConfig.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            success: false,
            message: "Demasiadas solicitudes. Intenta nuevamente en unos segundos.",
        },
    });

    app.set("trust proxy", 1);
    app.use(systemRequestLogger);
    app.use(requestContext);
    app.use(requestLogger);
    app.use(securityHeaders);
    app.use(cors(corsOptions));
    app.use(globalLimiter);
    app.use(express.json({ limit: getJsonBodyLimit() }));

    app.get("/", (req, res) => {
        res.json({
            success: true,
            message: "🚀 Backend corriendo correctamente",
            endpoints: {
                health: "/health",
                auth: "/api/auth",
                users: "/api/users",
                medicos: "/api/medicos",
                pacientes: "/api/pacientes",
                clinical: "/api/clinical",
                payments: "/api/payments",
                admin: "/api/admin",
                validarTelefono: "/api/validar-telefono",
                verifyEmailLink: "/api/auth/verify-email-link?email=...&codigo=......",
                recuperarContrasena: "/api/auth/recovery/send-code",
            },
        });
    });

    app.get("/health", (req, res) => {
        res.json({
            success: true,
            message: "Backend OK ✅",
            service: "virem-backend",
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            requestId: req.requestId || null,
        });
    });

    const authRoutes = require("./routes/auth.routes.js");
    app.use("/api/auth", authRoutes);

    const usersRoutes = require("./routes/users.routes.js");
    app.use("/api/users", usersRoutes);

    const medicosRoutes = require("./routes/medicos.routes.js");
    app.use("/api/medicos", medicosRoutes);

    const pacientesRoutes = require("./routes/pacientes.routes.js");
    app.use("/api/pacientes", pacientesRoutes);

    const phoneRoutes = require("./routes/phone.routes.js");
    app.use("/api", phoneRoutes);
    app.use("/api/phone", phoneRoutes);

    const exequaturRoutes = require("./routes/exequatur.routes.js");
    app.use("/api", exequaturRoutes);

    const agendaRoutes = require("./routes/agenda.routes.js");
    app.use("/api/agenda", agendaRoutes);

    const clinicalRoutes = require("./routes/clinical.routes.js");
    app.use("/api/clinical", clinicalRoutes);

    const paymentsRoutes = require("./routes/payments.routes.js");
    app.use("/api/payments", paymentsRoutes);

    const adminRoutes = require("./routes/admin.routes.js");
    app.use("/api/admin", adminRoutes);

    const recetasRoutes = require('./routes/recetas.routes.js');
    app.use('/api', recetasRoutes);

    const videoRoutes = require('./routes/video.routes.js');
    app.use('/api/video', videoRoutes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
