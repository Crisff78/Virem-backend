const { Pool } = require("pg");
require("dotenv").config();

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const useSsl = String(process.env.DB_SSL || "").toLowerCase() === "true";

const pool = new Pool(
  hasDatabaseUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      }
);

module.exports = pool;
