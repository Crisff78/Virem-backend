// Separate entry point: never load production app/index workers or database config.
if (process.env.NODE_ENV !== 'development') throw new Error('Portal preview requires NODE_ENV=development');
const { createPortalHarness } = require('../tests/helpers/portal-assistant');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { localAssistantProvider } = require('./local-assistant-provider');
async function main() {
  const port = Number(process.env.VIREM_PORTAL_PREVIEW_PORT || 3103);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid portal preview port');
  const assistantProvider = localAssistantProvider({ live: process.argv.includes('--openai') });
  const harness = await createPortalHarness({ delay: 350, assistantProvider });
  const server = harness.app.listen(port, '127.0.0.1', () =>
    console.log(`Local patient portal: http://127.0.0.1:${port} (in-memory DB, provider=${assistantProvider?.kind || 'synthetic'}, no deliveries)`));
  // The portal listens for incoming calls. No call/chat handlers exist in this preview.
  const io = new Server(server);
  io.use((socket, next) => {
    try { jwt.verify(socket.handshake.auth?.token, harness.secret); next(); }
    catch { next(new Error('Unauthorized')); }
  });
  process.on('SIGINT', () => io.close(() => server.close(() => harness.pool.end().then(() => process.exit()))));
}
main().catch(() => { console.error('Synthetic portal startup failed'); process.exitCode = 1; });
