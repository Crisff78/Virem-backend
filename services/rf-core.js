const { createHmac, randomInt, randomUUID } = require("crypto");
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

let ensureRfCoreSchemaPromise = null;

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

async function ensureRfCoreSchema() {
  if (ensureRfCoreSchemaPromise) return ensureRfCoreSchemaPromise;

  ensureRfCoreSchemaPromise = (async () => {
    await pool.query(
      `ALTER TABLE paciente
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER`
    );
    await pool.query(
      `ALTER TABLE medico
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER`
    );

    await pool.query(
      `ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS account_status VARCHAR(40) NOT NULL DEFAULT 'activa'`
    );
    await pool.query(
      `ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await pool.query(
      `ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS email_verificado_at TIMESTAMPTZ`
    );
    await pool.query(
      `ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS aprobado_por_admin BOOLEAN NOT NULL DEFAULT FALSE`
    );

    await pool.query(
      `UPDATE usuario
       SET account_status = 'activa'
       WHERE account_status IS NULL
          OR btrim(account_status) = ''`
    );

    await pool.query(
      `UPDATE usuario
       SET email_verificado = TRUE,
           email_verificado_at = COALESCE(email_verificado_at, NOW())
       WHERE email_verificado IS DISTINCT FROM TRUE
         AND account_status = 'activa'`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_usuario_account_status
       ON usuario (account_status, rolid, activo)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS pending_registration (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        registration_data JSONB NOT NULL,
        role_id INTEGER NOT NULL,
        verification_code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_pending_registration_email_expires
       ON pending_registration (email, expires_at)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS email_verificacion_code (
        id BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_verificacion_code_email_created
       ON email_verificacion_code (email, created_at DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS medico_documento (
        documentoid UUID PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        medicoid_text TEXT,
        tipo VARCHAR(40) NOT NULL,
        nombre VARCHAR(180),
        archivo_url TEXT NOT NULL,
        estado_revision VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        comentario_admin TEXT,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_medico_documento_usuario_tipo
       ON medico_documento (usuarioid, tipo, estado_revision, creado_en DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_modificacion_historial (
        id BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        actor_usuarioid INTEGER REFERENCES usuario(usuarioid) ON DELETE SET NULL,
        scope VARCHAR(40) NOT NULL,
        cambios_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        motivo TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_modificacion_historial_usuario_fecha
       ON user_modificacion_historial (usuarioid, created_at DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS historia_clinica (
        historiaid BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT NOT NULL,
        diagnostico TEXT NOT NULL,
        antecedentes TEXT,
        tratamiento TEXT,
        observaciones TEXT,
        duracion_min INTEGER,
        consentimiento_otorgado BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_usuarioid INTEGER,
        updated_by_usuarioid INTEGER
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_historia_clinica_paciente_fecha
       ON historia_clinica (pacienteid, created_at DESC)`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_historia_clinica_medico_fecha
       ON historia_clinica (medicoid_text, created_at DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS pago (
        pagoid UUID PRIMARY KEY,
        citaid UUID NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT,
        monto NUMERIC(12,2) NOT NULL,
        moneda CHAR(3) NOT NULL DEFAULT 'DOP',
        metodo_pago VARCHAR(40) NOT NULL,
        estado VARCHAR(40) NOT NULL DEFAULT 'simulado_aprobado',
        referencia_externa TEXT,
        detalle_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(`ALTER TABLE pago ADD COLUMN IF NOT EXISTS pacienteid INTEGER`);
    await pool.query(`ALTER TABLE pago ADD COLUMN IF NOT EXISTS medicoid_text TEXT`);
    await pool.query(
      `ALTER TABLE pago ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP'`
    );
    await pool.query(`ALTER TABLE pago ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(40)`);
    await pool.query(
      `ALTER TABLE pago ADD COLUMN IF NOT EXISTS estado VARCHAR(40) DEFAULT 'simulado_aprobado'`
    );
    await pool.query(`ALTER TABLE pago ADD COLUMN IF NOT EXISTS referencia_externa TEXT`);
    await pool.query(
      `ALTER TABLE pago ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb`
    );
    await pool.query(
      `ALTER TABLE pago ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`
    );
    await pool.query(
      `ALTER TABLE pago ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
    );

    await pool.query(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'metodopago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET metodo_pago = COALESCE(NULLIF(metodo_pago, ''''), metodopago)
          WHERE (metodo_pago IS NULL OR btrim(metodo_pago) = '''')
            AND metodopago IS NOT NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'estadopago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET estado = COALESCE(NULLIF(estado, ''''), estadopago)
          WHERE (estado IS NULL OR btrim(estado) = '''')
            AND estadopago IS NOT NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'transactionref'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET referencia_externa = COALESCE(referencia_externa, transactionref)
          WHERE referencia_externa IS NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'fechapago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET created_at = COALESCE(created_at, fechapago, NOW()),
              updated_at = COALESCE(updated_at, fechapago, created_at, NOW())
          WHERE created_at IS NULL
             OR updated_at IS NULL
        ';
      END IF;
    END $$`);

    await pool.query(
      `UPDATE pago p
       SET pacienteid = c.pacienteid,
           medicoid_text = c.medicoid::text
       FROM cita c
       WHERE p.citaid = c.citaid
         AND (p.pacienteid IS NULL OR p.medicoid_text IS NULL)`
    );
    await pool.query(
      `UPDATE pago
       SET moneda = 'DOP'
       WHERE moneda IS NULL
          OR btrim(moneda) = ''`
    );
    await pool.query(
      `UPDATE pago
       SET metodo_pago = 'tarjeta'
       WHERE metodo_pago IS NULL
          OR btrim(metodo_pago) = ''`
    );
    await pool.query(
      `UPDATE pago
       SET estado = 'simulado_aprobado'
       WHERE estado IS NULL
          OR btrim(estado) = ''`
    );
    await pool.query(
      `UPDATE pago
       SET detalle_json = '{}'::jsonb
       WHERE detalle_json IS NULL`
    );
    await pool.query(
      `UPDATE pago
       SET created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, created_at, NOW())
       WHERE created_at IS NULL
          OR updated_at IS NULL`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_pago_paciente_fecha
       ON pago (pacienteid, created_at DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS factura (
        facturaid UUID PRIMARY KEY,
        pagoid UUID NOT NULL REFERENCES pago(pagoid) ON DELETE CASCADE,
        numero_factura VARCHAR(80) NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        monto NUMERIC(12,2) NOT NULL,
        moneda CHAR(3) NOT NULL DEFAULT 'DOP',
        detalle_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await pool.query(`ALTER TABLE factura ADD COLUMN IF NOT EXISTS pacienteid INTEGER`);
    await pool.query(
      `ALTER TABLE factura ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP'`
    );
    await pool.query(
      `ALTER TABLE factura ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb`
    );
    await pool.query(
      `ALTER TABLE factura ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_factura_paciente_fecha
       ON factura (pacienteid, created_at DESC)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS valoracion (
        valoracionid BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT NOT NULL,
        puntaje SMALLINT NOT NULL,
        comentario TEXT,
        estado_moderacion VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        moderada_por INTEGER,
        moderada_en TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_valoracion_cita UNIQUE (citaid),
        CONSTRAINT chk_valoracion_puntaje CHECK (puntaje BETWEEN 1 AND 5)
      )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_valoracion_medico_estado
       ON valoracion (medicoid_text, estado_moderacion, created_at DESC)`
    );
  })().catch((err) => {
    ensureRfCoreSchemaPromise = null;
    throw err;
  });

  return ensureRfCoreSchemaPromise;
}

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

  if (!isActiveFlag) {
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
  await ensureRfCoreSchema();

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
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema();

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
      JSON.stringify(registrationData),
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
  await ensureRfCoreSchema();

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

  return {
    ok: true,
    email: normalizedEmail,
    roleId: Number(row.role_id),
    registrationData: row.registration_data,
    pendingId: row.id,
  };
}

async function deletePendingRegistration(dbClient, id) {
  const db = resolveDb(dbClient);
  await db.query("DELETE FROM pending_registration WHERE id = $1", [id]);
}

async function verifyEmailVerificationCode(dbClient, { email, codigo }) {
  const db = resolveDb(dbClient);
  await ensureRfCoreSchema();

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
         activo = TRUE
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
};
