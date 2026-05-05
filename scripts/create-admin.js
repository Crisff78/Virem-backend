const bcrypt = require("bcrypt");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const pool = require("../config/db");

async function createAdmin() {
  const username = "Admin";
  const email = "admin@virem.local"; // Internal email for DB consistency
  const password = "AdminPassword123!"; // User should change this
  const roleId = 3; // ADMIN_ROLE_ID

  const client = await pool.connect();
  try {
    console.log(`Checking if admin user exists...`);
    const existing = await client.query("SELECT usuarioid FROM usuario WHERE email = $1 OR email = $2", [email, username.toLowerCase()]);
    
    if (existing.rows.length > 0) {
      console.log("Admin user already exists. Updating password...");
      const passwordhash = await bcrypt.hash(password, 10);
      await client.query("UPDATE usuario SET passwordhash = $1 WHERE usuarioid = $2", [passwordhash, existing.rows[0].usuarioid]);
      console.log("Admin password updated successfully.");
    } else {
      console.log("Creating new admin user...");
      const passwordhash = await bcrypt.hash(password, 10);
      const result = await client.query(
        `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo, account_status, email_verificado, aprobado_por_admin)
         VALUES ($1, $2, $3, NOW(), TRUE, 'activa', TRUE, TRUE)
         RETURNING usuarioid`,
        [roleId, email, passwordhash]
      );
      console.log(`Admin user created with ID: ${result.rows[0].usuarioid}`);
    }
  } catch (err) {
    console.error("Error creating admin:", err);
  } finally {
    client.release();
    process.exit();
  }
}

createAdmin();
