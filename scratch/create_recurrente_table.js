const pool = require('../config/db');

async function setup() {
  try {
    console.log("Creating table medico_horario_recurrente...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS medico_horario_recurrente (
        medicoid UUID PRIMARY KEY REFERENCES medico(medicoid) ON DELETE CASCADE,
        pattern JSONB NOT NULL,
        modalidad VARCHAR(20) DEFAULT 'ambas',
        slot_minutos INTEGER DEFAULT 30,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("Table created successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Error creating table:", err);
    process.exit(1);
  }
}

setup();
