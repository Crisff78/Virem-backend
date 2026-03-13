const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { randomUUID, randomInt, createHmac } = require("crypto");
const pool = require("../config/db");
const { consultarExequaturSNS } = require("../services/exequatur.provider.js");
const {
  getUserProfileById,
  upsertUserProfileById,
  isSupportedImageUri,
  MAX_PHOTO_URL_LENGTH,
} = require("../services/user-profile.store");
const { requireAuth } = require("./middleware/auth");

const router = express.Router();
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

/**
 * Convierte "DD/MM/YYYY" -> "YYYY-MM-DD"
 * Si ya viene YYYY-MM-DD, lo deja igual.
 */
function toSqlDate(fecha) {
  const raw = String(fecha || "").trim();
  if (!raw) return raw;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parts = raw.split("/");
  if (parts.length !== 3) return raw;

  const [dd, mm, yyyy] = parts;
  if (!/^\d+$/.test(dd) || !/^\d+$/.test(mm) || !/^\d+$/.test(yyyy)) return raw;

  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function normalizePhone(rawPhone) {
  return String(rawPhone || "").replace(/\D/g, "").slice(0, 15);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function isStrongPassword(password) {
  const value = String(password || "");
  return (
    value.length >= 8 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

const RECOVERY_CODE_TTL_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.RECOVERY_CODE_TTL_MINUTES || "10", 10) || 10
);
const RECOVERY_RESEND_SECONDS = Math.max(
  30,
  Number.parseInt(process.env.RECOVERY_RESEND_SECONDS || "60", 10) || 60
);
const RECOVERY_MAX_ATTEMPTS = Math.max(
  3,
  Number.parseInt(process.env.RECOVERY_MAX_ATTEMPTS || "5", 10) || 5
);
const RECOVERY_CODE_LENGTH = 6;
const RECOVERY_HASH_SECRET =
  process.env.RECOVERY_CODE_SECRET ||
  process.env.JWT_SECRET ||
  "virem-dev-secret-change-me";

let recoveryTableReadyPromise = null;
let recoveryTransporterCache = undefined;

function generateRecoveryCode() {
  return String(randomInt(0, 10 ** RECOVERY_CODE_LENGTH)).padStart(
    RECOVERY_CODE_LENGTH,
    "0"
  );
}

function hashRecoveryCode(code, email) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const normalizedCode = String(code || "").trim();
  return createHmac("sha256", RECOVERY_HASH_SECRET)
    .update(`${normalizedEmail}::${normalizedCode}`)
    .digest("hex");
}

async function ensureRecoveryTable() {
  if (!recoveryTableReadyPromise) {
    recoveryTableReadyPromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS password_reset_code (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          verified_at TIMESTAMPTZ,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      )
      .then(() =>
        pool.query(
          `CREATE INDEX IF NOT EXISTS idx_password_reset_code_email_created
           ON password_reset_code (email, created_at DESC)`
        )
      )
      .catch((err) => {
        recoveryTableReadyPromise = null;
        throw err;
      });
  }

  return recoveryTableReadyPromise;
}

function getRecoveryTransporter() {
  if (typeof recoveryTransporterCache !== "undefined") {
    return recoveryTransporterCache;
  }

  const smtpUrl = String(process.env.SMTP_URL || "").trim();
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpUser = String(process.env.SMTP_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || "").trim();
  const smtpPort = Number.parseInt(process.env.SMTP_PORT || "587", 10) || 587;
  const smtpSecure = String(process.env.SMTP_SECURE || "false") === "true";

  if (smtpUrl) {
    recoveryTransporterCache = nodemailer.createTransport(smtpUrl);
    return recoveryTransporterCache;
  }

  if (smtpHost && smtpUser && smtpPass) {
    recoveryTransporterCache = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
    return recoveryTransporterCache;
  }

  recoveryTransporterCache = null;
  return recoveryTransporterCache;
}

async function sendRecoveryCodeEmail({ email, code }) {
  const transporter = getRecoveryTransporter();
  const fromEmail =
    String(process.env.RECOVERY_EMAIL_FROM || "").trim() ||
    String(process.env.SMTP_FROM || "").trim() ||
    String(process.env.SMTP_USER || "").trim() ||
    "no-reply@virem.local";

  if (!transporter) {
    if (String(process.env.NODE_ENV || "development") === "production") {
      throw new Error(
        "SMTP no configurado. Define SMTP_URL o SMTP_HOST/SMTP_USER/SMTP_PASS."
      );
    }

    console.warn(`[RECOVERY] Codigo para ${email}: ${code}`);
    return { delivered: false, devCode: code };
  }

  await transporter.sendMail({
    from: fromEmail,
    to: email,
    subject: "Codigo de recuperacion - VIREM",
    text: `Tu codigo de recuperacion es: ${code}. Expira en ${RECOVERY_CODE_TTL_MINUTES} minutos.`,
    html: `<p>Tu codigo de recuperacion es:</p><p><strong style="font-size:20px;letter-spacing:2px;">${code}</strong></p><p>Expira en ${RECOVERY_CODE_TTL_MINUTES} minutos.</p>`,
  });

  return { delivered: true };
}

let medicoColumnsCache = null;

async function getMedicoColumns(client) {
  if (medicoColumnsCache) return medicoColumnsCache;

  const schema = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'medico'`
  );

  medicoColumnsCache = new Map(
    schema.rows.map((row) => [
      String(row.column_name || "").toLowerCase(),
      {
        isNullable: String(row.is_nullable || "").toUpperCase() === "YES",
        columnDefault: row.column_default,
        dataType: String(row.data_type || "").toLowerCase(),
      },
    ])
  );

  return medicoColumnsCache;
}

async function insertMedicoCompatible({
  client,
  usuarioid,
  nombreCompletoTrim,
  fechaSQL,
  genero,
  cedulaClean,
  telefonoClean,
  especialidadTrim,
}) {
  const medicoColumns = await getMedicoColumns(client);
  const columns = [];
  const valueExpr = [];
  const params = [];
  const generoTrim = String(genero || "").trim();

  const addParam = (column, value) => {
    columns.push(column);
    params.push(value);
    valueExpr.push(`$${params.length}`);
  };

  const medicoidMeta = medicoColumns.get("medicoid");
  if (medicoidMeta && !medicoidMeta.columnDefault) {
    if (medicoidMeta.dataType === "uuid") {
      addParam("medicoid", randomUUID());
    } else if (medicoidMeta.dataType.includes("int")) {
      addParam("medicoid", Number(usuarioid));
    } else {
      addParam("medicoid", String(usuarioid));
    }
  }

  if (medicoColumns.has("nombrecompleto")) addParam("nombrecompleto", nombreCompletoTrim);
  if (medicoColumns.has("fechanacimiento")) addParam("fechanacimiento", fechaSQL);
  if (medicoColumns.has("genero")) addParam("genero", generoTrim);
  if (medicoColumns.has("cedula")) addParam("cedula", cedulaClean);
  if (medicoColumns.has("telefono")) addParam("telefono", telefonoClean);
  if (medicoColumns.has("especialidad")) {
    addParam("especialidad", especialidadTrim);
  } else if (medicoColumns.has("especialidadid")) {
    let especialidadId = null;
    if (especialidadTrim) {
      const espResult = await client.query(
        `SELECT especialidadid
         FROM especialidad
         WHERE lower(nombre) = lower($1)
         LIMIT 1`,
        [especialidadTrim]
      );
      especialidadId = espResult.rows[0]?.especialidadid ?? null;
    }
    addParam("especialidadid", especialidadId);
  }
  if (medicoColumns.has("consultorio")) addParam("consultorio", null);

  const fecharegistroMeta = medicoColumns.get("fecharegistro");
  if (fecharegistroMeta && !fecharegistroMeta.columnDefault) {
    columns.push("fecharegistro");
    valueExpr.push("NOW()");
  }

  if (!columns.length) {
    throw new Error("No se encontraron columnas insertables para la tabla medico.");
  }

  const insertSql = `INSERT INTO medico (${columns.join(", ")})
                     VALUES (${valueExpr.join(", ")})
                     RETURNING *`;
  const insertResult = await client.query(insertSql, params);
  const dbRow = insertResult.rows[0] || {};

  return {
    medicoid: dbRow.medicoid ?? null,
    nombreCompleto: dbRow.nombrecompleto ?? nombreCompletoTrim,
    fechanacimiento: dbRow.fechanacimiento ?? fechaSQL,
    genero: dbRow.genero ?? generoTrim,
    cedula: dbRow.cedula ?? cedulaClean,
    telefono: dbRow.telefono ?? telefonoClean,
    especialidad: dbRow.especialidad ?? especialidadTrim,
    fecharegistro: dbRow.fecharegistro ?? null,
  };
}

async function getMedicoProfileByUsuarioId(client, usuarioid, userCreatedAt) {
  const medicoColumns = await getMedicoColumns(client);
  const filters = [];

  if (medicoColumns.has("medicoid")) {
    filters.push("m.medicoid::text = $1::text");
  }
  if (medicoColumns.has("usuarioid")) {
    filters.push("m.usuarioid::text = $1::text");
  }

  const hasEspecialidadText = medicoColumns.has("especialidad");
  const hasEspecialidadId = medicoColumns.has("especialidadid");
  const hasFechaRegistro = medicoColumns.has("fecharegistro");

  const especialidadExpr = hasEspecialidadText
    ? `m.especialidad AS "especialidad"`
    : hasEspecialidadId
      ? `e.nombre AS "especialidad"`
      : `NULL AS "especialidad"`;

  const joinEspecialidad = hasEspecialidadId
    ? `LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid`
    : ``;

  const selectField = (columnName, alias) =>
    medicoColumns.has(columnName)
      ? `m.${columnName} AS "${alias}"`
      : `NULL AS "${alias}"`;

  const buildQuery = (whereClause) => `SELECT
      ${selectField("medicoid", "medicoid")},
      ${selectField("nombrecompleto", "nombreCompleto")},
      ${selectField("fechanacimiento", "fechanacimiento")},
      ${selectField("genero", "genero")},
      ${selectField("cedula", "cedula")},
      ${selectField("telefono", "telefono")},
      ${especialidadExpr},
      ${selectField("fecharegistro", "fecharegistro")}
    FROM medico m
    ${joinEspecialidad}
    ${whereClause}
    LIMIT 1`;

  const normalizeRow = (row) => ({
    medicoid: row.medicoid ?? null,
    nombreCompleto: row.nombreCompleto ?? null,
    fechanacimiento: row.fechanacimiento ?? null,
    genero: row.genero ?? null,
    cedula: row.cedula ?? null,
    telefono: row.telefono ?? null,
    especialidad: row.especialidad ?? null,
    fecharegistro: row.fecharegistro ?? null,
  });

  if (filters.length) {
    const directSql = buildQuery(`WHERE ${filters.join(" OR ")}`);
    const directResult = await client.query(directSql, [String(usuarioid)]);
    if (directResult.rows.length) {
      return normalizeRow(directResult.rows[0]);
    }
  }

  // Fallback para esquemas sin FK usuarioid/medicoid: empata por timestamp de creación.
  if (userCreatedAt && hasFechaRegistro) {
    const byExactDateSql = buildQuery(`WHERE m.fecharegistro = $1::timestamptz`);
    const byExactDate = await client.query(byExactDateSql, [userCreatedAt]);
    if (byExactDate.rows.length) {
      return normalizeRow(byExactDate.rows[0]);
    }

    // Fallback adicional: empata por orden de creación (usuario médico vs registro médico).
    const byRankSql = `WITH user_rank AS (
      SELECT
        u.usuarioid,
        u.fechacreacion,
        ROW_NUMBER() OVER (ORDER BY u.fechacreacion DESC, u.usuarioid DESC) AS rn
      FROM usuario u
      WHERE u.rolid = 2
    ),
    medico_rank AS (
      SELECT
        ${selectField("medicoid", "medicoid")},
        ${selectField("nombrecompleto", "nombreCompleto")},
        ${selectField("fechanacimiento", "fechanacimiento")},
        ${selectField("genero", "genero")},
        ${selectField("cedula", "cedula")},
        ${selectField("telefono", "telefono")},
        ${especialidadExpr},
        ${selectField("fecharegistro", "fecharegistro")},
        ROW_NUMBER() OVER (ORDER BY m.fecharegistro DESC, m.medicoid DESC) AS rn
      FROM medico m
      ${joinEspecialidad}
    )
    SELECT
      mr.*,
      ABS(EXTRACT(EPOCH FROM ((mr.fecharegistro::timestamp) - (ur.fechacreacion::timestamp)))) AS diff_seconds
    FROM user_rank ur
    JOIN medico_rank mr ON mr.rn = ur.rn
    WHERE ur.usuarioid = $1
    LIMIT 1`;

    const byRank = await client.query(byRankSql, [Number(usuarioid)]);
    if (byRank.rows.length) {
      const candidate = byRank.rows[0];
      const diffSeconds = Number(candidate.diff_seconds || 0);
      if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
        return normalizeRow(candidate);
      }
    }

    const byNearestDateSql = `SELECT
      ${selectField("medicoid", "medicoid")},
      ${selectField("nombrecompleto", "nombreCompleto")},
      ${selectField("fechanacimiento", "fechanacimiento")},
      ${selectField("genero", "genero")},
      ${selectField("cedula", "cedula")},
      ${selectField("telefono", "telefono")},
      ${especialidadExpr},
      ${selectField("fecharegistro", "fecharegistro")},
      ABS(EXTRACT(EPOCH FROM (m.fecharegistro - $1::timestamptz))) AS diff_seconds
    FROM medico m
    ${joinEspecialidad}
    ORDER BY diff_seconds ASC
    LIMIT 1`;

    const byNearest = await client.query(byNearestDateSql, [userCreatedAt]);
    if (byNearest.rows.length) {
      const candidate = byNearest.rows[0];
      const diffSeconds = Number(candidate.diff_seconds || 0);
      if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
        return normalizeRow(candidate);
      }
    }
  }

  return null;
}

async function getPacienteProfileByUsuarioId(client, usuarioid, userCreatedAt) {
  const directResult = await client.query(
    `SELECT
       p.pacienteid,
       p.nombres,
       p.apellidos,
       p.fechanacimiento,
       p.genero,
       p.cedula,
       p.telefono,
       p.fecharegistro
     FROM paciente p
     WHERE p.pacienteid::text = $1::text
     LIMIT 1`,
    [String(usuarioid)]
  );

  if (directResult.rows.length) {
    return directResult.rows[0];
  }

  if (userCreatedAt) {
    const byRank = await client.query(
      `WITH user_rank AS (
         SELECT
           u.usuarioid,
           u.fechacreacion,
           ROW_NUMBER() OVER (ORDER BY u.fechacreacion DESC, u.usuarioid DESC) AS rn
         FROM usuario u
         WHERE u.rolid = $2
       ),
       paciente_rank AS (
         SELECT
           p.pacienteid,
           p.nombres,
           p.apellidos,
           p.fechanacimiento,
           p.genero,
           p.cedula,
           p.telefono,
           p.fecharegistro,
           ROW_NUMBER() OVER (ORDER BY p.fecharegistro DESC, p.pacienteid DESC) AS rn
         FROM paciente p
       )
       SELECT
         pr.*,
         ABS(
           EXTRACT(
             EPOCH FROM ((pr.fecharegistro::timestamp) - (ur.fechacreacion::timestamp))
           )
         ) AS diff_seconds
       FROM user_rank ur
       JOIN paciente_rank pr ON pr.rn = ur.rn
       WHERE ur.usuarioid = $1
       LIMIT 1`,
      [Number(usuarioid), PACIENTE_ROLE_ID]
    );

    if (byRank.rows.length) {
      const row = byRank.rows[0];
      const diffSeconds = Number(row.diff_seconds || 0);
      if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
        return row;
      }
    }

    const byNearest = await client.query(
      `SELECT
         p.pacienteid,
         p.nombres,
         p.apellidos,
         p.fechanacimiento,
         p.genero,
         p.cedula,
         p.telefono,
         p.fecharegistro,
         ABS(
           EXTRACT(
             EPOCH FROM ((p.fecharegistro::timestamp) - ($1::timestamp))
           )
         ) AS diff_seconds
       FROM paciente p
       ORDER BY diff_seconds ASC
       LIMIT 1`,
      [userCreatedAt]
    );

    if (byNearest.rows.length) {
      const row = byNearest.rows[0];
      const diffSeconds = Number(row.diff_seconds || 0);
      if (Number.isFinite(diffSeconds) && diffSeconds <= 86400) {
        return row;
      }
    }
  }

  return null;
}

async function buildAuthUserPayload(client, userRow) {
  const payload = {
    usuarioid: userRow.usuarioid,
    rolid: userRow.rolid,
    email: userRow.email,
  };

  const isMedico = Number(userRow.rolid) === MEDICO_ROLE_ID;
  const isPaciente = Number(userRow.rolid) === PACIENTE_ROLE_ID;

  if (isMedico) {
    const medicoProfile = await getMedicoProfileByUsuarioId(
      client,
      userRow.usuarioid,
      userRow.fechacreacion
    );
    if (medicoProfile) {
      Object.assign(payload, medicoProfile);
    }
  } else if (isPaciente) {
    const pacienteProfile = await getPacienteProfileByUsuarioId(
      client,
      userRow.usuarioid,
      userRow.fechacreacion
    );

    if (pacienteProfile) {
      const nombres = String(pacienteProfile.nombres || '').trim();
      const apellidos = String(pacienteProfile.apellidos || '').trim();
      Object.assign(payload, {
        pacienteid: pacienteProfile.pacienteid ?? null,
        nombres,
        apellidos,
        nombre: nombres || null,
        apellido: apellidos || null,
        fechanacimiento: pacienteProfile.fechanacimiento ?? null,
        genero: pacienteProfile.genero ?? null,
        cedula: pacienteProfile.cedula ?? null,
        telefono: pacienteProfile.telefono ?? null,
        nombreCompleto: `${nombres} ${apellidos}`.trim() || null,
      });
    }
  }

  const userProfile = await getUserProfileById(client, userRow.usuarioid);
  if (userProfile?.fotoUrl) {
    payload.fotoUrl = userProfile.fotoUrl;
  }
  const meta = userProfile?.meta;
  if (meta && typeof meta === "object") {
    const assignIfMissing = (key, value) => {
      const clean = typeof value === "string" ? value.trim() : value;
      if (clean === undefined || clean === null || clean === "") return;
      if (!Object.prototype.hasOwnProperty.call(payload, key) || !payload[key]) {
        payload[key] = clean;
      }
    };

    assignIfMissing("direccion", meta.direccion);
    assignIfMissing("tipoSangre", meta.tipoSangre);
    assignIfMissing("alergias", meta.alergias);
    assignIfMissing("medicamentos", meta.medicamentos);
    assignIfMissing("antecedentes", meta.antecedentes);
    assignIfMissing("contactoEmergenciaNombre", meta.contactoEmergenciaNombre);
    assignIfMissing("contactoEmergenciaTelefono", meta.contactoEmergenciaTelefono);
    assignIfMissing("contactoEmergenciaParentesco", meta.contactoEmergenciaParentesco);
    if (Object.prototype.hasOwnProperty.call(meta, "recibirEmail")) {
      payload.recibirEmail = Boolean(meta.recibirEmail);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "recibirSMS")) {
      payload.recibirSMS = Boolean(meta.recibirSMS);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "compartirHistorial")) {
      payload.compartirHistorial = Boolean(meta.compartirHistorial);
    }
  }

  return payload;
}

/**
 * ===============================
 * POST /api/auth/register
 * Registra PACIENTE + USUARIO
 * ===============================
 */
router.post("/register", async (req, res) => {
  const {
    nombres,
    apellidos,
    fechanacimiento,
    genero,
    cedula,
    telefono,
    email,
    password,
  } = req.body;

  console.log("✅ POST /api/auth/register");
  console.log("📦 BODY:", req.body);

  if (
    !nombres ||
    !apellidos ||
    !fechanacimiento ||
    !genero ||
    !cedula ||
    !telefono ||
    !email ||
    !password
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan campos obligatorios (nombres, apellidos, fechanacimiento, genero, cedula, telefono, email, password).",
    });
  }

  const client = await pool.connect();

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const fechaSQL = toSqlDate(fechanacimiento);

    await client.query("BEGIN");

    // ✅ Email único
    const existing = await client.query(
      "SELECT usuarioid FROM usuario WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ese correo ya está registrado.",
      });
    }

    const passwordhash = await bcrypt.hash(String(password), 10);

    // ✅ Insert usuario PRIMERO (para evitar problemas de FK raros)
    const rolid = Number(process.env.DEFAULT_ROLID || 1);
    const activo = String(process.env.DEFAULT_ACTIVO || "true") === "true";

    const insertUsuario = await client.query(
      `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo)
       VALUES ($1,$2,$3,NOW(),$4)
       RETURNING usuarioid`,
      [rolid, normalizedEmail, passwordhash, activo]
    );

    const usuarioid = insertUsuario.rows[0].usuarioid;

    // ✅ Insert paciente (con usuarioid si tu BD lo requiere)
    // OJO: si tu tabla paciente NO tiene usuarioid, quita esa parte.
    // Como tu BD tiene fk_usuario: FOREIGN KEY (pacienteid) REFERENCES usuario(usuarioid)
    // eso es raro, pero lo manejamos con 2 inserts:
    //   - Insert usuario => usuarioid
    //   - Insert paciente forzando pacienteid = usuarioid
    const insertPaciente = await client.query(
      `INSERT INTO paciente (pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       RETURNING pacienteid`,
      [
        usuarioid,
        String(nombres).trim(),
        String(apellidos).trim(),
        fechaSQL,
        String(genero).trim(),
        String(cedula).replace(/\D/g, "").slice(0, 11),
        String(telefono).replace(/\D/g, "").slice(0, 11),
      ]
    );

    await client.query("COMMIT");

    console.log("✅ REGISTRO OK:", {
      pacienteid: insertPaciente.rows[0].pacienteid,
      usuarioid,
    });

    return res.json({
      success: true,
      message: "Paciente registrado correctamente.",
      pacienteid: insertPaciente.rows[0].pacienteid,
      usuarioid,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("❌ Error register paciente:", err);

    return res.status(500).json({
      success: false,
      message: "Error interno registrando paciente.",
      error: err?.message || String(err),
    });
  } finally {
    client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/register-medico
 * Registra MEDICO + USUARIO
 * ===============================
 */
router.post("/register-medico", async (req, res) => {
  const {
    nombreCompleto,
    fechanacimiento,
    genero,
    especialidad,
    cedula,
    telefono,
    fotoUrl,
    email,
    password,
    exequaturValidationToken,
  } = req.body;

  if (
    !nombreCompleto ||
    !fechanacimiento ||
    !genero ||
    !especialidad ||
    !cedula ||
    !telefono ||
    !email ||
    !password
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan campos obligatorios (nombreCompleto, fechanacimiento, genero, especialidad, cedula, telefono, email, password).",
    });
  }

  let client;

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const fechaSQL = toSqlDate(fechanacimiento);
    const nombreCompletoTrim = String(nombreCompleto).replace(/\s+/g, " ").trim();
    const cedulaClean = String(cedula).replace(/\D/g, "").slice(0, 11);
    const telefonoClean = normalizePhone(telefono);
    const especialidadTrim = String(especialidad).trim();
    const fotoUrlTrim = String(fotoUrl || "").trim();

    if (fotoUrlTrim.length > MAX_PHOTO_URL_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `fotoUrl supera ${MAX_PHOTO_URL_LENGTH} caracteres.`,
      });
    }

    if (!isSupportedImageUri(fotoUrlTrim || null)) {
      return res.status(400).json({
        success: false,
        message:
          "fotoUrl debe iniciar con http://, https://, file:// o data:image/.",
      });
    }

    const tokenRaw = String(exequaturValidationToken || "").trim();
    let exequaturValidatedByToken = false;

    if (tokenRaw && process.env.JWT_SECRET) {
      try {
        const payload = jwt.verify(tokenRaw, process.env.JWT_SECRET);
        const tokenScope = String(payload?.scope || "");
        const tokenExists = Boolean(payload?.exists);
        const tokenName = String(payload?.nombreCompleto || "")
          .replace(/\s+/g, " ")
          .trim();

        if (
          tokenScope === "exequatur-validation" &&
          tokenExists &&
          tokenName &&
          tokenName.localeCompare(nombreCompletoTrim, "es", { sensitivity: "base" }) === 0
        ) {
          exequaturValidatedByToken = true;
        }
      } catch (_) {}
    }

    let exequaturResult = { ok: true, exists: true };
    if (!exequaturValidatedByToken) {
      exequaturResult = await consultarExequaturSNS({
        nombreCompleto: nombreCompletoTrim,
      });
    }

    if (!exequaturResult.ok) {
      const statusCode = exequaturResult.serviceUnavailable ? 503 : 400;
      return res.status(statusCode).json({
        success: false,
        serviceUnavailable: Boolean(exequaturResult.serviceUnavailable),
        message:
          exequaturResult.reason ||
          "No se pudo validar el Exequatur del SNS. Intenta nuevamente.",
      });
    }

    if (!exequaturResult.exists) {
      const suggestedName = String(exequaturResult?.match?.candidateName || "").trim();
      const suggestedMessage = suggestedName
        ? ` Nombre similar encontrado: ${suggestedName}.`
        : "";

      return res.status(400).json({
        success: false,
        message: `El nombre del medico no aparece en el Exequatur del SNS.${suggestedMessage}`,
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT usuarioid FROM usuario WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ese correo ya está registrado.",
      });
    }

    const passwordhash = await bcrypt.hash(String(password), 10);
    // Para medicos, el default debe ser rol medico (2) si no se define DEFAULT_MEDICO_ROLID.
    const rolid = Number(process.env.DEFAULT_MEDICO_ROLID || 2);
    const activo = String(process.env.DEFAULT_ACTIVO || "true") === "true";

    const insertUsuario = await client.query(
      `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo)
       VALUES ($1,$2,$3,NOW(),$4)
       RETURNING usuarioid`,
      [rolid, normalizedEmail, passwordhash, activo]
    );

    const usuarioid = insertUsuario.rows[0].usuarioid;
    const medicoRow = await insertMedicoCompatible({
      client,
      usuarioid,
      nombreCompletoTrim,
      fechaSQL,
      genero,
      cedulaClean,
      telefonoClean,
      especialidadTrim,
    });

    if (fotoUrlTrim) {
      await upsertUserProfileById(client, usuarioid, { fotoUrl: fotoUrlTrim });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Médico registrado correctamente.",
      medico: medicoRow,
      usuarioid,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    return res.status(500).json({
      success: false,
      message: "Error interno registrando médico.",
      error: err?.message || String(err),
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/recovery/send-code
 * Genera y envia codigo de recuperacion
 * ===============================
 */
router.post("/recovery/send-code", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Debes enviar un correo valido.",
    });
  }

  let client;

  try {
    await ensureRecoveryTable();
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT usuarioid, activo
       FROM usuario
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    // Respuesta generica para evitar enumeracion de usuarios.
    if (!userResult.rows.length || !Boolean(userResult.rows[0].activo)) {
      return res.json({
        success: true,
        message:
          "Si el correo existe en nuestra plataforma, recibiras un codigo de recuperacion.",
      });
    }

    const latestResult = await client.query(
      `SELECT created_at
       FROM password_reset_code
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (latestResult.rows.length) {
      const latestCreatedAt = new Date(latestResult.rows[0].created_at).getTime();
      const elapsedSeconds = Math.floor((Date.now() - latestCreatedAt) / 1000);
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds < RECOVERY_RESEND_SECONDS) {
        const waitSeconds = RECOVERY_RESEND_SECONDS - elapsedSeconds;
        return res.status(429).json({
          success: false,
          message: `Espera ${waitSeconds}s antes de solicitar otro codigo.`,
        });
      }
    }

    const code = generateRecoveryCode();
    const codeHash = hashRecoveryCode(code, email);

    await client.query(
      `UPDATE password_reset_code
       SET used_at = NOW()
       WHERE email = $1
         AND used_at IS NULL`,
      [email]
    );

    await client.query(
      `INSERT INTO password_reset_code (
        email,
        code_hash,
        expires_at,
        attempts,
        created_at
      )
      VALUES (
        $1,
        $2,
        NOW() + ($3 * INTERVAL '1 minute'),
        0,
        NOW()
      )`,
      [email, codeHash, RECOVERY_CODE_TTL_MINUTES]
    );

    const delivery = await sendRecoveryCodeEmail({ email, code });
    const responsePayload = {
      success: true,
      message: "Te enviamos un codigo de recuperacion a tu correo.",
    };

    // Solo en desarrollo, para pruebas locales cuando no hay SMTP.
    if (delivery.devCode) {
      responsePayload.devCode = delivery.devCode;
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error("Error recovery/send-code:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo enviar el codigo de recuperacion.",
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/recovery/verify-code
 * Verifica codigo OTP de recuperacion
 * ===============================
 */
router.post("/recovery/verify-code", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();
  const code = String(req.body?.codigo || "").trim();

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Correo invalido.",
    });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({
      success: false,
      message: "El codigo debe tener 6 digitos.",
    });
  }

  let client;

  try {
    await ensureRecoveryTable();
    client = await pool.connect();

    const latestCode = await client.query(
      `SELECT id, code_hash, attempts, expires_at, used_at
       FROM password_reset_code
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (!latestCode.rows.length) {
      return res.status(400).json({
        success: false,
        message: "Codigo invalido o expirado.",
      });
    }

    const row = latestCode.rows[0];
    const codeId = row.id;

    if (row.used_at) {
      return res.status(400).json({
        success: false,
        message: "Codigo invalido o expirado.",
      });
    }

    const expiresAtMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
      await client.query(
        `UPDATE password_reset_code
         SET used_at = NOW()
         WHERE id = $1`,
        [codeId]
      );
      return res.status(400).json({
        success: false,
        message: "El codigo expiro. Solicita uno nuevo.",
      });
    }

    const attempts = Number(row.attempts || 0);
    if (attempts >= RECOVERY_MAX_ATTEMPTS) {
      return res.status(429).json({
        success: false,
        message: "Superaste el maximo de intentos. Solicita un nuevo codigo.",
      });
    }

    const expectedHash = hashRecoveryCode(code, email);
    if (expectedHash !== row.code_hash) {
      await client.query(
        `UPDATE password_reset_code
         SET attempts = attempts + 1
         WHERE id = $1`,
        [codeId]
      );
      return res.status(400).json({
        success: false,
        message: "Codigo incorrecto.",
      });
    }

    await client.query(
      `UPDATE password_reset_code
       SET verified_at = NOW()
       WHERE id = $1`,
      [codeId]
    );

    return res.json({
      success: true,
      message: "Codigo verificado correctamente.",
    });
  } catch (err) {
    console.error("Error recovery/verify-code:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo verificar el codigo.",
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/recovery/reset-password
 * Cambia password despues de OTP valido
 * ===============================
 */
router.post("/recovery/reset-password", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();
  const newPassword = String(req.body?.newPassword || "");

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Correo invalido.",
    });
  }

  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      success: false,
      message:
        "La contrasena debe tener al menos 8 caracteres, mayuscula, minuscula, numero y simbolo.",
    });
  }

  let client;

  try {
    await ensureRecoveryTable();
    client = await pool.connect();
    await client.query("BEGIN");

    const validCodeResult = await client.query(
      `SELECT id
       FROM password_reset_code
       WHERE email = $1
         AND verified_at IS NOT NULL
         AND used_at IS NULL
         AND expires_at > NOW()
       ORDER BY verified_at DESC
       LIMIT 1
       FOR UPDATE`,
      [email]
    );

    if (!validCodeResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message:
          "Debes validar un codigo de recuperacion vigente antes de cambiar la contrasena.",
      });
    }

    const userResult = await client.query(
      `SELECT usuarioid, activo
       FROM usuario
       WHERE email = $1
       LIMIT 1
       FOR UPDATE`,
      [email]
    );

    if (!userResult.rows.length || !Boolean(userResult.rows[0].activo)) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado.",
      });
    }

    const userId = userResult.rows[0].usuarioid;
    const codeId = validCodeResult.rows[0].id;
    const nextHash = await bcrypt.hash(newPassword, 10);

    await client.query(
      `UPDATE usuario
       SET passwordhash = $1
       WHERE usuarioid = $2`,
      [nextHash, userId]
    );

    await client.query(
      `UPDATE password_reset_code
       SET used_at = NOW()
       WHERE id = $1`,
      [codeId]
    );

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Contrasena actualizada correctamente.",
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Error recovery/reset-password:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la contrasena.",
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/login
 * ===============================
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || "").toLowerCase().trim();

  if (!normalizedEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "Email y password son obligatorios.",
    });
  }

  let client;

  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT usuarioid, rolid, email, passwordhash, activo, fechacreacion
       FROM usuario
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    const user = result.rows[0];

    if (!user.activo) {
      return res.status(403).json({ success: false, message: "Usuario inactivo." });
    }

    const ok = await bcrypt.compare(String(password), user.passwordhash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ success: false, message: "Falta JWT_SECRET en el .env" });
    }

    const token = jwt.sign(
      { usuarioid: user.usuarioid, rolid: user.rolid, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const userPayload = await buildAuthUserPayload(client, user);

    return res.json({
      success: true,
      message: "Login exitoso.",
      token,
      user: userPayload,
    });
  } catch (err) {
    console.error("Error login:", err);
    return res.status(500).json({ success: false, message: "Error interno en login." });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * GET /api/auth/me
 * Usuario autenticado + perfil medico (si aplica)
 * ===============================
 */
router.get("/me", requireAuth, async (req, res) => {
  let client;

  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT usuarioid, rolid, email, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1`,
      [req.user.usuarioid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado." });
    }

    const user = result.rows[0];
    if (!user.activo) {
      return res.status(403).json({ success: false, message: "Usuario inactivo." });
    }

    const userPayload = await buildAuthUserPayload(client, user);
    return res.json({ success: true, user: userPayload });
  } catch (err) {
    console.error("Error auth/me:", err);
    return res.status(500).json({ success: false, message: "Error interno obteniendo perfil." });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
