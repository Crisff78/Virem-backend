const pool = require("../config/db");
const { createNotification, resolveMedicoUserIds } = require("./platform-core");
const axios = require("axios");

/**
 * Service to process appointment reminders (24h, 1h, and starting now).
 */
async function processPendingReminders() {
  let client;
  try {
    client = await pool.connect();

    // 1. Find upcoming virtual appointments that are "active" (pendiente, confirmada, reprogramada)
    // and haven't sent certain reminders yet.
    const result = await client.query(
      `SELECT 
         c.citaid::text AS citaid,
         c.pacienteid,
         c.medicoid::text AS medicoid,
         c.fechahorainicio,
         c.reminders_sent,
         p.usuarioid AS paciente_usuarioid,
         p.nombres || ' ' || p.apellidos AS paciente_nombre,
         m.nombrecompleto AS medico_nombre
       FROM cita c
       JOIN paciente p ON p.pacienteid = c.pacienteid
       JOIN medico m ON m.medicoid = c.medicoid
       WHERE lower(c.modalidad) = 'virtual'
         AND lower(c.estado_codigo) IN ('pendiente', 'confirmada', 'reprogramada')
         AND c.fechahorainicio > NOW() - INTERVAL '10 minutes'
         AND c.fechahorainicio < NOW() + INTERVAL '25 hours'`
    );

    const appointments = result.rows;
    const now = new Date();

    for (const cita of appointments) {
      const startTime = new Date(cita.fechahorainicio);
      const diffMs = startTime.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      const diffMins = diffMs / (1000 * 60);

      const sent = cita.reminders_sent || {};
      let needsUpdate = false;

      // --- 24 Hours Reminder ---
      if (diffHours <= 24 && diffHours > 1 && !sent.h24) {
        await sendReminder(cita, "h24", "Recordatorio de cita mañana", `Mañana tienes una consulta virtual con ${cita.medico_nombre} a las ${formatTime(startTime)}.`);
        sent.h24 = true;
        needsUpdate = true;
      }

      // --- 1 Hour Reminder ---
      if (diffHours <= 1 && diffMins > 5 && !sent.h1) {
        await sendReminder(cita, "h1", "Tu cita inicia en 1 hora", `En una hora inicia tu consulta virtual con ${cita.medico_nombre}.`);
        sent.h1 = true;
        needsUpdate = true;
      }

      // --- Starting Now Reminder ---
      if (diffMins <= 5 && diffMins >= -5 && !sent.now) {
        await sendReminder(cita, "now", "¡Es hora de tu consulta!", `Tu consulta con ${cita.medico_nombre} está iniciando. Entra a la sala virtual ahora.`);
        sent.now = true;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await client.query(
          "UPDATE cita SET reminders_sent = $1 WHERE citaid::text = $2",
          [JSON.stringify(sent), cita.citaid]
        );
      }
    }
  } catch (err) {
    console.error("[ReminderService] Error processing reminders:", err);
  } finally {
    if (client) client.release();
  }
}

async function sendReminder(cita, type, title, content) {
  console.log(`[ReminderService] Sending ${type} reminder for cita ${cita.citaid}`);

  const reminderData = {
    citaId: cita.citaid,
    type,
    pacienteNombre: cita.paciente_nombre,
    medicoNombre: cita.medico_nombre,
    fechaHora: cita.fechahorainicio,
  };

  // 1. Send Notification to Patient
  await createNotification(pool, {
    usuarioid: cita.paciente_usuarioid,
    tipo: `recordatorio_${type}`,
    titulo: title,
    contenido: content,
    data: reminderData
  });

  // 2. Send Notification to Doctor
  const medicoUserIds = await resolveMedicoUserIds(pool, cita.medicoid);
  for (const userId of medicoUserIds) {
    await createNotification(pool, {
      usuarioid: userId,
      tipo: `recordatorio_${type}`,
      titulo: title,
      contenido: content,
      data: reminderData
    });
  }
}

function formatTime(date) {
  return date.toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" });
}

module.exports = { processPendingReminders };
