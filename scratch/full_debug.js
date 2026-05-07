const pool = require('../config/db');

async function fullDebug() {
    try {
        console.log('--- Doctor Info ---');
        const med = await pool.query("SELECT * FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%'");
        console.log(med.rows);
        
        if (med.rows.length > 0) {
            const m = med.rows[0];
            console.log('--- Specialty Info ---');
            const esp = await pool.query("SELECT * FROM especialidad WHERE especialidadid = $1", [m.especialidadid]);
            console.log(esp.rows);
            
            console.log('--- Active Schedules ---');
            const sch = await pool.query("SELECT * FROM horario_disponible WHERE medicoid = $1 AND fechafin > NOW() AND activo = true AND bloqueado = false", [m.medicoid]);
            console.log(sch.rows);
            
            console.log('--- Existing Appointments ---');
            const appointments = await pool.query("SELECT * FROM cita WHERE medicoid = $1 AND fechahorafin > NOW()", [m.medicoid]);
            console.log(appointments.rows);
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

fullDebug();
