const pool = require('./config/db');
async function run() {
  try {
    const q = `
      UPDATE cita 
      SET fechahorainicio = '2026-05-07 12:15:00-04', 
          fechahorafin = '2026-05-07 12:45:00-04', 
          estado_codigo = 'pendiente' 
      WHERE citaid IN (
        SELECT citaid 
        FROM cita 
        WHERE estado_codigo NOT IN ('completada', 'cancelada') 
        ORDER BY fechahorainicio DESC 
        LIMIT 1
      ) 
      RETURNING citaid, fechahorainicio
    `;
    const res = await pool.query(q);
    console.log('UPDATE SUCCESSFUL');
    console.log(JSON.stringify(res.rows[0]));
    process.exit(0);
  } catch (e) {
    console.error('UPDATE FAILED');
    console.error(e);
    process.exit(1);
  }
}
run();
