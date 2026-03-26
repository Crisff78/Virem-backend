const DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:8081",
    "http://localhost:19006",
    "http://localhost:3000",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:19006",
    "http://127.0.0.1:3000",
];

function normalizeList(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function getAllowedCorsOrigins() {
    const envList = normalizeList(process.env.CORS_ORIGIN);
    if (envList.length > 0) return envList;

    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
        return [];
    }

    return DEFAULT_ALLOWED_ORIGINS;
}

function getJsonBodyLimit() {
    const raw = String(process.env.MAX_JSON_BODY || "1mb").trim();
    return raw || "1mb";
}

function toBoolean(value, fallback = false) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getGlobalRateLimitConfig() {
    const windowMs = Number.parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || "60000", 10);
    const max = Number.parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || "180", 10);
    return {
        windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
        max: Number.isFinite(max) && max > 0 ? max : 180,
    };
}

function getSocketCorsOrigins() {
    const allowed = getAllowedCorsOrigins();
    return allowed;
}

function validateCriticalEnv() {
    const errors = [];
    const warnings = [];
    const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

    if (!process.env.JWT_SECRET) {
        errors.push("JWT_SECRET is required.");
    }

    const hasDatabaseUrl = Boolean(String(process.env.DATABASE_URL || "").trim());
    const hasDbParts =
        Boolean(String(process.env.DB_HOST || "").trim()) &&
        Boolean(String(process.env.DB_NAME || "").trim()) &&
        Boolean(String(process.env.DB_USER || "").trim());

    if (!hasDatabaseUrl && !hasDbParts) {
        errors.push("DATABASE_URL or DB_HOST/DB_NAME/DB_USER configuration is required.");
    }

    if (isProduction) {
        if (String(process.env.JWT_SECRET || "").trim().length < 32) {
            errors.push("JWT_SECRET must have at least 32 characters in production.");
        }

        if (!String(process.env.CORS_ORIGIN || "").trim()) {
            warnings.push("CORS_ORIGIN is empty in production; browser clients may be blocked.");
        }
    }

    return { errors, warnings, isProduction };
}

module.exports = {
    getAllowedCorsOrigins,
    getJsonBodyLimit,
    getGlobalRateLimitConfig,
    getSocketCorsOrigins,
    validateCriticalEnv,
    toBoolean,
};

