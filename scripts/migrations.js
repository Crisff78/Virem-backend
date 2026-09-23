// Explicit deployment step. Never imported/executed by a request or app startup.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { REQUIRED_SCHEMA_VERSION } = require('../config/schema-version');

const migrations = ['20260914_02a_runtime_schema', REQUIRED_SCHEMA_VERSION].map(version => ({
  version, file: path.join(__dirname, 'migrations', `${version}.sql`),
}));

async function runMigrations(client) {
  const applied = [];
  await client.query('BEGIN');
  try {
    // Both table-lock waits and competing deploys fail with a bounded timeout.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock(867473, 2001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const migration of migrations) {
      const sql = fs.readFileSync(migration.file, 'utf8');
      // Git may check out SQL using CRLF on Windows and LF on Linux.
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1 LIMIT 1', [migration.version]
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`La migracion ${migration.version} cambio despues de aplicarse.`);
        }
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, checksum]);
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  const { Client } = require('pg');
  const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const client = new Client({
    ...(connectionString ? { connectionString } : {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    }),
    ssl: String(process.env.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    const applied = await runMigrations(client);
    console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'Esquema al dia; ninguna migracion pendiente.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fallo la migracion:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations, migrations };
