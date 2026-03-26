const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  resolveUserContext,
  normalizeText,
  normalizeComparableText,
} = require("../services/platform-core");
const { ensureRfCoreSchema } = require("../services/rf-core");
const { ensureUserProfileTable } = require("../services/user-profile.store");

const router = express.Router();

function isCompletedCita(row) {
  const statusCode = normalizeComparableText(row?.estado_codigo || "");
  const statusName = normalizeComparableText(row?.estado_nombre || "");
  if (statusCode === "completada") return true;
  return (
    statusName.includes("complet") ||
    statusName.includes("finaliz") ||
    statusName.includes("realiz")
  );
}

async function hasPatientConsent(client, pacienteId) {
  const result = await client.query(
    `SELECT meta_json
     FROM usuario_perfil
     WHERE usuarioid::text = $1::text
     ORDER BY updated_at DESC
     LIMIT 1`,
    [String(pacienteId)]
  );

  if (!result.rows.length) return false;
  const meta = result.rows[0]?.meta_json;
  if (!meta || typeof meta !== "object") return false;
  return Boolean(meta.compartirHistorial);
}

router.use(requireAuth);
router.use(async (_req, res, next) => {
  try {
    await ensureRfCoreSchema();
    await ensureUserProfileTable();
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "No se pudo preparar el modulo clinico.",
    });
  }
});

