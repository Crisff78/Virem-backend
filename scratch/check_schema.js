const { Pool } = require("pg");
require("dotenv").config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const r = await p.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'paciente' AND column_name = 'cedula'");
  console.log("Schema:", r.rows);
  await p.end();
}
run();
