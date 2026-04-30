const pool = require("./config/db");
const fs = require("fs");
const path = require("path");
async function run() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "db", "fase7_recetas.sql"), "utf8");
    await pool.query(sql);
    console.log("Migration successful");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
