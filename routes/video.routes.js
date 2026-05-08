/**
 * Endpoints de videollamada (Zego).
 *
 * Reglas implementadas:
 *  - Solo medico/paciente de la cita pueden pedir token.
 *  - JWT obligatorio (requireAuth).
 *  - La cita debe estar registrada y en estado activo (pendiente/confirmada/reprogramada).
 *  - La ventana de acceso:
 *      [fechahorainicio - PRE_JOIN_S, fechahorainicio + duracionMin*60 + POST_JOIN_S]
 *  - El roomID es deterministico: "appt-<citaId>" (idempotente).
 *  - Devuelve serverNow para que el cliente sincronice tiempos.
 */

const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("./middleware/auth");
const {
  MEDICO_ROLE_ID,
  PACIENTE_ROLE_ID,
  ACTIVE_CITA_CODES,
  normalizeText,
  normalizeComparableText,
  resolveUserContext,
  fetchCitaByIdForContext,
  ensureVideoSala,
} = require("../services/platform-core");
const { generateLiveKitToken, getLiveKitConfig } = require("../services/livekit.service");
const { generateZegoRtcToken, getZegoConfig } = require("../services/zego.service");
const { emitToUser, emitCitaEvent } = require("../realtime/socket");

const router = express.Router();

// Ventanas de tiempo (segundos)
const PRE_JOIN_S = 5 * 60;   // 5 min antes pueden entrar
const POST_JOIN_S = 60;      // 1 min de gracia despues de fin
const TOKEN_TTL_S = 60 * 60; // token valido 1 hora

function durationMinutes(cita) {
  const raw = Number(cita?.duracionmin || cita?.duracion_min || 30);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(raw, 240); // tope 4h
}

function computeAccessWindow(cita) {
  const start = new Date(cita.fechahorainicio).getTime();
  if (!Number.isFinite(start)) return null;
  const dur = durationMinutes(cita) * 60 * 1000;
  return {
    startMs: start,
    endMs: start + dur,
    openFromMs: start - PRE_JOIN_S * 1000,
    closeAtMs: start + dur + POST_JOIN_S * 1000,
    durationMin: durationMinutes(cita),
  };
}

function evaluateAccess(cita, roleId) {
  const win = computeAccessWindow(cita);
  if (!win) return { canJoin: false, reason: "cita_sin_fecha", window: null };

  const estadoCode = normalizeComparableText(cita.estado_codigo);
  if (!ACTIVE_CITA_CODES.includes(estadoCode)) {
    return { canJoin: false, reason: "cita_no_activa", window: win, estadoCode };
  }

  const now = Date.now();
  if (now < win.openFromMs) {
    return { canJoin: false, reason: "fuera_de_horario_temprano", window: win, estadoCode };
  }
  if (now > win.closeAtMs) {
    return { canJoin: false, reason: "fuera_de_horario_tarde", window: win, estadoCode };
  }
  return { canJoin: true, reason: "ok", window: win, estadoCode };
}

function buildRoomId(citaId) {
  return `appt-${String(citaId).replace(/[^a-zA-Z0-9-]/g, "")}`;
}

function buildUserId({ context }) {
  const role = context.roleId === MEDICO_ROLE_ID ? "med" : "pac";
  return `${role}-${context.user.usuarioid}`;
}

function buildDisplayName(context) {
  if (context.roleId === MEDICO_ROLE_ID) {
    return context.medico?.nombrecompleto || "Medico";
  }
  const nombres = context.paciente?.nombres || "";
  const apellidos = context.paciente?.apellidos || "";
  return `${nombres} ${apellidos}`.trim() || "Paciente";
}

/**
 * GET /api/video/me/citas/:citaId/access
 * Devuelve el estado de acceso (sin emitir token) para la UI: contador, reglas, etc.
 */
