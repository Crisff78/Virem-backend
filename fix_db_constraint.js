const pool = require('./config/db');

async function fixConstraint() {
  try {
    console.log('Dropping existing constraint...');
    await pool.query(`
      ALTER TABLE horario_disponible 
      DROP CONSTRAINT IF EXISTS chk_horario_slot_minutos;
    `);
    console.log('Adding new relaxed constraint...');
    await pool.query(`
      ALTER TABLE horario_disponible 
      ADD CONSTRAINT chk_horario_slot_minutos CHECK (slot_minutos > 0);
    `);
    console.log('Successfully relaxed chk_horario_slot_minutos constraint!');
  } catch (err) {
    console.error('Error fixing constraint:', err);
  } finally {
    await pool.end();
  }
}

fixConstraint();
