const http = require("http");
require("dotenv").config();
const pool = require("./config/db");
const { createApp } = require("./app");
const { initializeSocketServer } = require("./realtime/socket");
const { validateCriticalEnv } = require("./config/env");

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
    console.log("✅ Conectado a Supabase correctamente");
    try {
      console.log("⏳ Inicializando esquemas de base de datos...");
      await Promise.all([
        ensureRfCoreSchema(),
        ensurePlatformSchema(),
        ensureUserProfileTable()
      ]);
      
      await ensureEstadoCatalog(pool);
      console.log("✅ Todos los esquemas han sido verificados.");
    } catch (err) {
      console.error("❌ Error inicializando esquemas:", err.message);
    }
  })
  .catch(err => {
    console.error("❌ Error conectando a Supabase:", err.message);
  });

const PORT = process.env.PORT || 3000;
initializeSocketServer(httpServer);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://localhost:${PORT}`);
});
