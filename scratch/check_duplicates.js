const pool = require('../config/db');

async function checkDuplicates() {
    try {
        const res = await pool.query("SELECT medicoid, nombrecompleto FROM medico WHERE nombrecompleto ILIKE '%Esperanza%'");
        console.log('Doctors found:', res.rows);
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkDuplicates();
