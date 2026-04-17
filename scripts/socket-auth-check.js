require("dotenv").config();

const { io } = require("socket.io-client");

const baseUrl =
  process.env.BASE_URL ||
  process.env.BACKEND_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;

const ownerToken = String(process.env.SOCKET_TEST_TOKEN_OWNER || "").trim();
const attackerToken = String(process.env.SOCKET_TEST_TOKEN_ATTACKER || "").trim();
const citaId = String(process.env.SOCKET_TEST_CITA_ID || "").trim();
const conversationId = String(process.env.SOCKET_TEST_CONVERSATION_ID || "").trim();
const timeoutMs = Number.parseInt(process.env.SOCKET_TEST_TIMEOUT_MS || "8000", 10) || 8000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function connectWithToken(token) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ["websocket"],
      auth: { token },
      timeout: timeoutMs,
    });

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };

    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(eventName, payload, (err, response) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(response || null);
    });
  });
}

async function run() {
  if (!ownerToken) {
    fail("SOCKET_TEST_TOKEN_OWNER es obligatorio.");
  }

  const sockets = [];
  try {
    const ownerSocket = await connectWithToken(ownerToken);
    sockets.push(ownerSocket);

    if (citaId) {
      const ownerJoinCita = await emitWithAck(ownerSocket, "join:cita", citaId);
      assert(ownerJoinCita?.ok === true, "El owner no pudo unirse a su cita.");
      console.log(`[OK] join:cita autorizado para ${citaId}`);
    }

    if (conversationId) {
      const ownerJoinConversation = await emitWithAck(
        ownerSocket,
        "join:conversation",
        conversationId
      );
      assert(
        ownerJoinConversation?.ok === true,
        "El owner no pudo unirse a su conversacion."
      );
      console.log(`[OK] join:conversation autorizado para ${conversationId}`);
    }

    if (attackerToken && citaId) {
      const attackerSocket = await connectWithToken(attackerToken);
      sockets.push(attackerSocket);

      const attackerJoinCita = await emitWithAck(attackerSocket, "join:cita", citaId);
      assert(
        attackerJoinCita?.ok === false && attackerJoinCita?.code === "cita_forbidden",
        "El atacante pudo unirse a una cita ajena."
      );
      console.log(`[OK] join:cita bloqueado para usuario no autorizado (${citaId})`);

      if (conversationId) {
        const attackerJoinConversation = await emitWithAck(
          attackerSocket,
          "join:conversation",
          conversationId
        );
        assert(
          attackerJoinConversation?.ok === false &&
            attackerJoinConversation?.code === "conversation_forbidden",
          "El atacante pudo unirse a una conversacion ajena."
        );
        console.log(
          `[OK] join:conversation bloqueado para usuario no autorizado (${conversationId})`
        );
      }
    }

    console.log("Socket auth check completado OK");
  } finally {
    for (const socket of sockets) {
      try {
        socket.disconnect();
      } catch (_) {}
    }
  }
}

run().catch((error) => {
  console.error("Socket auth check fallo:", error?.message || error);
  process.exit(1);
});
