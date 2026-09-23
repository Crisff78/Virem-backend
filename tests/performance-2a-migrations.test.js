const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runMigrations, migrations } = require('../scripts/migrations');
const { assertSchemaReady, REQUIRED_SCHEMA_VERSION } = require('../config/schema-version');

function database(options = {}) {
  let ledger = new Map(), snapshot;
  const calls = [];
  return { calls, get ledger() { return ledger; }, async query(sql, params = []) {
    calls.push(sql);
    if (sql === 'BEGIN') snapshot = new Map(ledger);
    if (sql === 'ROLLBACK') ledger = snapshot;
    if (sql.startsWith('-- Extracted') && options.failSchema) throw new Error('Synthetic DDL failure');
    if (sql.startsWith('INSERT INTO schema_migrations')) ledger.set(params[0], params[1]);
    if (sql.startsWith('SELECT checksum')) return { rows: ledger.has(params[0]) ? [{ checksum: ledger.get(params[0]) }] : [] };
    if (sql.startsWith('SELECT version')) return { rows: ledger.has(params[0]) ? [{ version: params[0] }] : [] };
    return { rows: [] };
  } };
}

test('migration is atomic, versioned and is not repeated on a subsequent run', async () => {
  const db = database();
  assert.deepEqual(await runMigrations(db), migrations.map(m => m.version));
  assert.equal(db.calls[0], 'BEGIN'); assert.equal(db.calls.at(-1), 'COMMIT');
  assert.ok(db.calls.indexOf('SELECT pg_advisory_xact_lock(867473, 2001)') <
    db.calls.findIndex(sql => sql.startsWith('CREATE TABLE')));
  assert.ok(db.calls.includes("SET LOCAL lock_timeout = '5s'"));
  assert.deepEqual(await runMigrations(db), []);
  assert.equal(db.calls.filter(sql => sql.startsWith('-- Extracted')).length, 1);
  await assertSchemaReady(db);
});

test('DDL failure rolls back and never records a completed version', async () => {
  const db = database({ failSchema: true });
  await assert.rejects(runMigrations(db), /Synthetic DDL failure/);
  assert.equal(db.calls.at(-1), 'ROLLBACK'); assert.equal(db.ledger.size, 0);
  assert.ok(!db.calls.some(sql => sql.startsWith('INSERT INTO schema_migrations')));
});

test('previously applied migrations cannot silently change', async () => {
  const db = database(); await runMigrations(db);
  db.ledger.set(REQUIRED_SCHEMA_VERSION, 'unexpected-checksum');
  await assert.rejects(runMigrations(db), /cambio despues de aplicarse/);
  assert.equal(db.calls.at(-1), 'ROLLBACK');
});

test('startup fails clearly when required schema migration is absent', async () => {
  await assert.rejects(assertSchemaReady(database()), /node scripts\/migrations.js/);
  await assert.rejects(assertSchemaReady({ query: async () => {
    throw Object.assign(new Error('missing table'), { code: '42P01' });
  } }), /node scripts\/migrations.js/);
});

test('runtime source has no schema-changing SQL; migration retains required tables and security columns', () => {
  const root = path.join(__dirname, '..');
  const ddl = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|(?:UNIQUE\s+)?INDEX|FUNCTION|EXTENSION)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/i;
  for (const folder of ['routes', 'services', 'config', 'realtime']) {
    function scan(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (file.endsWith('.js')) assert.ok(!ddl.test(fs.readFileSync(file, 'utf8')), file);
      }
    }
    scan(path.join(root, folder));
  }
  const sql = fs.readFileSync(migrations[0].file, 'utf8');
  for (const required of ['pending_registration', 'admin_mfa_challenge', 'password_reset_code',
    'recovery_ticket_hash', 'recovery_ticket_expires_at', 'usuario_perfil', 'receta_medica',
    'f_unaccent', 'idx_cita_medico_estado_fecha', 'uq_cita_medico_inicio_activa']) {
    assert.ok(sql.includes(required), required);
  }
});

test('compatibility schema helpers never acquire a pool connection or query inside a business transaction', async () => {
  const forbidden = () => { throw new Error('Schema helper accessed DB'); };
  for (const [file, fn] of [
    ['services/rf-core.js', 'ensureRfCoreSchema'],
    ['services/platform-core.js', 'ensurePlatformSchema'],
    ['services/user-profile.store.js', 'ensureUserProfileTable'],
  ]) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      module, process: { env: {} }, require: name => name === '../config/db'
        ? { query: forbidden, connect: forbidden } : {},
    });
    await module.exports[fn]({ query: forbidden });
    await module.exports[fn]();
  }
});

test('platform SELECT queries include explicit LIMITs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/platform-core.js'), 'utf8');
  const selects = [...source.matchAll(/([`"])(SELECT\s[\s\S]*?)\1/g)];
  assert.ok(selects.length > 10);
  for (const [sql] of selects) assert.match(sql, /\bLIMIT\b/i);
});
