const pool = require('../config/db');
async function run() {
  try {
    const tipos = await pool.query("SELECT tipoconsultaid, nombre FROM tipos_consulta LIMIT 5");
    const zonas = await pool.query("SELECT zonahorariaid, nombre FROM zonas_horarias LIMIT 5");
    console.log(JSON.stringify({tipos: tipos.rows, zonas: zonas.rows}, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
