const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

/**
 * Convierte "DD/MM/YYYY" -> "YYYY-MM-DD"
 * Si ya viene YYYY-MM-DD, lo deja igual.
 */
function toSqlDate(fecha) {
  const raw = String(fecha || "").trim();
  if (!raw) return raw;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parts = raw.split("/");
  if (parts.length !== 3) return raw;

  const [dd, mm, yyyy] = parts;
  if (!/^\d+$/.test(dd) || !/^\d+$/.test(mm) || !/^\d+$/.test(yyyy)) return raw;

  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * ===============================
 * POST /api/auth/register
 * Registra PACIENTE + USUARIO
 * ===============================
 */
router.post("/register", async (req, res) => {
  const {
    nombres,
    apellidos,
    fechanacimiento,
    genero,
    cedula,
    telefono,
    email,
    password,
  } = req.body;

  // Log para ver qué llega
  console.log("✅ POST /api/auth/register");
  console.log("📦 BODY:", req.body);

  if (
    !nombres ||
    !apellidos ||
    !fechanacimiento ||
    !genero ||
    !cedula ||
    !telefono ||
    !email ||
    !password
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan campos obligatorios (nombres, apellidos, fechanacimiento, genero, cedula, telefono, email, password).",
    });
  }

  const client = await pool.connect();
  try {
    const normalizedEmail = String(email).toLowerCase().trim();

    // Email único (fuera o dentro de tx da igual, pero aquí lo hacemos dentro)
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT usuarioid FROM usuario WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ese correo ya está registrado.",
      });
    }

    const passwordhash = await bcrypt.hash(String(password), 10);
    const fechaSQL = toSqlDate(fechanacimiento);

    // Insert paciente
    const insertPaciente = await client.query(
      `INSERT INTO paciente (nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING pacienteid`,
      [
        String(nombres).trim(),
        String(apellidos).trim(),
        fechaSQL,
        String(genero).trim(),
        String(cedula).trim(),
        String(telefono).trim(),
      ]
    );

    const pacienteid = insertPaciente.rows[0].pacienteid;

    // Insert usuario
    const rolid = Number(process.env.DEFAULT_ROLID || 1);
    const activo = String(process.env.DEFAULT_ACTIVO || "true") === "true";

    const insertUsuario = await client.query(
      `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo)
       VALUES ($1,$2,$3,NOW(),$4)
       RETURNING usuarioid`,
      [rolid, normalizedEmail, passwordhash, activo]
    );

    await client.query("COMMIT");

    console.log("✅ REGISTRO OK:", {
      pacienteid,
      usuarioid: insertUsuario.rows[0].usuarioid,
    });

    return res.json({
      success: true,
      message: "Paciente registrado correctamente.",
      pacienteid,
      usuarioid: insertUsuario.rows[0].usuarioid,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("❌ Error register paciente:", err);
    return res.status(500).json({
      success: false,
      message: "Error interno registrando paciente.",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/login
 * ===============================
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || "").toLowerCase().trim();

  if (!normalizedEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "Email y password son obligatorios.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT usuarioid, rolid, email, passwordhash, activo
       FROM usuario
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    const user = result.rows[0];

    if (!user.activo) {
      return res.status(403).json({ success: false, message: "Usuario inactivo." });
    }

    const ok = await bcrypt.compare(String(password), user.passwordhash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas." });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ success: false, message: "Falta JWT_SECRET en el .env" });
    }

    const token = jwt.sign(
      { usuarioid: user.usuarioid, rolid: user.rolid, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "Login exitoso.",
      token,
      user: { usuarioid: user.usuarioid, rolid: user.rolid, email: user.email },
    });
  } catch (err) {
    console.error("Error login:", err);
    return res.status(500).json({ success: false, message: "Error interno en login." });
  }
});

module.exports = router;
