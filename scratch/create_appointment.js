const { Pool } = require("pg");
const { randomUUID } = require("crypto");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    // 1. Search Doctor
    const medRes = await client.query(
      "SELECT medicoid, nombrecompleto FROM medico WHERE nombrecompleto ILIKE '%Esperanza Morales%' LIMIT 1"
    );
    if (medRes.rows.length === 0) throw new Error("Doctor not found");
    const medico = medRes.rows[0];

    // 2. Search Patient
    const pacRes = await client.query(
      "SELECT pacienteid, nombres, apellidos FROM paciente WHERE nombres ILIKE '%Maria%' AND apellidos ILIKE '%Castillo%' LIMIT 1"
    );
    if (pacRes.rows.length === 0) throw new Error("Patient not found");
    const paciente = pacRes.rows[0];

    // 3. Metadata IDs
    const statusId = 2; // pendiente
    const typeId = 1;   // Videoconsulta
    const tzId = 1;     // America/Santo_Domingo

    // 4. Create Appointment for 8:50 AM
    const citaId = randomUUID();
    const start = new Date("2026-05-08T08:50:00-04:00");
    const end = new Date(start.getTime() + 30 * 60 * 1000); 

    await client.query(
      `INSERT INTO cita (
        citaid, pacienteid, medicoid, tipoconsultaid, estadocitaid, zonahorariaid, 
        fechahorainicio, fechahorafin, duracionmin, precio, fechacreacion, 
        modalidad, estado_codigo, monto_total, monto_plataforma, monto_medico, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13, $14, $15, NOW())`,
      [
        citaId,
        Number(paciente.pacienteid),
        medico.medicoid,
        typeId,
        statusId,
        tzId,
        start.toISOString(),
        end.toISOString(),
        30,
        2000,
        'virtual',
        'pendiente',
        2000,
        400,
        1600
      ]
    );

    console.log("SUCCESS: Appointment created!");
    console.log(`Doctor: ${medico.nombrecompleto} (${medico.medicoid})`);
    console.log(`Patient: ${paciente.nombres} ${paciente.apellidos} (${paciente.pacienteid})`);
    console.log(`Time: 8:50 AM Today`);
    console.log(`Cita ID: ${citaId}`);

  } catch (err) {
    console.error("ERROR:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
