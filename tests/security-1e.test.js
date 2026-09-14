// Real modules and handlers; isolated DB/Socket.IO adapters, no network or .env.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');

function harness(options = {}) {
  const users = {
    3: { usuarioid: 3, rolid: 3, activo: true, account_status: 'activa', email_verificado: true },
    20: { usuarioid: 20, rolid: 2, activo: true, account_status: 'activa', email_verificado: true },
    99: { usuarioid: 99, rolid: 1, activo: true, account_status: 'activa', email_verificado: true },
  };
  const calls = [], events = [], notifications = [], sockets = [];
  let outstanding = 0, snapshot;
  const result = (rows = []) => ({ rows: structuredClone(rows), rowCount: rows.length });
  const cita = { citaid: 'cita-1', pacienteid: '7', medicoid: 'doctor-20', modalidad: 'virtual',
    fechahorainicio: new Date().toISOString(), estado_codigo: 'confirmada' };
  const db = {
    async connect() {
      if (options.failConnect) throw new Error('Synthetic connection failure');
      outstanding++;
      return { query: db.query, release() { outstanding--; } };
    },
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim(); calls.push(sql);
      if (sql === 'BEGIN') { snapshot = structuredClone(users); return result(); }
      if (sql === 'COMMIT') {
        if (options.failCommit) throw new Error('Synthetic commit failure');
        snapshot = undefined; return result();
      }
      if (sql === 'ROLLBACK') { if (snapshot) Object.assign(users, snapshot); return result(); }
      if (sql.includes('FROM usuario') && sql.startsWith('SELECT')) return result(users[params[0]] ? [users[params[0]]] : []);
      if (sql.startsWith('UPDATE usuario SET activo')) {
        Object.assign(users[params[2]], { activo: params[0], account_status: params[1], rolid: params[3] });
        return result([users[params[2]]]);
      }
      if (sql.startsWith('UPDATE usuario SET account_status')) {
        Object.assign(users[params[1]], { activo: false, account_status: params[0] }); return result();
      }
      if (sql.startsWith('UPDATE medico_documento')) return result();
      if (sql.includes('FROM medico') && sql.startsWith('SELECT')) return result([{ medicoid: 'doctor-' + params[0] }]);
      if (sql.includes('FROM paciente') && sql.startsWith('SELECT')) return result([{ pacienteid: '7' }]);
      if (sql.includes('FROM cita c')) {
        if (options.failCita) throw new Error('Synthetic appointment failure');
        const allowed = params[0] === 'cita-1' &&
          (sql.includes('AND c.pacienteid') ? Number(params[1]) === 7 : params[1] === 'doctor-20');
        return result(allowed ? [{ ...cita,
          ...(sql.includes('p.usuarioid AS paciente_usuarioid')
            ? { paciente_usuarioid: options.orphanPatient ? null : 99 } : {}) }] : []);
      }
      if (sql.includes('FROM conversaciones conv')) {
        if (options.failConversation) throw new Error('Synthetic conversation failure');
        return result(params[0] === 'conversation-1' && !options.denyConversation
          ? [{ conversacionid: 'conversation-1', citaid: 'cita-1', pacienteid: '7', medicoid: 'doctor-20' }] : []);
      }
      if (sql.startsWith('UPDATE video_salas')) return result([{ videosalaid: 'room-1', estado: 'abierta' }]);
      if (sql.startsWith('INSERT INTO notificaciones')) {
        notifications.push(params[0]); return result([{ notificacionid: '1', created_at: new Date().toISOString() }]);
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
  };
  let io;
  class FakeServer {
    constructor() { io = this; }
    use(fn) { this.authenticate = fn; }
    on(event, fn) { if (event === 'connection') this.connection = fn; }
    to(room) { return { emit: (event, payload) => events.push({ room, event, payload }) }; }
    in(room) { return { disconnectSockets: force => {
      assert.equal(force, true); calls.push('DISCONNECT ' + room);
      sockets.filter(s => s.rooms.has(room)).forEach(s => s.disconnect(true));
    } }; }
  }
  const dependencies = {
    '../utils/pagination': require('../utils/pagination'),
    crypto, bcrypt, axios: {}, nodemailer: {},
    '../config/db': db,
    jsonwebtoken: { verify: token => ({ usuarioid: Number(token) }) },
    'socket.io': { Server: FakeServer },
    '../config/env': { getSocketCorsOrigins: () => [] },
    '../services/user-profile.store': { getUserProfileById: async () => null },
    './user-profile.store': { getUserProfileById: async () => null },
    './middleware/auth': { requireAuth() {} },
    '../services/agenda-service': {}, '../services/livekit.service': {},
    '../services/exequatur.provider.js': {}, '../middleware/rate-limit': {},
  };
  function load(file, extra = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      module, Buffer, URL, URLSearchParams, process: { env: { NODE_ENV: 'test', JWT_SECRET: 'test-only' } },
      console: { log() {}, warn() {}, error() {} },
      require(name) {
        const map = { ...dependencies, ...extra };
        if (!(name in map)) throw new Error('Unmocked dependency: ' + name);
        return map[name];
      },
    });
    return module.exports;
  }
  const rf = load('services/rf-core.js');
  dependencies['../services/rf-core'] = dependencies['./rf-core'] = {
    ...rf, ensureRfCoreSchema: async () => {}, recordUserModification: async () => calls.push('AUDIT'),
  };
  const realtime = load('realtime/socket.js');
  dependencies['../realtime/socket'] = realtime;
  realtime.initializeSocketServer({});
  const platform = load('services/platform-core.js');
  dependencies['../services/platform-core'] = {
    ...platform, ensurePlatformSchema: async () => {},
    ensureConversation: async () => 'conversation-1', ensureVideoSala: async () => ({}),
    appendSystemMessage: async () => {},
  };
  function routes(file) {
    const handlers = new Map(), router = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
      router[method] = (route, ...fns) => handlers.set(method + ' ' + route, fns.at(-1));
    }
    load(file, { express: { Router: () => router } });
    return handlers;
  }
  async function request(file, route, req) {
    const handler = routes(file).get(route); assert.ok(handler);
    const res = { statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res); return res;
  }
  return { users, options, calls, events, notifications, realtime, platform, db, routes, request,
    get outstanding() { return outstanding; },
    async connect(userId) {
      const handlers = new Map();
      const socket = { connected: true, data: {}, rooms: new Set(),
        handshake: { auth: { token: String(userId) } },
        join(room) { this.rooms.add(room); }, leave(room) { this.rooms.delete(room); },
        on(event, fn) { handlers.set(event, fn); }, use(fn) { this.middleware = fn; },
        to: room => io.to(room),
        disconnect() { this.connected = false; this.rooms.clear(); },
        async dispatch(event, payload) {
          let response, allowed = false;
          const ack = data => { response = data; };
          const packet = [event, payload, ack];
          await this.middleware(packet, () => { allowed = true; });
          if (allowed) {
            if (event === 'join:admin_monitoring') await handlers.get(event)(ack);
            else await handlers.get(event)(payload, ack);
          }
          return response;
        },
      };
      let failure;
      await io.authenticate(socket, err => { failure = err; });
      if (failure) throw failure;
      sockets.push(socket); io.connection(socket); return socket;
    },
  };
}

