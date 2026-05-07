const pool = require('../config/db');

async function fixSchedules() {
    try {
        const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece';
        const specialtyId = 11;
        const timezoneId = 2;
        
        console.log('Cleaning up old test schedules...');
        await pool.query("DELETE FROM horario_disponible WHERE medicoid = $1", [medicoId]);

        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0); // Start of today (UTC)
        
        const end = new Date(start);
        end.setDate(end.getDate() + 7); // 7 days from now
        end.setHours(23, 59, 59, 999);
        
        console.log(`Creating a large block from ${start.toISOString()} to ${end.toISOString()}`);
        
        await pool.query(
            "INSERT INTO horario_disponible (medicoid, fechainicio, fechafin, activo, bloqueado, especialidadid, modalidad, zonahorariaid, nota, slot_minutos) VALUES ($1, $2, $3, true, false, $4, 'ambas', $5, 'FIXED_SCHED', 30)",
            [medicoId, start.toISOString(), end.toISOString(), specialtyId, timezoneId]
        );
        
        console.log('✅ Schedule fixed successfully.');
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

fixSchedules();
