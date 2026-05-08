const { Pool } = require("pg");
require("dotenv").config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const r = await p.query("SELECT pattern FROM medico_horario_recurrente WHERE medicoid::text = '77b18329-6e9c-4fc7-b000-f52e7bf4bece'");
  console.log("Pattern:", JSON.stringify(r.rows[0], null, 2));
  await p.end();
}
run();
