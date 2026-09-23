const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimitError, InternalServerError, APIConnectionTimeoutError } = require('openai');
const { createOpenAIProvider } = require('../services/patient-assistant/provider');
const { AssistantError } = require('../services/patient-assistant/contracts');
const config = { OPENAI_API_KEY: 'synthetic', VIREM_ASSISTANT_MODEL: 'fake', VIREM_DOCUMENT_MODEL: 'fake' };
const validAnswer = { summary: 'Resumen sintético', interpretation: 'Explicación sintética', uncertainty: '', consultation: [], followups: [] };
const input = () => ({ question: 'Explica el estudio', documents: [], history: [], signal: new AbortController().signal, onSummary: async () => {} });

test('answer and extraction schemas send array and page limits enforced locally to OpenAI', async () => {
  const requests = [];
  const client = { responses: { async create(body) {
    requests.push(body);
    if (!body.stream) return { status: 'completed', output_text: '{"kind":"unreadable","text":"","findings":[],"limitations":[]}' };
    return (async function* () { yield { type: 'response.output_text.delta', delta: JSON.stringify(validAnswer) }; yield { type: 'response.completed' }; })();
  } } };
  const provider = createOpenAIProvider(config, client);
  await provider.answer(input());
  await provider.extract({ bytes: Buffer.from('synthetic'), mime: 'image/png', pages: [], signal: new AbortController().signal });
  const answer = requests[0].text.format.schema.properties;
  assert.equal(answer.followups.maxItems, 3);
  assert.equal(answer.consultation.maxItems, 6);
  assert.match(answer.summary.description, /6000/);
  const extraction = requests[1].text.format.schema.properties;
  assert.equal(extraction.findings.maxItems, 100);
  assert.equal(extraction.limitations.maxItems, 10);
  assert.ok(extraction.findings.items.properties.page.anyOf.some(s => s.type === 'integer' && s.exclusiveMinimum === 0));
  assert.equal(requests[1].input[0].content[0].type, 'input_image');
  assert.equal(requests[1].store, false);
});

test('out-of-contract lists produce a specific recoverable error without logging clinical content', async () => {
  const logs = [];
  const client = { responses: { async *create() {
    yield { type: 'response.output_text.delta', delta: JSON.stringify({ ...validAnswer, summary: 'PRIVATE_CLINICAL_CONTENT', followups: ['a', 'b', 'c', 'd'] }) };
    yield { type: 'response.completed' };
  } } };
  await assert.rejects(createOpenAIProvider(config, client, event => logs.push(event)).answer(input()), e => e.code === 'invalid_response');
  assert.equal(logs[0].reason, 'limit_followups');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_CLINICAL_CONTENT'));
  assert.ok(!JSON.stringify(logs).includes('Explica el estudio'));
});

test('truncated output, rate limits and real SDK timeouts have distinct safe error codes', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"summary":"Parcial' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }];
  const incomplete = { responses: { async *create() { yield* events; } } };
  const truncated = [];
  await assert.rejects(createOpenAIProvider(config, incomplete, e => truncated.push(e)).answer(input()), e => e.code === 'response_incomplete');
  assert.equal(truncated[0].reason, 'max_output_tokens');
  assert.equal(truncated[0].providerStatus, undefined);
  const ended = [];
  const eof = { responses: { async *create() { yield events[0]; } } };
  await assert.rejects(createOpenAIProvider(config, eof, e => ended.push(e)).answer(input()), e => e.code === 'response_incomplete');
  assert.equal(ended[0].reason, 'stream_ended');
  const headers = new Headers();
  for (const [error, code, providerStatus] of [
    [new RateLimitError(429, { message: 'PRIVATE_PROVIDER_BODY' }, 'PRIVATE_PROVIDER_BODY', headers), 'provider_busy', 429],
    [new APIConnectionTimeoutError(), 'provider_timeout', undefined],
    [new InternalServerError(500, { message: 'PRIVATE_PROVIDER_BODY' }, 'PRIVATE_PROVIDER_BODY', headers), 'provider_error', 500],
  ]) {
    const logs = [];
    const client = { responses: { async create() { throw error; } } };
    await assert.rejects(createOpenAIProvider(config, client, event => logs.push(event)).answer(input()), e => e.code === code);
    assert.equal(logs[0].code, code);
    assert.equal(logs[0].providerStatus, providerStatus);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_PROVIDER_BODY'));
  }
});

test('server deadline is logged as timeout; patient stops and local callback failures are not provider errors', async () => {
  const hanging = { responses: { async create(_body, { signal }) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } };
  const deadline = new AbortController(), deadlineLogs = [];
  const pending = createOpenAIProvider(config, hanging, e => deadlineLogs.push(e)).answer({ ...input(), signal: deadline.signal });
  deadline.abort(new AssistantError('provider_timeout', 504));
  await assert.rejects(pending);
  assert.deepEqual([deadlineLogs[0].code, deadlineLogs[0].reason], ['provider_timeout', 'deadline']);
  const stop = new AbortController(), stopLogs = [];
  const stopped = createOpenAIProvider(config, hanging, e => stopLogs.push(e)).answer({ ...input(), signal: stop.signal });
  stop.abort(new AssistantError('interrupted', 409));
  await assert.rejects(stopped);
  assert.equal(stopLogs.length, 0);
  const streaming = { responses: { async *create() { yield { type: 'response.output_text.delta', delta: '{"summary":"Parcial' }; } } };
  const localLogs = [];
  await assert.rejects(createOpenAIProvider(config, streaming, e => localLogs.push(e))
    .answer({ ...input(), onSummary: async () => { throw new Error('SYNTHETIC_DATABASE_FAILURE'); } }), /SYNTHETIC_DATABASE_FAILURE/);
  assert.equal(localLogs.length, 0);
});

test('document extraction distinguishes truncation and logs contract failures without content', async () => {
  const extract = (response, logs) => createOpenAIProvider(config, { responses: { async create() { return response; } } }, e => logs.push(e))
    .extract({ bytes: Buffer.from('synthetic'), mime: 'image/png', pages: [], signal: new AbortController().signal });
  const truncatedLogs = [];
  await assert.rejects(extract({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"kind"' }, truncatedLogs),
    e => e.code === 'document_incomplete');
  assert.equal(truncatedLogs[0].reason, 'max_output_tokens');
  const schemaLogs = [];
  const tooLong = { kind: 'laboratory', text: 'PRIVATE_CLINICAL_CONTENT', findings: [{ label: 'X'.repeat(201), value: '1', unit: '', range: '', quote: '', page: null }], limitations: [] };
  await assert.rejects(extract({ status: 'completed', output_text: JSON.stringify(tooLong) }, schemaLogs), e => e.code === 'unreadable');
  assert.deepEqual([schemaLogs[0].code, schemaLogs[0].reason], ['unreadable', 'schema']);
  assert.ok(!JSON.stringify(schemaLogs).includes('PRIVATE_CLINICAL_CONTENT'));
});
