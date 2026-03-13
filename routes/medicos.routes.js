const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");

const router = express.Router();

function normalizeDate(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (isoPrefix?.[1]) return isoPrefix[1];

  const parts = raw.split("/");
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts;
    if (/^\d+$/.test(dd) && /^\d+$/.test(mm) && /^\d+$/.test(yyyy)) {
      return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }
  }
  return raw;
}

async function resolveEspecialidadId(client, especialidadValue) {
  const raw = String(especialidadValue || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await client.query(
      `SELECT especialidadid
       FROM especialidad
       WHERE especialidadid = $1
       LIMIT 1`,
      [Number(raw)]
    );
    if (byId.rows.length) return Number(byId.rows[0].especialidadid);
  }

  const byName = await client.query(
    `SELECT especialidadid
     FROM especialidad
     WHERE lower(nombre) = lower($1)
     LIMIT 1`,
    [raw]
  );
  if (byName.rows.length) return Number(byName.rows[0].especialidadid);

  return null;
}

// ===============================
// API: Listar medicos
// Endpoint: GET /api/medicos
// ===============================
router.get("/", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         m.medicoid::text AS "medicoid",
         m.nombrecompleto AS "nombreCompleto",
         m.fechanacimiento,
         m.genero,
         m.cedula,
         m.telefono,
         m.consultorio,
         m.especialidadid,
         COALESCE(e.nombre, '') AS "especialidad",
         m.fecharegistro
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       ORDER BY m.fecharegistro DESC, m.medicoid DESC`
    );
    return res.json({ success: true, medicos: result.rows });
  } catch (err) {
    console.error("Error GET /medicos:", err);
    return res.status(500).json({ success: false, message: "Error interno listando medicos." });
  }
});

// ===============================
// API: Obtener medico por ID
// Endpoint: GET /api/medicos/:id
// ===============================
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         m.medicoid::text AS "medicoid",
         m.nombrecompleto AS "nombreCompleto",
         m.fechanacimiento,
         m.genero,
         m.cedula,
         m.telefono,
         m.consultorio,
         m.especialidadid,
         COALESCE(e.nombre, '') AS "especialidad",
         m.fecharegistro
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [String(req.params.id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Medico no encontrado." });
    }

    return res.json({ success: true, medico: result.rows[0] });
  } catch (err) {
    console.error("Error GET /medicos/:id:", err);
    return res.status(500).json({ success: false, message: "Error interno obteniendo medico." });
  }
});

// ===============================
// API: Crear medico
// Endpoint: POST /api/medicos
// ===============================
router.post("/", requireAuth, async (req, res) => {
  const {
    nombreCompleto,
    fechanacimiento,
    genero,
    cedula,
    telefono,
    especialidad,
    consultorio,
  } = req.body;

  const nombreCompletoTrim = String(nombreCompleto || "").replace(/\s+/g, " ").trim();
  const fechaSQL = normalizeDate(fechanacimiento);
  const generoTrim = String(genero || "").replace(/\s+/g, " ").trim();
  const cedulaClean = String(cedula || "").replace(/\D/g, "").slice(0, 11);
  const telefonoClean = String(telefono || "").replace(/\D/g, "").slice(0, 15);
  const consultorioTrim = String(consultorio || "").replace(/\s+/g, " ").trim() || null;

  if (!nombreCompletoTrim || !fechaSQL || !generoTrim || !cedulaClean || !telefonoClean) {
    return res.status(400).json({ success: false, message: "Faltan campos obligatorios." });
  }

  let client;
  try {
    client = await pool.connect();
    const especialidadid = await resolveEspecialidadId(client, especialidad);
    const medicoid = randomUUID();

    const result = await client.query(
      `INSERT INTO medico (
         medicoid, especialidadid, cedula, telefono, consultorio,
         fecharegistro, fechanacimiento, genero, nombrecompleto
       )
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8)
       RETURNING
         medicoid::text AS "medicoid",
         nombrecompleto AS "nombreCompleto",
         fechanacimiento,
         genero,
         cedula,
         telefono,
         consultorio,
         especialidadid,
         fecharegistro`,
      [
        medicoid,
        especialidadid,
        cedulaClean,
        telefonoClean,
        consultorioTrim,
        fechaSQL,
        generoTrim,
        nombreCompletoTrim,
      ]
    );

    const medico = result.rows[0];
    return res.status(201).json({
      success: true,
      medico: {
        ...medico,
        especialidad: String(especialidad || "").trim(),
      },
    });
  } catch (err) {
    console.error("Error POST /medicos:", err);
    return res.status(500).json({ success: false, message: "Error interno creando medico." });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Actualizar medico
// Endpoint: PUT /api/medicos/:id
// ===============================
router.put("/:id", requireAuth, async (req, res) => {
  const {
    nombreCompleto,
    fechanacimiento,
    genero,
    cedula,
    telefono,
    especialidad,
    consultorio,
  } = req.body;

  const nombreCompletoTrim = String(nombreCompleto || "").replace(/\s+/g, " ").trim();
  const fechaSQL = normalizeDate(fechanacimiento);
  const generoTrim = String(genero || "").replace(/\s+/g, " ").trim();
  const cedulaClean = String(cedula || "").replace(/\D/g, "").slice(0, 11);
  const telefonoClean = String(telefono || "").replace(/\D/g, "").slice(0, 15);
  const consultorioTrim = String(consultorio || "").replace(/\s+/g, " ").trim() || null;

  if (!nombreCompletoTrim || !fechaSQL || !generoTrim || !cedulaClean || !telefonoClean) {
    return res.status(400).json({ success: false, message: "Faltan campos obligatorios." });
  }

  let client;
  try {
    client = await pool.connect();
    const especialidadid = await resolveEspecialidadId(client, especialidad);

    const result = await client.query(
      `UPDATE medico
       SET nombrecompleto = $1,
           fechanacimiento = $2,
           genero = $3,
           cedula = $4,
           telefono = $5,
           especialidadid = $6,
           consultorio = $7
       WHERE medicoid::text = $8::text
       RETURNING
         medicoid::text AS "medicoid",
         nombrecompleto AS "nombreCompleto",
         fechanacimiento,
         genero,
         cedula,
         telefono,
         consultorio,
         especialidadid,
         fecharegistro`,
      [
        nombreCompletoTrim,
        fechaSQL,
        generoTrim,
        cedulaClean,
        telefonoClean,
        especialidadid,
        consultorioTrim,
        String(req.params.id),
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Medico no encontrado." });
    }

    const medico = result.rows[0];
    return res.json({
      success: true,
      medico: {
        ...medico,
        especialidad: String(especialidad || "").trim(),
      },
    });
  } catch (err) {
    console.error("Error PUT /medicos/:id:", err);
    return res.status(500).json({ success: false, message: "Error interno actualizando medico." });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// API: Eliminar medico
// Endpoint: DELETE /api/medicos/:id
// ===============================
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM medico
       WHERE medicoid::text = $1::text
       RETURNING medicoid::text AS "medicoid"`,
      [String(req.params.id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Medico no encontrado." });
    }

    return res.json({ success: true, message: "Medico eliminado." });
  } catch (err) {
    console.error("Error DELETE /medicos/:id:", err);
    return res.status(500).json({ success: false, message: "Error interno eliminando medico." });
  }
});

module.exports = router;
