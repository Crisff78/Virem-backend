const express = require("express");
const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { randomUUID, randomInt, createHmac, timingSafeEqual } = require("crypto");
const pool = require("../config/db");
const { consultarExequaturSNS } = require("../services/exequatur.provider.js");
const {
  getUserProfileById,
  upsertUserProfileById,
  isSupportedImageUri,
  MAX_PHOTO_URL_LENGTH,
} = require("../services/user-profile.store");
const { requireAuth } = require("./middleware/auth");
const {
  ACCOUNT_STATUS,
  EMAIL_CODE_TTL_MINUTES,
  ensureRfCoreSchema,
  resolveLoginAccessState,
  normalizeAccountStatus,
  createEmailVerificationCode,
  createPendingRegistration,
  verifyPendingRegistration,
  deletePendingRegistration,
  verifyEmailVerificationCode,
  saveMedicoDocument,
  hashEmailVerificationCode,
  generateEmailVerificationCode,
} = require("../services/rf-core");
const { authLimiter, recoveryLimiter } = require("../middleware/rate-limit");

const router = express.Router();
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

const ADMIN_MFA_TTL_MINUTES = 5;
const ADMIN_MFA_MAX_ATTEMPTS = 5;
const ADMIN_MFA_RESEND_SECONDS = 60;

function hashAdminMfaCode(userId, challengeId, code) {
  const secret = process.env.ADMIN_MFA_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("Admin MFA secret is not configured");
  return createHmac("sha256", secret)
    .update(`admin-mfa::${userId}::${challengeId}::${code}`)
    .digest("hex");
}

// Called only after password/account validation, with the usuario row locked.
// Expected denials are committed by the caller so failed attempts persist.
async function verifyAdminMfa(client, user, body) {
  const userId = String(user.usuarioid);
  const result = await client.query(
    `SELECT *, expires_at > clock_timestamp() AS unexpired,
       sent_at > clock_timestamp() - ($2 * INTERVAL '1 second') AS resend_blocked
     FROM admin_mfa_challenge WHERE usuarioid = $1 FOR UPDATE`,
    [userId, ADMIN_MFA_RESEND_SECONDS]
  );
  const challenge = result.rows[0];
  const deny = (status, code, message) => ({
    status, body: { success: false, mfaRequired: true, code, message },
  });
  if (challenge?.unexpired && challenge.attempts >= ADMIN_MFA_MAX_ATTEMPTS) {
    return deny(429, "MFA_LOCKED", "Demasiados intentos. Espera a que expire el codigo y solicita otro.");
  }

  // Merely sending a challenge ID or a client-side 'verified' flag never logs in.
  if (body.otp !== undefined && body.resendMfa !== true) {
    if (!challenge || !challenge.unexpired || challenge.used_at) {
      return deny(401, "MFA_INVALID", "Codigo invalido o expirado. Solicita un nuevo codigo.");
    }
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const challengeId = typeof body.mfaChallengeId === "string" ? body.mfaChallengeId : "";
    const candidate = Buffer.from(hashAdminMfaCode(userId, challenge.challenge_id, otp), "hex");
    const stored = Buffer.from(challenge.code_hash, "hex");
    const valid = /^\d{6}$/.test(otp) && challengeId === challenge.challenge_id &&
      candidate.length === stored.length && timingSafeEqual(candidate, stored);
    if (!valid) {
      await client.query("UPDATE admin_mfa_challenge SET attempts = attempts + 1 WHERE usuarioid = $1", [userId]);
      return deny(401, "MFA_INVALID", "Codigo de seguridad invalido.");
    }
    const consumed = await client.query(
      `UPDATE admin_mfa_challenge SET used_at = NOW(), code_hash = ''
       WHERE usuarioid = $1 AND challenge_id = $2 AND used_at IS NULL
         AND expires_at > clock_timestamp() AND attempts < $3`,
      [userId, challengeId, ADMIN_MFA_MAX_ATTEMPTS]
    );
    if (consumed.rowCount !== 1) {
      return deny(401, "MFA_INVALID", "Codigo invalido o expirado. Solicita un nuevo codigo.");
    }
    return null;
  }

  const pending = (id) => ({ status: 202, body: {
    success: true, mfaRequired: true, mfaChallengeId: id,
    message: "Introduce el codigo enviado al correo de seguridad de tu cuenta.",
  } });
  if (challenge?.unexpired && !challenge.used_at && body.resendMfa !== true) {
    return pending(challenge.challenge_id);
  }
  if (challenge?.resend_blocked) {
    return deny(429, "MFA_RESEND_LIMIT", "Espera un minuto antes de solicitar otro codigo.");
  }

  const destination = user.email === "admin@virem.local"
    ? String(process.env.ADMIN_MFA_EMAIL || "").trim()
    : user.email;
  const webhook = new URL(String(process.env.MAKE_WEBHOOK_URL || ""));
  if (!isValidEmail(destination) || webhook.protocol !== "https:" || webhook.username || webhook.password) {
    throw new Error("Admin MFA delivery is not configured");
  }
  const id = randomUUID();
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  await client.query(
    `INSERT INTO admin_mfa_challenge (usuarioid, challenge_id, code_hash, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + ($4 * INTERVAL '1 minute'))
     ON CONFLICT (usuarioid) DO UPDATE SET challenge_id = EXCLUDED.challenge_id,
       code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
       sent_at = clock_timestamp(),
       attempts = CASE WHEN admin_mfa_challenge.expires_at > clock_timestamp()
                       THEN admin_mfa_challenge.attempts ELSE 0 END,
       used_at = NULL`,
    [userId, id, hashAdminMfaCode(userId, id, code), ADMIN_MFA_TTL_MINUTES]
  );
  // Preserve Make's form payload. Never return/log the OTP or Axios request config.
  const payload = new URLSearchParams({
    type: "admin_2fa", email: destination, code, user: "Admin", timestamp: new Date().toISOString(),
  });
  await axios.post(webhook.toString(), payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000, maxRedirects: 0,
  });
  return pending(id);
}

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
const RECOVERY_RESEND_SECONDS = 1;
const RECOVERY_MAX_ATTEMPTS = Math.max(
  3,
  Number.parseInt(process.env.RECOVERY_MAX_ATTEMPTS || "5", 10) || 5
);
const RECOVERY_CODE_LENGTH = 6;
const RECOVERY_TICKET_TTL_MINUTES = 15;
const RECOVERY_HASH_SECRET =
  process.env.RECOVERY_CODE_SECRET ||
  process.env.JWT_SECRET ||
  (isProductionEnv() ? (() => { throw new Error("Falta RECOVERY_CODE_SECRET en producción") })() : "virem-dev-secret-change-me");

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

