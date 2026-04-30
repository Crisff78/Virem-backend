const pool = require('../config/db');

async function checkAndris() {
  const email = 'andristoribio1@gmail.com';
  try {
    console.log(`Checking user and patient profile for ${email}...`);
    const userResult = await pool.query("SELECT * FROM usuario WHERE email = $1", [email]);
    
    if (userResult.rows.length === 0) {
      console.log("User not found.");
      process.exit(0);
    }
    
    const user = userResult.rows[0];
    console.log("User found:", JSON.stringify(user, null, 2));
    
    const pacienteResult = await pool.query("SELECT * FROM paciente WHERE usuarioid = $1", [user.usuarioid]);
    if (pacienteResult.rows.length === 0) {
      console.log("No patient profile linked. Searching orphans...");
      const orphan = await pool.query("SELECT * FROM paciente WHERE nombres ILIKE '%Andris%' OR apellidos ILIKE '%Toribio%'");
      console.log("Possible orphans:", JSON.stringify(orphan.rows, null, 2));
    } else {
      console.log("Patient profile linked:", JSON.stringify(pacienteResult.rows[0], null, 2));
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

checkAndris();