test('null/primitive payloads cannot crash call, typing or RTC handlers', async () => {
  const h = harness(); const s = await h.connect(20);
  for (const event of ['typing', 'call:invite', 'call:accept', 'rtc:offer']) {
    for (const payload of [null, undefined, [], 'bad']) {
      assert.equal((await s.dispatch(event, payload)).code, 'payload_invalid');
    }
  }
  assert.equal(h.outstanding, 0); assert.equal(s.connected, true);
});

test('call invitations require DB appointment membership and use its participant rooms', async () => {
  const h = harness(); const s = await h.connect(20);
  assert.equal((await s.dispatch('call:invite', { citaId: 'someone-elses-cita' })).ok, false);
  assert.equal(h.events.filter(e => e.event === 'call:incoming').length, 0);
  assert.equal((await s.dispatch('call:invite', { citaId: 'cita-1', pacienteId: 'attacker' })).ok, true);
  assert.deepEqual(h.events.filter(e => e.event === 'call:incoming').map(e => e.room),
    ['cita:cita-1', 'paciente:7', 'medico:doctor-20']);
  assert.equal(h.outstanding, 0);
});

test('SQL failures return server_error and release every acquired connection', async () => {
  const h = harness(); const s = await h.connect(20);
  h.options.failCita = true;
  assert.equal((await s.dispatch('call:invite', { citaId: 'cita-1' })).code, 'server_error');
  h.options.failConnect = true;
  assert.equal((await s.dispatch('call:invite', { citaId: 'cita-1' })).code, 'server_error');
  assert.equal(h.outstanding, 0);
  assert.equal(h.events.filter(e => e.event === 'call:incoming').length, 0);
});

