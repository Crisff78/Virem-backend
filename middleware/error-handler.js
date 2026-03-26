function notFoundHandler(req, res) {
    return res.status(404).json({
        success: false,
        message: `Ruta no existe: ${req.method} ${req.originalUrl}`,
        requestId: req.requestId || null,
    });
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const statusCode = Number(err?.statusCode || err?.status || 500);
    const message =
        statusCode >= 500
            ? "Error interno del servidor."
            : String(err?.message || "Error en la solicitud.");

    if (statusCode >= 500) {
        console.error(
            JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                requestId: req.requestId || null,
                method: req.method,
                path: req.originalUrl,
                statusCode,
                message: String(err?.message || "unexpected_error"),
                stack: err?.stack || null,
            })
        );
    }

    return res.status(statusCode).json({
        success: false,
        message,
        requestId: req.requestId || null,
    });
}

module.exports = {
    notFoundHandler,
    errorHandler,
};

