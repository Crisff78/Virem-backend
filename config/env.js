const DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:19006",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:8082",
    "http://127.0.0.1:19006",
];

function normalizeList(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function toOrigin(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    try {
        return new URL(raw).origin;
    } catch (err) {
        return "";
    }
}

function uniqueList(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function normalizeOrigins(values) {
    return uniqueList(
        values
            .map((value) => toOrigin(value))
            .filter(Boolean)
    );
}

function getConfiguredCorsOrigins() {
    return normalizeOrigins([
        ...normalizeList(process.env.CORS_ORIGIN),
        process.env.PUBLIC_WEB_URL,
    ]);
}

function allowLoopbackCorsOrigins() {
    return toBoolean(process.env.CORS_ALLOW_LOOPBACK, true);
}

function getAllowedCorsOrigins() {
    const configuredOrigins = getConfiguredCorsOrigins();
    const loopbackOrigins = allowLoopbackCorsOrigins() ? DEFAULT_ALLOWED_ORIGINS : [];
    const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

    if (configuredOrigins.length > 0) {
        return uniqueList([...configuredOrigins, ...loopbackOrigins]);
    }

    if (isProduction) {
        return uniqueList(loopbackOrigins);
    }

    return uniqueList([...DEFAULT_ALLOWED_ORIGINS, ...loopbackOrigins]);
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
    const configuredCorsOrigins = getConfiguredCorsOrigins();
    const loopbackCorsEnabled = allowLoopbackCorsOrigins();

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

        if (!configuredCorsOrigins.length && !loopbackCorsEnabled) {
            warnings.push(
                "CORS_ORIGIN is empty in production and PUBLIC_WEB_URL is missing/invalid; browser clients may be blocked."
            );
        } else if (!configuredCorsOrigins.length && loopbackCorsEnabled) {
            warnings.push(
                "CORS_ORIGIN and PUBLIC_WEB_URL are empty/invalid in production; only loopback origins remain enabled."
            );
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

