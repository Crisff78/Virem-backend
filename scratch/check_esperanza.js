const pool = require('../config/db');

async function checkMedico() {
  try {
    console.log("Searching for medico: Esperanza Morales de la Cruz...");
    const result = await pool.query(`
      SELECT m.*, e.nombre as especialidad_nombre
      FROM medico m
      LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
      WHERE m.nombrecompleto ILIKE '%Esperanza Morales de la Cruz%'
    `);

    if (result.rows.length === 0) {
      console.log("Medico not found.");
    } else {
      console.log("Medico found:");
      console.log(JSON.stringify(result.rows, null, 2));
    }

    const allEspecialidades = await pool.query("SELECT * FROM especialidad");
    console.log("Available Especialidades:");
    console.log(JSON.stringify(allEspecialidades.rows, null, 2));

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

checkMedico();