test('typing rechecks conversation ownership even after previously joining', async () => {
  const h = harness(); const s = await h.connect(20);
  await s.dispatch('join:conversation', 'conversation-1');
  h.options.denyConversation = true;
  assert.equal((await s.dispatch('typing', { conversacionId: 'conversation-1', isTyping: true })).ok, false);
  h.options.denyConversation = false;
  assert.equal((await s.dispatch('typing', { conversacionId: 'conversation-1', isTyping: true })).ok, true);
  h.options.failConversation = true;
  assert.equal((await s.dispatch('typing', { conversacionId: 'conversation-1', isTyping: false })).code, 'server_error');
  assert.equal(h.events.filter(e => e.event === 'typing').length, 1);
  assert.equal(h.outstanding, 0);
});

test('HTTP blocking disconnects all target devices only after COMMIT', async () => {
  const h = harness(); const a = await h.connect(20), b = await h.connect(20), other = await h.connect(99);
  const res = await h.request('routes/admin.routes.js', 'patch /usuarios/:usuarioId/estado',
    { user: { usuarioid: 3 }, params: { usuarioId: '20' }, body: { accountStatus: 'bloqueada' } });
  assert.equal(res.statusCode, 200); assert.equal(a.connected, false); assert.equal(b.connected, false);
  assert.equal(other.connected, true);
  assert.ok(h.calls.indexOf('COMMIT') < h.calls.indexOf('DISCONNECT user:20'));
  await assert.rejects(h.connect(20), /user_not_found/);
  assert.equal(h.outstanding, 0);
});

test('HTTP admin demotion removes monitoring sockets and audits the role mutation', async () => {
  const h = harness(); const admin = await h.connect(3);
  await admin.dispatch('join:admin_monitoring'); assert.ok(admin.rooms.has('admin_monitoring'));
  const res = await h.request('routes/admin.routes.js', 'patch /usuarios/:usuarioId/estado',
    { user: { usuarioid: 3 }, params: { usuarioId: '3' }, body: { rolid: 1 } });
  assert.equal(res.statusCode, 200); assert.equal(h.users[3].rolid, 1);
  assert.equal(admin.connected, false); assert.equal(admin.rooms.size, 0);
  assert.ok(h.calls.includes('AUDIT'));
});

test('failed commit never disconnects an unchanged account', async () => {
  const h = harness({ failCommit: true }); const s = await h.connect(20);
  const res = await h.request('routes/admin.routes.js', 'patch /usuarios/:usuarioId/estado',
    { user: { usuarioid: 3 }, params: { usuarioId: '20' }, body: { activo: false } });
  assert.equal(res.statusCode, 500); assert.equal(s.connected, true); assert.equal(h.users[20].activo, true);
  assert.equal(h.outstanding, 0);
});

test('cached socket roles and HTTP JWT roles cannot retain downgraded privileges', async () => {
  const h = harness(); const s = await h.connect(3); h.users[3].rolid = 1;
  assert.equal((await s.dispatch('join:admin_monitoring')).code, 'access_revoked');
  assert.equal(s.connected, false);
  const context = await h.platform.resolveUserContext(h.db, { usuarioid: 3, rolid: 3 });
  assert.equal(context.error.status, 403);
});

test('open/close video notifications resolve paciente.usuarioid, never pacienteid', async () => {
  for (const action of ['abrir', 'finalizar']) {
    const h = harness();
    const res = await h.request('routes/agenda.routes.js', 'post /me/citas/:citaId/video-sala/' + action,
      { user: { usuarioid: 20, rolid: 2 }, params: { citaId: 'cita-1' }, body: {} });
    assert.equal(res.statusCode, 200); assert.deepEqual(h.notifications, [99]);
    assert.ok(h.events.some(e => e.event === 'notificacion_nueva' && e.room === 'user:99'));
    assert.ok(!h.events.some(e => e.room === 'user:7')); assert.equal(h.outstanding, 0);
  }
});

test('orphan patient associations never fall back to another account ID', async () => {
  const h = harness({ orphanPatient: true });
  const res = await h.request('routes/agenda.routes.js', 'post /me/citas/:citaId/video-sala/abrir',
    { user: { usuarioid: 20, rolid: 2 }, params: { citaId: 'cita-1' }, body: {} });
  assert.equal(res.statusCode, 200); assert.deepEqual(h.notifications, []);
});

test('public mail diagnostic route is absent and module imports resolve', () => {
  const h = harness(); assert.equal(h.routes('routes/auth.routes.js').has('get /debug-email'), false);
});
