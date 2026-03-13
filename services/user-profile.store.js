const pool = require("../config/db");

const USER_PROFILE_TABLE = "usuario_perfil";
const MAX_PHOTO_URL_LENGTH = 3000000;

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
            meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`
        );
      }
      await pool.query(
        `ALTER TABLE ${USER_PROFILE_TABLE}
         ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb`
      );
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
      `SELECT usuarioid, foto_url, meta_json, updated_at
       FROM ${USER_PROFILE_TABLE}
       WHERE usuarioid = $1
       LIMIT 1`,
      [String(usuarioid)]
    );
    const row = result.rows[0] || null;
    const fotoUrlDb = row?.foto_url || null;
    const fotoUrl = isSupportedImageUri(fotoUrlDb) ? fotoUrlDb : null;
    const metaRaw = row?.meta_json;
    const meta =
      metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
        ? metaRaw
        : {};
    return {
      usuarioid: row?.usuarioid || String(usuarioid),
      fotoUrl,
      meta,
      updatedAt: row?.updated_at || null,
    };
  } catch {
    return { usuarioid: String(usuarioid), fotoUrl: null, meta: {}, updatedAt: null };
  }
}

async function upsertUserProfileById(dbClient, usuarioid, profilePatch = {}) {
  if (usuarioid === undefined || usuarioid === null) {
    throw new Error("usuarioid es obligatorio para guardar perfil.");
  }

  const hasFotoUrl = Object.prototype.hasOwnProperty.call(profilePatch, "fotoUrl");
  const hasMeta = Object.prototype.hasOwnProperty.call(profilePatch, "meta");
  const normalizedFotoUrl = hasFotoUrl
    ? normalizeFotoUrl(profilePatch.fotoUrl)
    : null;
  const normalizedMeta =
    hasMeta &&
    profilePatch.meta &&
    typeof profilePatch.meta === "object" &&
    !Array.isArray(profilePatch.meta)
      ? profilePatch.meta
      : {};
  if (!isSupportedImageUri(normalizedFotoUrl)) {
    throw new Error("La fotoUrl no tiene un formato permitido.");
  }

  await ensureUserProfileTable();
  const db = resolveDb(dbClient);
  const result = await db.query(
    `INSERT INTO ${USER_PROFILE_TABLE} (usuarioid, foto_url, meta_json, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (usuarioid)
     DO UPDATE SET
       foto_url = CASE
         WHEN $4::boolean THEN EXCLUDED.foto_url
         ELSE ${USER_PROFILE_TABLE}.foto_url
       END,
       meta_json = CASE
         WHEN $5::boolean THEN EXCLUDED.meta_json
         ELSE ${USER_PROFILE_TABLE}.meta_json
       END,
       updated_at = NOW()
     RETURNING usuarioid, foto_url, meta_json, updated_at`,
    [
      String(usuarioid),
      normalizedFotoUrl,
      JSON.stringify(normalizedMeta),
      hasFotoUrl,
      hasMeta,
    ]
  );
  const row = result.rows[0] || {};
  const metaRaw = row.meta_json;
  const nextMeta =
    metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? metaRaw
      : {};
  return {
    usuarioid: row.usuarioid || String(usuarioid),
    fotoUrl: row.foto_url || null,
    meta: nextMeta,
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
