// Isolated regression tests: actual handlers/services, synthetic DB and mail.
// No .env, production database, listening server or external requests are used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");

const SECRET = "isolated-security-test-secret-not-for-deployment";
const EMAIL = "fixture@example.invalid";
const PASSWORD = "SyntheticPassword9!";
const OTP = "123456";
const otpHash = () => crypto.createHmac("sha256", SECRET).update(`${EMAIL}::${OTP}`).digest("hex");

function harness() {
  const state = { pending: [], codes: [], users: [] };
  const calls = [];
  let snapshot;
  let failPasswordUpdate = false;
  let failTicketLookup = false;
  let expireTicketOnPasswordUpdate = false;
  const db = {
    async connect() { return this; },
    release() { calls.push({ sql: "RELEASE" }); },
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      const result = (rows = []) => ({ rows: structuredClone(rows), rowCount: rows.length });
      if (sql === "BEGIN") { snapshot = structuredClone(state); return result(); }
      if (sql === "COMMIT") { snapshot = undefined; return result(); }
      if (sql === "ROLLBACK") {
        if (snapshot) Object.assign(state, snapshot);
        snapshot = undefined;
        return result();
      }
      if (/^(CREATE|ALTER) /.test(sql)) return result();
      if (sql.startsWith("SELECT usuarioid FROM usuario WHERE email")) {
        return result(state.users.filter(u => u.email === params[0]));
      }
      if (sql.startsWith("INSERT INTO pending_registration")) {
        state.pending = [{ id: 1, email: params[0], registration_data: JSON.parse(params[1]),
          role_id: params[2], verification_code_hash: params[3], attempts: 0,
          expires_at: new Date(Date.now() + 1200000) }];
        return result();
      }
      if (sql.startsWith("DELETE FROM pending_registration")) {
        state.pending = state.pending.filter(p => sql.includes("email =") ? p.email !== params[0] : p.id !== params[0]);
        return result();
      }
      if (sql.startsWith("SELECT * FROM pending_registration")) {
        return result(state.pending.filter(p => p.email === params[0]));
      }
      if (sql.startsWith("UPDATE pending_registration SET attempts")) {
        state.pending.find(p => p.id === params[0]).attempts++;
        return result();
      }
      if (sql.startsWith("UPDATE pending_registration SET registration_data")) {
        state.pending.find(p => p.id === params[1]).registration_data = JSON.parse(params[0]);
        return result();
      }
      if (sql.startsWith("SELECT id, code_hash")) {
        return result(state.codes.filter(c => c.email === params[0]));
      }
      if (sql.startsWith("SELECT id FROM password_reset_code")) {
        if (failTicketLookup) throw new Error("Synthetic ticket lookup failure");
        assert.ok(sql.includes("FOR UPDATE"), "Ticket must be locked until password update commits");
        assert.ok(sql.includes("recovery_ticket_hash = $2") && sql.includes("recovery_ticket_expires_at > NOW()"));
        return result(state.codes.filter(c => c.email === params[0] && c.verified_at && !c.used_at &&
          c.recovery_ticket_hash === params[1] && c.recovery_ticket_expires_at > Date.now()));
      }
      if (sql.startsWith("UPDATE password_reset_code SET verified_at")) {
        assert.equal(params[2], 15, "Ticket lifetime must be 15 minutes");
        Object.assign(state.codes.find(c => c.id === params[0]), { verified_at: new Date(),
          recovery_ticket_hash: params[1], recovery_ticket_expires_at: Date.now() + params[2] * 60000 });
        return result();
      }
      if (sql.startsWith("UPDATE password_reset_code SET attempts")) {
        state.codes.find(c => c.id === params[0]).attempts++;
        return result();
      }
      if (sql.startsWith("UPDATE password_reset_code SET used_at")) {
        const row = state.codes.find(c => c.id === params[0]);
        if (params.length === 3) {
          assert.ok(sql.includes("email = $2") && sql.includes("recovery_ticket_hash = $3") &&
            sql.includes("used_at IS NULL") && sql.includes("recovery_ticket_expires_at > clock_timestamp()"));
          if (!row || row.email !== params[1] || row.recovery_ticket_hash !== params[2] ||
              !row.verified_at || row.used_at || row.recovery_ticket_expires_at <= Date.now()) return result();
        }
        row.used_at = new Date();
        if (sql.includes("recovery_ticket_hash = NULL")) {
          row.recovery_ticket_hash = null;
          row.recovery_ticket_expires_at = null;
        }
        return result([row]);
      }
      if (sql.startsWith("SELECT usuarioid, activo FROM usuario")) {
        return result(state.users.filter(u => u.email === params[0]));
      }
      if (sql.startsWith("UPDATE usuario SET passwordhash")) {
        if (failPasswordUpdate) throw new Error("Synthetic database failure");
        const user = state.users.find(u => u.usuarioid === params[1]);
        if (!user) return result();
        user.passwordhash = params[0];
        if (expireTicketOnPasswordUpdate) state.codes[0].recovery_ticket_expires_at = Date.now() - 1;
        return result([user]);
      }
      // Schema compatibility/backfills are unrelated to these unit fixtures.
      if (sql.startsWith("UPDATE usuario")) return result();
      if (sql.startsWith("UPDATE pago ")) return result();
      if (sql.includes("information_schema.columns")) {
        return result([
          { column_name: "medicoid", data_type: "uuid", column_default: null },
          { column_name: "usuarioid", data_type: "integer", column_default: null },
          { column_name: "nombrecompleto", data_type: "text", column_default: null },
        ]);
      }
      if (sql.startsWith("INSERT INTO usuario")) {
        const doctor = params[0] === 2;
        if (doctor) {
          assert.ok(sql.includes("NOW(),FALSE,$4,TRUE,NOW(),FALSE)"), "Approval flags must be server constants");
          assert.equal(params[3], "pendiente_aprobacion");
        }
        const user = { usuarioid: 99, rolid: params[0], email: params[1], passwordhash: params[2],
          activo: !doctor, account_status: doctor ? params[3] : "activa", aprobado_por_admin: false };
        state.users.push(user);
        return result([user]);
      }
      if (sql.startsWith("INSERT INTO medico")) return result([{ medicoid: crypto.randomUUID() }]);
      throw new Error(`Unexpected SQL in isolated test: ${sql}`);
    },
  };
  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "patch", "delete", "use"]) {
    router[method] = (route, ...fns) => { handlers.set(`${method} ${route}`, fns.at(-1)); return router; };
  }
  let core;
  function load(relative) {
    const module = { exports: {} };
    const filename = path.join(__dirname, "..", relative);
    const dependencies = {
      crypto, bcrypt,
      "../config/db": db,
      express: { Router: () => router },
      axios: { post: async () => ({ status: 200 }) },
      jsonwebtoken: {}, nodemailer: {},
      "../services/exequatur.provider.js": {},
      "../services/user-profile.store": { upsertUserProfileById: async () => ({}) },
      "./middleware/auth": { requireAuth() {} },
      "../middleware/rate-limit": { authLimiter() {}, recoveryLimiter() {} },
      "../services/rf-core": core,
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, exports: module.exports,
      require(name) {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unmocked dependency: ${name}`);
        return dependencies[name];
      },
      process: { env: { NODE_ENV: "test", JWT_SECRET: SECRET, MAKE_WEBHOOK_URL: "https://mail.example.invalid" } },
      console: { error() {}, warn() {}, log() {} },
      URL, Buffer,
    }, { filename });
    return module.exports;
  }
  core = load("services/rf-core.js");
  load("routes/auth.routes.js");

  async function request(route, body) {
    const response = { statusCode: 200, body: null, headers: {},
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
      setHeader(key, value) { this.headers[key] = value; },
    };
    await handlers.get(`post ${route}`)({ body }, response);
    return response;
  }
  function seedRecovery() {
    state.users = [{ usuarioid: 42, email: EMAIL, activo: true, passwordhash: "original" }];
    state.codes = [{ id: 1, email: EMAIL, code_hash: otpHash(), attempts: 0,
      expires_at: new Date(Date.now() + 600000), verified_at: null, used_at: null }];
  }
  return { core, db, state, calls, request, seedRecovery,
    failTicketLookup: () => { failTicketLookup = true; },
    expireTicketOnPasswordUpdate: () => { expireTicketOnPasswordUpdate = true; },
    failPasswordUpdate: () => { failPasswordUpdate = true; } };
}

test("reset without ticket is forbidden before any database access", async () => {
  const h = harness();
  const res = await h.request("/recovery/reset-password", { email: EMAIL, newPassword: PASSWORD });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(h.calls.length, 0);
});

test("OTP issues only a hashed 15-minute ticket; OTP cannot be verified twice", async () => {
  const h = harness(); h.seedRecovery();
  const res = await h.request("/recovery/verify-code", { email: EMAIL, codigo: OTP });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "Codigo verificado correctamente.");
  assert.match(res.body.recoveryTicket, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.notEqual(h.state.codes[0].recovery_ticket_hash, res.body.recoveryTicket);
  assert.equal(h.state.codes[0].recovery_ticket_hash,
    crypto.createHmac("sha256", SECRET).update(`password-reset-ticket::${EMAIL}::${res.body.recoveryTicket}`).digest("hex"));
  const again = await h.request("/recovery/verify-code", { email: EMAIL, codigo: OTP });
  assert.equal(again.statusCode, 400);
  assert.equal(again.body.recoveryTicket, undefined);
});

test("ticket is bound to email, succeeds once and changes the password in its transaction", async () => {
  const h = harness(); h.seedRecovery();
  const verified = await h.request("/recovery/verify-code", { email: EMAIL, codigo: OTP });
  const body = { email: EMAIL, recoveryTicket: verified.body.recoveryTicket, newPassword: PASSWORD };
  const wrongEmail = await h.request("/recovery/reset-password", { ...body, email: "other@example.invalid" });
  assert.equal(wrongEmail.statusCode, 401);
  const forged = await h.request("/recovery/reset-password", { ...body, recoveryTicket: crypto.randomUUID() });
  assert.equal(forged.statusCode, 401);
  // Ticket validity is independent from the already verified OTP's old TTL.
  h.state.codes[0].expires_at = new Date(0);
  const start = h.calls.length;
  const reset = await h.request("/recovery/reset-password", body);
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.body.message, "Contrasena actualizada correctamente.");
  assert.ok(await bcrypt.compare(PASSWORD, h.state.users[0].passwordhash));
  assert.equal(h.state.codes[0].recovery_ticket_hash, null);
  assert.ok(h.state.codes[0].used_at);
  const transaction = h.calls.slice(start).map(c => c.sql);
  assert.equal(transaction[0], "BEGIN");
  assert.equal(transaction.at(-2), "COMMIT");
  assert.ok(transaction.findIndex(s => s.startsWith("UPDATE usuario SET passwordhash")) <
    transaction.findIndex(s => s.startsWith("UPDATE password_reset_code SET used_at")));
  const replay = await h.request("/recovery/reset-password", body);
  assert.equal(replay.statusCode, 401);
});

test("expired ticket fails and a database error rolls back password and ticket", async () => {
  const h = harness(); h.seedRecovery();
  const verified = await h.request("/recovery/verify-code", { email: EMAIL, codigo: OTP });
  const body = { email: EMAIL, recoveryTicket: verified.body.recoveryTicket, newPassword: PASSWORD };
  h.state.codes[0].recovery_ticket_expires_at = Date.now() - 1;
  assert.equal((await h.request("/recovery/reset-password", body)).statusCode, 401);
  h.state.codes[0].recovery_ticket_expires_at = Date.now() + 60000;
  h.failPasswordUpdate();
  assert.equal((await h.request("/recovery/reset-password", body)).statusCode, 500);
  assert.equal(h.state.users[0].passwordhash, "original");
  assert.equal(h.state.codes[0].used_at, null);
  assert.ok(h.state.codes[0].recovery_ticket_hash);
});

test("random ticket without a stored match returns 401 before accessing or updating the user", async () => {
  const h = harness(); h.seedRecovery();
  const res = await h.request("/recovery/reset-password", {
    email: EMAIL, recoveryTicket: crypto.randomUUID(), newPassword: PASSWORD,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.ok(h.calls.some(c => c.sql.startsWith("SELECT id FROM password_reset_code")));
  assert.ok(!h.calls.some(c => c.sql.startsWith("SELECT usuarioid, activo") || c.sql.startsWith("UPDATE ")));
  assert.equal(h.calls.at(-2).sql, "ROLLBACK");
  assert.equal(h.state.users[0].passwordhash, "original");
});

test("ticket lookup failure returns 500 and never changes the password", async () => {
  const h = harness(); h.seedRecovery(); h.failTicketLookup();
  const res = await h.request("/recovery/reset-password", {
    email: EMAIL, recoveryTicket: crypto.randomUUID(), newPassword: PASSWORD,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.ok(!h.calls.some(c => c.sql.startsWith("UPDATE ") || c.sql === "COMMIT"));
  assert.equal(h.calls.at(-2).sql, "ROLLBACK");
  assert.equal(h.state.users[0].passwordhash, "original");
});

test("failure to consume the ticket rolls back the password update", async () => {
  const h = harness(); h.seedRecovery();
  const verified = await h.request("/recovery/verify-code", { email: EMAIL, codigo: OTP });
  h.expireTicketOnPasswordUpdate();
  const res = await h.request("/recovery/reset-password", {
    email: EMAIL, recoveryTicket: verified.body.recoveryTicket, newPassword: PASSWORD,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(h.state.users[0].passwordhash, "original");
  assert.equal(h.state.codes[0].used_at, null);
  assert.ok(h.state.codes[0].recovery_ticket_hash);
  assert.equal(h.calls.at(-2).sql, "ROLLBACK");
});

test("registration hashes before INSERT and disregards supplied passwordHash", async () => {
  const h = harness();
  await h.core.createPendingRegistration(h.db, { email: EMAIL, roleId: 1,
    registrationData: { nombres: "Fixture", password: PASSWORD, passwordHash: "injected" } });
  const data = h.state.pending[0].registration_data;
  assert.equal(Object.hasOwn(data, "password"), false);
  assert.ok(await bcrypt.compare(PASSWORD, data.passwordHash));
  assert.ok(!h.calls.some(c => JSON.stringify(c.params).includes(PASSWORD)));
});

test("wrong registration OTP commits every attempt and enforces lockout even with correct OTP", async () => {
  const h = harness();
  const verification = await h.core.createPendingRegistration(h.db, { email: EMAIL, roleId: 2,
    registrationData: { password: PASSWORD } });
  const wrong = String((Number(verification.codigo) + 1) % 1000000).padStart(6, "0");
  for (let i = 1; i <= h.core.EMAIL_CODE_MAX_ATTEMPTS; i++) {
    const res = await h.request("/register/confirm", { email: EMAIL, codigo: wrong });
    assert.equal(res.statusCode, 400);
    assert.equal(h.state.pending[0].attempts, i);
    assert.equal(h.calls.at(-2).sql, "COMMIT");
  }
  const correctAfterLockout = await h.request("/register/confirm", { email: EMAIL, codigo: verification.codigo });
  assert.equal(correctAfterLockout.statusCode, 400);
  assert.match(correctAfterLockout.body.message, /Demasiados intentos/);
  assert.equal(h.state.users.length, 0);
});

test("doctor registration ignores approval injection and confirmation reuses bcrypt hash", async () => {
  const h = harness();
  const registration = await h.request("/register-medico", {
    email: EMAIL, password: PASSWORD, nombreCompleto: "Fixture", fechanacimiento: "1990-01-01",
    aprobado_por_admin: true, activo: true, account_status: "activa", estado: "activa",
  });
  assert.equal(registration.statusCode, 200);
  assert.equal(registration.body.requiresEmailVerification, true);
  const original = h.state.pending[0].registration_data.passwordHash;
  h.state.pending[0].verification_code_hash = otpHash();
  const confirmed = await h.request("/register/confirm", {
    email: EMAIL, codigo: OTP, aprobado_por_admin: true, activo: true,
  });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(confirmed.body.success, true);
  assert.equal(confirmed.body.usuarioid, 99);
  assert.equal(confirmed.body.requiresAdminApproval, true);
  const user = h.state.users[0];
  assert.equal(user.activo, false);
  assert.equal(user.aprobado_por_admin, false);
  assert.equal(user.account_status, "pendiente_aprobacion");
  assert.equal(user.passwordhash, original);
  assert.equal(h.state.pending.length, 0);
  const access = h.core.resolveLoginAccessState(user);
  assert.equal(access.ok, false);
  assert.equal(access.code, "PENDING_APPROVAL");
});

test("legacy pending registration converts the password after correct OTP", async () => {
  const h = harness();
  h.state.pending = [{ id: 1, email: EMAIL, role_id: 2, attempts: 0,
    expires_at: new Date(Date.now() + 60000), verification_code_hash: otpHash(),
    registration_data: { password: PASSWORD, nombreCompleto: "Legacy" } }];
  const result = await h.core.verifyPendingRegistration(h.db, { email: EMAIL, codigo: OTP });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.registrationData, "password"), false);
  assert.ok(await bcrypt.compare(PASSWORD, result.registrationData.passwordHash));
  assert.equal(Object.hasOwn(h.state.pending[0].registration_data, "password"), false);
});
