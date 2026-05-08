const pool = require("../config/db");

async function repairPatients() {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");

        console.log("🔍 Buscando pacientes sin perfil...");
        const orphaned = await client.query(`
            SELECT u.usuarioid, u.email
            FROM usuario u
            LEFT JOIN paciente p ON u.usuarioid = p.usuarioid
            WHERE u.rolid = 1 AND p.pacienteid IS NULL
        `);

        for (const user of orphaned.rows) {
            console.log(`🛠️ Reparando perfil para: ${user.email} (ID: ${user.usuarioid})`);
            // Insertamos un perfil básico para que no falle el login
            await client.query(`
                INSERT INTO paciente (pacienteid, usuarioid, nombres, apellidos, fechanacimiento, genero, cedula, telefono)
                VALUES ($1, $1, $2, $3, $4, $5, $6, $7)
            `, [
                user.usuarioid, 
                "Paciente", 
                "Prueba", 
                "1990-01-01", 
                "M", 
                "00000000000", 
                "0000000000"
            ]);
        }

        console.log("✅ Perfiles creados.");

        console.log("🔓 Activando todas las cuentas de paciente para desarrollo...");
        const update = await client.query(`
            UPDATE usuario
            SET account_status = 'activa',
                email_verificado = true,
                activo = true
            WHERE rolid = 1
        `);
        console.log(`✅ ${update.rowCount} cuentas actualizadas a 'activa'.`);

        await client.query("COMMIT");
        console.log("🚀 Reparación completada con éxito.");
    } catch (err) {
        if (client) await client.query("ROLLBACK");
        console.error("❌ Error reparando pacientes:", err);
    } finally {
        if (client) client.release();
        process.exit();
    }
}

repairPatients();
