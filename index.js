const http = require("http");
require("dotenv").config();
const pool = require("./config/db");
const { createApp } = require("./app");
const { initializeSocketServer } = require("./realtime/socket");
const { validateCriticalEnv } = require("./config/env");
const sysLogger = require("./utils/sysLogger");

const app = createApp();
const httpServer = http.createServer(app);

const envValidation = validateCriticalEnv();
if (envValidation.warnings.length) {
  envValidation.warnings.forEach((warning) => {
    sysLogger.add(`[ENV WARNING] ${warning}`, "WARNING");
  });
}
if (envValidation.errors.length) {
  envValidation.errors.forEach((error) => {
    sysLogger.add(`[ENV ERROR] ${error}`, "ERROR");
  });
  process.exit(1);
}

const { assertSchemaReady } = require("./config/schema-version");
const { ensureEstadoCatalog } = require("./services/platform-core");
const { processPendingReminders } = require("./services/reminder-service");
const PORT = process.env.PORT || 3000;

async function start() {
  // Read-only readiness check: deploy migrations before starting the application.
  await assertSchemaReady(pool);
  await ensureEstadoCatalog(pool);
  initializeSocketServer(httpServer);
  setInterval(() => {
    processPendingReminders().catch(err => {
      sysLogger.add(`Error en intervalo de recordatorios: ${err.message}`, "ERROR");
    });
  }, 60000);
  httpServer.listen(PORT, "0.0.0.0", () => {
    sysLogger.add(`Backend corriendo en http://localhost:${PORT}`, "SERVER");
    sysLogger.add(process.env.MAKE_WEBHOOK_URL
      ? "Automatización: Make.com activa"
      : "Automatización: Make.com no configurada (usando fallback SMTP)", "INFO");
    if (process.env.VERIPHONE_API_KEY) {
      sysLogger.add("Validación: Veriphone API integrada correctamente", "SUCCESS");
    }
  });
}

start().catch(async err => {
  sysLogger.add(`No se pudo iniciar el backend: ${err.message}`, "ERROR");
  await pool.end();
  process.exitCode = 1;
});