// ===============================
// POST /api/clinical/me/citas/:citaId/historia
// Solo medico tratante puede registrar/editar historia clinica
// ===============================
router.post("/me/citas/:citaId/historia", async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const diagnostico = normalizeText(req.body?.diagnostico);
  const antecedentes = normalizeText(req.body?.antecedentes);
  const tratamiento = normalizeText(req.body?.tratamiento);
  const observaciones = normalizeText(req.body?.observaciones);
  const duracionMinRaw = Number.parseInt(String(req.body?.duracionMin || ""), 10);
  const duracionMin = Number.isFinite(duracionMinRaw)
    ? Math.max(1, Math.min(720, duracionMinRaw))
    : null;

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }
  if (!diagnostico) {
    return res.status(400).json({ success: false, message: "diagnostico es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    if (context.roleId !== MEDICO_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo el medico tratante puede registrar historia clinica.",
      });
    }

    const citaResult = await client.query(
      `SELECT
         c.citaid::text AS citaid,
         c.pacienteid::text AS pacienteid,
         c.medicoid::text AS medicoid,
         c.estado_codigo,
         COALESCE(ec.nombre, 'Pendiente') AS estado_nombre
       FROM cita c
       LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
       WHERE c.citaid::text = $1::text
         AND c.medicoid::text = $2::text
       LIMIT 1
       FOR UPDATE`,
      [citaId, String(context.medico.medicoid)]
    );

    if (!citaResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "No se encontro la cita para este medico.",
      });
    }

    const cita = citaResult.rows[0];
    const consent = await hasPatientConsent(client, cita.pacienteid);
    if (!consent) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message:
          "El paciente no ha otorgado consentimiento para compartir su historial clinico.",
      });
    }

    const upsert = await client.query(
      `INSERT INTO historia_clinica (
         citaid,
         pacienteid,
         medicoid_text,
         diagnostico,
         antecedentes,
         tratamiento,
         observaciones,
         duracion_min,
         consentimiento_otorgado,
         created_by_usuarioid,
         updated_by_usuarioid,
         created_at,
         updated_at
       )
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$9,NOW(),NOW())
       ON CONFLICT (citaid)
       DO UPDATE SET
         diagnostico = EXCLUDED.diagnostico,
         antecedentes = EXCLUDED.antecedentes,
         tratamiento = EXCLUDED.tratamiento,
         observaciones = EXCLUDED.observaciones,
         duracion_min = EXCLUDED.duracion_min,
         consentimiento_otorgado = TRUE,
         updated_by_usuarioid = EXCLUDED.updated_by_usuarioid,
         updated_at = NOW()
       RETURNING
         historiaid,
         citaid::text AS citaid,
         pacienteid,
         medicoid_text,
         diagnostico,
         antecedentes,
         tratamiento,
         observaciones,
         duracion_min,
         consentimiento_otorgado,
         created_at,
         updated_at`,
      [
        citaId,
        Number(cita.pacienteid),
        String(cita.medicoid),
        diagnostico,
        antecedentes || null,
        tratamiento || null,
        observaciones || null,
        duracionMin,
        Number(req.user.usuarioid),
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Historia clinica guardada correctamente.",
      historia: upsert.rows[0] || null,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return res.status(500).json({
      success: false,
      message: "No se pudo guardar la historia clinica.",
    });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// GET /api/clinical/me/historia
// Paciente: su historia
// Medico: solo sus pacientes
// Admin: lectura limitada
// ===============================
router.get("/me/historia", async (req, res) => {
  const pacienteIdFilter = normalizeText(req.query?.pacienteId);
  const limitRaw = Number.parseInt(String(req.query?.limit || "80"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 80;

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const params = [];
    const where = [];

    if (context.roleId === PACIENTE_ROLE_ID) {
      params.push(Number(context.paciente.pacienteid));
      where.push(`h.pacienteid = $${params.length}`);
    } else if (context.roleId === MEDICO_ROLE_ID) {
      params.push(String(context.medico.medicoid));
      where.push(`h.medicoid_text = $${params.length}`);
      if (pacienteIdFilter) {
        params.push(Number.parseInt(pacienteIdFilter, 10));
        where.push(`h.pacienteid = $${params.length}`);
      }
    } else {
      // Admin o rol distinto: lectura limitada.
      if (pacienteIdFilter) {
        params.push(Number.parseInt(pacienteIdFilter, 10));
        where.push(`h.pacienteid = $${params.length}`);
      }
    }

    params.push(limit);

    const result = await client.query(
      `SELECT
         h.historiaid,
         h.citaid::text AS citaid,
         h.pacienteid,
         h.medicoid_text,
         h.diagnostico,
         h.antecedentes,
         h.tratamiento,
         h.observaciones,
         h.duracion_min,
         h.consentimiento_otorgado AS consentimiento_otorgado,
         h.created_at,
         h.updated_at,
         COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre,
         COALESCE(
           NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
           'Paciente'
         ) AS paciente_nombre
       FROM historia_clinica h
       LEFT JOIN medico m ON m.medicoid::text = h.medicoid_text
       LEFT JOIN paciente p ON p.pacienteid = h.pacienteid
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY h.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const limitedAdmin = context.roleId !== PACIENTE_ROLE_ID && context.roleId !== MEDICO_ROLE_ID;

    return res.json({
      success: true,
      historias: result.rows.map((row) => ({
        historiaId: Number(row.historiaid || 0),
        citaId: normalizeText(row.citaid),
        pacienteId: Number(row.pacienteid || 0),
        pacienteNombre: normalizeText(row.paciente_nombre),
        medicoId: normalizeText(row.medicoid_text),
        medicoNombre: normalizeText(row.medico_nombre),
        diagnostico: limitedAdmin ? "Lectura limitada para administracion" : normalizeText(row.diagnostico),
        antecedentes: limitedAdmin ? "" : normalizeText(row.antecedentes),
        tratamiento: limitedAdmin ? "" : normalizeText(row.tratamiento),
        observaciones: limitedAdmin ? "" : normalizeText(row.observaciones),
        duracionMin: row.duracion_min ? Number(row.duracion_min) : null,
        consentimientoOtorgado: Boolean(row.consentimiento_otorgado),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "No se pudo listar la historia clinica.",
    });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// POST /api/clinical/me/citas/:citaId/valoracion
// Paciente deja una sola valoracion por cita completada
// ===============================
router.post("/me/citas/:citaId/valoracion", async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  const puntaje = Number.parseInt(String(req.body?.puntaje || ""), 10);
  const comentario = normalizeText(req.body?.comentario).slice(0, 2000);

  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }
  if (!Number.isFinite(puntaje) || puntaje < 1 || puntaje > 5) {
    return res.status(400).json({
      success: false,
      message: "puntaje debe ser un numero entre 1 y 5.",
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      await client.query("ROLLBACK");
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    if (context.roleId !== PACIENTE_ROLE_ID) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo pacientes pueden registrar valoraciones.",
      });
    }

    const citaResult = await client.query(
      `SELECT
         c.citaid::text AS citaid,
         c.pacienteid::text AS pacienteid,
         c.medicoid::text AS medicoid,
         c.estado_codigo,
         COALESCE(ec.nombre, 'Pendiente') AS estado_nombre
       FROM cita c
       LEFT JOIN estado_cita ec ON ec.estadocitaid = c.estadocitaid
       WHERE c.citaid::text = $1::text
         AND c.pacienteid = $2
       LIMIT 1
       FOR UPDATE`,
      [citaId, Number(context.paciente.pacienteid)]
    );

    if (!citaResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "No se encontro la cita para este paciente.",
      });
    }

    const cita = citaResult.rows[0];
    if (!isCompletedCita(cita)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Solo puedes valorar citas completadas.",
      });
    }

    const inserted = await client.query(
      `INSERT INTO valoracion (
         citaid,
         pacienteid,
         medicoid_text,
         puntaje,
         comentario,
         estado_moderacion,
         created_at,
         updated_at
       )
       VALUES ($1::uuid,$2,$3,$4,$5,'pendiente',NOW(),NOW())
       ON CONFLICT (citaid)
       DO NOTHING
       RETURNING
         valoracionid,
         citaid::text AS citaid,
         puntaje,
         comentario,
         estado_moderacion,
         created_at`,
      [
        citaId,
        Number(context.paciente.pacienteid),
        String(cita.medicoid),
        puntaje,
        comentario || null,
      ]
    );

    if (!inserted.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ya registraste una valoracion para esta cita.",
      });
    }

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Valoracion registrada y pendiente de moderacion.",
      valoracion: inserted.rows[0],
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return res.status(500).json({ success: false, message: "No se pudo registrar la valoracion." });
  } finally {
    if (client) client.release();
  }
});

// ===============================
// GET /api/clinical/me/valoraciones
// Paciente: propias, Medico: recibidas
// ===============================
router.get("/me/valoraciones", async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    let query = "";
    let params = [];

    if (context.roleId === PACIENTE_ROLE_ID) {
      query = `SELECT
        v.valoracionid,
        v.citaid::text AS citaid,
        v.puntaje,
        v.comentario,
        v.estado_moderacion,
        v.created_at,
        COALESCE(m.nombrecompleto, 'Medico') AS medico_nombre
      FROM valoracion v
      LEFT JOIN medico m ON m.medicoid::text = v.medicoid_text
      WHERE v.pacienteid = $1
      ORDER BY v.created_at DESC`;
      params = [Number(context.paciente.pacienteid)];
    } else if (context.roleId === MEDICO_ROLE_ID) {
      query = `SELECT
        v.valoracionid,
        v.citaid::text AS citaid,
        v.puntaje,
        v.comentario,
        v.estado_moderacion,
        v.created_at,
        COALESCE(
          NULLIF(TRIM(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')), ''),
          'Paciente'
        ) AS paciente_nombre
      FROM valoracion v
      LEFT JOIN paciente p ON p.pacienteid = v.pacienteid
      WHERE v.medicoid_text = $1
        AND lower(COALESCE(v.estado_moderacion, 'pendiente')) = 'aprobada'
      ORDER BY v.created_at DESC`;
      params = [String(context.medico.medicoid)];
    } else {
      return res.status(403).json({
        success: false,
        message: "Solo pacientes o medicos pueden consultar valoraciones desde este endpoint.",
      });
    }

    const result = await client.query(query, params);
    return res.json({ success: true, valoraciones: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: "No se pudo consultar valoraciones." });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
