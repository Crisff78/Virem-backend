require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const MIGRATIONS = [
  "db/fase2_normalizar_cita_paciente.sql",
  "db/fase2_seed_catalogos_cita.sql",
  "db/fase3_citas_tiempo_real.sql",
  "db/fase4_optimizacion_agenda_chat_video.sql",
];

async function getCitaPacienteColumnType(client) {
  const result = await client.query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cita'
       AND column_name = 'pacienteid'
     LIMIT 1`
  );
  if (!result.rows.length) return { dataType: "", udtName: "" };
  return {
    dataType: String(result.rows[0].data_type || "").trim().toLowerCase(),
    udtName: String(result.rows[0].udt_name || "").trim().toLowerCase(),
  };
}

async function shouldSkipMigration(client, relativeFile) {
  if (relativeFile !== "db/fase2_normalizar_cita_paciente.sql") {
    return { skip: false, reason: "" };
  }

  const typeInfo = await getCitaPacienteColumnType(client);
  const isInteger =
    typeInfo.udtName === "int4" || typeInfo.dataType.includes("integer");
  if (isInteger) {
    return {
      skip: true,
      reason:
        "cita.pacienteid ya es INTEGER, la normalizacion de fase2 no es necesaria.",
    };
  }

  return { skip: false, reason: "" };
}

async function printUniqueIndexStatus(client) {
  const indexResult = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'uq_cita_medico_inicio_activa'
     ) AS exists`
  );
  const hasUniqueIndex = Boolean(indexResult.rows[0]?.exists);

  const dupResult = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM (
       SELECT medicoid, fechahorainicio
       FROM cita
       WHERE lower(coalesce(estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')
       GROUP BY medicoid, fechahorainicio
       HAVING COUNT(*) > 1
     ) d`
  );
  const duplicateGroups = Number(dupResult.rows[0]?.total || 0);

  console.log("\n--- Verificacion anti doble-reserva ---");
  console.log(`Indice unico activo: ${hasUniqueIndex ? "SI" : "NO"}`);
  console.log(`Grupos duplicados activos: ${duplicateGroups}`);

  if (!hasUniqueIndex && duplicateGroups > 0) {
    console.log(
      "Aviso: limpia duplicados activos y vuelve a ejecutar `npm run migrate:agenda` para crear el indice unico."
    );
  }
}

function resolveConnectionConfig() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    };
  }

  const host = String(process.env.DB_HOST || "").trim();
  const port = Number.parseInt(String(process.env.DB_PORT || "5432"), 10) || 5432;
  const database = String(process.env.DB_NAME || "").trim();
  const user = String(process.env.DB_USER || "").trim();
  const password = String(process.env.DB_PASSWORD || "");

  if (!host || !database || !user) {
    throw new Error(
      "Falta configuracion de base de datos. Define DATABASE_URL o DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD."
    );
  }

  return {
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: false },
  };
}

async function run() {
  const client = new Client(resolveConnectionConfig());
  await client.connect();

  try {
    for (const relativeFile of MIGRATIONS) {
      const filePath = path.join(process.cwd(), relativeFile);
      if (!fs.existsSync(filePath)) {
        throw new Error(`No existe el archivo de migracion: ${relativeFile}`);
      }

      const skipInfo = await shouldSkipMigration(client, relativeFile);
      if (skipInfo.skip) {
        console.log(`\n>> Saltando ${relativeFile}`);
        console.log(`   Motivo: ${skipInfo.reason}`);
        continue;
      }

      const sql = fs.readFileSync(filePath, "utf8");
      console.log(`\n>> Ejecutando ${relativeFile}`);
      await client.query(sql);
      console.log(`OK ${relativeFile}`);
    }

    await printUniqueIndexStatus(client);
    console.log("\nMigraciones completadas.");
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("\nFallo ejecutando migraciones:", err.message);
  process.exit(1);
});
