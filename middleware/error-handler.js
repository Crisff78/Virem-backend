const PUBLIC_MESSAGES = {
    400: "Solicitud invalida.",
    401: "Debes iniciar sesion nuevamente.",
    403: "No tienes permiso para realizar esta accion.",
    404: "Recurso no encontrado.",
    409: "La solicitud entra en conflicto con el estado actual del recurso.",
    413: "La solicitud supera el tamano permitido.",
    422: "No se pudo procesar la solicitud.",
    429: "Demasiadas solicitudes. Intenta nuevamente mas tarde.",
};

function errorBody(statusCode, req) {
    const message = PUBLIC_MESSAGES[statusCode] || (statusCode >= 500
        ? "Error interno del servidor." : "Error en la solicitud.");
    // Keep message for existing clients; never serialize the exception or URL.
    return { success: false, error: message, message, requestId: req.requestId || null };
}

function notFoundHandler(req, res) {
    return res.status(404).json(errorBody(404, req));
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    // Express 5 forwards rejected async route/middleware promises here.
    const requestedStatus = Number(err?.statusCode || err?.status || 500);
    const statusCode = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
        ? requestedStatus : 500;

    if (statusCode >= 500) {
        console.error(
            JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                requestId: req.requestId || null,
                method: req.method,
                statusCode,
                message: "request_failed",
            })
        );
    }

    return res.status(statusCode).json(errorBody(statusCode, req));
}

module.exports = {
    notFoundHandler,
    errorHandler,
};

