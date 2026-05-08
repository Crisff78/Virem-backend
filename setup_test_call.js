const pool = require('./config/db');

async function run() {
  try {
    console.log('--- Configurando Cita de Prueba "AHORA" ---');
    
    // 1. Find a test patient (or create one)
    const pRes = await pool.query("SELECT pacienteid FROM paciente LIMIT 1");
    if (pRes.rows.length === 0) throw new Error('No hay pacientes en la BD');
    const pacienteId = pRes.rows[0].pacienteid;

    // 2. Find a test doctor
    const mRes = await pool.query("SELECT medicoid FROM medico LIMIT 1");
    if (mRes.rows.length === 0) throw new Error('No hay medicos en la BD');
    const medicoId = mRes.rows[0].medicoid;

    console.log(`Paciente ID: ${pacienteId}, Medico ID: ${medicoId}`);

    // 3. Create a appointment starting 2 minutes ago (to be inside the window)
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
        'virtual', 'TEST LIVEKIT NOW', 'pendiente'
      ) RETURNING citaid, fechahorainicio, fechahorafin
    `;
    
    const insRes = await pool.query(insertQ, [pacienteId, medicoId, start.toISOString(), end.toISOString()]);
    
    console.log('CITA DE PRUEBA CREADA CON ÉXITO:');
    console.log('ID:', insRes.rows[0].citaid);
    console.log('Inicio:', insRes.rows[0].fechahorainicio);
    console.log('Fin:', insRes.rows[0].fechahorafin);
    console.log('\n--- INSTRUCCIONES ---');
    console.log('1. Asegúrate de que el backend tenga las credenciales de LiveKit en el .env');
    console.log('2. Inicia sesión como el médico en la laptop.');
    console.log('3. Inicia sesión como el paciente en el móvil.');
    console.log('4. Entra a la sección de Consulta Virtual.');

    process.exit(0);
  } catch (e) {
    console.error('OPERACIÓN FALLIDA');
    console.error(e);
    process.exit(1);
  }
}

run();
