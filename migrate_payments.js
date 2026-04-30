const pool = require("./config/db");

async function run() {
  try {
    console.log("Checking for payment columns in 'cita'...");
    const checkColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'cita' AND column_name = 'pago_completado'
    `);

    if (checkColumns.rows.length === 0) {
      console.log("Adding payment columns to 'cita'...");
      await pool.query(`
        ALTER TABLE cita 
        ADD COLUMN pago_completado BOOLEAN DEFAULT FALSE,
        ADD COLUMN pago_metodo VARCHAR(50),
        ADD COLUMN pago_referencia VARCHAR(100),
        ADD COLUMN pago_fecha TIMESTAMPTZ
      `);
      console.log("Columns added successfully.");
    } else {
      console.log("Payment columns already exist.");
    }

  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    process.exit();
  }
}

run();
