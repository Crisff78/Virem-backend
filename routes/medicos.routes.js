const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  ADMIN_ROLE_ID,
  requireRole,
  requireOwnership,
} = require("./middleware/access-control");
const {
  ensureUserProfileTable,
  isSupportedImageUri,
} = require("../services/user-profile.store");
const { ensurePlatformSchema } = require("../services/platform-core");
const { ensureRfCoreSchema } = require("../services/rf-core");

const router = express.Router();
const MEDICO_ROLE_ID = 2;

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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

  const all = await client.query(
    `SELECT especialidadid, nombre
     FROM especialidad
     ORDER BY especialidadid ASC`
  );
  const normalizedTarget = normalizeComparableText(raw);

  const exact = all.rows.find(
    (row) => normalizeComparableText(row.nombre) === normalizedTarget
  );
  if (exact) return Number(exact.especialidadid);

  const fuzzy = all.rows.find((row) => {
    const normalizedName = normalizeComparableText(row.nombre);
    return (
      normalizedName.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedName)
    );
  });
  if (fuzzy) return Number(fuzzy.especialidadid);

  try {
    const inserted = await client.query(
      `INSERT INTO especialidad (nombre)
       VALUES ($1)
       RETURNING especialidadid`,
      [raw]
    );
    return Number(inserted.rows[0]?.especialidadid || 0) || null;
  } catch (_) {
    const retry = await client.query(
      `SELECT especialidadid
       FROM especialidad
       WHERE lower(nombre) = lower($1)
       LIMIT 1`,
      [raw]
    );
    return retry.rows.length ? Number(retry.rows[0].especialidadid) : null;
  }
}

async function resolveMedicoOwner(req) {
  const result = await pool.query(
    `SELECT usuarioid
     FROM medico
     WHERE medicoid::text = $1::text
     LIMIT 1`,
    [String(req.params.id || "")]
  );

  if (!result.rows.length) {
    return {
      exists: false,
      notFoundMessage: "Medico no encontrado.",
    };
  }

  return {
    exists: true,
    ownerUserIds: [result.rows[0].usuarioid],
    notFoundMessage: "Medico no encontrado.",
    forbiddenMessage: "No puedes modificar el perfil de otro medico.",
  };
}

function getActorFromRequest(req) {
  if (req.accessControl?.actor) {
    return req.accessControl.actor;
  }

  return {
    usuarioid: Number.parseInt(String(req.user?.usuarioid || ""), 10) || 0,
    roleId: Number.parseInt(String(req.user?.rolid || ""), 10) || 0,
  };
}

function sanitizeMedicoForAudience(row, actor, options = {}) {
  const rowOwnerUserId = Number.parseInt(String(row?.usuarioid || ""), 10);
  const isOwner =
    actor && Number.isFinite(rowOwnerUserId) && rowOwnerUserId > 0
      ? Number(actor.usuarioid) === rowOwnerUserId
      : false;
  const isAdmin = Number(actor?.roleId || 0) === ADMIN_ROLE_ID;
  const exposeSensitive = isOwner || isAdmin;

  return {
    medicoid: String(row?.medicoid || "").trim(),
    nombreCompleto: String(row?.nombreCompleto || "").trim(),
    fechanacimiento: exposeSensitive ? row?.fechanacimiento || null : null,
    genero: exposeSensitive ? String(row?.genero || "").trim() || null : null,
    cedula: exposeSensitive ? String(row?.cedula || "").trim() || null : null,
    telefono: exposeSensitive ? String(row?.telefono || "").trim() || null : null,
    consultorio: String(row?.consultorio || "").trim() || null,
    especialidadid: row?.especialidadid ? Number(row.especialidadid) : null,
    especialidad: String(row?.especialidad || "").trim() || "Medicina General",
    permitePresencial: Boolean(row?.permitePresencial),
    permiteVirtual: Boolean(row?.permiteVirtual),
    ratingPromedio: Number(row?.ratingPromedio || 0),
    totalValoraciones: Number(row?.totalValoraciones || 0),
    proximoHorarioDisponible: row?.proximoHorarioDisponible || null,
    fotoUrl: isSupportedImageUri(row?.fotoUrl || null)
      ? String(row?.fotoUrl || "").trim() || null
      : null,
    fecharegistro: row?.fecharegistro || null,
  };
}

