const pool = require("./config/db");

async function run() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'medico'
    `);
    console.log("Columns in 'medico':", JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

run();
