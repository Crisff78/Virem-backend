const { createHmac, randomInt, randomUUID } = require("crypto");
const bcrypt = require("bcrypt");
const pool = require("../config/db");

const ACCOUNT_STATUS = {
  ACTIVE: "activa",
  PENDING_VERIFICATION: "pendiente_verificacion",
  PENDING_APPROVAL: "pendiente_aprobacion",
  REJECTED: "rechazada",
  BLOCKED: "bloqueada",
};

const EMAIL_CODE_LENGTH = 6;
const EMAIL_CODE_TTL_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.EMAIL_VERIFICATION_TTL_MINUTES || "20", 10) || 20
);
const EMAIL_CODE_MAX_ATTEMPTS = Math.max(
  3,
  Number.parseInt(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS || "5", 10) || 5
);
const EMAIL_HASH_SECRET =
  process.env.EMAIL_VERIFICATION_SECRET ||
  process.env.RECOVERY_CODE_SECRET ||
  process.env.JWT_SECRET ||
  "virem-dev-secret-change-me";


function resolveDb(dbClient) {
  if (dbClient && typeof dbClient.query === "function") {
    return dbClient;
  }
  return pool;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeAccountStatus(value, fallback = ACCOUNT_STATUS.ACTIVE) {
  const raw = normalizeComparableText(value)
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z_]/g, "");

  if (raw === "activa" || raw === "activo" || raw === "active") {
    return ACCOUNT_STATUS.ACTIVE;
  }
  if (
    raw === "pendiente_verificacion" ||
    raw === "pending_verification" ||
    raw === "por_verificar"
  ) {
    return ACCOUNT_STATUS.PENDING_VERIFICATION;
  }
  if (
    raw === "pendiente_aprobacion" ||
    raw === "pending_approval" ||
    raw === "en_revision"
  ) {
    return ACCOUNT_STATUS.PENDING_APPROVAL;
  }
  if (raw === "rechazada" || raw === "rejected") {
    return ACCOUNT_STATUS.REJECTED;
  }
  if (
    raw === "bloqueada" ||
    raw === "bloqueado" ||
    raw === "blocked" ||
    raw === "inactiva"
  ) {
    return ACCOUNT_STATUS.BLOCKED;
  }

  return fallback;
}

function hashEmailVerificationCode(email, code) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  const normalizedCode = normalizeText(code);
  return createHmac("sha256", EMAIL_HASH_SECRET)
    .update(`${normalizedEmail}::${normalizedCode}`)
    .digest("hex");
}

function generateEmailVerificationCode() {
  return String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(
    EMAIL_CODE_LENGTH,
    "0"
  );
}

// Compatibility export: schema changes run only through scripts/migrations.js.
async function ensureRfCoreSchema() {}

function resolveLoginAccessState(userRow, options = {}) {
  const roleId = Number(userRow?.rolid || 0);
  const isActiveFlag = Boolean(userRow?.activo);
  const status = normalizeAccountStatus(
    userRow?.account_status || userRow?.accountStatus,
    ACCOUNT_STATUS.ACTIVE
  );
  const emailVerified = Boolean(userRow?.email_verificado ?? userRow?.emailVerified);
  const enforceEmailVerification =
    options.enforceEmailVerification !== undefined
      ? Boolean(options.enforceEmailVerification)
      : String(process.env.REQUIRE_EMAIL_VERIFICATION || "true") === "true";

  if (!isActiveFlag && status !== ACCOUNT_STATUS.PENDING_APPROVAL) {
    return {
      ok: false,
      code: "USER_INACTIVE",
      message: "Tu cuenta esta inactiva. Contacta al administrador.",
      status,
      emailVerified,
    };
  }

  if (status === ACCOUNT_STATUS.PENDING_VERIFICATION) {
    return {
      ok: false,
      code: "PENDING_VERIFICATION",
      message:
        "Tu cuenta aun no ha sido verificada. Revisa tu correo e ingresa el codigo de verificacion.",
      status,
      emailVerified,
    };
  }

  if (status === ACCOUNT_STATUS.PENDING_APPROVAL) {
    return {
      ok: false,
      code: "PENDING_APPROVAL",
      message:
        "Tu cuenta de medico esta pendiente de aprobacion administrativa. Te notificaremos cuando sea aprobada.",
      status,
      emailVerified,
    };
  }

  if (status === ACCOUNT_STATUS.REJECTED) {
    return {
      ok: false,
      code: "ACCOUNT_REJECTED",
      message:
        "Tu cuenta fue rechazada por administracion. Contacta soporte para revisar tu documentacion.",
      status,
      emailVerified,
    };
  }

  if (status === ACCOUNT_STATUS.BLOCKED) {
    return {
      ok: false,
      code: "ACCOUNT_BLOCKED",
      message: "Tu cuenta esta bloqueada temporalmente. Contacta al administrador.",
      status,
      emailVerified,
    };
  }

  if (roleId === 1 && enforceEmailVerification && !emailVerified) {
    return {
      ok: false,
      code: "PENDING_VERIFICATION",
      message:
        "Debes verificar tu correo antes de iniciar sesion. Solicita un nuevo codigo si no lo recibiste.",
      status: ACCOUNT_STATUS.PENDING_VERIFICATION,
      emailVerified,
    };
  }

  return {
    ok: true,
    code: "ACTIVE",
    message: "Cuenta activa.",
    status,
    emailVerified,
  };
}

