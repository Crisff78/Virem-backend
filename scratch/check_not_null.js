const pool = require('../config/db');

async function checkNullability() {
    try {
        const res = await pool.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'cita'");
        console.log(res.rows.filter(r => r.is_nullable === 'NO').map(r => r.column_name));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkNullability();
