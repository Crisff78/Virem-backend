const { AccessToken } = require("livekit-server-sdk");

/**
 * Generate a LiveKit token for a specific room and user.
 * 
 * @param {object} args
 * @param {string} args.roomName Unique name of the room (e.g. "appt-123")
 * @param {string} args.participantName Display name of the participant
 * @param {string} args.participantIdentity Unique identity of the participant (e.g. "med-45")
 * @param {number} [args.ttl=3600] Token TTL in seconds
 * @returns {string} The generated JWT token
 */
async function generateLiveKitToken({
  roomName,
  participantName,
  participantIdentity,
  ttl = 3600,
}) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured in .env");
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity,
    name: participantName,
    ttl: ttl,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await at.toJwt();
}

function getLiveKitConfig() {
  return {
    url: process.env.LIVEKIT_URL || "wss://virem-video.livekit.cloud", // Fallback for demo if not set
    apiKey: process.env.LIVEKIT_API_KEY,
  };
}

module.exports = {
  generateLiveKitToken,
  getLiveKitConfig,
};
