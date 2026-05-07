const pool = require('../config/db');
async function run() {
  try {
    const res = await pool.query("SELECT usuarioid, email FROM usuario WHERE usuarioid IN (18, 69)");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
