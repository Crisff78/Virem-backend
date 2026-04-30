const pool = require('../config/db');

async function fixAndris() {
  try {
    console.log("Linking Andris Toribio profile...");
    await pool.query(`
      UPDATE paciente 
      SET usuarioid = 5 
      WHERE pacienteid = 5;
    `);
    console.log("Link successful.");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

fixAndris();
