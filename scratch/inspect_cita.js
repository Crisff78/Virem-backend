const pool = require('../config/db');

async function inspectCita() {
    try {
        const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'cita' ORDER BY ordinal_position");
        console.log(res.rows.map(r => r.column_name).join(', '));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

inspectCita();
