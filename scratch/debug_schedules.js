const pool = require('../config/db');

async function debugDoctor() {
    try {
        console.log('Searching for doctor...');
        const res = await pool.query("SELECT * FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%'");
        console.log('Doctor found:', res.rows);
        
        if (res.rows.length > 0) {
            const medicoId = res.rows[0].medicoid;
            console.log('Checking schedules for medicoid:', medicoId);
            const schedules = await pool.query("SELECT * FROM horario_disponible WHERE medicoid = $1", [medicoId]);
            console.log('All schedules found:', schedules.rows);
            
            const upcoming = await pool.query("SELECT * FROM horario_disponible WHERE medicoid = $1 AND fechainicio > NOW()", [medicoId]);
            console.log('Upcoming schedules:', upcoming.rows);

            if (upcoming.rows.length === 0) {
                console.log('No upcoming schedules found. Creating a test schedule...');
                const start = new Date();
                start.setHours(start.getHours() + 1, 0, 0, 0);
                const end = new Date(start);
                end.setHours(end.getHours() + 1);
                
                await pool.query(
                    "INSERT INTO horario_disponible (medicoid, fechainicio, fechafin, activo, bloqueado, especialidadid) VALUES ($1, $2, $3, true, false, $4)",
                    [medicoId, start.toISOString(), end.toISOString(), res.rows[0].especialidadid]
                );
                console.log('Test schedule created for:', start.toLocaleString());
            }
        } else {
            console.log('Doctor not found in the database.');
        }
    } catch (err) {
        console.error('Error during debug:', err);
    } finally {
        process.exit();
    }
}

debugDoctor();
