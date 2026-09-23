// Opt-in provider for the disposable local portal. Never imports config/db or index.
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');
const { createOpenAIProvider } = require('../services/patient-assistant/provider');
const CONFIG_KEYS = ['OPENAI_API_KEY', 'VIREM_ASSISTANT_MODEL', 'VIREM_DOCUMENT_MODEL', 'VIREM_TRANSCRIPTION_MODEL'];

function localAssistantProvider({ live = false, env = process.env,
  readConfig = () => parse(fs.readFileSync(path.join(__dirname, '../.env'))),
  createProvider = createOpenAIProvider,
} = {}) {
  if (!live) return undefined;
  if (env.NODE_ENV !== 'development') throw new Error('Live local portal requires development mode');
  const saved = readConfig();
  // Copy only provider configuration into an isolated object, never into process.env.
  const config = Object.fromEntries(CONFIG_KEYS.map(key => [key, env[key] || saved[key]]));
  const adapter = createProvider(config);
  for (const kind of ['answer', 'extract', 'transcribe']) adapter.available(kind);
  return { kind: 'openai', adapter };
}
module.exports = { localAssistantProvider };