router.get("/me/citas/:citaId/access", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }

    const cita = await fetchCitaByIdForContext(client, { citaId, context });
    if (!cita) {
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    const { canJoin, reason, window, estadoCode } = evaluateAccess(cita, context.roleId);
    return res.json({
      success: true,
      serverNow: Date.now(),
      cita: {
        citaId: normalizeText(cita.citaid),
        modalidad: normalizeText(cita.modalidad),
        estadoCodigo: estadoCode,
        fechaHoraInicio: cita.fechahorainicio,
        durationMin: window?.durationMin || 30,
      },
      access: {
        canJoin,
        reason,
        openFrom: window?.openFromMs ?? null,
        startsAt: window?.startMs ?? null,
        endsAt: window?.endMs ?? null,
        closesAt: window?.closeAtMs ?? null,
      },
    });
  } catch (err) {
    console.error("Error GET /video/me/citas/:id/access:", err);
    return res
      .status(500)
      .json({ success: false, message: "No se pudo verificar el acceso." });
  } finally {
    if (client) client.release();
  }
});

/**
 * POST /api/video/me/citas/:citaId/token
 * Emite token Zego para la cita. Valida ventana temporal y permisos.
 */
router.post("/me/citas/:citaId/token", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
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

    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    const access = evaluateAccess(cita, context.roleId);
    if (!access.canJoin) {
      await client.query("ROLLBACK");
      const messages = {
        cita_sin_fecha: "La cita no tiene una fecha valida.",
        cita_no_activa: "Esta cita no esta activa.",
        fuera_de_horario_temprano:
          "La videollamada estara disponible cuando llegue la hora de la cita.",
        fuera_de_horario_tarde:
          "La ventana de la videollamada ya cerro.",
      };
      return res.status(403).json({
        success: false,
        message: messages[access.reason] || "No puedes entrar a la videollamada ahora.",
        reason: access.reason,
        access: {
          canJoin: false,
          reason: access.reason,
          openFrom: access.window?.openFromMs ?? null,
          startsAt: access.window?.startMs ?? null,
          endsAt: access.window?.endMs ?? null,
          closesAt: access.window?.closeAtMs ?? null,
        },
        serverNow: Date.now(),
      });
    }

    const provider = process.env.VIDEO_PROVIDER || "livekit";
    // Asegurar registro en video_salas para auditoria/estado.
    const sala = await ensureVideoSala(client, { citaId, provider });

    // Marcar abierta si es el medico el que pide el token (asume que arranca la llamada).
    if (context.roleId === MEDICO_ROLE_ID) {
      await client.query(
        `UPDATE video_salas
            SET estado = CASE WHEN estado = 'finalizada' THEN 'finalizada' ELSE 'abierta' END,
                opened_at = COALESCE(opened_at, NOW())
          WHERE citaid::text = $1::text`,
        [citaId]
      );
    }

    await client.query("COMMIT");

    const roomId = buildRoomId(citaId);
    const userId = buildUserId({ context });
    const displayName = buildDisplayName(context);

    // 1. Intentar LiveKit
    const lkCfg = getLiveKitConfig();
    const hasLiveKit = lkCfg.apiKey && process.env.LIVEKIT_API_SECRET;

    if (hasLiveKit && (provider === "livekit" || !getZegoConfig())) {
      const token = await generateLiveKitToken({
        roomName: roomId,
        participantIdentity: userId,
        participantName: displayName,
        ttl: TOKEN_TTL_S,
      });

      return res.json({
        success: true,
        serverNow: Date.now(),
        provider: "livekit",
        livekit: {
          url: lkCfg.url,
          token,
          roomId,
          userId,
          userName: displayName,
        },
        access: {
          canJoin: true,
          startsAt: access.window.startMs,
          endsAt: access.window.endMs,
          closesAt: access.window.closeAtMs,
          durationMin: access.window.durationMin,
        },
        sala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
            }
          : null,
      });
    }

    // 2. Intentar Zego como fallback o si es el preferido
    const zegoCfg = getZegoConfig();
    if (zegoCfg) {
      const token = generateZegoRtcToken({
        userId,
        roomId,
        effectiveTimeSeconds: TOKEN_TTL_S,
      });

      return res.json({
        success: true,
        serverNow: Date.now(),
        provider: "zego",
        zego: {
          appId: zegoCfg.appId,
          server: zegoCfg.server,
          token,
          roomId,
          userId,
          userName: displayName,
          ttlSeconds: TOKEN_TTL_S,
        },
        access: {
          canJoin: true,
          startsAt: access.window.startMs,
          endsAt: access.window.endMs,
          closesAt: access.window.closeAtMs,
          durationMin: access.window.durationMin,
        },
        sala: sala
          ? {
              videoSalaId: normalizeText(sala.videosalaid),
              estado: normalizeText(sala.estado),
            }
          : null,
      });
    }

    return res.status(500).json({
      success: false,
      message: "No hay ningun proveedor de video configurado o disponible.",
    });

  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("Error POST /video/me/citas/:id/token:", err);
    return res
      .status(500)
      .json({ success: false, message: "No se pudo emitir el token de video." });
  } finally {
    if (client) client.release();
  }
});

