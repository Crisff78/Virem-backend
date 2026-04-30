const pool = require("./config/db");

async function run() {
  try {
    console.log("Configurando precio de prueba para la Dra. Esperanza...");
    await pool.query(`
      UPDATE medico 
      SET precio = 1500.00, 
          tipo_plan = 'comision', 
          comision_porcentaje = 10.00 
      WHERE medicoid IN (
        SELECT medicoid FROM medico WHERE nombrecompleto ILIKE '%Esperanza%' LIMIT 1
      )
    `);
    console.log("Dra. Esperanza configurada con $1,500.00 y 10% de comisión.");
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

run();
