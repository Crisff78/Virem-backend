const pool = require('../config/db');

async function run() {
  const client = await pool.connect();
  try {
    console.log("Setting transaction read-only off...");
    await client.query("SET default_transaction_read_only = off;");
    
    const resReadOnly = await client.query("SHOW default_transaction_read_only;");
    console.log("default_transaction_read_only after SET:", resReadOnly.rows[0]);

    // Let's see if we can do a test query or run a transaction
    await client.query("BEGIN;");
    await client.query("SET TRANSACTION READ WRITE;");
    // Just run a benign select
    const res = await client.query("SELECT 1;");
    console.log("SELECT 1 in READ WRITE transaction:", res.rows[0]);
    await client.query("COMMIT;");
    console.log("Transaction committed successfully!");
  } catch (err) {
    console.error("Error running test:", err.message);
    try { await client.query("ROLLBACK;"); } catch(e){}
  } finally {
    client.release();
    await pool.end();
  }
}

run();
