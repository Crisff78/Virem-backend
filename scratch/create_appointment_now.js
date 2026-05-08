const pool = require('../config/db');
const { randomUUID } = require('crypto');

async function run() {
  try {
    const citaId = randomUUID();
    const pacienteId = 69; // Andris Toribio
    const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece'; // Esperanza Morales
    
    // Create for tonight 10:27 PM to 11:00 PM
    const start = new Date('2026-05-07T22:27:00-04:00');
    const end = new Date('2026-05-07T23:00:00-04:00');

    console.log('Creando cita desde:', start.toISOString(), 'hasta:', end.toISOString());

    const query = `
      INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, zonahorariaid,
        fechahorainicio, fechahorafin, modalidad, estado_codigo, estadocitaid,
        duracionmin
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    
    const values = [
      citaId, pacienteId, medicoId, 1, 1,
      start, end, 'virtual', 'confirmada', 2,
      33 // 10:27 to 11:00 is 33 mins
    ];

    const res = await pool.query(query, values);
    console.log('Cita creada exitosamente:', JSON.stringify(res.rows[0], null, 2));
    
    // Create video sala entry with livekit provider
    const videoSalaId = randomUUID();
    await pool.query(
      `INSERT INTO video_salas (videosalaid, citaid, proveedor, room_name, estado)
       VALUES ($1, $2, $3, $4, $5)`,
      [videoSalaId, citaId, 'livekit', `appt-${citaId}`, 'pendiente']
    );
    console.log('Sala de video creada (LiveKit) para la cita:', citaId);

  } catch(e) {
    console.error('Error al crear la cita:', e);
  } finally {
    process.exit();
  }
}
run();
