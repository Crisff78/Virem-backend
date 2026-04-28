const pool = require("./config/db");

async function run() {
  try {
    console.log("Añadiendo columnas financieras a 'medico' y 'cita'...");
    
    // 1. Columnas en la tabla médico para su plan de negocio
    await pool.query(`
      ALTER TABLE medico 
      ADD COLUMN IF NOT EXISTS tipo_plan VARCHAR(20) DEFAULT 'comision',
      ADD COLUMN IF NOT EXISTS comision_porcentaje NUMERIC(5,2) DEFAULT 10.00,
      ADD COLUMN IF NOT EXISTS membresia_monto NUMERIC(12,2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS membresia_activa BOOLEAN DEFAULT FALSE
    `);

    // 2. Columnas en la tabla cita para registrar el desglose del pago
    await pool.query(`
      ALTER TABLE cita 
      ADD COLUMN IF NOT EXISTS monto_total NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS monto_plataforma NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS monto_medico NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS comision_aplicada NUMERIC(5,2)
    `);

    console.log("Infraestructura financiera creada con éxito.");

  } catch (err) {
    console.error("Error en migración financiera:", err);
  } finally {
    process.exit();
  }
}

run();
