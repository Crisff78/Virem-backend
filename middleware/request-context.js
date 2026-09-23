const { randomUUID } = require("crypto");

function requestContext(req, res, next) {
    const headerRequestId = String(req.headers["x-request-id"] || "").trim();
    const requestId = req.url.startsWith('/api/patient-assistant') ? randomUUID() : headerRequestId || randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    req.requestStartAt = process.hrtime.bigint();
    next();
}

function requestLogger(req, res, next) {
    const startedAt = Date.now();

    res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        const logLine = {
            ts: new Date().toISOString(),
            level: "info",
            requestId: req.requestId,
            method: req.method,
            path: require('../services/patient-assistant/log-path').logPath(req),
            statusCode: res.statusCode,
            durationMs,
            ip: req.ip,
            userAgent: req.originalUrl.startsWith('/api/patient-assistant') ? undefined : String(req.headers["user-agent"] || ""),
        };
        console.log(JSON.stringify(logLine));
    });

    next();
}

module.exports = {
    requestContext,
    requestLogger,
};

