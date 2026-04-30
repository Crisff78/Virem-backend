const pool = require('../config/db');

async function cleanupDuplicates() {
  try {
    console.log("Analyzing users for Esperanza Morales de la Cruz...");
    const result = await pool.query(`
      SELECT u.usuarioid, u.email, m.medicoid, m.especialidadid, m.fecharegistro, e.nombre as especialidad
      FROM usuario u
      JOIN medico m ON m.usuarioid = u.usuarioid
      LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
      WHERE m.nombrecompleto ILIKE '%Esperanza Morales de la Cruz%'
      ORDER BY m.fecharegistro DESC
    `);

    console.log("Users and Medicos linked:");
    console.log(JSON.stringify(result.rows, null, 2));

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

cleanupDuplicates();
