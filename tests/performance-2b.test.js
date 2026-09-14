const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { getPagination } = require('../utils/pagination');
const { createFixtureApp } = require('../verify-concurrency-2b');

test('pagination accepts limit/offset or page and bounds invalid/oversized inputs', () => {
  assert.deepEqual(getPagination({ limit: '7', offset: '14' }), { limit: 7, offset: 14 });
  assert.deepEqual(getPagination({ limit: '7', page: '3' }), { limit: 7, offset: 14 });
  assert.deepEqual(getPagination({ limit: '99999', offset: '-1' }), { limit: 250, offset: 0 });
  assert.deepEqual(getPagination({ limit: '10;DROP TABLE usuario', offset: [] }), { limit: 50, offset: 0 });
});

function loadRoutes(file, options = {}) {
  const handlers = new Map(), calls = [];
  const router = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    router[method] = (route, ...fns) => handlers.set(method + ' ' + route, fns.at(-1));
  }
  const query = async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
    if (sql.startsWith('SELECT usuarioid, rolid, email, activo, account_status')) {
      return { rows: [{ usuarioid: 3, rolid: 3, activo: true, account_status: 'activa' }] };
    }
    assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/);
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.equal(Math.max(...placeholders), params.length, 'SQL parameters must match placeholders');
    assert.deepEqual(Array.from(params).slice(-2), [7, 14]);
    return { rows: sql.startsWith('WITH pending_page') ? Array.from({ length: options.count || 3 }, (_, i) => ({
      usuarioid: i + 20, account_status: 'pendiente_aprobacion', documentos: [{
        documentoid: 'doc-' + i, usuarioid: i + 20, archivo_url: 'https://example.invalid/document',
        tipo: 'titulo', estado_revision: 'pendiente', creado_en: '2026-09-14T00:00:00+00:00',
      }],
    })) : [] };
  };
  const normalizeText = value => String(value || '').trim().replace(/\s+/g, ' ');
  const dependencies = {
    express: { Router: () => router }, crypto,
    '../config/db': { query, connect: async () => ({ query, release() {} }) },
    '../utils/pagination': { getPagination },
    './middleware/auth': { requireAuth() {} },
    './middleware/access-control': { ADMIN_ROLE_ID: 3, MEDICO_ROLE_ID: 2,
      requireRole: () => () => {}, requireOwnership: () => () => {} },
    '../services/platform-core': { ensurePlatformSchema: async () => {},
      resolveUserContext: async (_client, user) => ({ roleId: user.rolid, user, medico: { medicoid: 'doctor' } }) },
    '../services/rf-core': { ensureRfCoreSchema: async () => {}, normalizeText,
      normalizeAccountStatus: value => value || 'activa', ACCOUNT_STATUS: { ACTIVE: 'activa', PENDING_APPROVAL: 'pendiente_aprobacion' } },
    '../services/user-profile.store': { ensureUserProfileTable: async () => {}, isSupportedImageUri: () => true },
    '../services/recetas-validator': {}, '../realtime/socket': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, process: { env: {} }, console,
    require(name) { if (!(name in dependencies)) throw new Error('Unexpected import: ' + name); return dependencies[name]; },
  });
  return { calls, async request(route, rolid = 3) {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handlers.get('get ' + route)({ query: { limit: '7', offset: '14', q: 'test' }, user: { usuarioid: 3, rolid } }, res);
    return res;
  } };
}

for (const [file, routes] of [
  ['admin.routes.js', ['/usuarios', '/citas', '/pagos', '/usuarios/modificaciones', '/valoraciones/pendientes']],
  ['medicos.routes.js', ['/', '/especialidades']],
  ['pacientes.routes.js', ['/']],
  ['recetas.routes.js', ['/medico/me/recetas', '/paciente/me/recetas']],
]) {
  test(`${file}: listings bind pagination in PostgreSQL and preserve response arrays`, async () => {
    for (const route of routes) {
      const h = loadRoutes('routes/' + file);
      const res = await h.request(route, route.startsWith('/paciente') ? 1 : route.startsWith('/medico') ? 2 : 3);
      assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
      assert.ok(Object.values(res.body).some(Array.isArray));
      assert.ok(h.calls.some(c => /OFFSET \$/.test(c.sql)));
    }
  });
}

test('pending doctor document listing executes two queries regardless of page size', async () => {
  for (const count of [1, 30]) {
    const h = loadRoutes('routes/admin.routes.js', { count });
    const res = await h.request('/medicos/pendientes');
    assert.equal(res.statusCode, 200); assert.equal(h.calls.length, 2);
    assert.match(h.calls[1].sql, /jsonb_agg/);
    assert.equal(res.body.pendientes.length, count);
    assert.equal(res.body.pendientes[0].documentos[0].archivoUrl, 'https://example.invalid/document');
    assert.equal(res.body.pendientes[0].documentos[0].creadoEn, '2026-09-14T00:00:00.000Z');
    assert.equal(res.body.pendientes[0].documentos[0].nombre, '');
  }
});

