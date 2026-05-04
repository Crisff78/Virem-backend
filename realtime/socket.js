const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const pool = require("../config/db");
const { ensureRfCoreSchema } = require("../services/rf-core");
const { getSocketCorsOrigins } = require("../config/env");

let ioInstance = null;

const MEDICO_ROLE_ID = 2;
const PACIENTE_ROLE_ID = 1;

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toRoom(prefix, id) {
  const clean = normalizeText(id);
  if (!clean) return "";
  return `${prefix}:${clean}`;
}

function getSocketAuth(socket) {
  return socket.data?.auth || {};
}

function getSocketRealtimeScopes(socket) {
  if (!socket.data.realtimeScopes) {
    socket.data.realtimeScopes = {
      citas: new Set(),
      conversations: new Set(),
    };
  }
  return socket.data.realtimeScopes;
}

function respondToSocketAction(callback, payload) {
  if (typeof callback === "function") {
    callback(payload);
  }
}

async function resolveMedicoIdForUser(client, userRow) {
  if (!userRow) return "";
  const result = await client.query(
    `SELECT medicoid::text AS medicoid
     FROM medico
     WHERE usuarioid = $1
     LIMIT 1`,
    [Number(userRow.usuarioid)]
  );
  return normalizeText(result.rows[0]?.medicoid);
}

async function resolveRealtimeContext(usuarioid) {
  const userId = Number.parseInt(String(usuarioid || ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return { userId: "", roleId: 0, pacienteId: "", medicoId: "" };
  }

  await ensureRfCoreSchema();

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      `SELECT usuarioid, rolid, activo, fechacreacion
       FROM usuario
       WHERE usuarioid = $1
       LIMIT 1`,
      [userId]
    );
    if (!userResult.rows.length || !Boolean(userResult.rows[0].activo)) {
      return { userId: "", roleId: 0, pacienteId: "", medicoId: "" };
    }

    const user = userResult.rows[0];
    const roleId = Number(user.rolid || 0);

    if (roleId === PACIENTE_ROLE_ID) {
      const pacienteResult = await client.query(
        `SELECT pacienteid::text AS pacienteid
         FROM paciente
         WHERE usuarioid = $1
         LIMIT 1`,
        [userId]
      );
      return {
        userId: String(userId),
        roleId,
        pacienteId: normalizeText(pacienteResult.rows[0]?.pacienteid),
        medicoId: "",
      };
    }

    if (roleId === MEDICO_ROLE_ID) {
      const medicoId = await resolveMedicoIdForUser(client, user);
      return {
        userId: String(userId),
        roleId,
        pacienteId: "",
        medicoId,
      };
    }

    return { userId: String(userId), roleId, pacienteId: "", medicoId: "" };
  } finally {
    client.release();
  }
}

async function canAccessCita(client, auth, citaId) {
  const cleanCitaId = normalizeText(citaId);
  const pacienteId = normalizeText(auth?.pacienteId);
  const medicoId = normalizeText(auth?.medicoId);
  const roleId = Number(auth?.roleId || 0);

  if (!cleanCitaId) {
    return { ok: false, code: "cita_id_invalid" };
  }

  if (roleId === PACIENTE_ROLE_ID && pacienteId) {
    const result = await client.query(
      `SELECT
         c.citaid::text AS citaid,
         c.pacienteid::text AS pacienteid,
         c.medicoid::text AS medicoid
       FROM cita c
       WHERE c.citaid::text = $1::text
         AND c.pacienteid = $2
       LIMIT 1`,
      [cleanCitaId, Number(pacienteId)]
    );

    if (result.rows.length) {
      return { ok: true, cita: result.rows[0] };
    }

    return { ok: false, code: "cita_forbidden" };
  }

  if (roleId === MEDICO_ROLE_ID && medicoId) {
    const result = await client.query(
      `SELECT
         c.citaid::text AS citaid,
         c.pacienteid::text AS pacienteid,
         c.medicoid::text AS medicoid
       FROM cita c
       WHERE c.citaid::text = $1::text
         AND c.medicoid::text = $2::text
       LIMIT 1`,
      [cleanCitaId, medicoId]
    );

    if (result.rows.length) {
      return { ok: true, cita: result.rows[0] };
    }

    return { ok: false, code: "cita_forbidden" };
  }

  return { ok: false, code: "role_not_allowed" };
}

