/**
 * Zego RTC Token v04 generator (no external SDK needed).
 *
 * Implements the official spec:
 * https://docs.zegocloud.com/article/14140
 *
 * Algorithm:
 *  1. JSON-encode payload = {
 *       app_id, user_id, nonce, ctime, expire,
 *       payload  // base64 of room/permission JSON
 *     }
 *  2. Random IV (16 bytes), AES-128-CBC encrypt with first 16 bytes of ServerSecret.
 *  3. Build binary: BigEndian
 *       int64 expire | int16 ivLen | iv | int16 dataLen | encrypted
 *  4. base64 -> "04" + token
 */

const crypto = require("crypto");

const TOKEN_VERSION = "04";
const ERROR_CODES = {
  SUCCESS: 0,
  APP_ID_INVALID: 1,
  USER_ID_INVALID: 3,
  SECRET_INVALID: 5,
  EFFECTIVE_TIME_IN_SECONDS_INVALID: 6,
};

function ensureConfigured() {
  const appId = Number.parseInt(String(process.env.ZEGO_APP_ID || "").trim(), 10);
  const serverSecret = String(process.env.ZEGO_SERVER_SECRET || "").trim();

  if (!Number.isFinite(appId) || appId <= 0) {
    const err = new Error("ZEGO_APP_ID no configurado o invalido");
    err.code = ERROR_CODES.APP_ID_INVALID;
    throw err;
  }
  if (!serverSecret || serverSecret.length !== 32) {
    const err = new Error(
      "ZEGO_SERVER_SECRET debe ser exactamente 32 caracteres (consola Zego -> Server Secret)"
    );
    err.code = ERROR_CODES.SECRET_INVALID;
    throw err;
  }
  return { appId, serverSecret };
}

function randomNonce() {
  // 31-bit signed positive int (Zego spec)
  return Math.floor(Math.random() * 2147483647);
}

function aesEncrypt(plainText, secret, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", secret, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
}

/**
 * Generate a Zego RTC token bound to a specific roomID and userID.
 *
 * @param {object} args
 * @param {string} args.userId  Stable user identifier (e.g. "usuario:42")
 * @param {string} args.roomId  Room identifier (e.g. "appt-<citaId>")
 * @param {number} [args.effectiveTimeSeconds=3600]  Token TTL
 * @param {{stream_id_list?: string[]}} [args.privilege]  Optional Zego privilege map (1=login, 2=publish)
 * @returns {string} Token to pass to ZegoExpressEngine.loginRoom
 */
function generateZegoRtcToken({
  userId,
  roomId,
  effectiveTimeSeconds = 3600,
  privilege,
}) {
  const { appId, serverSecret } = ensureConfigured();

  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) {
    const err = new Error("userId es obligatorio");
    err.code = ERROR_CODES.USER_ID_INVALID;
    throw err;
  }
  if (!Number.isFinite(effectiveTimeSeconds) || effectiveTimeSeconds <= 0) {
    const err = new Error("effectiveTimeSeconds debe ser > 0");
    err.code = ERROR_CODES.EFFECTIVE_TIME_IN_SECONDS_INVALID;
    throw err;
  }

  const ctime = Math.floor(Date.now() / 1000);
  const expire = ctime + Math.floor(effectiveTimeSeconds);

  const payloadObj = {
    app_id: appId,
    user_id: cleanUserId,
    nonce: randomNonce(),
    ctime,
    expire,
    payload: roomId
      ? Buffer.from(
          JSON.stringify({
            room_id: String(roomId),
            // 1 = loginRoom, 2 = publishStream
            privilege: privilege?.privilege || { 1: 1, 2: 1 },
            stream_id_list: privilege?.stream_id_list || null,
          })
        ).toString("base64")
      : "",
  };

  const plainText = JSON.stringify(payloadObj);
  const iv = crypto.randomBytes(16);
  const aesKey = Buffer.from(serverSecret).slice(0, 16);
  const encrypted = aesEncrypt(plainText, aesKey, iv);

  const expireBuf = Buffer.alloc(8);
  expireBuf.writeBigInt64BE(BigInt(expire));

  const ivLenBuf = Buffer.alloc(2);
  ivLenBuf.writeInt16BE(iv.length);

  const dataLenBuf = Buffer.alloc(2);
  dataLenBuf.writeInt16BE(encrypted.length);

  const binary = Buffer.concat([expireBuf, ivLenBuf, iv, dataLenBuf, encrypted]);
  return TOKEN_VERSION + binary.toString("base64");
}

function getZegoConfig() {
  try {
    const { appId } = ensureConfigured();
    const server = process.env.ZEGO_SERVER || `wss://webliveroom${appId}-api.zegocloud.com/ws`;
    return { appId, server };
  } catch {
    return null;
  }
}

module.exports = {
  generateZegoRtcToken,
  getZegoConfig,
  ZEGO_ERROR_CODES: ERROR_CODES,
};
