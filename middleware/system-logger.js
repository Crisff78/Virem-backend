const sysLogger = require("../utils/sysLogger");

function systemRequestLogger(req, res, next) {
  const { method, url } = req;
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    
    // Filtramos ruido:
    // 1. Ignorar OPTIONS (pre-flight CORS)
    if (method === 'OPTIONS') return;

    // 2. Ignorar polling exitoso de IT Stats (para que no llene la consola)
    if (url.includes('/it-stats') && status < 400) return;

    const logMsg = `${method} ${url} ${status} - ${duration}ms`;
    
    if (status >= 400) {
      sysLogger.add(logMsg, "ERROR");
    } else {
      sysLogger.add(logMsg, "HTTP");
    }
  });

  next();
}

module.exports = { systemRequestLogger };
