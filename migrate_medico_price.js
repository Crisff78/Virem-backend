const pool = require("./config/db");

async function run() {
  try {
    console.log("Checking for 'precio' in 'medico'...");
    const checkColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'medico' AND column_name = 'precio'
    `);

    if (checkColumns.rows.length === 0) {
      console.log("Adding 'precio' to 'medico'...");
      await pool.query(`
        ALTER TABLE medico 
        ADD COLUMN precio NUMERIC(12,2) DEFAULT 0
      `);
      console.log("Column added successfully.");
    } else {
      console.log("'precio' column already exists.");
    }

  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    process.exit();
  }
}

run();
