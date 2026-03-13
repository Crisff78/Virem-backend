const pool = require("../config/db");

const USER_PROFILE_TABLE = "usuario_perfil";
const MAX_PHOTO_URL_LENGTH = 4096;

let ensureUserProfileTablePromise = null;

function resolveDb(dbClient) {
  if (dbClient && typeof dbClient.query === "function") {
    return dbClient;
  }
  return pool;
}

function normalizeFotoUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  if (value.length > MAX_PHOTO_URL_LENGTH) {
    throw new Error(
      `La fotoUrl supera el limite permitido (${MAX_PHOTO_URL_LENGTH} caracteres).`
    );
  }
  return value;
}

function isSupportedImageUri(value) {
  if (!value) return true;
  const lower = String(value).toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("file://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("data:image/")
  );
}

async function ensureUserProfileTable() {
  if (!ensureUserProfileTablePromise) {
    ensureUserProfileTablePromise = (async () => {
      const existsResult = await pool.query(
        `SELECT to_regclass('public.${USER_PROFILE_TABLE}') AS table_name`
      );
      const exists = Boolean(existsResult.rows[0]?.table_name);
      if (!exists) {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${USER_PROFILE_TABLE} (
            usuarioid TEXT PRIMARY KEY,
            foto_url TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`
        );
      }
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${USER_PROFILE_TABLE}_updated_at
         ON ${USER_PROFILE_TABLE} (updated_at DESC)`
      );
    })().catch((err) => {
      ensureUserProfileTablePromise = null;
      throw err;
    });
  }

  return ensureUserProfileTablePromise;
}

async function getUserProfileById(dbClient, usuarioid) {
  if (usuarioid === undefined || usuarioid === null) {
    return { usuarioid: null, fotoUrl: null, updatedAt: null };
  }

  try {
    await ensureUserProfileTable();
    const db = resolveDb(dbClient);
    const result = await db.query(
      `SELECT usuarioid, foto_url, updated_at
       FROM ${USER_PROFILE_TABLE}
       WHERE usuarioid = $1
       LIMIT 1`,
      [String(usuarioid)]
    );
    const row = result.rows[0] || null;
    return {
      usuarioid: row?.usuarioid || String(usuarioid),
      fotoUrl: row?.foto_url || null,
      updatedAt: row?.updated_at || null,
    };
  } catch {
    return { usuarioid: String(usuarioid), fotoUrl: null, updatedAt: null };
  }
}

async function upsertUserProfileById(dbClient, usuarioid, { fotoUrl }) {
  if (usuarioid === undefined || usuarioid === null) {
    throw new Error("usuarioid es obligatorio para guardar perfil.");
  }

  const normalizedFotoUrl = normalizeFotoUrl(fotoUrl);
  if (!isSupportedImageUri(normalizedFotoUrl)) {
    throw new Error("La fotoUrl no tiene un formato permitido.");
  }

  await ensureUserProfileTable();
  const db = resolveDb(dbClient);
  const result = await db.query(
    `INSERT INTO ${USER_PROFILE_TABLE} (usuarioid, foto_url, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (usuarioid)
     DO UPDATE SET
       foto_url = EXCLUDED.foto_url,
       updated_at = NOW()
     RETURNING usuarioid, foto_url, updated_at`,
    [String(usuarioid), normalizedFotoUrl]
  );
  const row = result.rows[0] || {};
  return {
    usuarioid: row.usuarioid || String(usuarioid),
    fotoUrl: row.foto_url || null,
    updatedAt: row.updated_at || null,
  };
}

module.exports = {
  ensureUserProfileTable,
  getUserProfileById,
  upsertUserProfileById,
  isSupportedImageUri,
  MAX_PHOTO_URL_LENGTH,
};