// ===============================
// API: Listar medicos
// Endpoint: GET /api/medicos
// ===============================
router.get("/", requireAuth, async (req, res) => {
  const especialidadQuery = String(req.query?.especialidad || "").trim();
  const ubicacionQuery = String(req.query?.ubicacion || "").trim();
  const modalidadQuery = normalizeComparableText(req.query?.modalidad || "");
  const minRatingRaw = Number(req.query?.minRating);
  const minRating = Number.isFinite(minRatingRaw) ? Number(minRatingRaw) : null;
  const onlyAvailable = ["1", "true", "si", "yes"].includes(
    String(req.query?.disponible || "").toLowerCase().trim()
  );

  try {
    await ensureUserProfileTable();
    await ensurePlatformSchema();
    await ensureRfCoreSchema();
    const actor = getActorFromRequest(req);

    const filters = [];
    const params = [];

    if (especialidadQuery) {
      params.push(especialidadQuery, `%${especialidadQuery}%`);
      filters.push(
        `(lower(COALESCE(e.nombre, '')) = lower($${params.length - 1}) OR lower(COALESCE(e.nombre, '')) LIKE lower($${params.length}))`
      );
    }
    if (ubicacionQuery) {
      params.push(`%${ubicacionQuery}%`);
      filters.push(`lower(COALESCE(m.consultorio, '')) LIKE lower($${params.length})`);
    }
    if (modalidadQuery === "presencial") {
      filters.push(`COALESCE(e.permite_presencial, TRUE) = TRUE`);
    }
    if (modalidadQuery === "virtual") {
      filters.push(`COALESCE(e.permite_virtual, TRUE) = TRUE`);
    }
    if (Number.isFinite(minRating) && minRating !== null) {
      params.push(minRating);
      filters.push(`COALESCE(rv.rating_promedio, 0) >= $${params.length}`);
    }
    if (onlyAvailable) {
      filters.push(`ns.proximo_horario IS NOT NULL`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await pool.query(
      `WITH rating AS (
         SELECT
           v.medicoid_text,
           ROUND(AVG(v.puntaje)::numeric, 2) AS rating_promedio,
           COUNT(*)::int AS total_valoraciones
         FROM valoracion v
         WHERE lower(COALESCE(v.estado_moderacion, 'pendiente')) = 'aprobada'
         GROUP BY v.medicoid_text
       ),
       next_slot AS (
         SELECT
           h.medicoid::text AS medicoid_text,
           MIN(h.fechainicio) AS proximo_horario
         FROM horario_disponible h
         WHERE h.activo = TRUE
           AND h.bloqueado = FALSE
           AND h.fechafin > NOW()
         GROUP BY h.medicoid::text
       )
       SELECT DISTINCT ON (COALESCE(NULLIF(m.cedula,''), m.medicoid::text))
         m.medicoid::text AS "medicoid",
         m.nombrecompleto AS "nombreCompleto",
         m.usuarioid,
         m.fechanacimiento,
         m.genero,
         m.cedula,
         m.telefono,
         m.consultorio,
         m.especialidadid,
         COALESCE(e.nombre, 'Medicina General') AS "especialidad",
         COALESCE(e.permite_presencial, TRUE) AS "permitePresencial",
         COALESCE(e.permite_virtual, TRUE) AS "permiteVirtual",
         COALESCE(rv.rating_promedio, 0) AS "ratingPromedio",
         COALESCE(rv.total_valoraciones, 0) AS "totalValoraciones",
         ns.proximo_horario AS "proximoHorarioDisponible",
         COALESCE(mp.foto_url) AS "fotoUrl",
         m.fecharegistro
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       LEFT JOIN rating rv ON rv.medicoid_text = m.medicoid::text
       LEFT JOIN next_slot ns ON ns.medicoid_text = m.medicoid::text
        LEFT JOIN LATERAL (
          SELECT up.foto_url
          FROM usuario_perfil up
          WHERE up.usuarioid::text = m.usuarioid::text
            AND up.foto_url IS NOT NULL
            AND up.foto_url <> ''
          ORDER BY up.updated_at DESC
          LIMIT 1
        ) mp ON TRUE
       ${whereClause}
       ORDER BY COALESCE(NULLIF(m.cedula,''), m.medicoid::text), m.fecharegistro DESC, m.medicoid DESC`
      ,
      params
    );
    const medicos = result.rows.map((row) =>
      sanitizeMedicoForAudience(row, actor, { directoryView: true })
    );
    return res.json({ success: true, medicos });
  } catch (err) {
    console.error("Error GET /medicos:", err);
    return res.status(500).json({ success: false, message: "Error interno listando medicos." });
  }
});

// ===============================
// API: Listar especialidades
// Endpoint: GET /api/medicos/especialidades
// ===============================
router.get("/especialidades", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.especialidadid,
         e.nombre,
         e.permite_presencial,
         e.permite_virtual,
         COUNT(m.medicoid) FILTER (WHERE m.medicoid IS NOT NULL)::int AS total_medicos
       FROM especialidad e
       LEFT JOIN medico m ON m.especialidadid = e.especialidadid
       GROUP BY e.especialidadid, e.nombre, e.permite_presencial, e.permite_virtual
       ORDER BY lower(e.nombre) ASC`
    );
    return res.json({
      success: true,
      especialidades: result.rows.map((row) => ({
        especialidadid: Number(row.especialidadid),
        nombre: String(row.nombre || "").trim(),
        permitePresencial: Boolean(row.permite_presencial),
        permiteVirtual: Boolean(row.permite_virtual),
        totalMedicos: Number(row.total_medicos || 0),
      })),
    });
  } catch (err) {
    console.error("Error GET /medicos/especialidades:", err);
    return res
      .status(500)
      .json({ success: false, message: "Error interno listando especialidades." });
  }
});

// ===============================
// API: Obtener medico por ID
// Endpoint: GET /api/medicos/:id
// ===============================
router.get("/:id", requireAuth, async (req, res) => {
  try {
    await ensureUserProfileTable();
    await ensurePlatformSchema();
    await ensureRfCoreSchema();
    const actor = getActorFromRequest(req);

    const result = await pool.query(
      `WITH rating AS (
         SELECT
           v.medicoid_text,
           ROUND(AVG(v.puntaje)::numeric, 2) AS rating_promedio,
           COUNT(*)::int AS total_valoraciones
         FROM valoracion v
         WHERE lower(COALESCE(v.estado_moderacion, 'pendiente')) = 'aprobada'
         GROUP BY v.medicoid_text
       ),
       next_slot AS (
         SELECT
           h.medicoid::text AS medicoid_text,
           MIN(h.fechainicio) AS proximo_horario
         FROM horario_disponible h
         WHERE h.activo = TRUE
           AND h.bloqueado = FALSE
           AND h.fechafin > NOW()
         GROUP BY h.medicoid::text
       )
       SELECT
         m.medicoid::text AS "medicoid",
         m.nombrecompleto AS "nombreCompleto",
         m.usuarioid,
         m.fechanacimiento,
         m.genero,
         m.cedula,
         m.telefono,
         m.consultorio,
         m.especialidadid,
         COALESCE(e.nombre, 'Medicina General') AS "especialidad",
         COALESCE(e.permite_presencial, TRUE) AS "permitePresencial",
         COALESCE(e.permite_virtual, TRUE) AS "permiteVirtual",
         COALESCE(rv.rating_promedio, 0) AS "ratingPromedio",
         COALESCE(rv.total_valoraciones, 0) AS "totalValoraciones",
         ns.proximo_horario AS "proximoHorarioDisponible",
         mp.foto_url AS "fotoUrl",
         m.fecharegistro
       FROM medico m
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       LEFT JOIN rating rv ON rv.medicoid_text = m.medicoid::text
       LEFT JOIN next_slot ns ON ns.medicoid_text = m.medicoid::text
        LEFT JOIN LATERAL (
          SELECT up.foto_url
          FROM usuario_perfil up
          WHERE up.usuarioid::text = m.usuarioid::text
            AND up.foto_url IS NOT NULL
            AND up.foto_url <> ''
          ORDER BY up.updated_at DESC
          LIMIT 1
        ) mp ON TRUE
       WHERE m.medicoid::text = $1::text
       LIMIT 1`,
      [String(req.params.id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Medico no encontrado." });
    }

    const medico = sanitizeMedicoForAudience(result.rows[0], actor, {
      directoryView: false,
    });

    return res.json({ success: true, medico });
  } catch (err) {
    console.error("Error GET /medicos/:id:", err);
    return res.status(500).json({ success: false, message: "Error interno obteniendo medico." });
  }
});

// ===============================
// API: Crear medico
// Endpoint: POST /api/medicos
// ===============================
router.post("/", requireAuth, requireRole(ADMIN_ROLE_ID), async (req, res) => {
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
router.put(
  "/:id",
  requireAuth,
  requireOwnership(resolveMedicoOwner, { allowRoles: [ADMIN_ROLE_ID] }),
  async (req, res) => {
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
    const actor = getActorFromRequest(req);
    if (actor.roleId !== ADMIN_ROLE_ID && actor.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({
        success: false,
        message: "Solo administradores o el medico propietario pueden actualizar este perfil.",
      });
    }

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
router.delete("/:id", requireAuth, requireRole(ADMIN_ROLE_ID), async (req, res) => {
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
