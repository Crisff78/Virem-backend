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

const { ensureRfCoreSchema } = require("./services/rf-core");
const { ensurePlatformSchema, ensureEstadoCatalog } = require("./services/platform-core");
const { ensureUserProfileTable } = require("./services/user-profile.store");

pool.query("SELECT NOW()")
  .then(async res => {
    sysLogger.add("Conectado a Supabase correctamente", "SUCCESS");
    try {
      sysLogger.add("Inicializando esquemas de base de datos...", "INFO");
      await Promise.all([
        ensureRfCoreSchema(),
        ensurePlatformSchema(),
        ensureUserProfileTable()
      ]);
      
      await ensureEstadoCatalog(pool);
      sysLogger.add("Todos los esquemas han sido verificados.", "SUCCESS");
    } catch (err) {
      sysLogger.add(`Error inicializando esquemas: ${err.message}`, "ERROR");
    }
  })
  .catch(err => {
    sysLogger.add(`Error conectando a Supabase: ${err.message}`, "ERROR");
  });

const PORT = process.env.PORT || 3000;

initializeSocketServer(httpServer);

// Reminder Service Loop
const { processPendingReminders } = require("./services/reminder-service");
const REMINDER_INTERVAL_MS = 60000; // 1 minute
setInterval(() => {
  processPendingReminders().catch(err => {
    sysLogger.add(`Error en intervalo de recordatorios: ${err.message}`, "ERROR");
  });
}, REMINDER_INTERVAL_MS);

httpServer.listen(PORT, "0.0.0.0", () => {
  sysLogger.add(`Backend corriendo en http://localhost:${PORT}`, "SERVER");
  if (process.env.MAKE_WEBHOOK_URL) {
    sysLogger.add(`Automatización: Make.com activa (${process.env.MAKE_WEBHOOK_URL.substring(0, 40)}...)`, "INFO");
  } else {
    sysLogger.add("Automatización: Make.com no configurada (usando fallback SMTP)", "WARNING");
  }
  
  if (process.env.VERIPHONE_API_KEY) {
    sysLogger.add("Validación: Veriphone API integrada correctamente", "SUCCESS");
  }
});
