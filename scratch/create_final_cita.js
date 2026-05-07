const pool = require('../config/db');
const { randomUUID } = require('crypto');

async function run() {
  try {
    const citaId = randomUUID();
    const pacienteId = 69;
    const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece';
    
    // Create for today 2:55 PM
    // The current time in logs is 2026-05-07T14:51:33-04:00
    const start = new Date('2026-05-07T14:55:00-04:00');
    const end = new Date('2026-05-07T15:25:00-04:00');

    const query = `
      INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, zonahorariaid,
        fechahorainicio, fechahorafin, modalidad, estado_codigo, estadocitaid,
        duracionmin
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    
    // We'll use estadocitaid 2 for confirmed (common pattern)
    // and tipoconsultaid 1 for Videoconsulta
    const values = [
      citaId, pacienteId, medicoId, 1, 1,
      start, end, 'virtual', 'confirmada', 2,
      30
    ];

    const res = await pool.query(query, values);
    console.log('Cita creada exitosamente:', JSON.stringify(res.rows[0], null, 2));
    
    // Create video sala entry too
    const videoSalaId = randomUUID();
    await pool.query(
      `INSERT INTO video_salas (videosalaid, citaid, proveedor, room_name, estado)
       VALUES ($1, $2, $3, $4, $5)`,
      [videoSalaId, citaId, 'zego', `appt-${citaId}`, 'pendiente']
    );
    console.log('Sala de video creada para la cita.');

  } catch(e) {
    console.error('Error al crear la cita:', e);
  } finally {
    process.exit();
  }
}
run();
