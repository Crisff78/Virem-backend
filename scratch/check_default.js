const pool = require('../config/db');

async function checkDefault() {
    try {
        const res = await pool.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'cita' AND column_name = 'reminders_sent'");
        console.log(res.rows);
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkDefault();
