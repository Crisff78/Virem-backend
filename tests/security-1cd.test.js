// Actual login handler with isolated PostgreSQL/mail adapters. No .env/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const PASSWORD = 'SyntheticAdmin9!';
const SECRET = 'isolated-mfa-secret-not-for-deployment';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function harness(options = {}) {
  const user = { usuarioid: 42, rolid: 3, email: 'staff@example.invalid',
    passwordhash: PASSWORD_HASH, activo: true, account_status: 'activa', email_verificado: true,
    ...options.user };
  let challenge = null;
  let snapshot;
  const calls = [];
  const deliveries = [];
  const logs = [];
  let signed = 0;
  const db = {
    async connect() { return this; },
    release() { calls.push('RELEASE'); },
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      calls.push(sql);
      const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
      if (sql === 'BEGIN') { snapshot = structuredClone(challenge); return result([]); }
      if (sql === 'COMMIT') { snapshot = undefined; return result([]); }
      if (sql === 'ROLLBACK') { challenge = snapshot; snapshot = undefined; return result([]); }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS admin_mfa_challenge')) return result([]);
      if (sql.includes('FROM usuario WHERE email')) {
        assert.ok(sql.endsWith('FOR UPDATE'), 'Serialize MFA requests for the same account');
        return result(!options.missingUser && user.email === params[0] ? [user] : []);
      }
      if (sql.startsWith('SELECT *, expires_at')) {
        assert.ok(sql.endsWith('FOR UPDATE'));
        return result(challenge ? [{ ...challenge, unexpired: challenge.expires_at > Date.now(),
          resend_blocked: challenge.sent_at > Date.now() - params[1] * 1000 }] : []);
      }
      if (sql.startsWith('INSERT INTO admin_mfa_challenge')) {
        const attempts = challenge?.expires_at > Date.now() ? challenge.attempts : 0;
        assert.ok(sql.includes('THEN admin_mfa_challenge.attempts ELSE 0 END'), 'Resending cannot reset active attempt budget');
        challenge = { usuarioid: params[0], challenge_id: params[1], code_hash: params[2],
          expires_at: Date.now() + params[3] * 60000, sent_at: Date.now(), attempts, used_at: null };
        return result([challenge]);
      }
      if (sql.startsWith('UPDATE admin_mfa_challenge SET attempts')) {
        challenge.attempts++;
        return result([challenge]);
      }
      if (sql.startsWith('UPDATE admin_mfa_challenge SET used_at')) {
        assert.ok(sql.includes('expires_at > clock_timestamp()') && sql.includes('used_at IS NULL'));
        if (options.failConsume || !challenge || challenge.used_at || challenge.expires_at <= Date.now()) return result([]);
        assert.equal(challenge.usuarioid, params[0]);
        assert.equal(challenge.challenge_id, params[1]);
        challenge.used_at = Date.now(); challenge.code_hash = '';
        return result([challenge]);
      }
      if (sql.includes('FROM paciente') || sql.includes('FROM medico')) return result([]);
      if (sql.includes('information_schema.columns')) return result([{ column_name: 'usuarioid' }]);
      throw new Error('Unexpected SQL: ' + sql);
    },
  };
  const handlers = new Map();
  const router = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    router[method] = (route, ...fns) => handlers.set(`${method} ${route}`, fns.at(-1));
  }
  const env = { NODE_ENV: 'test', JWT_SECRET: SECRET,
    MAKE_WEBHOOK_URL: 'https://mail.example.invalid/webhook', ...options.env };
  const dependencies = {
    express: { Router: () => router }, crypto, bcrypt, nodemailer: {},
    jsonwebtoken: { sign(...args) { signed++; return jwt.sign(...args); } },
    axios: { async post(url, body, config) {
      assert.equal(config.timeout, 10000); assert.equal(config.maxRedirects, 0);
      if (options.mailFailure) throw new Error('Synthetic mail failure with sensitive-request-data');
      deliveries.push({ url, ...Object.fromEntries(new URLSearchParams(body)) });
      return { status: 200 };
    } },
    '../config/db': db,
    '../services/exequatur.provider.js': {},
    '../services/user-profile.store': { async getUserProfileById() {
      if (options.profileFailure) throw new Error('Synthetic profile failure');
      return null;
    } },
    './middleware/auth': { requireAuth() {} },
    '../middleware/rate-limit': { authLimiter() {}, recoveryLimiter() {} },
    '../services/rf-core': { ACCOUNT_STATUS: {}, async ensureRfCoreSchema() {},
      normalizeAccountStatus: value => value,
      resolveLoginAccessState: u => ({ ok: u.activo, code: 'USER_INACTIVE', message: 'Inactive' }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/auth.routes.js'), 'utf8'), {
    module: { exports: {} }, process: { env }, URL, URLSearchParams, Buffer,
    console: { error: (...args) => logs.push(args), warn() {}, log() {} },
    require(name) { if (!(name in dependencies)) throw new Error('Unmocked dependency: ' + name); return dependencies[name]; },
  });
  return {
    get challenge() { return challenge; }, get signed() { return signed; }, deliveries, calls, logs,
    async login(body = {}) {
      const response = { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; } };
      await handlers.get('post /login')({ body: { email: user.email, password: PASSWORD, ...body } }, response);
      return response;
    },
  };
}

