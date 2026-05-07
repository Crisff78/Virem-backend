const pool = require('../config/db');

async function createTestSchedule() {
    try {
        const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece';
        const start = new Date();
        start.setMinutes(start.getMinutes() + 10); // Start in 10 minutes
        const end = new Date(start);
        end.setHours(end.getHours() + 2);
        
        await pool.query(
            "INSERT INTO horario_disponible (medicoid, fechainicio, fechafin, activo, bloqueado, especialidadid, modalidad, zonahorariaid) VALUES ($1, $2, $3, true, false, 11, 'ambas', 2)",
            [medicoId, start.toISOString(), end.toISOString()]
        );
        console.log('✅ Schedule created successfully for:', start.toLocaleString());
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

createTestSchedule();
