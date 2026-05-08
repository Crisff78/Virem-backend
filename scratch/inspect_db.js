const { Pool } = require("pg");
require("dotenv").config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const r = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log("Tables:", r.rows.map(x=>x.table_name).join(", "));
  const c = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'cita' AND table_schema = 'public'");
  console.log("Cita Columns:", c.rows.map(x=>x.column_name).join(", "));
  await p.end();
}
run();
