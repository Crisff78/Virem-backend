const pool = require('./config/db');

async function run() {
  try {
    console.log('--- Configurando Cita de Prueba: Esperanza vs Andris ---');
    
    // 1. Find Andris Toribio (Paciente)
    const pRes = await pool.query("SELECT pacienteid FROM paciente WHERE nombres || ' ' || apellidos ILIKE '%Andris Toribio%' LIMIT 1");
    if (pRes.rows.length === 0) throw new Error('Paciente Andris Toribio not found');
    const pacienteId = pRes.rows[0].pacienteid;

    // 2. Find Esperanza Morales (Medico)
    const mRes = await pool.query("SELECT medicoid FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%' LIMIT 1");
    if (mRes.rows.length === 0) throw new Error('Medico Esperanza Morales not found');
    const medicoId = mRes.rows[0].medicoid;

    console.log(`Paciente ID: ${pacienteId}, Medico ID: ${medicoId}`);

    // 3. Create a appointment starting now
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 1000);
    const end = new Date(now.getTime() + 28 * 60 * 1000);

    const insertQ = `
      INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, estadocitaid, zonahorariaid,
        fechahorainicio, fechahorafin, duracionmin, precio, fechacreacion,
        modalidad, motivo_consulta, estado_codigo
      ) VALUES (
        gen_random_uuid(), $1, $2, 
        (SELECT tipoconsultaid FROM tipos_consulta WHERE lower(nombre) LIKE '%video%' OR lower(nombre) LIKE '%virtual%' LIMIT 1),
        (SELECT estadocitaid FROM estado_cita WHERE lower(codigo) = 'pendiente' LIMIT 1),
        (SELECT zonahorariaid FROM zonas_horarias WHERE lower(nombre) = 'utc' LIMIT 1),
        $3, $4, 30, 0, NOW(),
        'virtual', 'PRUEBA LIVEKIT: ESPERANZA Y ANDRIS', 'pendiente'
      ) RETURNING citaid, fechahorainicio, fechahorafin
    `;
    
    const insRes = await pool.query(insertQ, [pacienteId, medicoId, start.toISOString(), end.toISOString()]);
    
    console.log('CITA DE PRUEBA CREADA CON ÉXITO:');
    console.log('ID:', insRes.rows[0].citaid);
    console.log('Médico:', 'Esperanza Morales');
    console.log('Paciente:', 'Andris Toribio');

    process.exit(0);
  } catch (e) {
    console.error('OPERACIÓN FALLIDA');
    console.error(e);
    process.exit(1);
  }
}

run();
