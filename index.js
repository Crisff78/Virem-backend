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
    console.warn(`[ENV WARNING] ${warning}`);
  });
}
if (envValidation.errors.length) {
  envValidation.errors.forEach((error) => {
    console.error(`[ENV ERROR] ${error}`);
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
    console.error("❌ Error conectando a Supabase:", err.message);
  });

const PORT = process.env.PORT || 3000;
initializeSocketServer(httpServer);

// Reminder Service Loop
const { processPendingReminders } = require("./services/reminder-service");
const REMINDER_INTERVAL_MS = 60000; // 1 minute
setInterval(() => {
  processPendingReminders().catch(err => console.error("Error in reminder interval:", err));
}, REMINDER_INTERVAL_MS);

httpServer.listen(PORT, "0.0.0.0", () => {
  sysLogger.add(`Backend corriendo en http://localhost:${PORT}`, "SERVER");
  if (process.env.MAKE_WEBHOOK_URL) {
    console.log(`🔗 Automatización: Make.com activa (${process.env.MAKE_WEBHOOK_URL.substring(0, 30)}...)`);
  } else {
    console.log(`⚠️ Automatización: Make.com no configurada (usando SMTP local)`);
  }
});
