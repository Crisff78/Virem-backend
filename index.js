const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();
const pool = require("./config/db");
const { initializeSocketServer } = require("./realtime/socket");

const app = express();
const httpServer = http.createServer(app);

// Middlewares
app.use(cors());
app.use(express.json({ limit: "20mb" }));

pool.query("SELECT NOW()")
  .then(res => {
    console.log("✅ Conectado a Supabase correctamente");
    console.log(res.rows);
  })
  .catch(err => {
    console.error("❌ Error conectando a Supabase:", err.message);
  });

// Ruta raíz
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "🚀 Backend corriendo correctamente",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      users: "/api/users",
      medicos: "/api/medicos",
      pacientes: "/api/pacientes",
      validarTelefono: "/api/validar-telefono",
      recuperarContrasena: "/api/auth/recovery/send-code",
    },
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Backend OK ✅" });
});

// ===============================
// ✅ RUTAS AUTH
// ===============================
const authRoutes = require("./routes/auth.routes.js");
app.use("/api/auth", authRoutes);

// ===============================
// ✅ RUTAS USERS (perfil/password)
// ===============================
const usersRoutes = require("./routes/users.routes.js");
app.use("/api/users", usersRoutes);

// ===============================
// ✅ RUTAS MEDICOS
// ===============================
const medicosRoutes = require("./routes/medicos.routes.js");
app.use("/api/medicos", medicosRoutes);

// ===============================
// ✅ RUTAS PACIENTES
// ===============================
const pacientesRoutes = require("./routes/pacientes.routes.js");
app.use("/api/pacientes", pacientesRoutes);

// ===============================
// ✅ RUTA VALIDAR TELÉFONO
// Archivo: routes/phone.routes.js
// Endpoint: POST /api/validar-telefono
// ===============================
const phoneRoutes = require("./routes/phone.routes.js");
app.use("/api", phoneRoutes);

// ===============================
// ✅ RUTA VALIDAR EXEQUÁTUR (SNS)
// Endpoint: POST /api/validar-exequatur
// ===============================
const exequaturRoutes = require("./routes/exequatur.routes.js");
app.use("/api", exequaturRoutes);

// ===============================
// ✅ RUTAS AGENDA / TIEMPO REAL
// ===============================
const agendaRoutes = require("./routes/agenda.routes.js");
app.use("/api/agenda", agendaRoutes);


// Catch-all
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Ruta no existe: ${req.method} ${req.originalUrl}`,
  });
});

const PORT = process.env.PORT || 3000;
initializeSocketServer(httpServer);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://localhost:${PORT}`);
});
