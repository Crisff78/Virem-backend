const pool = require('./config/db');
async function run() {
  try {
    // 1. Find Maria Castillo (Paciente)
    const pRes = await pool.query("SELECT pacienteid FROM paciente WHERE nombres || ' ' || apellidos ILIKE '%Maria Castillo%' LIMIT 1");
    if (pRes.rows.length === 0) throw new Error('Paciente Maria Castillo not found');
    const pacienteId = pRes.rows[0].pacienteid;

    // 2. Find Esperanza Morales (Medico)
    const mRes = await pool.query("SELECT medicoid FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%' LIMIT 1");
    if (mRes.rows.length === 0) throw new Error('Medico Esperanza Morales not found');
    const medicoId = mRes.rows[0].medicoid;

    // 3. Delete existing conflicting appointments for this doctor at this time to avoid constraint issues
    await pool.query("UPDATE cita SET estado_codigo = 'cancelada' WHERE medicoid = $1 AND fechahorainicio = '2026-05-07 12:30:00-04' AND estado_codigo NOT IN ('completada', 'cancelada')", [medicoId]);

    // 4. Update THE appointment (simplified query)
    const q = `
      UPDATE cita 
      SET fechahorainicio = '2026-05-07 12:30:00-04', 
          fechahorafin = '2026-05-07 13:00:00-04', 
          estado_codigo = 'pendiente' 
      WHERE citaid IN (
        SELECT citaid 
        FROM cita 
        WHERE pacienteid = $1 AND medicoid = $2
          AND estado_codigo NOT IN ('completada', 'cancelada')
        ORDER BY fechahorainicio DESC
        LIMIT 1
      )
      RETURNING citaid, fechahorainicio, fechahorafin
    `;
    const res = await pool.query(q, [pacienteId, medicoId]);
    
    if (res.rows.length === 0) {
      console.log('NO ACTIVE APPOINTMENT FOUND TO UPDATE. INSERTING NEW ONE...');
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
          '2026-05-07 12:30:00-04', '2026-05-07 13:00:00-04', 30, 1000, NOW(),
          'virtual', 'Prueba de videollamada', 'pendiente'
        ) RETURNING citaid, fechahorainicio
      `;
      const insRes = await pool.query(insertQ, [pacienteId, medicoId]);
      console.log('INSERT SUCCESSFUL');
      console.log(JSON.stringify(insRes.rows[0]));
    } else {
      console.log('UPDATE SUCCESSFUL');
      console.log(JSON.stringify(res.rows[0]));
    }
    process.exit(0);
  } catch (e) {
    console.error('OPERATION FAILED');
    console.error(e);
    process.exit(1);
  }
}
run();
