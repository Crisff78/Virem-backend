const pool = require('../config/db');

async function testAvailabilityAPI() {
    try {
        const medicoId = '77b18329-6e9c-4fc7-b000-f52e7bf4bece';
        const especialidadId = 11;
        
        console.log('--- Testing Availability API Logic ---');
        
        // Simulating the query logic in agenda.routes.js
        const params = [medicoId, especialidadId];
        const query = `
            SELECT 
                h.*, 
                m.nombrecompleto as medico_nombre,
                e.nombre as especialidad_nombre
            FROM horario_disponible h
            JOIN medico m ON m.medicoid = h.medicoid
            LEFT JOIN especialidad e ON e.especialidadid = COALESCE(h.especialidadid, m.especialidadid)
            WHERE h.activo = TRUE 
              AND h.bloqueado = FALSE 
              AND h.fechafin > NOW()
              AND h.medicoid::text = $1::text
              AND COALESCE(h.especialidadid, m.especialidadid) = $2
        `;
        
        const res = await pool.query(query, params);
        console.log('Number of availability rows found:', res.rows.length);
        
        if (res.rows.length > 0) {
            console.log('Sample row:', res.rows[0]);
        } else {
            console.log('No rows found matching the filters.');
        }

    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

testAvailabilityAPI();