/**
 * POST /api/video/me/citas/:citaId/end
 * Marca la sala como finalizada. Cualquiera de los dos puede terminar.
 * Emite call:ended a los miembros de la cita.
 */
router.post("/me/citas/:citaId/end", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
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
    const cita = await fetchCitaByIdForContext(client, { citaId, context, lock: true });
    if (!cita) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    await client.query(
      `UPDATE video_salas
          SET estado = 'finalizada',
              closed_at = NOW()
        WHERE citaid::text = $1::text`,
      [citaId]
    );
    await client.query("COMMIT");

    emitCitaEvent({
      eventName: "call:ended",
      citaId,
      pacienteId: cita.pacienteid,
      medicoId: cita.medicoid,
      extraPayload: { endedBy: context.roleId === MEDICO_ROLE_ID ? "medico" : "paciente" },
    });

    return res.json({ success: true });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("Error POST /video/me/citas/:id/end:", err);
    return res
      .status(500)
      .json({ success: false, message: "No se pudo finalizar la videollamada." });
  } finally {
    if (client) client.release();
  }
});

/**
 * POST /api/video/me/citas/:citaId/invite
 * Notifica al otro extremo que se va a iniciar la llamada (incoming call ringing).
 */
router.post("/me/citas/:citaId/invite", requireAuth, async (req, res) => {
  const citaId = normalizeText(req.params?.citaId);
  if (!citaId) {
    return res.status(400).json({ success: false, message: "citaId es obligatorio." });
  }

  let client;
  try {
    client = await pool.connect();
    const context = await resolveUserContext(client, req.user);
    if (context.error) {
      return res
        .status(context.error.status)
        .json({ success: false, message: context.error.message });
    }
    const cita = await fetchCitaByIdForContext(client, { citaId, context });
    if (!cita) {
      return res.status(404).json({ success: false, message: "Cita no encontrada." });
    }

    const access = evaluateAccess(cita, context.roleId);
    if (!access.canJoin) {
      return res.status(403).json({
        success: false,
        message: "No puedes iniciar la videollamada fuera del horario.",
        reason: access.reason,
      });
    }

    // Buscar usuarioid del receptor para enviarle invitacion
    let receiverUserId = null;
    if (context.roleId === MEDICO_ROLE_ID) {
      const r = await client.query(
        "SELECT usuarioid FROM paciente WHERE pacienteid = $1 LIMIT 1",
        [Number(cita.pacienteid)]
      );
      receiverUserId = Number(r.rows[0]?.usuarioid || 0);
    } else {
      const r = await client.query(
        "SELECT usuarioid FROM medico WHERE medicoid::text = $1::text LIMIT 1",
        [String(cita.medicoid)]
      );
      receiverUserId = Number(r.rows[0]?.usuarioid || 0);
    }

    const callerName = buildDisplayName(context);
    const invitePayload = {
      citaId,
      callerRole: context.roleId === MEDICO_ROLE_ID ? "medico" : "paciente",
      callerName,
      callerUsuarioId: context.user.usuarioid,
      at: new Date().toISOString(),
    };

    if (receiverUserId > 0) {
      emitToUser(receiverUserId, "call:incoming", invitePayload);
    }

    return res.json({ success: true, invitedUsuarioId: receiverUserId });
  } catch (err) {
    console.error("Error POST /video/me/citas/:id/invite:", err);
    return res
      .status(500)
      .json({ success: false, message: "No se pudo enviar la invitacion." });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
