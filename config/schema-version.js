const REQUIRED_SCHEMA_VERSION = '20260922_patient_assistant';

async function assertSchemaReady(db) {
  try {
    const result = await db.query(
      'SELECT version FROM schema_migrations WHERE version = $1 LIMIT 1',
      [REQUIRED_SCHEMA_VERSION]
    );
    if (result.rows.length !== 1) throw new Error('Schema version missing');
  } catch (error) {
    if (error.code && error.code !== '42P01') throw error;
    throw new Error('Falta la migracion requerida. Ejecuta node scripts/migrations.js antes de iniciar el backend.');
  }
}

module.exports = { REQUIRED_SCHEMA_VERSION, assertSchemaReady };
