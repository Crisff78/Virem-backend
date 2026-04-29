const pool = require("../config/db");

async function migrate() {
  console.log("Iniciando migración de precios v2...");
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // 1. Agregar columnas de precios específicos si no existen
    await client.query(`
      ALTER TABLE medico 
      ADD COLUMN IF NOT EXISTS precio_chat NUMERIC(10,2) DEFAULT 500,
      ADD COLUMN IF NOT EXISTS precio_videollamada NUMERIC(10,2) DEFAULT 1000
    `);
    console.log("- Columnas precio_chat y precio_videollamada aseguradas.");

    // 2. Asegurar que la comisión sea del 15% por defecto
    await client.query(`
      ALTER TABLE medico 
      ALTER COLUMN comision_porcentaje SET DEFAULT 15
    `);
    
    // 3. Actualizar registros existentes que tengan la comisión antigua (ej. 10%)
    await client.query(`
      UPDATE medico 
      SET comision_porcentaje = 15 
      WHERE comision_porcentaje IS NULL OR comision_porcentaje < 15
    `);
    console.log("- Comisión actualizada al 15% para todos los médicos.");

    // 4. Sincronizar precio base (si existe) con los nuevos precios si están en 0
    await client.query(`
      UPDATE medico 
      SET precio_chat = COALESCE(precio, 500),
          precio_videollamada = COALESCE(precio * 1.5, 1000)
      WHERE precio_chat = 500 AND precio_videollamada = 1000 AND precio > 0
    `);

    await client.query("COMMIT");
    console.log("Migración completada exitosamente.");
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Error en la migración:", err);
    process.exit(1);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

migrate();