function hashRecoveryTicket(ticket, email) {
  return createHmac("sha256", RECOVERY_HASH_SECRET)
    .update(`password-reset-ticket::${email}::${ticket}`)
    .digest("hex");
}

// Compatibility helper; recovery tables are provisioned by scripts/migrations.js.
async function ensureRecoveryTable() {}

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

function isProductionEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function allowConsoleEmailFallback() {
  const raw = String(process.env.EMAIL_FALLBACK_TO_CONSOLE || "").trim().toLowerCase();
  if (!raw) {
    return !isProductionEnv();
  }
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function trimTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function resolvePublicBackendUrl() {
  const explicit = String(
    process.env.PUBLIC_BACKEND_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      ""
  ).trim();
  if (explicit) return trimTrailingSlash(explicit);
  const port = Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
  return `http://localhost:${port}`;
}

function resolvePublicWebUrl() {
  const explicit = String(
    process.env.PUBLIC_WEB_URL ||
      process.env.WEB_PUBLIC_URL ||
      process.env.FRONTEND_PUBLIC_URL ||
      process.env.EXPO_PUBLIC_FRONTEND_URL ||
      ""
  ).trim();
  return explicit ? trimTrailingSlash(explicit) : "";
}

function buildEmailVerificationLink(email, code) {
  const backendUrl = resolvePublicBackendUrl();
  return (
    `${backendUrl}/api/auth/verify-email-link` +
    `?email=${encodeURIComponent(String(email || "").trim().toLowerCase())}` +
    `&codigo=${encodeURIComponent(String(code || "").trim())}`
  );
}

async function sendRecoveryCodeEmail({ email, code }) {
  const makeWebhookUrl = String(process.env.MAKE_WEBHOOK_URL || "").trim();
  const transporter = getRecoveryTransporter();
  const fromEmail =
    String(process.env.RECOVERY_EMAIL_FROM || "").trim() ||
    String(process.env.SMTP_FROM || "").trim() ||
    String(process.env.SMTP_USER || "").trim() ||
    "no-reply@virem.local";

  // Si tenemos Webhook de Make, enviamos los datos allí primero
  if (makeWebhookUrl) {
    try {
      if (email) {
        await axios.post(makeWebhookUrl, {
          type: 'recovery_code',
          email: email,
          to: email, // Alias for easier mapping
          pacienteEmail: email, // Added for compatibility with Make.com scenarios
          code: code,
          timestamp: new Date().toISOString()
        });
        console.log(`✅ Código de recuperación enviado a Make.com para ${email}`);
      }
      return { delivered: true };
    } catch (makeError) {
      console.error(`❌ Error enviando recuperación a Make.com: ${makeError.message}`);
    }
  }

  if (!transporter) {
    if (!allowConsoleEmailFallback()) {
      throw new Error(
        "SMTP no configurado. Define SMTP_URL o SMTP_HOST/SMTP_USER/SMTP_PASS. Si quieres modo consola, usa EMAIL_FALLBACK_TO_CONSOLE=true."
      );
    }

    console.warn("[RECOVERY] Envio no disponible; respuesta de desarrollo habilitada.");
    return { delivered: false, devCode: code };
  }

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: "Codigo de recuperacion - VIREM",
      text: `Tu codigo de recuperacion es: ${code}. Expira en ${RECOVERY_CODE_TTL_MINUTES} minutos.`,
      html: `<p>Tu codigo de recuperacion es:</p><p><strong style="font-size:20px;letter-spacing:2px;">${code}</strong></p><p>Expira en ${RECOVERY_CODE_TTL_MINUTES} minutos.</p>`,
    });
  } catch (error) {
    if (!allowConsoleEmailFallback()) {
      throw error;
    }

    console.warn("[RECOVERY] Fallo de envio; respuesta de desarrollo habilitada.");
    return { delivered: false, devCode: code };
  }

  return { delivered: true };
}

