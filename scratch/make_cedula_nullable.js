const { Pool } = require("pg");
require("dotenv").config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  try {
    await p.query("ALTER TABLE paciente ALTER COLUMN cedula DROP NOT NULL");
    console.log("Column 'cedula' is now nullable in 'paciente' table.");
  } catch (err) {
    console.error("Error altering table:", err.message);
  } finally {
    await p.end();
  }
}
run();
