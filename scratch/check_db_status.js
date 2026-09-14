const pool = require('../config/db');

async function check() {
  try {
    const resRecovery = await pool.query("SELECT pg_is_in_recovery();");
    console.log("pg_is_in_recovery:", resRecovery.rows[0]);

    const resReadOnly = await pool.query("SHOW default_transaction_read_only;");
    console.log("default_transaction_read_only:", resReadOnly.rows[0]);

    const resTransReadOnly = await pool.query("SHOW transaction_read_only;");
    console.log("transaction_read_only:", resTransReadOnly.rows[0]);

    const resSession = await pool.query("SELECT current_user, current_database();");
    console.log("current_user & database:", resSession.rows[0]);

  } catch (err) {
    console.error("Error checking DB status:", err.message);
  } finally {
    await pool.end();
  }
}

check();