async function createEmailVerificationCode(
  dbClient,
  { usuarioid, email, ttlMinutes = EMAIL_CODE_TTL_MINUTES }
) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema(db);

  const normalizedEmail = normalizeText(email).toLowerCase();
  const code = generateEmailVerificationCode();
  const codeHash = hashEmailVerificationCode(normalizedEmail, code);

  await db.query(
    `UPDATE email_verificacion_code
     SET used_at = NOW()
     WHERE email = $1
       AND used_at IS NULL`,
    [normalizedEmail]
  );

  await db.query(
    `INSERT INTO email_verificacion_code (
      usuarioid,
      email,
      code_hash,
      expires_at,
      attempts,
      created_at
    )
    VALUES (
      $1,
      $2,
      $3,
      NOW() + ($4 * INTERVAL '1 minute'),
      0,
      NOW()
    )`,
    [Number(usuarioid), normalizedEmail, codeHash, Number(ttlMinutes)]
  );

  return {
    codigo: code,
    ttlMinutes: Number(ttlMinutes),
  };
}

async function createPendingRegistration(
  dbClient,
  { email, registrationData, roleId, ttlMinutes = EMAIL_CODE_TTL_MINUTES }
) {
  // Never accept a client-supplied hash or persist the original password.
  const { password, ...profileData } = registrationData;
  if (typeof password !== "string" || !password) {
    throw new Error("La contrasena es obligatoria.");
  }
  const safeRegistrationData = {
    ...profileData,
    passwordHash: await bcrypt.hash(password, 10),
  };
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema(db);

  const normalizedEmail = normalizeText(email).toLowerCase();
  const code = generateEmailVerificationCode();
  const codeHash = hashEmailVerificationCode(normalizedEmail, code);

  // Limpiar anteriores para este correo
  await db.query("DELETE FROM pending_registration WHERE email = $1", [
    normalizedEmail,
  ]);

  await db.query(
    `INSERT INTO pending_registration (
      email,
      registration_data,
      role_id,
      verification_code_hash,
      expires_at
    )
    VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 minute'))`,
    [
      normalizedEmail,
      JSON.stringify(safeRegistrationData),
      Number(roleId),
      codeHash,
      Number(ttlMinutes),
    ]
  );

  return {
    codigo: code,
    ttlMinutes: Number(ttlMinutes),
  };
}

