const test = require('node:test');
const assert = require('node:assert/strict');
const { localAssistantProvider } = require('../scripts/local-assistant-provider');

test('local synthetic mode never reads private config or creates a paid provider', () => {
  const forbidden = () => { throw new Error('Must not run'); };
  assert.equal(localAssistantProvider({ readConfig: forbidden, createProvider: forbidden }), undefined);
});

test('explicit OpenAI mode only forwards the four provider settings and verifies configuration without inference', () => {
  const kinds = [];
  const adapter = { available: kind => kinds.push(kind) };
  const selected = localAssistantProvider({ live: true, env: { NODE_ENV: 'development', VIREM_ASSISTANT_MODEL: 'override' },
    readConfig: () => ({ OPENAI_API_KEY: 'fake-test-key', VIREM_ASSISTANT_MODEL: 'stored', VIREM_DOCUMENT_MODEL: 'document',
      VIREM_TRANSCRIPTION_MODEL: 'transcription', DATABASE_URL: 'must-never-connect', JWT_SECRET: 'must-never-copy' }),
    createProvider(config) {
      assert.deepEqual(config, { OPENAI_API_KEY: 'fake-test-key', VIREM_ASSISTANT_MODEL: 'override',
        VIREM_DOCUMENT_MODEL: 'document', VIREM_TRANSCRIPTION_MODEL: 'transcription' });
      return adapter;
    },
  });
  assert.equal(selected.kind, 'openai');
  assert.equal(selected.adapter, adapter);
  assert.deepEqual(kinds, ['answer', 'extract', 'transcribe']);
});

test('local OpenAI mode refuses production and missing settings instead of using canned answers', () => {
  assert.throws(() => localAssistantProvider({ live: true, env: { NODE_ENV: 'production' } }), /development/);
  assert.throws(() => localAssistantProvider({ live: true, env: { NODE_ENV: 'development' }, readConfig: () => ({}) }), /unavailable/);
});
