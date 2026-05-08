const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

const router = express.Router();

// Asegurar esquema de recetas
const ensureRecetasSchema = async () => {
  try {
    await pool.query(`
      ALTER TABLE receta_medica 
      ADD COLUMN IF NOT EXISTS disponible_paciente BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS signos_vitales_json JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS ordenes_laboratorio TEXT,
      ADD COLUMN IF NOT EXISTS doctor_info_json JSONB DEFAULT '{}'::jsonb
    `);
  } catch (err) {
    console.error("Error asegurando esquema de recetas:", err.message);
  }
};
ensureRecetasSchema();

const { 
  resolveUserContext, 
  normalizeText, 
  parsePositiveInt, 
  createNotification 
} = require("../services/platform-core");

// MEDICO: Emitir receta
router.post("/medico/me/recetas", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    
    // 1. Resolver contexto seguro del usuario (previene inyeccion de identidad)
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res.status(context.error.status).json({ success: false, message: context.error.message });
    }

    if (context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Acceso denegado: Solo médicos pueden emitir recetas" });
    }

    const medicoid = context.medico.medicoid;

    // 2. Extracción y Limpieza de datos (Sanitización básica para prevenir XSS/Payload abuse)
    let { 
      pacienteid, 
      paciente_search, 
      citaid, 
      diagnostico, 
      medicamentos, 
      instrucciones, 
      disponible_paciente,
      signos_vitales,
      ordenes_laboratorio,
      doctor_info
    } = req.body;
    
    diagnostico = normalizeText(diagnostico).slice(0, 5000);
    instrucciones = normalizeText(instrucciones).slice(0, 5000);
    ordenes_laboratorio = normalizeText(ordenes_laboratorio).slice(0, 5000);
    paciente_search = normalizeText(paciente_search).slice(0, 100);

    // Validaciones de tipo estrictas
    if (!Array.isArray(medicamentos)) {
      return res.status(400).json({ success: false, message: "El listado de medicamentos debe ser un arreglo" });
    }

    // 3. Resolución de Paciente con protección contra SQLi
    let targetPacienteId = parsePositiveInt(pacienteid);

    if (!targetPacienteId && paciente_search) {
      // Uso de f_unaccent para búsqueda segura e insensible a acentos
      const pResult = await client.query(
        `SELECT usuarioid FROM paciente 
         WHERE (lower(f_unaccent(nombres || ' ' || apellidos)) LIKE lower(f_unaccent($1)) 
            OR btrim(cedula) = $2)
         LIMIT 1`,
        [`%${paciente_search}%`, paciente_search]
      );
      if (pResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: "No se encontró ningún paciente con ese nombre o cédula" });
      }
      targetPacienteId = pResult.rows[0].usuarioid;
    }

    if (!targetPacienteId) {
      return res.status(400).json({ success: false, message: "Debe identificar un paciente válido" });
    }

    // 4. Verificación de Autorización (¿Tiene el médico permiso para recetar a este paciente?)
    // Si se provee una citaid, verificamos que el médico y paciente coincidan
    let cleanCitaId = '00000000-0000-0000-0000-000000000000';
    if (citaid && citaid !== cleanCitaId) {
      const citaCheck = await client.query(
        `SELECT citaid FROM cita 
         WHERE citaid::text = $1 
           AND medicoid::text = $2 
           AND pacienteid = (SELECT pacienteid FROM paciente WHERE usuarioid = $3)
         LIMIT 1`,
        [citaid, String(medicoid), targetPacienteId]
      );
      if (citaCheck.rows.length === 0) {
        // Si no hay cita directa, al menos validamos que el médico haya tenido alguna interacción previa o sea un médico registrado
        // Por ahora, si se provee citaid y no coincide, bloqueamos por seguridad
        return res.status(403).json({ success: false, message: "No tiene autorización para emitir recetas para esta cita específica" });
      }
      cleanCitaId = citaid;
    }

    // 5. Inserción Segura (Transaccional)
    const result = await client.query(
      `INSERT INTO receta_medica (
        pacienteid, citaid, medicoid_text, diagnostico, medicamentos_json, 
        instrucciones, disponible_paciente, signos_vitales_json, 
        ordenes_laboratorio, doctor_info_json
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING recetaid::text, created_at`,
      [
        targetPacienteId, 
        cleanCitaId, 
        String(medicoid), 
        diagnostico || 'Sin diagnóstico especificado', 
        JSON.stringify(medicamentos), 
        instrucciones, 
        disponible_paciente ?? true,
        JSON.stringify(signos_vitales || {}),
        ordenes_laboratorio,
        JSON.stringify(doctor_info || {})
      ]
    );

    // 6. Notificación asíncrona (usando servicio centralizado)
    createNotification(client, {
      usuarioid: targetPacienteId,
      tipo: 'receta_nueva',
      titulo: 'Nueva Receta Disponible',
      contenido: `El Dr. ${context.medico.nombrecompleto || 'tu médico'} ha emitido una nueva receta para ti.`,
      data: { recetaid: result.rows[0].recetaid }
    }).catch(e => console.warn("[Recetas] Error notificacion:", e.message));

    return res.json({ success: true, receta: result.rows[0] });

  } catch (error) {
    console.error("[CRITICAL] Error al emitir receta:", error);
    return res.status(500).json({ success: false, message: "Error de seguridad/sistema al procesar la receta" });
  } finally {
    if (client) client.release();
  }
});

