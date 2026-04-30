const pool = require('./config/db');

pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('usuario_perfil', 'medico', 'paciente')")
  .then(res => console.log(res.rows.map(r => r.column_name).join(', ')))
  .catch(err => console.error(err.message))
  .finally(() => pool.end());