async function verifyPendingRegistration(dbClient, { email, codigo }) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema(db);

  const normalizedEmail = normalizeText(email).toLowerCase();
  const cleanCode = normalizeText(codigo);

  const res = await db.query(
    `SELECT * FROM pending_registration
     WHERE email = $1
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [normalizedEmail]
  );

  if (!res.rows.length) {
    return { ok: false, code: "NOT_FOUND", message: "Registro no encontrado." };
  }

  const row = res.rows[0];
  const expiresAtMs = new Date(row.expires_at).getTime();

  if (expiresAtMs < Date.now()) {
    await db.query("DELETE FROM pending_registration WHERE id = $1", [row.id]);
    return { ok: false, code: "EXPIRED", message: "El código ha expirado." };
  }

  if (Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
    return {
      ok: false,
      code: "MAX_ATTEMPTS",
      message: "Demasiados intentos. Regístrate de nuevo.",
    };
  }

  const expectedHash = hashEmailVerificationCode(normalizedEmail, cleanCode);
  if (expectedHash !== row.verification_code_hash) {
    await db.query(
      "UPDATE pending_registration SET attempts = attempts + 1 WHERE id = $1",
      [row.id]
    );
    return { ok: false, code: "INCORRECT", message: "Código incorrecto." };
  }

  // Keep registrations started before this change usable. Upgrade their
  // credential only after proving ownership of the OTP; confirmation deletes
  // the pending row in the same transaction.
  const registrationData = { ...row.registration_data };
  if (typeof registrationData.password === "string") {
    registrationData.passwordHash = await bcrypt.hash(registrationData.password, 10);
    delete registrationData.password;
    await db.query(
      "UPDATE pending_registration SET registration_data = $1 WHERE id = $2",
      [JSON.stringify(registrationData), row.id]
    );
  }
  if (typeof registrationData.passwordHash !== "string" ||
      !/^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(registrationData.passwordHash)) {
    return { ok: false, code: "INVALID_REGISTRATION", message: "Regístrate de nuevo para actualizar tus credenciales." };
  }

  return {
    ok: true,
    email: normalizedEmail,
    roleId: Number(row.role_id),
    registrationData,
    pendingId: row.id,
  };
}

async function deletePendingRegistration(dbClient, id) {
  const db = resolveDb(dbClient);
  await db.query("DELETE FROM pending_registration WHERE id = $1", [id]);
}

async function verifyEmailVerificationCode(dbClient, { email, codigo }) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema(db);

  const normalizedEmail = normalizeText(email).toLowerCase();
  const cleanCode = normalizeText(codigo);

  const latest = await db.query(
    `SELECT
       id,
       usuarioid,
       code_hash,
       attempts,
       expires_at,
       used_at
     FROM email_verificacion_code
     WHERE email = $1
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [normalizedEmail]
  );

  if (!latest.rows.length) {
    return {
      ok: false,
      code: "INVALID_OR_EXPIRED",
      message: "Codigo invalido o expirado.",
    };
  }

  const row = latest.rows[0];
  if (row.used_at) {
    return {
      ok: false,
      code: "INVALID_OR_EXPIRED",
      message: "Codigo invalido o expirado.",
    };
  }

  const expiresAtMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    await db.query(
      `UPDATE email_verificacion_code
       SET used_at = NOW()
       WHERE id = $1`,
      [row.id]
    );

    return {
      ok: false,
      code: "EXPIRED",
      message: "El codigo expiro. Solicita uno nuevo.",
    };
  }

  const attempts = Number(row.attempts || 0);
  if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return {
      ok: false,
      code: "MAX_ATTEMPTS",
      message: "Superaste el maximo de intentos. Solicita un nuevo codigo.",
    };
  }

  const expectedHash = hashEmailVerificationCode(normalizedEmail, cleanCode);
  if (expectedHash !== row.code_hash) {
    await db.query(
      `UPDATE email_verificacion_code
       SET attempts = attempts + 1
       WHERE id = $1`,
      [row.id]
    );

    return {
      ok: false,
      code: "INCORRECT_CODE",
      message: "Codigo incorrecto.",
    };
  }

  await db.query(
    `UPDATE email_verificacion_code
     SET verified_at = NOW(),
         used_at = NOW()
     WHERE id = $1`,
    [row.id]
  );

  const userRoleRes = await db.query('SELECT rolid FROM usuario WHERE usuarioid = $1', [Number(row.usuarioid)]);
  const userRoleId = Number(userRoleRes.rows[0]?.rolid || 0);

  const nextStatus = (userRoleId === 2) 
    ? ACCOUNT_STATUS.PENDING_APPROVAL 
    : ACCOUNT_STATUS.ACTIVE;

  await db.query(
    `UPDATE usuario
     SET email_verificado = TRUE,
         email_verificado_at = NOW(),
         account_status = CASE
           WHEN account_status = $1 THEN $2
           ELSE account_status
         END,
          activo = CASE
            WHEN rolid = 2 AND aprobado_por_admin IS DISTINCT FROM TRUE THEN FALSE
            WHEN account_status = $1 AND rolid <> 2 THEN TRUE
            ELSE activo
          END
     WHERE usuarioid = $3`,
    [ACCOUNT_STATUS.PENDING_VERIFICATION, nextStatus, Number(row.usuarioid)]
  );

  return {
    ok: true,
    code: "VERIFIED",
    message: "Correo verificado correctamente.",
    usuarioid: Number(row.usuarioid),
  };
}

