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

function normalizePhone(rawPhone) {
  return String(rawPhone || "").replace(/\D/g, "").slice(0, 15);
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
    const fechaSQL = toSqlDate(fechanacimiento);

    await client.query("BEGIN");

    // ✅ Email único
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

    // ✅ Insert usuario PRIMERO (para evitar problemas de FK raros)
    const rolid = Number(process.env.DEFAULT_ROLID || 1);
    const activo = String(process.env.DEFAULT_ACTIVO || "true") === "true";

    const insertUsuario = await client.query(
      `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo)
       VALUES ($1,$2,$3,NOW(),$4)
       RETURNING usuarioid`,
      [rolid, normalizedEmail, passwordhash, activo]
    );

    const usuarioid = insertUsuario.rows[0].usuarioid;

    // ✅ Insert paciente (con usuarioid si tu BD lo requiere)
    // OJO: si tu tabla paciente NO tiene usuarioid, quita esa parte.
    // Como tu BD tiene fk_usuario: FOREIGN KEY (pacienteid) REFERENCES usuario(usuarioid)
    // eso es raro, pero lo manejamos con 2 inserts:
    //   - Insert usuario => usuarioid
    //   - Insert paciente forzando pacienteid = usuarioid
    const insertPaciente = await client.query(
      `INSERT INTO paciente (pacienteid, nombres, apellidos, fechanacimiento, genero, cedula, telefono, fecharegistro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       RETURNING pacienteid`,
      [
        usuarioid,
        String(nombres).trim(),
        String(apellidos).trim(),
        fechaSQL,
        String(genero).trim(),
        String(cedula).replace(/\D/g, "").slice(0, 11),
        String(telefono).replace(/\D/g, "").slice(0, 11),
      ]
    );

    await client.query("COMMIT");

    console.log("✅ REGISTRO OK:", {
      pacienteid: insertPaciente.rows[0].pacienteid,
      usuarioid,
    });

    return res.json({
      success: true,
      message: "Paciente registrado correctamente.",
      pacienteid: insertPaciente.rows[0].pacienteid,
      usuarioid,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("❌ Error register paciente:", err);

    return res.status(500).json({
      success: false,
      message: "Error interno registrando paciente.",
      error: err?.message || String(err),
    });
  } finally {
    client.release();
  }
});

/**
 * ===============================
 * POST /api/auth/register-medico
 * Registra MEDICO + USUARIO
 * ===============================
 */
router.post("/register-medico", async (req, res) => {
  const {
    nombreCompleto,
    fechanacimiento,
    genero,
    especialidad,
    cedula,
    telefono,
    email,
    password,
  } = req.body;

  if (
    !nombreCompleto ||
    !fechanacimiento ||
    !genero ||
    !especialidad ||
    !cedula ||
    !telefono ||
    !email ||
    !password
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan campos obligatorios (nombreCompleto, fechanacimiento, genero, especialidad, cedula, telefono, email, password).",
    });
  }

  const client = await pool.connect();

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const fechaSQL = toSqlDate(fechanacimiento);
    const nombreCompletoTrim = String(nombreCompleto).replace(/\s+/g, " ").trim();
    const cedulaClean = String(cedula).replace(/\D/g, "").slice(0, 11);
    const telefonoClean = normalizePhone(telefono);
    const especialidadTrim = String(especialidad).trim();

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
    const rolid = Number(process.env.DEFAULT_MEDICO_ROLID || process.env.DEFAULT_ROLID || 2);
    const activo = String(process.env.DEFAULT_ACTIVO || "true") === "true";

    const insertUsuario = await client.query(
      `INSERT INTO usuario (rolid, email, passwordhash, fechacreacion, activo)
       VALUES ($1,$2,$3,NOW(),$4)
       RETURNING usuarioid`,
      [rolid, normalizedEmail, passwordhash, activo]
    );

    const usuarioid = insertUsuario.rows[0].usuarioid;

    let medicoRow;
    try {
      const withId = await client.query(
        `INSERT INTO medico (medicoid, nombrecompleto, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         RETURNING medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
        [
          usuarioid,
          nombreCompletoTrim,
          fechaSQL,
          String(genero).trim(),
          cedulaClean,
          telefonoClean,
          especialidadTrim,
        ]
      );
      medicoRow = withId.rows[0];
    } catch (e) {
      const withoutId = await client.query(
        `INSERT INTO medico (nombrecompleto, fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         RETURNING medicoid, nombrecompleto AS "nombreCompleto", fechanacimiento, genero, cedula, telefono, especialidad, fecharegistro`,
        [
          nombreCompletoTrim,
          fechaSQL,
          String(genero).trim(),
          cedulaClean,
          telefonoClean,
          especialidadTrim,
        ]
      );
      medicoRow = withoutId.rows[0];
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Médico registrado correctamente.",
      medico: medicoRow,
      usuarioid,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    return res.status(500).json({
      success: false,
      message: "Error interno registrando médico.",
      error: err?.message || String(err),
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
