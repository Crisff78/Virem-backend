const { randomUUID } = require("crypto");

function requestContext(req, res, next) {
    const headerRequestId = String(req.headers["x-request-id"] || "").trim();
    const requestId = headerRequestId || randomUUID();
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
            path: req.originalUrl,
            statusCode: res.statusCode,
            durationMs,
            ip: req.ip,
            userAgent: String(req.headers["user-agent"] || ""),
        };
        console.log(JSON.stringify(logLine));
    });

    next();
}

module.exports = {
    requestContext,
    requestLogger,
};

