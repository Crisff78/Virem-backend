const pool = require('../config/db');
async function run() {
  try {
    const med = await pool.query("SELECT m.medicoid, m.nombrecompleto, m.usuarioid FROM medico m WHERE m.nombrecompleto ILIKE '%Esperanza%'");
    const pac = await pool.query("SELECT p.pacienteid, p.nombres, p.apellidos, p.usuarioid FROM paciente p WHERE p.nombres ILIKE '%Maria%' AND p.apellidos ILIKE '%Castillo%'");
    console.log(JSON.stringify({medicos: med.rows, pacientes: pac.rows}, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