async function canAccessConversation(client, auth, conversationId) {
  const cleanConversationId = normalizeText(conversationId);
  const pacienteId = normalizeText(auth?.pacienteId);
  const medicoId = normalizeText(auth?.medicoId);
  const roleId = Number(auth?.roleId || 0);

  if (!cleanConversationId) {
    return { ok: false, code: "conversation_id_invalid" };
  }

  if (roleId === PACIENTE_ROLE_ID && pacienteId) {
    const result = await client.query(
      `SELECT
         conv.conversacionid::text AS conversacionid,
         conv.citaid::text AS citaid,
         conv.pacienteid::text AS pacienteid,
         conv.medicoid::text AS medicoid
       FROM conversaciones conv
       WHERE conv.conversacionid::text = $1::text
         AND conv.pacienteid = $2
       LIMIT 1`,
      [cleanConversationId, Number(pacienteId)]
    );

    if (result.rows.length) {
      return { ok: true, conversation: result.rows[0] };
    }

    return { ok: false, code: "conversation_forbidden" };
  }

  if (roleId === MEDICO_ROLE_ID && medicoId) {
    const result = await client.query(
      `SELECT
         conv.conversacionid::text AS conversacionid,
         conv.citaid::text AS citaid,
         conv.pacienteid::text AS pacienteid,
         conv.medicoid::text AS medicoid
       FROM conversaciones conv
       WHERE conv.conversacionid::text = $1::text
         AND conv.medicoid::text = $2::text
       LIMIT 1`,
      [cleanConversationId, medicoId]
    );

    if (result.rows.length) {
      return { ok: true, conversation: result.rows[0] };
    }

    return { ok: false, code: "conversation_forbidden" };
  }

  return { ok: false, code: "role_not_allowed" };
}

async function joinAuthorizedCitaRoom(socket, citaId, callback) {
  let client;
  try {
    client = await pool.connect();
    const auth = getSocketAuth(socket);
    const access = await canAccessCita(client, auth, citaId);

    if (!access.ok) {
      respondToSocketAction(callback, access);
      return;
    }

    const cleanCitaId = normalizeText(access.cita?.citaid || citaId);
    const room = toRoom("cita", cleanCitaId);
    if (!room) {
      respondToSocketAction(callback, { ok: false, code: "cita_id_invalid" });
      return;
    }

    socket.join(room);
    getSocketRealtimeScopes(socket).citas.add(cleanCitaId);
    respondToSocketAction(callback, {
      ok: true,
      citaId: cleanCitaId,
      room,
    });
  } catch (err) {
    respondToSocketAction(callback, { ok: false, code: "server_error" });
  } finally {
    if (client) client.release();
  }
}

async function joinAuthorizedConversationRoom(socket, conversationId, callback) {
  let client;
  try {
    client = await pool.connect();
    const auth = getSocketAuth(socket);
    const access = await canAccessConversation(client, auth, conversationId);

    if (!access.ok) {
      respondToSocketAction(callback, access);
      return;
    }

    const cleanConversationId = normalizeText(
      access.conversation?.conversacionid || conversationId
    );
    const room = toRoom("conversation", cleanConversationId);
    if (!room) {
      respondToSocketAction(callback, { ok: false, code: "conversation_id_invalid" });
      return;
    }

    socket.join(room);
    getSocketRealtimeScopes(socket).conversations.add(cleanConversationId);
    respondToSocketAction(callback, {
      ok: true,
      conversacionId: cleanConversationId,
      citaId: normalizeText(access.conversation?.citaid),
      room,
    });
  } catch (err) {
    respondToSocketAction(callback, { ok: false, code: "server_error" });
  } finally {
    if (client) client.release();
  }
}

function extractBearerToken(socket) {
  const authToken = normalizeText(socket.handshake?.auth?.token);
  if (authToken) return authToken;

  const headerToken = normalizeText(socket.handshake?.headers?.authorization);
  if (!headerToken) return "";
  if (headerToken.toLowerCase().startsWith("bearer ")) {
    return normalizeText(headerToken.slice(7));
  }
  return "";
}

function requireIo() {
  return ioInstance;
}

function emitToRoom(roomName, eventName, payload) {
  const io = requireIo();
  if (!io || !roomName || !eventName) return;
  io.to(roomName).emit(eventName, payload);
}

function emitToUser(userId, eventName, payload) {
  emitToRoom(toRoom("user", userId), eventName, payload);
}

function emitCitaEvent({
  eventName,
  citaId,
  pacienteId,
  medicoId,
  extraPayload = {},
}) {
  const payload = {
    citaId: normalizeText(citaId),
    pacienteId: normalizeText(pacienteId),
    medicoId: normalizeText(medicoId),
    ...extraPayload,
  };
  emitToRoom(toRoom("cita", citaId), eventName, payload);
  emitToRoom(toRoom("paciente", pacienteId), eventName, payload);
  emitToRoom(toRoom("medico", medicoId), eventName, payload);
}

