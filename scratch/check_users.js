const pool = require("../config/db");

async function checkUsers() {
    try {
        const res = await pool.query(`
            SELECT u.usuarioid, u.email, u.account_status, u.email_verificado, p.pacienteid IS NOT NULL as has_profile
            FROM usuario u
            LEFT JOIN paciente p ON u.usuarioid = p.usuarioid
            WHERE u.rolid = 1
            ORDER BY u.usuarioid DESC
        `);
        console.log("=== TODOS LOS PACIENTES ===");
        console.table(res.rows);
        
        const roles = await pool.query("SELECT * FROM rol");
        console.log("=== ROLES ===");
        console.table(roles.rows);
        
    } catch (err) {
        console.error("Error checking users:", err);
    } finally {
        await pool.end();
    }
}

checkUsers();
