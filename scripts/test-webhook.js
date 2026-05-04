require("dotenv").config();
const axios = require("axios");

const testData = {
  event: "notification",
  userId: 1,
  email: "usuario_prueba@ejemplo.com",
  telefono: "+18095551234",
  tipo: "recordatorio_h1",
  titulo: "Cita en 1 hora",
  contenido: "Tu consulta con el Dr. Juan Perez inicia en 1 hora.",
  data: {
    citaId: "uuid-de-prueba",
    medicoNombre: "Dr. Juan Perez",
    pacienteNombre: "Paciente de Prueba"
  }
};

async function triggerTest() {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) {
    console.error("❌ No hay MAKE_WEBHOOK_URL en el .env");
    return;
  }

  console.log("🚀 Enviando disparo de prueba a Make...");
  try {
    const res = await axios.post(url, testData);
    console.log("✅ Recibido por Make:", res.status);
    console.log("Ya puedes volver a Make para continuar la configuración.");
  } catch (err) {
    console.error("❌ Error enviando a Make:", err.message);
  }
}

triggerTest();