test('every stored administrator role requires server MFA before JWT, even with a normal email', async () => {
  const h = harness();
  const res = await h.login({ mfaVerified: true, rolid: 1 });
  assert.equal(res.statusCode, 202); assert.equal(res.body.mfaRequired, true);
  assert.equal(res.body.token, undefined); assert.equal(h.signed, 0);
  assert.equal(h.deliveries.length, 1);
  const sent = h.deliveries[0];
  assert.equal(sent.type, 'admin_2fa'); assert.equal(sent.email, 'staff@example.invalid');
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(h.challenge.code_hash, crypto.createHmac('sha256', SECRET)
    .update(`admin-mfa::42::${res.body.mfaChallengeId}::${sent.code}`).digest('hex'));
  assert.ok(!JSON.stringify(res.body).includes(sent.code));
  assert.ok(h.calls.includes('COMMIT'));
});

test('correct MFA grants the existing login response once; reuse is denied', async () => {
  const h = harness(); const pending = await h.login();
  const body = { otp: h.deliveries[0].code, mfaChallengeId: pending.body.mfaChallengeId };
  const login = await h.login(body);
  assert.equal(login.statusCode, 200); assert.equal(login.body.success, true);
  assert.equal(login.body.message, 'Login exitoso.'); assert.equal(login.body.user.rolid, 3);
  assert.equal(jwt.verify(login.body.token, SECRET).rolid, 3);
  assert.ok(h.challenge.used_at); assert.equal(h.challenge.code_hash, '');
  assert.equal((await h.login(body)).statusCode, 401); assert.equal(h.signed, 1);
});

test('wrong OTP persists five attempts, then blocks correct OTP and resending', async () => {
  const h = harness(); const pending = await h.login();
  const correct = h.deliveries[0].code;
  const wrong = correct === '000000' ? '000001' : '000000';
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal((await h.login({ otp: wrong, mfaChallengeId: pending.body.mfaChallengeId })).statusCode, 401);
    assert.equal(h.challenge.attempts, attempt);
  }
  assert.equal((await h.login({ otp: correct, mfaChallengeId: pending.body.mfaChallengeId })).statusCode, 429);
  assert.equal((await h.login({ resendMfa: true })).statusCode, 429);
  assert.equal(h.signed, 0); assert.equal(h.deliveries.length, 1);
});

test('forged challenge ID and expired OTP cannot authorize login', async () => {
  const h = harness(); const pending = await h.login();
  assert.equal((await h.login({ otp: h.deliveries[0].code, mfaChallengeId: crypto.randomUUID() })).statusCode, 401);
  h.challenge.expires_at = Date.now() - 1;
  assert.equal((await h.login({ otp: h.deliveries[0].code, mfaChallengeId: pending.body.mfaChallengeId })).statusCode, 401);
  assert.equal(h.signed, 0);
});

test('resends obey cooldown, rotate the challenge and preserve failed attempts', async () => {
  const h = harness(); const first = await h.login();
  assert.equal((await h.login()).body.mfaChallengeId, first.body.mfaChallengeId);
  assert.equal(h.deliveries.length, 1);
  assert.equal((await h.login({ resendMfa: true })).statusCode, 429);
  h.challenge.sent_at = Date.now() - 61000; h.challenge.attempts = 2;
  const second = await h.login({ resendMfa: true });
  assert.equal(second.statusCode, 202);
  assert.notEqual(second.body.mfaChallengeId, first.body.mfaChallengeId);
  assert.equal(h.challenge.attempts, 2);
  assert.equal((await h.login({ otp: h.deliveries[0].code, mfaChallengeId: first.body.mfaChallengeId })).statusCode, 401);
  assert.equal(h.signed, 0);
});

test('delivery failure never returns OTP/JWT, rolls back the challenge and logs no request details', async () => {
  const h = harness({ mailFailure: true });
  const res = await h.login();
  assert.equal(res.statusCode, 500); assert.equal(h.signed, 0); assert.equal(h.challenge, null);
  assert.ok(!JSON.stringify(h.logs).includes('sensitive-request-data'));
  assert.ok(h.calls.includes('ROLLBACK'));
});

test('wrong password, missing user, inactive account or missing delivery config fail closed', async () => {
  for (const options of [{ missingUser: true }, { user: { activo: false } },
    { env: { MAKE_WEBHOOK_URL: '' } }, { user: { email: 'admin@virem.local' } }]) {
    const h = harness(options); const res = await h.login();
    assert.ok(res.statusCode >= 400); assert.equal(h.signed, 0); assert.equal(h.deliveries.length, 0);
  }
  const h = harness(); assert.equal((await h.login({ password: 'wrong' })).statusCode, 401);
  assert.equal(h.deliveries.length, 0);
});

test('admin alias delivers only to the server-configured address', async () => {
  const h = harness({ user: { email: 'admin@virem.local' }, env: { ADMIN_MFA_EMAIL: 'security@example.invalid' } });
  assert.equal((await h.login({ email: 'admin', mfaEmail: 'attacker@example.invalid' })).statusCode, 202);
  assert.equal(h.deliveries[0].email, 'security@example.invalid'); assert.equal(h.signed, 0);
});

test('MFA consumption and later failures cannot issue a session', async () => {
  for (const options of [{ failConsume: true }, { profileFailure: true }]) {
    const h = harness(options); const pending = await h.login();
    const res = await h.login({ otp: h.deliveries[0].code, mfaChallengeId: pending.body.mfaChallengeId });
    assert.ok(res.statusCode >= 400); assert.equal(h.signed, 0); assert.equal(h.challenge.used_at, null);
  }
});

test('patient and doctor login contracts stay unchanged', async () => {
  for (const rolid of [1, 2]) {
    const h = harness({ user: { rolid } }); const res = await h.login();
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assert.equal(jwt.verify(res.body.token, SECRET).rolid, rolid);
    assert.equal(res.body.user.rolid, rolid); assert.equal(h.deliveries.length, 0);
  }
});
