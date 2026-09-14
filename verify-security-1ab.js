/**
 * Run from backend: node verify-security-1ab.js
 * Requires the updated LOCAL server and its same database/.env configuration.
 * Creates one synthetic doctor, checks OTP attempts and approval in PostgreSQL,
 * and removes only that fixture in finally. Never prints passwords or OTPs.
 * Registration invokes the server's configured email delivery (use test providers).
 * Optional: SECURITY_TEST_BASE_URL=http://127.0.0.1:3000
 */
const assert = require("node:assert/strict");
const { randomUUID, randomInt, createHmac } = require("node:crypto");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

async function run() {
  const baseUrl = new URL(process.env.SECURITY_TEST_BASE_URL || "http://127.0.0.1:3000");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname) &&
      ["http:", "https:"].includes(baseUrl.protocol) && !baseUrl.username && !baseUrl.password,
    "SECURITY_TEST_BASE_URL debe apuntar al servidor local."
  );
  const secret = process.env.EMAIL_VERIFICATION_SECRET || process.env.RECOVERY_CODE_SECRET ||
    process.env.JWT_SECRET;
  assert.ok(secret, "Configura las mismas claves de entorno que utiliza el servidor local.");

  const email = `security-1ab-${randomUUID()}@example.invalid`;
  const password = `Test!Aa9-${randomUUID()}`;
  const pool = new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT || 5432),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
        }),
    ssl: String(process.env.DB_SSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : undefined,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    query_timeout: 20000,
  });
  let cleanupNeeded = false;

  async function post(endpoint, body) {
    const response = await fetch(new URL(endpoint, baseUrl), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    assert.ok(typeof data.success === "boolean" && typeof data.message === "string",
      `${endpoint}: el contrato success/message debe conservarse (HTTP ${response.status}).`);
    return { status: response.status, data };
  }

  async function cleanup() {
    if (!cleanupNeeded) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const users = await client.query("SELECT usuarioid FROM usuario WHERE email = $1", [email]);
      for (const user of users.rows) {
        // Every deletion is scoped to the unpredictable email created by this run.
        if ((await client.query("SELECT to_regclass('public.usuario_perfil') AS name")).rows[0].name) {
          await client.query("DELETE FROM usuario_perfil WHERE usuarioid::text = $1", [String(user.usuarioid)]);
        }
        await client.query("DELETE FROM medico WHERE usuarioid = $1", [user.usuarioid]);
        await client.query("DELETE FROM usuario WHERE usuarioid = $1 AND email = $2", [user.usuarioid, email]);
      }
      await client.query("DELETE FROM pending_registration WHERE email = $1", [email]);
      await client.query("COMMIT");
      console.log("[OK] Cuenta sintetica y registro pendiente eliminados.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    const direct = await post("/api/auth/recovery/reset-password", { email, newPassword: password });
    assert.ok([401, 403].includes(direct.status) && direct.data.success === false,
      "A: el cambio de contrasena SIN ticket debe rechazarse con 401/403.");
    console.log("[OK] A: cambio de contrasena sin ticket rechazado.");

    const forged = await post("/api/auth/recovery/reset-password", {
      email, newPassword: password, recoveryTicket: randomUUID(),
    });
    assert.ok([400, 401, 403].includes(forged.status) && forged.data.success === false,
      `A: ticket inexistente: se esperaba HTTP 400/401/403 y success=false; recibido HTTP ${forged.status}, success=${forged.data.success}.` +
      (forged.status >= 500 ? " Error interno: revisa el log del backend y la conexion/esquema de PostgreSQL." : ""));
    console.log("[OK] A: ticket inexistente rechazado.");

    await pool.query("SELECT 1");
    const specialties = await pool.query("SELECT nombre FROM especialidad ORDER BY especialidadid LIMIT 1");
    assert.ok(specialties.rows.length, "La BD de pruebas necesita un catalogo de especialidades.");
    cleanupNeeded = true;
    const registration = await post("/api/auth/register-medico", {
      email,
      password,
      nombreCompleto: "Medico Prueba Seguridad",
      fechanacimiento: "1990-01-01",
      genero: "Hombre",
      especialidad: specialties.rows[0].nombre,
      cedula: String(randomInt(10000000000, 99999999999)),
      telefono: "8095550100",
      fotoUrl: "",
      aprobado_por_admin: true,
      activo: true,
      estado: "activa",
      account_status: "activa",
      passwordHash: "client-controlled-hash-must-be-ignored",
    });
    assert.ok(registration.status === 200 && registration.data.success && registration.data.requiresEmailVerification,
      "B: el alta debe conservar la respuesta de verificacion pendiente. Revisa logs locales si fallo.");

    const pendingResult = await pool.query(
      "SELECT id, registration_data, role_id FROM pending_registration WHERE email = $1", [email]
    );
    assert.ok(pendingResult.rows.length === 1,
      "B: no se encontro el registro; servidor y script deben usar la MISMA BD.");
    const pending = pendingResult.rows[0];
    assert.ok(Number(pending.role_id) === 2, "B: el registro debe tener rol medico.");
    assert.ok(!Object.hasOwn(pending.registration_data, "password"),
      "S03: se encontro password original en el registro pendiente.");
    assert.ok(typeof pending.registration_data.passwordHash === "string" &&
      await bcrypt.compare(password, pending.registration_data.passwordHash),
      "S03: el hash persistido debe corresponder a la contrasena, no al hash del cliente.");
    const originalHash = pending.registration_data.passwordHash;
    console.log("[OK] S03: registro pendiente contiene bcrypt y no password original.");

    // Set a known OTP ONLY on our synthetic row, so this check never needs a
    // real mailbox or exposure of devVerificationCode in production responses.
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const hash = createHmac("sha256", secret).update(`${email}::${code}`).digest("hex");
    const seeded = await pool.query(
      `UPDATE pending_registration
       SET verification_code_hash = $1, attempts = 0, expires_at = NOW() + INTERVAL '15 minutes'
       WHERE id = $2 AND email = $3`, [hash, pending.id, email]
    );
    assert.ok(seeded.rowCount === 1, "No se pudo preparar el OTP de la cuenta sintetica.");
    const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, "0");
    const incorrect = await post("/api/auth/register/confirm", { email, codigo: wrongCode });
    assert.ok(incorrect.status === 400 && !incorrect.data.success,
      "S04: un OTP incorrecto debe rechazarse.");
    const attempts = await pool.query("SELECT attempts FROM pending_registration WHERE id = $1 AND email = $2",
      [pending.id, email]);
    assert.ok(Number(attempts.rows[0]?.attempts) === 1, "S04: el intento fallido se perdio (ROLLBACK indebido).");
    console.log("[OK] S04: intento fallido confirmado en PostgreSQL.");

    const confirmed = await post("/api/auth/register/confirm", {
      email, codigo: code, aprobado_por_admin: true, activo: true, estado: "activa",
    });
    assert.ok(confirmed.status === 201 && confirmed.data.success && confirmed.data.usuarioid,
      "B: el OTP correcto debe completar el registro. Comprueba claves OTP compartidas y esquema de pruebas.");
    const result = await pool.query(
      `SELECT usuarioid, rolid, activo, account_status, aprobado_por_admin, passwordhash
       FROM usuario WHERE email = $1`, [email]
    );
    const doctor = result.rows[0];
    assert.ok(result.rows.length === 1 && Number(doctor.rolid) === 2,
      "B: no se creo exactamente un usuario medico.");
    assert.ok(doctor.activo === false && doctor.aprobado_por_admin === false &&
      doctor.account_status === "pendiente_aprobacion",
      "B: inyeccion de aprobacion aceptada; se requiere activo=false, aprobado=false, pendiente_aprobacion.");
    assert.ok(doctor.passwordhash === originalHash,
      "S03: confirmacion debe reutilizar el hash, sin aplicar bcrypt por segunda vez.");
    console.log("[OK] B: medico inactivo, pendiente de aprobacion y aprobado_por_admin=false.");
    console.log("[OK] S03: hash final conservado sin doble hash.");

    const login = await post("/api/auth/login", { email, password });
    assert.ok(login.status === 403 && !login.data.success && !login.data.token,
      "B: un medico pendiente no puede obtener una sesion.");
    console.log("[OK] B: login de medico pendiente rechazado.");
  } finally {
    try {
      await cleanup();
    } catch (error) {
      console.error(`No se pudo limpiar la cuenta sintetica ${email}; revisa solo esa cuenta.`);
      throw error;
    } finally {
      await pool.end();
    }
  }
  console.log("Validacion 1A/1B completada correctamente.");
}

run().catch((error) => {
  // Do not dump response bodies, configuration, password hashes or OTPs.
  console.error(`Validacion fallida: ${error.message}`);
  process.exitCode = 1;
});
