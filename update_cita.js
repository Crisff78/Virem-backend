const pool = require('./config/db');
async function run() {
  try {
    // Specifically target the 12:15 PM appointment to extend it to 1:00 PM
    const q = `
      UPDATE cita 
      SET fechahorafin = '2026-05-07 13:00:00-04', 
          estado_codigo = 'pendiente' 
      WHERE fechahorainicio = '2026-05-07 12:15:00-04'
        AND estado_codigo NOT IN ('completada', 'cancelada')
      RETURNING citaid, fechahorainicio, fechahorafin
    `;
    const res = await pool.query(q);
    if (res.rows.length === 0) {
      console.log('NO MATCHING APPOINTMENT FOUND FOR 12:15 PM');
    } else {
      console.log('UPDATE SUCCESSFUL - 12:15 PM EXTENDED TO 1:00 PM');
      console.log(JSON.stringify(res.rows[0]));
    }
    process.exit(0);
  } catch (e) {
    console.error('UPDATE FAILED');
    console.error(e);
    process.exit(1);
  }
}
run();
