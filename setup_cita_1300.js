const pool = require('./config/db');

async function run() {
  try {
    console.log('--- Configurando Cita 1:00 PM ---');
    
    // 1. Find Maria Castillo (Paciente)
    const pRes = await pool.query("SELECT pacienteid FROM paciente WHERE nombres || ' ' || apellidos ILIKE '%Maria Castillo%' LIMIT 1");
    if (pRes.rows.length === 0) throw new Error('Paciente Maria Castillo not found');
    const pacienteId = pRes.rows[0].pacienteid;

    // 2. Find Esperanza Morales (Medico)
    const mRes = await pool.query("SELECT medicoid FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%' LIMIT 1");
    if (mRes.rows.length === 0) throw new Error('Medico Esperanza Morales not found');
    const medicoId = mRes.rows[0].medicoid;

    console.log(`Paciente ID: ${pacienteId}, Medico ID: ${medicoId}`);

    const start = '2026-05-07 13:00:00-04';
    const end = '2026-05-07 13:30:00-04';

    const insertQ = `
      INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, estadocitaid, zonahorariaid,
        fechahorainicio, fechahorafin, duracionmin, precio, fechacreacion,
        modalidad, motivo_consulta, estado_codigo
      ) VALUES (
        gen_random_uuid(), $1, $2, 
        (SELECT tipoconsultaid FROM tipos_consulta WHERE lower(nombre) LIKE '%video%' LIMIT 1),
        (SELECT estadocitaid FROM estado_cita WHERE lower(codigo) = 'pendiente' LIMIT 1),
        (SELECT zonahorariaid FROM zonas_horarias WHERE lower(nombre) = 'utc' LIMIT 1),
        $3, $4, 30, 1000, NOW(),
        'virtual', 'Consulta Programada 1:00 PM', 'pendiente'
      ) RETURNING citaid, fechahorainicio, fechahorafin
    `;
    
    const insRes = await pool.query(insertQ, [pacienteId, medicoId, start, end]);
    
    console.log('NUEVA CITA INSERTADA CON ÉXITO:');
    console.log(JSON.stringify(insRes.rows[0], null, 2));

    process.exit(0);
  } catch (e) {
    console.error('OPERACIÓN FALLIDA');
    console.error(e);
    process.exit(1);
  }
}

run();
