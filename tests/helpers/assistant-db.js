const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const path = require("node:path");

// Real PostgreSQL engine in memory; no .env, network or existing patient database.
async function assistantDatabase() {
  const db = new PGlite();
  await db.exec(
    "CREATE TABLE usuario(usuarioid INTEGER PRIMARY KEY, rolid INTEGER NOT NULL DEFAULT 1, activo BOOLEAN NOT NULL DEFAULT TRUE); INSERT INTO usuario VALUES(1,1,true),(2,1,true),(3,2,true),(4,1,false);",
  );
  await db.exec(
    fs.readFileSync(
      path.join(
        __dirname,
        "../../scripts/migrations/20260922_patient_assistant.sql",
      ),
      "utf8",
    ),
  );
  let tail = Promise.resolve();
  async function acquire() {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
  const pool = {
    async connect() {
      const release = await acquire();
      return { query: (sql, params) => db.query(sql, params), release };
    },
    async query(sql, params) {
      const release = await acquire();
      try {
        return await db.query(sql, params);
      } finally {
        release();
      }
    },
    end: () => db.close(),
  };
  return pool;
}
function syntheticAuth(pool) {
  return {
    authenticate(req, res, next) {
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      const id = token === "synthetic-preview" ? 1 : Number(token);
      if (!Number.isInteger(id) || id < 1)
        return res.status(401).json({ message: "Token requerido." });
      req.user = { usuarioid: id };
      next();
    },
    async patientOnly(req, res, next) {
      const { rows } = await pool.query(
        "SELECT * FROM usuario WHERE usuarioid=$1",
        [req.user.usuarioid],
      );
      if (!rows[0] || rows[0].rolid !== 1 || !rows[0].activo)
        return res.status(403).json({ message: "Acceso denegado." });
      req.accessControl = { actor: { usuarioid: rows[0].usuarioid } };
      next();
    },
  };
}
module.exports = { assistantDatabase, syntheticAuth };
