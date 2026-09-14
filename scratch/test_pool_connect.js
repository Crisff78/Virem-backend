const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('connect', (client) => {
  console.log("New client connected, setting default_transaction_read_only = off");
  client.query('SET default_transaction_read_only = off;')
    .catch(err => console.error('Error in on connect:', err.message));
});

async function run() {
  try {
    const res = await pool.query("SHOW default_transaction_read_only;");
    console.log("default_transaction_read_only query:", res.rows[0]);
    
    // Test creating a dummy table or doing some write
    console.log("Attempting a write/DDL query...");
    await pool.query("CREATE TEMP TABLE test_temp_pool (id serial);");
    console.log("Success! Temp table created.");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await pool.end();
  }
}

run();
