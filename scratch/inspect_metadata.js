const { Pool } = require("pg");
require("dotenv").config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const r1 = await p.query("SELECT tipoconsultaid, nombre FROM tipos_consulta");
  console.log("Tipos Consulta:", r1.rows);
  const r2 = await p.query("SELECT zonahorariaid, nombre FROM zonas_horarias");
  console.log("Zonas Horarias:", r2.rows);
  const r3 = await p.query("SELECT estadocitaid, codigo FROM estado_cita");
  console.log("Estados Cita:", r3.rows);
  await p.end();
}
run();
