const pool = require('../config/db');

async function checkUsuario() {
    try {
        const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'usuario'");
        console.log(res.rows.map(r => r.column_name));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkUsuario();
