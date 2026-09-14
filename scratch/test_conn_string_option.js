const { Pool } = require("pg");
require("dotenv").config();

// Let's parse DATABASE_URL and append the options parameter
const originalUrl = process.env.DATABASE_URL;
const separator = originalUrl.includes('?') ? '&' : '?';
const newUrl = `${originalUrl}${separator}options=-c%20default_transaction_read_only%3Doff`;

console.log("Connecting to:", newUrl);

const pool = new Pool({
  connectionString: newUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("SHOW default_transaction_read_only;");
    console.log("default_transaction_read_only query:", res.rows[0]);
    
    console.log("Attempting a write/DDL query...");
    await pool.query("CREATE TEMP TABLE test_temp_opt (id serial);");
    console.log("Success! Temp table created.");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await pool.end();
  }
}

run();
