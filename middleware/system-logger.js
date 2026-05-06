const sysLogger = require("../utils/sysLogger");

function systemRequestLogger(req, res, next) {
  const { method, url } = req;
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
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