// A lock-aware adapter for isolated regressions. The stress script separately
// checks the same route/helper using PostgreSQL's actual advisory locks.
function memoryPool() {
  const rows = [], locks = new Map(), observed = [];
  const medicoId = crypto.randomUUID();
  return { rows, observed, medicoId, async connect() {
    const held = [], pending = []; let transaction = false;
    const releaseLocks = () => { held.splice(0).forEach(release => release()); };
    return { release() { assert.equal(held.length, 0, 'No locks may leak after release'); },
      async query(raw, params = []) {
        const sql = raw.replace(/\s+/g, ' ').trim(); observed.push(sql);
        if (sql.startsWith('BEGIN')) {
          assert.equal(sql, 'BEGIN ISOLATION LEVEL READ COMMITTED'); transaction = true;
          return { rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql === 'COMMIT') rows.push(...pending);
          transaction = false; releaseLocks(); return { rows: [] };
        }
        if (sql.includes('pg_advisory_xact_lock')) {
          assert.equal(transaction, true);
          const predecessor = locks.get(params[0]) || Promise.resolve();
          let unlock; const gate = new Promise(resolve => { unlock = resolve; });
          locks.set(params[0], predecessor.then(() => gate));
          await predecessor; held.push(unlock); return { rows: [{}] };
        }
        if (sql.startsWith('SELECT c.citaid')) {
          assert.ok(!sql.includes('FOR UPDATE'), 'Conflict reads must not deadlock with rescheduled rows');
          assert.equal(held.length, 2, 'Lock doctor and patient before checking for overlap');
          const matches = rows.filter(row => row.fechahorainicio < params[1] && row.fechahorafin > params[0] &&
            (row.medicoid === params[3] || row.pacienteid === params[4]) && row.citaid !== params[2]);
          await new Promise(resolve => setTimeout(resolve, 10));
          return { rows: matches };
        }
        if (sql.startsWith('INSERT INTO cita')) {
          pending.push({ citaid: params[0], pacienteid: params[1], medicoid: params[2],
            fechahorainicio: params[6], fechahorafin: params[7], estado_codigo: 'pendiente' });
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('SELECT * FROM cita')) return { rows: [...rows, ...pending].filter(row => row.citaid === params[0]) };
        if (sql.includes('FROM medico')) return { rows: [{ medicoid: medicoId, precio: 1000 }] };
        throw new Error('Unexpected fixture SQL: ' + sql);
      },
    };
  } };
}

test('two real HTTP booking requests serialize: identical/overlapping conflict, adjacent succeeds', async () => {
  for (const [minutes, expected] of [[0, [201, 409]], [15, [201, 409]], [30, [201, 201]]]) {
    const pool = memoryPool(); const { app, tokens } = createFixtureApp(pool, [101, 102]);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now() + 86400000;
      const responses = await Promise.all(tokens.map((token, i) => fetch(`http://127.0.0.1:${server.address().port}/api/agenda/me/citas`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicoId: pool.medicoId, fechaHoraInicio: new Date(start + i * minutes * 60000).toISOString(), precio: 1000 }),
        signal: AbortSignal.timeout(5000),
      })));
      assert.deepEqual(responses.map(res => res.status).sort(), expected);
      assert.equal(pool.rows.length, expected.filter(status => status === 201).length);
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
});

test('rescheduling rejects patient overlap with a different doctor and rolls back unchanged', async () => {
  const pool = memoryPool();
  const firstStart = new Date(Date.now() + 86400000).toISOString();
  const nextStart = new Date(Date.now() + 2 * 86400000).toISOString();
  const citaId = crypto.randomUUID();
  pool.rows.push(
    { citaid: citaId, pacienteid: 101, medicoid: pool.medicoId, fechahorainicio: firstStart,
      fechahorafin: new Date(Date.parse(firstStart) + 1800000).toISOString(), duracionmin: 30, estado_codigo: 'pendiente' },
    { citaid: crypto.randomUUID(), pacienteid: 101, medicoid: crypto.randomUUID(), fechahorainicio: nextStart,
      fechahorafin: new Date(Date.parse(nextStart) + 1800000).toISOString(), duracionmin: 30, estado_codigo: 'pendiente' }
  );
  const before = structuredClone(pool.rows);
  const { app, tokens } = createFixtureApp(pool, [101, 102]);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agenda/me/citas/${citaId}/reprogramar`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fechaHoraInicio: nextStart }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).success, false);
    assert.deepEqual(pool.rows, before);
    assert.ok(pool.observed.includes('ROLLBACK'));
    assert.ok(!pool.observed.some(sql => sql.startsWith('UPDATE cita')));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