async function sendEmailVerificationCodeEmail({ email, code }) {
  const makeWebhookUrl = String(process.env.MAKE_WEBHOOK_URL || "").trim();
  const transporter = getRecoveryTransporter();
  const verificationLink = buildEmailVerificationLink(email, code);
  const fromEmail =
    String(process.env.SMTP_USER || "").trim() ||
    String(process.env.VERIFICATION_EMAIL_FROM || "").trim() ||
    String(process.env.RECOVERY_EMAIL_FROM || "").trim() ||
    String(process.env.SMTP_FROM || "").trim() ||
    "no-reply@virem.local";

  // Si tenemos Webhook de Make, enviamos los datos allí primero
  if (makeWebhookUrl) {
    try {
      if (email) {
        await axios.post(makeWebhookUrl, {
          type: 'verification_code',
          email: email,
          to: email, // Alias for easier mapping
          pacienteEmail: email, // Added for compatibility with Make.com scenarios
          code: code,
          verificationLink: verificationLink,
          timestamp: new Date().toISOString()
        });
        console.log(`✅ Datos enviados a Make.com Webhook para ${email}`);
      }
      return { delivered: true };
    } catch (makeError) {
      console.error(`❌ Error enviando a Make.com: ${makeError.message}`);
    }
  }

  if (!transporter) {
    if (!allowConsoleEmailFallback()) {
      throw new Error(
        "SMTP no configurado. Define SMTP_URL o SMTP_HOST/SMTP_USER/SMTP_PASS. Si quieres modo consola, usa EMAIL_FALLBACK_TO_CONSOLE=true."
      );
    }

    console.warn("[VERIFY] Envio no disponible; respuesta de desarrollo habilitada.");
    return { delivered: false, devCode: code };
  }

  try {
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          .container { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; background-color: #f6fafd; border-radius: 24px; }
          .white-box { background-color: #ffffff; padding: 40px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
          .logo { text-align: center; margin-bottom: 30px; }
          .logo-text { font-size: 28px; font-weight: 800; color: #137fec; letter-spacing: 2px; }
          .title { font-size: 24px; font-weight: 700; color: #0a1931; margin-bottom: 10px; text-align: center; }
          .subtitle { font-size: 16px; color: #4a7fa7; margin-bottom: 30px; text-align: center; line-height: 1.5; }
          .code-box { background-color: #f1f7ff; padding: 20px; border-radius: 16px; text-align: center; margin-bottom: 30px; border: 1px dashed #137fec; }
          .code { font-size: 36px; font-weight: 800; color: #137fec; letter-spacing: 8px; margin: 0; }
          .footer { font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #137fec; color: #ffffff !important; text-decoration: none; border-radius: 12px; font-weight: 700; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">
            <span class="logo-text">VIREM</span>
          </div>
          <div class="white-box">
            <h1 class="title">Verifica tu correo</h1>
            <p class="subtitle">¡Gracias por unirte a VIREM! Para completar tu registro, introduce el siguiente código en la aplicación:</p>
            
            <div class="code-box">
              <h2 class="code">${code}</h2>
            </div>
            
            <p class="subtitle" style="margin-bottom: 10px;">Este código expirará en ${EMAIL_CODE_TTL_MINUTES} minutos.</p>
            
            <div style="text-align: center; margin-top: 20px;">
              <p style="font-size: 14px; color: #64748b;">Si prefieres, también puedes verificar haciendo clic aquí:</p>
              <a href="${verificationLink}" class="btn">Verificar ahora</a>
            </div>
          </div>
          <div class="footer">
            &copy; 2026 VIREM - Plataforma Médica Integral.<br>
            Si no solicitaste este código, puedes ignorar este correo.
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: `Verifica tu cuenta en VIREM [${code}]`,
      text: `Tu código de verificación de VIREM es: ${code}. Expira en ${EMAIL_CODE_TTL_MINUTES} minutos.`,
      html: htmlContent,
    });
    console.log(`✅ Email de verificación enviado a ${email}`);
  } catch (error) {
    if (!allowConsoleEmailFallback()) {
      throw error;
    }

    console.warn("[VERIFY] Fallo de envio; respuesta de desarrollo habilitada.");
    return { delivered: false, devCode: code };
  }

  return { delivered: true };
}

let medicoColumnsCache = null;
let pacienteColumnsCache = null;

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function resolveEspecialidadIdFlexible(client, especialidadValue) {
  const raw = String(especialidadValue || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await client.query(
      `SELECT especialidadid
       FROM especialidad
       WHERE especialidadid = $1
       LIMIT 1`,
      [Number(raw)]
    );
    if (byId.rows.length) {
      return Number(byId.rows[0].especialidadid);
    }
  }

  const all = await client.query(
    `SELECT especialidadid, nombre
     FROM especialidad
     ORDER BY especialidadid ASC`
  );
  const normalizedTarget = normalizeComparableText(raw);

  const exactMatch = all.rows.find(
    (row) => normalizeComparableText(row.nombre) === normalizedTarget
  );
  if (exactMatch) return Number(exactMatch.especialidadid);

  const fuzzyMatch = all.rows.find((row) => {
    const normalizedRow = normalizeComparableText(row.nombre);
    return (
      normalizedRow.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedRow)
    );
  });
  if (fuzzyMatch) return Number(fuzzyMatch.especialidadid);

  try {
    const inserted = await client.query(
      `INSERT INTO especialidad (nombre)
       VALUES ($1)
       RETURNING especialidadid`,
      [raw]
    );
    return Number(inserted.rows[0]?.especialidadid || 0) || null;
  } catch (_) {
    const retry = await client.query(
      `SELECT especialidadid
       FROM especialidad
       WHERE lower(nombre) = lower($1)
       LIMIT 1`,
      [raw]
    );
    return retry.rows.length ? Number(retry.rows[0].especialidadid) : null;
  }
}

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

async function getPacienteColumns(client) {
  if (pacienteColumnsCache) return pacienteColumnsCache;

  const schema = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'paciente'`
  );

  pacienteColumnsCache = new Map(
    schema.rows.map((row) => [
      String(row.column_name || "").toLowerCase(),
      {
        isNullable: String(row.is_nullable || "").toUpperCase() === "YES",
        columnDefault: row.column_default,
        dataType: String(row.data_type || "").toLowerCase(),
      },
    ])
  );

  return pacienteColumnsCache;
}

async function insertPacienteCompatible({
  client,
  usuarioid,
  nombres,
  apellidos,
  fechaSQL,
  genero,
  cedulaClean,
  telefonoClean,
}) {
  const pacienteColumns = await getPacienteColumns(client);
  const columns = [];
  const valueExpr = [];
  const params = [];

  const addParam = (column, value) => {
    columns.push(column);
    params.push(value);
    valueExpr.push(`$${params.length}`);
  };

  const pacienteidMeta = pacienteColumns.get("pacienteid");
  if (pacienteidMeta && !pacienteidMeta.columnDefault) {
    addParam("pacienteid", Number(usuarioid));
  }

  addParam("nombres", String(nombres).trim());
  addParam("apellidos", String(apellidos).trim());
  addParam("fechanacimiento", fechaSQL);
  addParam("genero", String(genero).trim());
  addParam("cedula", cedulaClean);
  addParam("telefono", telefonoClean);

  if (pacienteColumns.has("usuarioid")) {
    addParam("usuarioid", Number(usuarioid));
  }

  const fecharegistroMeta = pacienteColumns.get("fecharegistro");
  if (fecharegistroMeta && !fecharegistroMeta.columnDefault) {
    columns.push("fecharegistro");
    valueExpr.push("NOW()");
  }

  const insertSql = `INSERT INTO paciente (${columns.join(", ")})
                     VALUES (${valueExpr.join(", ")})
                     RETURNING pacienteid`;
  const result = await client.query(insertSql, params);
  return result.rows[0] || null;
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

  if (medicoColumns.has("usuarioid")) addParam("usuarioid", Number(usuarioid));
  if (medicoColumns.has("nombrecompleto")) addParam("nombrecompleto", nombreCompletoTrim);
  if (medicoColumns.has("fechanacimiento")) addParam("fechanacimiento", fechaSQL);
  if (medicoColumns.has("genero")) addParam("genero", generoTrim);
  if (medicoColumns.has("cedula")) addParam("cedula", cedulaClean);
  if (medicoColumns.has("telefono")) addParam("telefono", telefonoClean);
  if (medicoColumns.has("especialidad")) {
    addParam("especialidad", especialidadTrim);
  } else if (medicoColumns.has("especialidadid")) {
    const especialidadId = await resolveEspecialidadIdFlexible(client, especialidadTrim);
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

async function getMedicoProfileByUsuarioId(client, usuarioid, userCreatedAt, options = {}) {
  const medicoColumns = await getMedicoColumns(client);
  if (!medicoColumns.has("usuarioid")) return null;

  const hasEspecialidadText = medicoColumns.has("especialidad");
  const hasEspecialidadId = medicoColumns.has("especialidadid");

  const especialidadExpr = hasEspecialidadText
    ? `m.especialidad AS "especialidad"`
    : hasEspecialidadId
      ? `COALESCE(e.nombre, 'Medicina General') AS "especialidad"`
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

  const directResult = await client.query(
    buildQuery(`WHERE m.usuarioid = $1`),
    [Number(usuarioid)]
  );
  if (directResult.rows.length) {
    return normalizeRow(directResult.rows[0]);
  }

  return null;
}

async function getPacienteProfileByUsuarioId(client, usuarioid, userCreatedAt) {
  const pacienteColumns = await getPacienteColumns(client);
  if (!pacienteColumns.has("usuarioid")) return null;

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
     WHERE p.usuarioid = $1
     LIMIT 1`,
    [Number(usuarioid)]
  );

  if (directResult.rows.length) {
    return directResult.rows[0];
  }

  return null;
}

async function buildAuthUserPayload(client, userRow) {
  const payload = {
    usuarioid: userRow.usuarioid,
    rolid: userRow.rolid,
    email: userRow.email,
    accountStatus: normalizeAccountStatus(userRow.account_status || "activa"),
    emailVerificado: Boolean(userRow.email_verificado),
  };
  const userProfile = await getUserProfileById(client, userRow.usuarioid);
  const meta =
    userProfile?.meta && typeof userProfile.meta === "object" ? userProfile.meta : {};

  const isMedico = Number(userRow.rolid) === MEDICO_ROLE_ID;
  const isPaciente = Number(userRow.rolid) === PACIENTE_ROLE_ID;

  if (isMedico) {
    const medicoProfile = await getMedicoProfileByUsuarioId(client, userRow.usuarioid);
    if (medicoProfile) {
      Object.assign(payload, medicoProfile);
    }
  } else if (isPaciente) {
    const pacienteProfile = await getPacienteProfileByUsuarioId(client, userRow.usuarioid);

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

  if (userProfile?.fotoUrl) {
    payload.fotoUrl = userProfile.fotoUrl;
  }
  if (meta && typeof meta === "object") {
    const assignIfMissing = (key, value) => {
      const clean = typeof value === "string" ? value.trim() : value;
      if (clean === undefined || clean === null || clean === "") return;
      if (!Object.prototype.hasOwnProperty.call(payload, key) || !payload[key]) {
        payload[key] = clean;
      }
    };

    assignIfMissing("nombreCompleto", meta.nombreCompleto);
    assignIfMissing("especialidad", meta.especialidad);
    assignIfMissing("cedula", meta.cedula);
    assignIfMissing("telefono", meta.telefono);
    assignIfMissing("genero", meta.genero);
    assignIfMissing("fechanacimiento", meta.fechanacimiento);

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
router.post("/register", authLimiter, async (req, res) => {
  const { nombres, apellidos, fechanacimiento, genero, cedula, telefono, email, password } = req.body;
  const normalizedEmail = String(email || "").toLowerCase().trim();

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const existing = await client.query("SELECT usuarioid FROM usuario WHERE email = $1", [normalizedEmail]);
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Este correo ya está registrado." });
    }

    const bodyCompleto = { nombres, apellidos, fechanacimiento, genero, cedula, telefono, password };
    const verification = await createPendingRegistration(client, {
      email: normalizedEmail,
      registrationData: bodyCompleto,
      roleId: PACIENTE_ROLE_ID,
    });

    await client.query("COMMIT");
    let delivery = null;
    try {
      delivery = await sendEmailVerificationCodeEmail({ email: normalizedEmail, code: verification.codigo });
    } catch (emailErr) {
      console.error("⚠️ Error enviando email de verificación:", emailErr.message);
      // No fallamos el registro completo si solo falló el envío del email, 
      // pero informamos al usuario o logueamos el problema.
    }

    return res.status(200).json({
      success: true,
      message: "Código enviado. Verifícalo para completar tu registro.",
      requiresEmailVerification: true,
      ...(delivery?.devCode ? { devVerificationCode: delivery.devCode } : {}),
    });
  } catch (err) {
    if (client) {
      try {
        // Solo intentamos ROLLBACK si la conexión sigue abierta y no se ha hecho COMMIT
        await client.query("ROLLBACK");
      } catch (rbErr) {
        // Silenciamos errores de rollback si la transacción ya terminó
      }
    }
    console.error("❌ Error crítico en registro de paciente:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Error interno registrando paciente.",
      error: "Error interno registrando paciente."
    });
  } finally {
    if (client) client.release();
  }
});



/**
 * ===============================
 * POST /api/auth/register-medico
 * Registra MEDICO + USUARIO
 * ===============================
 */
router.post("/register-medico", authLimiter, async (req, res) => {
  const { nombreCompleto, fechanacimiento, genero, especialidad, cedula, telefono, fotoUrl, email, password, documentos, exequaturValidationToken } = req.body;
  const normalizedEmail = String(email || "").toLowerCase().trim();

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const existing = await client.query("SELECT usuarioid FROM usuario WHERE email = $1", [normalizedEmail]);
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Este correo ya está registrado." });
    }

    const bodyCompleto = { nombreCompleto, fechanacimiento, genero, especialidad, cedula, telefono, fotoUrl, password, documentos, exequaturValidationToken };
    const verification = await createPendingRegistration(client, {
      email: normalizedEmail,
      registrationData: bodyCompleto,
      roleId: MEDICO_ROLE_ID,
    });

    await client.query("COMMIT");
    let delivery = null;
    try {
      delivery = await sendEmailVerificationCodeEmail({ email: normalizedEmail, code: verification.codigo });
    } catch (emailErr) {
      console.error("⚠️ Error enviando email de verificación (médico):", emailErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Código enviado. Verifícalo para completar tu registro profesional.",
      requiresEmailVerification: true,
      ...(delivery?.devCode ? { devVerificationCode: delivery.devCode } : {}),
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rbErr) {}
    }
    console.error("❌ Error crítico en registro de médico:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Error interno registrando médico.",
      error: "Error interno registrando médico."
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/register/confirm", authLimiter, async (req, res) => {
  const { email, codigo } = req.body;
  const normalizedEmail = String(email || "").toLowerCase().trim();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const verif = await verifyPendingRegistration(client, { email: normalizedEmail, codigo });
    if (!verif.ok) {
      // Incorrect/expired OTPs mutate attempts or delete the expired row.
      // Commit these expected failures; only unexpected errors are rolled back.
      await client.query("COMMIT");
      return res.status(400).json({ success: false, message: verif.message });
    }

    const { roleId, registrationData, pendingId } = verif;
    const body = registrationData;
    let usuarioid = null;

    if (roleId === MEDICO_ROLE_ID) {
      const passwordhash = body.passwordHash;
      const ins = await client.query(
        `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo, account_status, email_verificado, email_verificado_at, aprobado_por_admin)
         VALUES ($1,$2,$3,NOW(),FALSE,$4,TRUE,NOW(),FALSE)
         RETURNING usuarioid`,
        [roleId, normalizedEmail, passwordhash, ACCOUNT_STATUS.PENDING_APPROVAL]
      );
      usuarioid = ins.rows[0].usuarioid;
      const medico = await insertMedicoCompatible({
        client, usuarioid,
        nombreCompletoTrim: body.nombreCompleto,
        fechaSQL: toSqlDate(body.fechanacimiento),
        genero: body.genero,
        cedulaClean: body.cedula,
        telefonoClean: body.telefono,
        especialidadTrim: body.especialidad
      });
      await upsertUserProfileById(client, usuarioid, {
        meta: { nombreCompleto: body.nombreCompleto, especialidad: body.especialidad, cedula: body.cedula, telefono: body.telefono, genero: body.genero, fechanacimiento: body.fechanacimiento },
        fotoUrl: body.fotoUrl
      });
      if (body.documentos?.cedulaProfesionalUrl) {
        await saveMedicoDocument(client, { usuarioid, medicoid: String(medico.medicoid || ""), tipo: "cedula_profesional", nombre: "Cédula profesional", archivoUrl: body.documentos.cedulaProfesionalUrl });
      }
      if (body.documentos?.certificadoEspecialidadUrl) {
        await saveMedicoDocument(client, { usuarioid, medicoid: String(medico.medicoid || ""), tipo: "certificado_especialidad", nombre: "Certificado de especialidad", archivoUrl: body.documentos.certificadoEspecialidadUrl });
      }
    } else {
      const passwordhash = body.passwordHash;
      const ins = await client.query(
        `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo, account_status, email_verificado, email_verificado_at)
         VALUES ($1,$2,$3,NOW(),TRUE,'activa',TRUE,NOW())
         RETURNING usuarioid`,
        [roleId, normalizedEmail, passwordhash]
      );
      usuarioid = ins.rows[0].usuarioid;
      await insertPacienteCompatible({
        client,
        usuarioid,
        nombres: body.nombres,
        apellidos: body.apellidos,
        fechaSQL: toSqlDate(body.fechanacimiento),
        genero: body.genero,
        cedulaClean: body.cedula,
        telefonoClean: body.telefono
      });
    }

    await deletePendingRegistration(client, pendingId);
    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Registro completado con éxito.",
      usuarioid,
      ...(roleId === MEDICO_ROLE_ID ? { requiresAdminApproval: true } : {}),
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Error confirming registration:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Error al crear la cuenta.",
      error: "Error al crear la cuenta."
    });
  } finally {
    if (client) client.release();
  }
});



function renderEmailVerificationPage({
  title,
  message,
  success = false,
  loginUrl = "",
}) {
  const safeTitle = String(title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeLoginUrl = String(loginUrl || "").trim();
  const accent = success ? "#16a34a" : "#dc2626";

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body{font-family:Arial,sans-serif;background:#f4f8fb;margin:0;padding:0}
      .wrap{max-width:520px;margin:56px auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e5edf4}
      h1{margin:0 0 10px 0;color:#0a1931;font-size:24px}
      p{margin:0 0 16px 0;color:#334155;line-height:1.5}
      .bar{height:4px;background:${accent};border-radius:999px;margin-bottom:16px}
      a.btn{display:inline-block;text-decoration:none;background:#137fec;color:#fff;padding:10px 16px;border-radius:10px;font-weight:700}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="bar"></div>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      ${safeLoginUrl ? `<a class="btn" href="${safeLoginUrl}">Ir al login</a>` : ""}
    </div>
  </body>
</html>`;
}

/**
 * ===============================
 * GET /api/auth/verify-email-link
 * Verifica correo desde enlace enviado por email
 * ===============================
 */
router.get("/verify-email-link", async (req, res) => {
  const email = String(req.query?.email || "")
    .toLowerCase()
    .trim();
  const codigo = String(req.query?.codigo || req.query?.code || "").trim();
  const loginUrl = resolvePublicWebUrl();

  if (!isValidEmail(email) || !/^\d{6}$/.test(codigo)) {
    return res
      .status(400)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(
        renderEmailVerificationPage({
          title: "Enlace invalido",
          message:
            "El enlace de verificacion no es valido o ya no contiene un codigo correcto.",
          success: false,
          loginUrl,
        })
      );
  }

  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();

    const verification = await verifyEmailVerificationCode(client, { email, code: codigo });
    if (!verification?.success) {
      return res
        .status(400)
        .set("Content-Type", "text/html; charset=utf-8")
        .send(
          renderEmailVerificationPage({
            title: "No se pudo verificar",
            message:
              verification?.message ||
              "Tu codigo no pudo validarse. Solicita un nuevo codigo de verificacion.",
            success: false,
            loginUrl,
          })
        );
    }

    return res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(
        renderEmailVerificationPage({
          title: "Correo verificado",
          message: "Tu cuenta ya fue verificada. Puedes iniciar sesion.",
          success: true,
          loginUrl,
        })
      );
  } catch (err) {
    return res
      .status(500)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(
        renderEmailVerificationPage({
          title: "Error interno",
          message:
            "Ocurrio un error procesando la verificacion. Intenta de nuevo en unos minutos.",
          success: false,
          loginUrl,
        })
      );
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/verify-email
 * Verifica correo de paciente por codigo
 * ===============================
 */
router.post("/verify-email", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();
  const codigo = String(req.body?.codigo || "").trim();

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Correo invalido.",
    });
  }
  if (!/^\d{6}$/.test(codigo)) {
    return res.status(400).json({
      success: false,
      message: "El codigo debe tener 6 digitos.",
    });
  }

  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await verifyEmailVerificationCode(client, {
      email,
      codigo,
    });
    if (!result.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        code: result.code,
        message: result.message,
      });
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Correo verificado correctamente. Ya puedes iniciar sesion.",
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return res.status(500).json({
      success: false,
      message: "No se pudo verificar el correo.",
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/resend-verification
 * Reenvia codigo de verificacion de correo
 * ===============================
 */
router.post("/resend-verification", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Correo invalido.",
    });
  }

  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT
         usuarioid,
         rolid,
         activo,
         account_status,
         email_verificado
       FROM usuario
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    // Respuesta generica para evitar enumeracion.
    if (!userResult.rows.length) {
      return res.json({
        success: true,
        message:
          "Si el correo existe y requiere verificacion, te enviaremos un nuevo codigo.",
      });
    }

    const userRow = userResult.rows[0];
    const status = normalizeComparableText(userRow.account_status || "activa");
    const emailVerified = Boolean(userRow.email_verificado);

    if (
      !Boolean(userRow.activo) ||
      emailVerified ||
      status !== ACCOUNT_STATUS.PENDING_VERIFICATION
    ) {
      return res.json({
        success: true,
        message:
          "Si el correo existe y requiere verificacion, te enviaremos un nuevo codigo.",
      });
    }

    const codePayload = await createEmailVerificationCode(client, {
      usuarioid: userRow.usuarioid,
      email,
      ttlMinutes: EMAIL_CODE_TTL_MINUTES,
    });
    const delivery = await sendEmailVerificationCodeEmail({
      email,
      code: codePayload.codigo,
    });

    return res.json({
      success: true,
      message: "Te enviamos un nuevo codigo de verificacion.",
      ...(delivery?.devCode ? { devVerificationCode: delivery.devCode } : {}),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "No se pudo reenviar el codigo de verificacion.",
      error: "No se pudo reenviar el codigo de verificacion.",
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
router.post("/recovery/send-code", recoveryLimiter, async (req, res) => {
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
router.post("/recovery/verify-code", recoveryLimiter, async (req, res) => {
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
    await client.query("BEGIN");

    const latestCode = await client.query(
      `SELECT id, code_hash, attempts, expires_at, used_at, verified_at
       FROM password_reset_code
       WHERE email = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [email]
    );

    if (!latestCode.rows.length) {
      await client.query("COMMIT");
      return res.status(400).json({
        success: false,
        message: "Codigo invalido o expirado.",
      });
    }

    const row = latestCode.rows[0];
    const codeId = row.id;

    if (row.used_at || row.verified_at) {
      await client.query("COMMIT");
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
      await client.query("COMMIT");
      return res.status(400).json({
        success: false,
        message: "El codigo expiro. Solicita uno nuevo.",
      });
    }

    const attempts = Number(row.attempts || 0);
    if (attempts >= RECOVERY_MAX_ATTEMPTS) {
      await client.query("COMMIT");
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
      await client.query("COMMIT");
      return res.status(400).json({
        success: false,
        message: "Codigo incorrecto.",
      });
    }

    const recoveryTicket = randomUUID();
    await client.query(
      `UPDATE password_reset_code
       SET verified_at = NOW(),
           recovery_ticket_hash = $2,
           recovery_ticket_expires_at = NOW() + ($3 * INTERVAL '1 minute')
       WHERE id = $1`,
      [codeId, hashRecoveryTicket(recoveryTicket, email), RECOVERY_TICKET_TTL_MINUTES]
    );
    await client.query("COMMIT");

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      success: true,
      message: "Codigo verificado correctamente.",
      recoveryTicket,
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
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
  const recoveryTicket = typeof req.body?.recoveryTicket === "string"
    ? req.body.recoveryTicket.trim().toLowerCase()
    : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recoveryTicket)) {
    return res.status(403).json({
      success: false,
      message: "Debes presentar un ticket de recuperacion valido.",
    });
  }
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

    // Match the stored fingerprint of this exact ticket and email, never just
    // an earlier successful OTP. Hold the row lock until both updates commit.
    const validTicketResult = await client.query(
      `SELECT id
       FROM password_reset_code
       WHERE email = $1
         AND verified_at IS NOT NULL
         AND used_at IS NULL
         AND recovery_ticket_hash = $2
         AND recovery_ticket_expires_at > NOW()
       ORDER BY verified_at DESC
       LIMIT 1
       FOR UPDATE`,
      [email, hashRecoveryTicket(recoveryTicket, email)]
    );

    if (validTicketResult.rows.length !== 1) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message:
          "El ticket de recuperacion es invalido o ha expirado. Solicita un nuevo codigo.",
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
    const codeId = validTicketResult.rows[0].id;
    const nextHash = await bcrypt.hash(newPassword, 10);

    const passwordUpdateResult = await client.query(
      `UPDATE usuario
       SET passwordhash = $1
       WHERE usuarioid = $2`,
      [nextHash, userId]
    );
    if (passwordUpdateResult.rowCount !== 1) {
      throw new Error("Password recovery did not update exactly one user");
    }

    const consumedTicketResult = await client.query(
      `UPDATE password_reset_code
       SET used_at = NOW(),
           recovery_ticket_hash = NULL,
           recovery_ticket_expires_at = NULL
       WHERE id = $1
         AND email = $2
         AND recovery_ticket_hash = $3
         AND verified_at IS NOT NULL
         AND used_at IS NULL
         AND recovery_ticket_expires_at > clock_timestamp()`,
      [codeId, email, hashRecoveryTicket(recoveryTicket, email)]
    );
    if (consumedTicketResult.rowCount !== 1) {
      // Also roll back the password if the ticket expired during hashing.
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message:
          "El ticket de recuperacion es invalido o ha expirado. Solicita un nuevo codigo.",
      });
    }

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
router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").toLowerCase().trim();

  if (!normalizedEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "Email y password son obligatorios.",
    });
  }

  let client;
  let transactionOpen = false;

  try {
    await ensureRfCoreSchema();
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    let searchEmail = normalizedEmail;
    if (normalizedEmail === 'admin') {
      searchEmail = 'admin@virem.local';
    }

    const result = await client.query(
      `SELECT
         usuarioid,
         rolid,
         email,
         passwordhash,
         activo,
         fechacreacion,
         account_status,
         email_verificado
       FROM usuario
       WHERE email = $1 FOR UPDATE`,
      [searchEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    const user = result.rows[0];

    const ok = await bcrypt.compare(String(password), user.passwordhash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    const loginState = resolveLoginAccessState(user);
    if (!loginState.ok) {
      return res.status(403).json({
        success: false,
        code: loginState.code,
        message: loginState.message,
      });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ success: false, message: "Falta JWT_SECRET en el .env" });
    }

    if (Number(user.rolid) === 3) {
      const mfaResult = await verifyAdminMfa(client, user, req.body);
      if (mfaResult) {
        await client.query("COMMIT");
        transactionOpen = false;
        return res.status(mfaResult.status).json(mfaResult.body);
      }
    }

    const userPayload = await buildAuthUserPayload(client, user);

    const token = jwt.sign(
      { usuarioid: user.usuarioid, rolid: user.rolid, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return res.json({
      success: true,
      message: "Login exitoso.",
      token,
      user: userPayload,
    });
  } catch (err) {
    // Axios errors can contain webhook URLs and OTPs in their request config.
    console.error("Error interno en login o entrega MFA.");
    return res.status(500).json({ success: false, message: "Error interno en login." });
  } finally {
    if (client && transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
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
    await ensureRfCoreSchema();
    client = await pool.connect();

    const result = await client.query(
      `SELECT
         usuarioid,
         rolid,
         email,
         activo,
         fechacreacion,
         account_status,
         email_verificado
       FROM usuario
       WHERE usuarioid = $1`,
      [req.user.usuarioid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado." });
    }

    const user = result.rows[0];
    const loginState = resolveLoginAccessState(user, {
      enforceEmailVerification: false,
    });
    if (!loginState.ok) {
      return res.status(403).json({
        success: false,
        code: loginState.code,
        message: loginState.message,
      });
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

/**
 * ===============================
 * POST /api/auth/resend-verification-pending
 * Reenvia codigo para registro pendiente
 * ===============================
 */
router.post("/resend-verification-pending", async (req, res) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Correo inválido.",
    });
  }

  let client;
  try {
    await ensureRfCoreSchema();
    client = await pool.connect();

    const pendingResult = await client.query(
      `SELECT id, registration_data, role_id, verification_code_hash, expires_at
       FROM pending_registration
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (!pendingResult.rows.length) {
      return res.json({
        success: true,
        message: "Si existe un registro pendiente, te enviaremos un nuevo código.",
      });
    }

    const row = pendingResult.rows[0];
    const expiresAt = new Date(row.expires_at).getTime();
    const nowMs = Date.now();

    // Verificar si el registro pendiente aún es válido
    if (expiresAt <= nowMs) {
      await client.query("DELETE FROM pending_registration WHERE id = $1", [row.id]);
      return res.json({
        success: true,
        message: "Si existe un registro pendiente, te enviaremos un nuevo código.",
      });
    }

    // Generar nuevo código
    const newCode = generateEmailVerificationCode();
    const normalizedEmail = normalizeComparableText(email).toLowerCase();
    const newCodeHash = hashEmailVerificationCode(normalizedEmail, newCode);

    await client.query(
      `UPDATE pending_registration
       SET verification_code_hash = $1, created_at = NOW()
       WHERE id = $2`,
      [newCodeHash, row.id]
    );

    const delivery = await sendEmailVerificationCodeEmail({
      email,
      code: newCode,
    });

    return res.json({
      success: true,
      message: "Se envió un nuevo código de verificación.",
      ...(delivery?.devCode ? { devVerificationCode: delivery.devCode } : {}),
    });
  } catch (err) {
    console.error("Error resend-verification-pending:", err);
    return res.status(500).json({
      success: false,
      message: "No se pudo reenviar el código.",
      error: "No se pudo reenviar el código.",
    });
  } finally {
    if (client) client.release();
  }
});



module.exports = router;