function emitConversationEvent({
  eventName,
  conversacionId,
  citaId,
  pacienteId,
  medicoId,
  extraPayload = {},
}) {
  const payload = {
    conversacionId: normalizeText(conversacionId),
    citaId: normalizeText(citaId),
    pacienteId: normalizeText(pacienteId),
    medicoId: normalizeText(medicoId),
    ...extraPayload,
  };
  emitToRoom(toRoom("conversation", conversacionId), eventName, payload);
  emitToRoom(toRoom("cita", citaId), eventName, payload);
  emitToRoom(toRoom("paciente", pacienteId), eventName, payload);
  emitToRoom(toRoom("medico", medicoId), eventName, payload);
}

function emitMedicoPresence({ medicoId, online }) {
  const cleanMedicoId = normalizeText(medicoId);
  if (!cleanMedicoId) return;
  const eventName = online ? "medico_en_linea" : "medico_fuera_de_linea";
  emitToRoom(toRoom("medico", cleanMedicoId), eventName, {
    medicoId: cleanMedicoId,
    online: Boolean(online),
    at: new Date().toISOString(),
  });
}

function initializeSocketServer(httpServer) {
  if (ioInstance) return ioInstance;

  ioInstance = new Server(httpServer, {
    cors: {
      origin: getSocketCorsOrigins(),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  ioInstance.use(async (socket, next) => {
    try {
      const token = extractBearerToken(socket);
      if (!token) {
        return next(new Error("token_missing"));
      }
      if (!process.env.JWT_SECRET) {
        return next(new Error("jwt_secret_missing"));
      }
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const context = await resolveRealtimeContext(payload?.usuarioid);
      if (!context.userId) {
        return next(new Error("user_not_found"));
      }
      socket.data.auth = {
        usuarioid: context.userId,
        roleId: context.roleId,
        pacienteId: context.pacienteId,
        medicoId: context.medicoId,
      };
      return next();
    } catch (err) {
      return next(new Error("token_invalid"));
    }
  });

  ioInstance.on("connection", (socket) => {
    const auth = getSocketAuth(socket);
    const userId = normalizeText(auth.usuarioid);
    const pacienteId = normalizeText(auth.pacienteId);
    const medicoId = normalizeText(auth.medicoId);
    const scopes = getSocketRealtimeScopes(socket);

    socket.join(toRoom("user", userId));
    if (pacienteId) socket.join(toRoom("paciente", pacienteId));
    if (medicoId) {
      socket.join(toRoom("medico", medicoId));
      emitMedicoPresence({ medicoId, online: true });
    }

    socket.on("join:cita", async (citaId, callback) => {
      await joinAuthorizedCitaRoom(socket, citaId, callback);
    });

    socket.on("leave:cita", (citaId) => {
      const cleanCitaId = normalizeText(citaId);
      if (!scopes.citas.has(cleanCitaId)) return;
      const room = toRoom("cita", cleanCitaId);
      if (room) socket.leave(room);
      scopes.citas.delete(cleanCitaId);
    });

    socket.on("join:conversation", async (conversationId, callback) => {
      await joinAuthorizedConversationRoom(socket, conversationId, callback);
    });

    socket.on("leave:conversation", (conversationId) => {
      const cleanConversationId = normalizeText(conversationId);
      if (!scopes.conversations.has(cleanConversationId)) return;
      const room = toRoom("conversation", cleanConversationId);
      if (room) socket.leave(room);
      scopes.conversations.delete(cleanConversationId);
    });

    socket.on("typing", ({ conversacionId, isTyping }) => {
      const cleanConversationId = normalizeText(conversacionId);
      if (!scopes.conversations.has(cleanConversationId)) return;

      const room = toRoom("conversation", cleanConversationId);
      if (!room) return;
      socket.to(room).emit("typing", {
        conversacionId: cleanConversationId,
        usuarioid: userId,
        emisorTipo: auth.roleId === PACIENTE_ROLE_ID ? "paciente" : "medico",
        isTyping: Boolean(isTyping),
        at: new Date().toISOString(),
      });
    });

    socket.on("disconnect", () => {
      if (medicoId) {
        emitMedicoPresence({ medicoId, online: false });
      }
    });
  });

  return ioInstance;
}

module.exports = {
  initializeSocketServer,
  getIO: requireIo,
  emitToRoom,
  emitToUser,
  emitCitaEvent,
  emitConversationEvent,
  emitMedicoPresence,
};
