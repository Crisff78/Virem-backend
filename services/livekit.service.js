const { AccessToken } = require("livekit-server-sdk");
const { normalizeText } = require("./platform-core");

/**
 * Generates a LiveKit Access Token for a participant.
 * @param {string} roomName - The name of the room to join.
 * @param {string} identity - Unique identity of the user.
 * @param {string} name - Display name of the user.
 * @returns {Promise<string>} - The generated token.
 */
async function generateLiveKitToken(roomName, identity, name) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured in .env");
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: normalizeText(identity),
    name: normalizeText(name),
  });

  at.addGrant({
    roomJoin: true,
    room: normalizeText(roomName),
    canPublish: true,
    canSubscribe: true,
  });

  return await at.toJwt();
}

module.exports = {
  generateLiveKitToken,
};
