const pool = require('../config/db');

async function createManySchedules() {
    try {
        const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece';
        const specialtyId = 11;
        const timezoneId = 2;
        
        // Clear old test schedules to avoid clutter
        await pool.query("DELETE FROM horario_disponible WHERE medicoid = $1 AND nota = 'TEST_AUTO'", [medicoId]);

        const days = 7;
        for (let i = 0; i < days; i++) {
            const start = new Date();
            start.setDate(start.getDate() + i);
            start.setHours(8, 0, 0, 0); // 8 AM
            
            const end = new Date(start);
            end.setHours(20, 0, 0, 0); // 8 PM
            
            await pool.query(
                "INSERT INTO horario_disponible (medicoid, fechainicio, fechafin, activo, bloqueado, especialidadid, modalidad, zonahorariaid, nota) VALUES ($1, $2, $3, true, false, $4, 'ambas', $5, 'TEST_AUTO')",
                [medicoId, start.toISOString(), end.toISOString(), specialtyId, timezoneId]
            );
            console.log(`✅ Schedule created for day ${i}: ${start.toDateString()}`);
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

createManySchedules();
