const pool = require("./config/db");

async function setup() {
  const client = await pool.connect();
  try {
    console.log("Conectando a la base de datos...");
    await client.query("BEGIN");

    // 1. Buscar a Esperanza
    const medicoRes = await client.query(`
      SELECT medicoid, especialidadid 
      FROM medico 
      WHERE nombrecompleto ILIKE '%Esperanza%' 
         OR nombrecompleto ILIKE '%Morales%' 
      LIMIT 1
    `);

    if (medicoRes.rows.length === 0) {
      console.log("No se encontró a la doctora Esperanza.");
      return;
    }

    const medico = medicoRes.rows[0];
    console.log(`Médico encontrado: ${medico.medicoid}, Especialidad: ${medico.especialidadid}`);

    // 2. Insertar un horario para hoy a las 12:00 PM (hora de RD o UTC-4)
    // Para simplificar, vamos a calcular la hora en UTC (12:00 PM AST = 16:00 UTC)
    // O mejor, tomamos "hoy" a las 12:00 en la zona horaria del servidor
    const date = new Date();
    
    // Si ya pasó mediodía, lo creamos para mañana. Si no, para hoy.
    // Aunque el usuario pide a las 12:00. Vamos a crearlo explícitamente para mañana a las 12:00, o hoy si es posible.
    // Vamos a insertar varios para los próximos 3 días a las 12:00 para asegurar que siempre haya.
    
    for (let i = 0; i < 3; i++) {
        const slotDate = new Date();
        slotDate.setDate(slotDate.getDate() + i);
        
        const yyyy = slotDate.getFullYear();
        const mm = String(slotDate.getMonth() + 1).padStart(2, '0');
        const dd = String(slotDate.getDate()).padStart(2, '0');

        // Formato UTC aproximado (depende de la timezone de la BD, pero TIMESTAMP WITH TIME ZONE lo maneja)
        // 12:00 PM AST = 16:00:00Z
        const fechaInicio = `${yyyy}-${mm}-${dd}T16:00:00.000Z`;
        const fechaFin = `${yyyy}-${mm}-${dd}T16:30:00.000Z`;

        await client.query(`
          INSERT INTO horario_disponible (medicoid, fechainicio, fechafin, activo, bloqueado, especialidadid, modalidad, zonahorariaid, nota, slot_minutos)
          VALUES ($1, $2, $3, true, false, $4, 'ambas', 2, 'AUTO_GENERADO_1200', 30)
        `, [medico.medicoid, fechaInicio, fechaFin, medico.especialidadid]);
        
        console.log(`Horario insertado para ${yyyy}-${mm}-${dd} 12:00 PM - 12:30 PM (AST)`);
    }

    await client.query("COMMIT");
    console.log("¡Horarios insertados exitosamente!");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error:", error);
  } finally {
    client.release();
    process.exit(0);
  }
}

setup();