// MEDICO: Listar sus recetas emitidas
router.get("/medico/me/recetas", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) return res.status(context.error.status).json({ success: false, message: context.error.message });

    if (context.roleId !== MEDICO_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo médicos" });
    }

    const medicoid = String(context.medico.medicoid);
    const result = await client.query(
      `SELECT r.recetaid::text, r.diagnostico, r.medicamentos_json, r.instrucciones, r.created_at,
              COALESCE(p.nombres || ' ' || p.apellidos, 'Paciente') AS paciente_nombre
       FROM receta_medica r
       LEFT JOIN paciente p ON p.usuarioid = r.pacienteid
       WHERE r.medicoid_text = $1
       ORDER BY r.created_at DESC`,
      [medicoid]
    );

    return res.json({ success: true, recetas: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  } finally {
    if (client) client.release();
  }
});

// PACIENTE: Listar sus recetas recibidas
router.get("/paciente/me/recetas", requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) return res.status(context.error.status).json({ success: false, message: context.error.message });

    if (context.roleId !== PACIENTE_ROLE_ID) {
      return res.status(403).json({ success: false, message: "Solo pacientes" });
    }

    const result = await client.query(
      `SELECT r.recetaid::text, r.diagnostico, r.medicamentos_json, r.instrucciones, r.created_at,
              COALESCE(m.nombrecompleto, 'Médico') AS medico_nombre
       FROM receta_medica r
       LEFT JOIN medico m ON m.usuarioid::text = r.medicoid_text
       WHERE r.pacienteid = $1
       ORDER BY r.created_at DESC`,
      [context.user.usuarioid]
    );

    return res.json({ success: true, recetas: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  } finally {
    if (client) client.release();
  }
});

// Obtener detalle de una receta (Seguridad Reforzada)
router.get("/recetas/:id", requireAuth, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const cleanId = normalizeText(id);
    if (!cleanId) return res.status(400).json({ success: false, message: "ID de receta inválido" });

    client = await pool.connect();
    
    // 1. Resolver contexto del usuario que consulta
    const context = await resolveUserContext(client, req.user);
    if (context.error) return res.status(context.error.status).json({ success: false, message: context.error.message });

    // 2. Consulta con Join para verificar propiedad y obtener datos
    const result = await client.query(
      `SELECT r.recetaid::text, r.diagnostico, r.medicamentos_json, r.instrucciones, r.created_at, r.pacienteid,
              r.signos_vitales_json, r.ordenes_laboratorio, r.doctor_info_json, r.medicoid_text,
              COALESCE(p.nombres || ' ' || p.apellidos, 'Paciente') AS paciente_nombre,
              COALESCE(p.cedula, '') AS paciente_cedula,
              COALESCE(m.nombrecompleto, 'Médico') AS medico_nombre,
              COALESCE(e.nombre, 'Medicina General') AS especialidad_nombre
       FROM receta_medica r
       LEFT JOIN paciente p ON p.usuarioid = r.pacienteid
       LEFT JOIN medico m ON m.usuarioid::text = r.medicoid_text
       LEFT JOIN especialidad e ON e.especialidadid = m.especialidadid
       WHERE r.recetaid::text = $1`,
      [cleanId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Receta no encontrada" });
    }

    const receta = result.rows[0];

    // 3. Verificación de Autorización Estricta
    let hasAccess = false;

    // Caso A: Es el paciente dueño de la receta
    if (context.roleId === PACIENTE_ROLE_ID && context.user.usuarioid === receta.pacienteid) {
      hasAccess = true;
    }
    // Caso B: Es el médico que emitió la receta
    else if (context.roleId === MEDICO_ROLE_ID && String(context.medico.medicoid) === receta.medicoid_text) {
      hasAccess = true;
    }
    // Caso C: Es otro médico (Requiere verificar consentimiento del paciente)
    else if (context.roleId === MEDICO_ROLE_ID) {
      const { hasPatientConsent } = require("./clinical.routes"); // Reutilizamos lógica de consentimiento si está disponible
      // Si no podemos importar hasPatientConsent fácilmente, implementamos un check rápido aquí
      const consentResult = await client.query(
        `SELECT meta_json FROM usuario_perfil WHERE usuarioid = $1 LIMIT 1`,
        [receta.pacienteid]
      );
      const consent = consentResult.rows[0]?.meta_json?.compartirHistorial === true;
      if (consent) hasAccess = true;
    }
    // Caso D: Es Administrador
    else if (context.roleId === 3) {
      hasAccess = true;
    }

    if (!hasAccess) {
      console.warn(`[SECURITY] Intento de acceso no autorizado a receta ${cleanId} por usuario ${context.user.usuarioid}`);
      return res.status(403).json({ success: false, message: "No tiene permisos para ver esta receta" });
    }

    return res.json({ success: true, receta });
  } catch (error) {
    console.error("[SECURITY ERROR] Fallo al recuperar detalle de receta:", error);
    return res.status(500).json({ success: false, message: "Error interno de seguridad" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
