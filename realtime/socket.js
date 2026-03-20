const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const pool = require("../config/db");
const { getUserProfileById } = require("../services/user-profile.store");

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

async function resolveMedicoIdForUser(client, userRow) {
  if (!userRow) return "";
  const profile = await getUserProfileById(client, userRow.usuarioid);
  const meta = profile?.meta && typeof profile.meta === "object" ? profile.meta : {};

  const knownMedicoId = normalizeText(meta.medicoid || meta.medicoId);
  if (knownMedicoId) {
    const byKnown = await client.query(
      `SELECT medicoid::text AS medicoid
       FROM medico
       WHERE medicoid::text = $1::text
       LIMIT 1`,
      [knownMedicoId]
    );
    if (byKnown.rows.length) return normalizeText(byKnown.rows[0].medicoid);
  }

  const byExact = await client.query(
    `SELECT medicoid::text AS medicoid
     FROM medico
     WHERE medicoid::text = $1::text
     LIMIT 1`,
    [String(userRow.usuarioid)]
  );
  if (byExact.rows.length) return normalizeText(byExact.rows[0].medicoid);

  if (!userRow.fechacreacion) return "";

  const byNearest = await client.query(
    `SELECT
       medicoid::text AS medicoid,
       ABS(EXTRACT(EPOCH FROM (fecharegistro - $1::timestamptz))) AS diff_seconds
     FROM medico
     ORDER BY diff_seconds ASC
     LIMIT 1`,
    [userRow.fechacreacion]
  );

  if (!byNearest.rows.length) return "";
  const diffSeconds = Number(byNearest.rows[0].diff_seconds || 0);
  if (!Number.isFinite(diffSeconds) || diffSeconds > 86400) return "";
  return normalizeText(byNearest.rows[0].medicoid);
}

async function resolveRealtimeContext(usuarioid) {
  const userId = Number.parseInt(String(usuarioid || ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return { userId: "", roleId: 0, pacienteId: "", medicoId: "" };
  }

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
         WHERE pacienteid = $1
         LIMIT 1`,
        [userId]
      );
      return {
        userId: String(userId),
        roleId,
        pacienteId: normalizeText(pacienteResult.rows[0]?.pacienteid || String(userId)),
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
      origin: "*",
      methods: ["GET", "POST"],
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
    const auth = socket.data?.auth || {};
    const userId = normalizeText(auth.usuarioid);
    const pacienteId = normalizeText(auth.pacienteId);
    const medicoId = normalizeText(auth.medicoId);

    socket.join(toRoom("user", userId));
    if (pacienteId) socket.join(toRoom("paciente", pacienteId));
    if (medicoId) {
      socket.join(toRoom("medico", medicoId));
      emitMedicoPresence({ medicoId, online: true });
    }

    socket.on("join:cita", (citaId) => {
      const room = toRoom("cita", citaId);
      if (room) socket.join(room);
    });

    socket.on("leave:cita", (citaId) => {
      const room = toRoom("cita", citaId);
      if (room) socket.leave(room);
    });

    socket.on("join:conversation", (conversationId) => {
      const room = toRoom("conversation", conversationId);
      if (room) socket.join(room);
    });

    socket.on("leave:conversation", (conversationId) => {
      const room = toRoom("conversation", conversationId);
      if (room) socket.leave(room);
    });

    socket.on("typing", ({ conversacionId, isTyping }) => {
      const room = toRoom("conversation", conversacionId);
      if (!room) return;
      socket.to(room).emit("typing", {
        conversacionId: normalizeText(conversacionId),
        usuarioid: userId,
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
