/**
 * Run: node verify-concurrency-2b.js
 * Real PostgreSQL locks/INSERTs and the real HTTP booking route/service.
 * Uses a temporary, uniquely named schema; never inserts into public tables.
 * Requires CREATE SCHEMA permission. Prefer CONCURRENCY_TEST_DATABASE_URL;
 * otherwise uses backend/.env DATABASE_URL or DB_*. Cleans its schema in finally.
 * Profiles/catalogs/notifications/email are fixtures; no external delivery occurs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

function createFixtureApp(pool, patientIds) {
  const secret = crypto.randomBytes(32).toString('hex');
  const noop = async () => {};
  const dependencies = {
    express, crypto, jsonwebtoken: jwt, '../config/db': pool, axios: {},
    '../realtime/socket': { emitCitaEvent() {}, emitConversationEvent() {} },
    './rf-core': {}, './user-profile.store': {},
    './email-service': { sendEmail: noop }, './invoice-service': { generateInvoiceHTML: () => '' },
    '../services/livekit.service': {},
  };
  function load(relative) {
    const module = { exports: {} };
    vm.compileFunction(fs.readFileSync(path.join(__dirname, relative), 'utf8'),
      ['module', 'require', 'process', 'console'], { filename: relative })(module, name => {
        if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
        return dependencies[name];
      }, { env: { NODE_ENV: 'test', JWT_SECRET: secret } }, { log() {}, warn() {}, error() {} });
    return module.exports;
  }
  const platform = load('services/platform-core.js');
  const fixturePlatform = {
    ...platform,
    async resolveUserContext(_client, user) {
      if (!patientIds.includes(Number(user?.usuarioid))) return { error: { status: 403, message: 'Unknown fixture' } };
      return { roleId: 1, user: { usuarioid: user.usuarioid, email: '' },
        paciente: { pacienteid: user.usuarioid, nombres: 'Synthetic patient' } };
    },
    ensureEstadoCatalog: async () => ({ pendiente: 1, reprogramada: 2 }),
    resolveZonaHorariaId: async () => 1,
    resolveTipoConsultaId: async () => 1,
    resolveEspecialidad: async () => ({ especialidadid: 1, permite_presencial: true, permite_virtual: true }),
    resolveMedicoUserIds: async () => [], createNotification: noop,
    appendCitaHistorial: noop, ensureConversation: async () => crypto.randomUUID(), appendSystemMessage: noop,
    async fetchCitaByIdForContext(client, { citaId }) {
      return (await client.query('SELECT * FROM cita WHERE citaid = $1 LIMIT 1', [citaId])).rows[0];
    },
  };
  dependencies['./platform-core'] = dependencies['../services/platform-core'] = fixturePlatform;
  dependencies['../services/agenda-service'] = load('services/agenda-service.js');
  dependencies['./middleware/auth'] = load('routes/middleware/auth.js');
  const app = express(); app.use(express.json());
  let waiting = [];
  // Both HTTP requests must arrive before either reservation handler proceeds.
  app.post('/api/agenda/me/citas', (req, res, next) => {
    const entry = { next, timer: null };
    entry.timer = setTimeout(() => {
      waiting = waiting.filter(item => item !== entry);
      res.status(503).json({ success: false, message: 'Concurrency barrier timed out' });
    }, 5000);
    waiting.push(entry);
    if (waiting.length === 2) {
      const ready = waiting; waiting = [];
      for (const item of ready) { clearTimeout(item.timer); item.next(); }
    }
  });
  app.use('/api/agenda', load('routes/agenda.routes.js'));
  return { app, tokens: patientIds.map(usuarioid => jwt.sign({ usuarioid, rolid: 1 }, secret, { expiresIn: '5m' })) };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
  const { Pool } = require('pg');
  const connectionString = process.env.CONCURRENCY_TEST_DATABASE_URL || process.env.DATABASE_URL;
  const pool = new Pool({
    ...(connectionString ? { connectionString } : {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    }),
    ssl: String(process.env.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 10000, lock_timeout: 5000,
  });
  const schema = 'virem_test_2b_' + crypto.randomUUID().replace(/-/g, '');
  assert.match(schema, /^virem_test_2b_[a-f0-9]{32}$/);
  const medicoId = crypto.randomUUID();
  const firstPatient = crypto.randomInt(1000000000, 1500000000);
  const patientIds = [firstPatient, firstPatient + 1];
  let created = false, server;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await pool.query(`CREATE TABLE "${schema}".especialidad (especialidadid integer PRIMARY KEY, nombre text);
      CREATE TABLE "${schema}".medico (
        medicoid uuid PRIMARY KEY, nombrecompleto text, especialidadid integer,
        tipo_plan text, comision_porcentaje numeric, membresia_activa boolean,
        precio numeric, precio_videollamada numeric, fecharegistro timestamptz
      );
      CREATE TABLE "${schema}".cita (
        citaid uuid PRIMARY KEY, pacienteid integer, medicoid uuid, tipoconsultaid integer,
        estadocitaid integer, zonahorariaid integer, fechahorainicio timestamptz,
        fechahorafin timestamptz, duracionmin integer, precio numeric, fechacreacion timestamptz,
        nota text, modalidad text, motivo_consulta text, cancelada_por text, cancelacion_motivo text,
        disponibilidadid integer, estado_codigo text, pago_completado boolean, pago_metodo text,
        pago_referencia text, pago_fecha timestamptz, monto_total numeric, monto_plataforma numeric,
        monto_medico numeric, comision_aplicada numeric, updated_at timestamptz
      )`);
    // Deliberately no unique doctor/start index: the application locking must work.
    await pool.query(`INSERT INTO "${schema}".especialidad VALUES (1, 'Fixture')`);
    await pool.query(`INSERT INTO "${schema}".medico (medicoid, nombrecompleto, especialidadid, precio)
      VALUES ($1, 'Synthetic doctor', 1, 1000)`, [medicoId]);
    const fixturePool = { async connect() {
      const client = await pool.connect();
      try { await client.query(`SET search_path TO "${schema}"`); }
      catch (error) { client.release(); throw error; }
      return {
        async query(sql, params) {
          const result = await client.query(sql, params);
          // Widen the read/insert race so this test fails reliably without locks.
          if (/^SELECT c\.citaid/.test(sql.trim())) await new Promise(resolve => setTimeout(resolve, 30));
          return result;
        },
        release() { client.release(); },
      };
    } };
    const { app, tokens } = createFixtureApp(fixturePool, patientIds);
    server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/api/agenda/me/citas`;
    for (const [caseIndex, overlapMinutes, expected] of [[0, 0, [201, 409]], [1, 15, [201, 409]], [2, 30, [201, 201]]]) {
      const start = Date.now() + (7 + caseIndex) * 86400000;
      const responses = await Promise.all(tokens.map((token, index) => fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicoId, fechaHoraInicio: new Date(start + index * overlapMinutes * 60000).toISOString(),
          duracionMin: 30, modalidad: 'presencial', precio: 1000 }),
      })));
      const bodies = await Promise.all(responses.map(response => response.json()));
      const statuses = responses.map(response => response.status).sort((a, b) => a - b);
      assert.deepEqual(statuses, expected, `Overlap ${overlapMinutes} min: unexpected HTTP statuses`);
      responses.forEach((response, index) => assert.equal(bodies[index].success, response.status < 300));
      const count = await pool.query(`SELECT COUNT(*)::integer AS total FROM "${schema}".cita
        WHERE fechahorainicio >= $1 AND fechahorainicio < $2`,
        [new Date(start), new Date(start + 3600000)]);
      assert.equal(count.rows[0].total, expected.filter(status => status < 300).length);
      console.log(`[OK] Caso ${caseIndex + 1}: HTTP ${statuses.join('/')} y filas persistidas correctas.`);
    }
  } finally {
    if (server?.listening) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    try {
      if (created) {
        // This name is generated and validated above; never derive it from user input.
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        console.log('[OK] Esquema de prueba eliminado.');
      }
    } finally { await pool.end(); }
  }
}

if (require.main === module) main().catch(error => {
  console.error('Validacion de concurrencia fallida:', error.message);
  process.exitCode = 1;
});
module.exports = { createFixtureApp };