async function saveMedicoDocument(
  dbClient,
  {
    usuarioid,
    medicoid = "",
    tipo,
    nombre = "",
    archivoUrl,
    estadoRevision = "pendiente",
  }
) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema();

  const cleanTipo = normalizeComparableText(tipo).replace(/\s+/g, "_");
  const cleanNombre = normalizeText(nombre);
  const cleanUrl = normalizeText(archivoUrl);
  const cleanEstado = normalizeComparableText(estadoRevision).replace(/\s+/g, "_") || "pendiente";

  if (!cleanTipo || !cleanUrl) {
    throw new Error("tipo y archivoUrl son obligatorios para guardar documento medico.");
  }

  const documentoid = randomUUID();
  await db.query(
    `INSERT INTO medico_documento (
      documentoid,
      usuarioid,
      medicoid_text,
      tipo,
      nombre,
      archivo_url,
      estado_revision,
      creado_en,
      actualizado_en
    )
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
    [
      documentoid,
      Number(usuarioid),
      normalizeText(medicoid),
      cleanTipo,
      cleanNombre || null,
      cleanUrl,
      cleanEstado,
    ]
  );

  return {
    documentoid,
    usuarioid: Number(usuarioid),
    medicoid: normalizeText(medicoid),
    tipo: cleanTipo,
    nombre: cleanNombre,
    archivoUrl: cleanUrl,
    estadoRevision: cleanEstado,
  };
}

async function listMedicoDocumentsByUsuarioId(dbClient, usuarioid) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema();

  const result = await db.query(
    `SELECT
       documentoid::text AS documentoid,
       usuarioid,
       medicoid_text,
       tipo,
       nombre,
       archivo_url,
       estado_revision,
       comentario_admin,
       creado_en,
       actualizado_en
     FROM medico_documento
     WHERE usuarioid = $1
     ORDER BY creado_en DESC`,
    [Number(usuarioid)]
  );

  return result.rows.map((row) => ({
    documentoid: normalizeText(row.documentoid),
    usuarioid: Number(row.usuarioid),
    medicoid: normalizeText(row.medicoid_text),
    tipo: normalizeText(row.tipo),
    nombre: normalizeText(row.nombre),
    archivoUrl: normalizeText(row.archivo_url),
    estadoRevision: normalizeText(row.estado_revision),
    comentarioAdmin: normalizeText(row.comentario_admin),
    creadoEn: row.creado_en || null,
    actualizadoEn: row.actualizado_en || null,
  }));
}

async function recordUserModification(
  dbClient,
  { usuarioid, actorUsuarioid = null, scope = "perfil", changes = {}, motivo = "" }
) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema();

  const cleanScope = normalizeComparableText(scope).replace(/\s+/g, "_") || "perfil";
  const payload = changes && typeof changes === "object" ? changes : {};

  await db.query(
    `INSERT INTO user_modificacion_historial (
      usuarioid,
      actor_usuarioid,
      scope,
      cambios_json,
      motivo,
      created_at
    )
    VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
    [
      Number(usuarioid),
      actorUsuarioid ? Number(actorUsuarioid) : null,
      cleanScope,
      JSON.stringify(payload),
      normalizeText(motivo) || null,
    ]
  );
}

function buildInvoiceNumber(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const randomBlock = String(randomInt(1000, 10000));
  return `FAC-${year}${month}${day}-${randomBlock}`;
}

module.exports = {
  ACCOUNT_STATUS,
  EMAIL_CODE_TTL_MINUTES,
  EMAIL_CODE_MAX_ATTEMPTS,
  normalizeText,
  normalizeComparableText,
  normalizeAccountStatus,
  ensureRfCoreSchema,
  resolveLoginAccessState,
  createEmailVerificationCode,
  createPendingRegistration,
  verifyPendingRegistration,
  deletePendingRegistration,
  verifyEmailVerificationCode,
  saveMedicoDocument,
  listMedicoDocumentsByUsuarioId,
  recordUserModification,
  buildInvoiceNumber,
  hashEmailVerificationCode,
  generateEmailVerificationCode,
};
