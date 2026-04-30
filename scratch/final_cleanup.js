const pool = require('../config/db');

async function targetCleanup() {
  const targetEmail = 'esperanzamorales@hotmail.com';
  try {
    console.log(`Starting cleanup for ${targetEmail}...`);

    // 1. Find the main user
    const mainUser = await pool.query("SELECT * FROM usuario WHERE email = $1", [targetEmail]);
    if (mainUser.rows.length === 0) {
      console.log("Error: Target user not found.");
      process.exit(1);
    }
    const mainUserId = mainUser.rows[0].usuarioid;

    // 2. Find the main medico
    const mainMedico = await pool.query("SELECT * FROM medico WHERE usuarioid = $1", [mainUserId]);
    let mainMedicoId;
    if (mainMedico.rows.length === 0) {
      console.log("Warning: No medico linked to this user yet. Looking for orphans with same name...");
      const orphan = await pool.query("SELECT * FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales de la Cruz%' AND usuarioid IS NULL ORDER BY fecharegistro DESC LIMIT 1");
      if (orphan.rows.length > 0) {
        mainMedicoId = orphan.rows[0].medicoid;
        await pool.query("UPDATE medico SET usuarioid = $1, especialidadid = 11 WHERE medicoid = $2", [mainUserId, mainMedicoId]);
        console.log("Linked orphan medico to user.");
      } else {
        console.log("No medico found to link. Will create one or skip.");
      }
    } else {
      mainMedicoId = mainMedico.rows[0].medicoid;
      await pool.query("UPDATE medico SET especialidadid = 11 WHERE medicoid = $1", [mainMedicoId]);
      console.log("Ensured main medico has Medicina General.");
    }

    // 3. Identify and delete duplicates
    // We want to delete all medicos named Esperanza except the main one
    console.log("Deleting duplicate medicos...");
    const duplicates = await pool.query(`
      SELECT medicoid, usuarioid FROM medico 
      WHERE nombrecompleto ILIKE '%Esperanza Morales de la Cruz%' 
      AND medicoid <> $1
    `, [mainMedicoId || '00000000-0000-0000-0000-000000000000']);

    for (const row of duplicates.rows) {
      console.log(`Deleting duplicate medico ${row.medicoid}...`);
      await pool.query("DELETE FROM medico WHERE medicoid = $1", [row.medicoid]);
      if (row.usuarioid && row.usuarioid !== mainUserId) {
        console.log(`Deleting duplicate user ${row.usuarioid}...`);
        await pool.query("DELETE FROM usuario WHERE usuarioid = $1", [row.usuarioid]);
      }
    }

    console.log("Cleanup finished successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Cleanup error:", err);
    process.exit(1);
  }
}

targetCleanup();
