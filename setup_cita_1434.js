/**
 * Setup script to create a real appointment for Maria Castillo and Esperanza Morales.
 * Scheduled for Today at 14:34 (2:34 PM) until 15:04 (3:04 PM).
 */
const pool = require('./config/db');

async function setup() {
  try {
    const pRes = await pool.query("SELECT pacienteid FROM paciente WHERE nombres || ' ' || apellidos ILIKE '%Maria Castillo%' LIMIT 1");
    const mRes = await pool.query("SELECT medicoid FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%' LIMIT 1");

    if (pRes.rows.length === 0 || mRes.rows.length === 0) {
       console.error('No se encontro paciente o medico');
       process.exit(1);
    }

    const pacienteId = pRes.rows[0].pacienteid;
    const medicoId = mRes.rows[0].medicoid;

    // FECHA: Hoy a las 14:34
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const startsAt = `${dateStr} 14:34:00-04`;
    const endsAt = `${dateStr} 15:04:00-04`;

    console.log(`Creando cita para las 14:34 (2:34 PM)...`);

    const insertQ = `
      INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, estadocitaid, zonahorariaid,
        fechahorainicio, fechahorafin, duracionmin, precio, fechacreacion,
        modalidad, motivo_consulta, estado_codigo
      ) VALUES (
        gen_random_uuid(), $1, $2, 
        (SELECT tipoconsultaid FROM tipos_consulta WHERE lower(nombre) LIKE '%video%' LIMIT 1),
        (SELECT estadocitaid FROM estado_cita WHERE lower(codigo) = 'confirmada' LIMIT 1),
        (SELECT zonahorariaid FROM zonas_horarias WHERE lower(nombre) = 'utc' LIMIT 1),
        $3, $4, 30, 1500, NOW(),
        'virtual', 'Consulta Programada 2:34 PM (Zego Web Test 2)', 'confirmada'
      ) RETURNING citaid
    `;

    const res = await pool.query(insertQ, [pacienteId, medicoId, startsAt, endsAt]);

    console.log('Cita creada con ID:', res.rows[0].citaid);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

setup();
