const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { createPortalHarness, PASSWORD } = require('./helpers/portal-assistant');

test('real login and Bearer middleware protect the assistant against other users and roles', async t => {
  const h = await createPortalHarness({ delay: 1 });
  const server = await new Promise(resolve => { const s = h.app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, token, body, method = body ? 'POST' : 'GET') => fetch(base + route, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = (email, password = PASSWORD) => request('/api/auth/login', null, { email, password });
  const prefix = '/api/patient-assistant';
  await t.test('login validates password and active account; unauthenticated and invalid JWT are denied', async () => {
    assert.equal((await login('paciente1@example.invalid', 'incorrecta')).status, 401);
    assert.equal((await login('inactivo@example.invalid')).status, 403);
    assert.equal((await request(prefix + '/conversation')).status, 401);
    assert.equal((await request(prefix + '/conversation', 'synthetic-preview')).status, 401);
  });
  const p1 = await (await login('paciente1@example.invalid')).json();
  const p2 = await (await login('paciente2@example.invalid')).json();
  const doctor = await (await login('medico@example.invalid')).json();
  assert.ok(p1.token && p2.token && doctor.token, 'Real login issues signed sessions for the synthetic accounts');
  await t.test('persisted role and activity override claims in a signed token', async () => {
    assert.equal((await request(prefix + '/conversation', doctor.token)).status, 403);
    const wrongRole = jwt.sign({ usuarioid: 3, rolid: 1 }, h.secret);
    assert.equal((await request(prefix + '/conversation', wrongRole)).status, 403);
    const inactive = jwt.sign({ usuarioid: 4, rolid: 1 }, h.secret);
    assert.equal((await request(prefix + '/conversation', inactive)).status, 403);
    const expired = jwt.sign({ usuarioid: 1, rolid: 1 }, h.secret, { expiresIn: -1 });
    assert.equal((await request(prefix + '/conversation', expired)).status, 401);
  });
  await t.test('patients keep separate conversations and cannot send/delete in another patient conversation', async () => {
    const c1 = await (await request(prefix + '/conversation', p1.token, {})).json();
    const c2 = await (await request(prefix + '/conversation', p2.token, {})).json();
    const id1 = c1.conversation.id, id2 = c2.conversation.id;
    assert.notEqual(id1, id2);
    const body = { requestId: randomUUID(), question: 'Pregunta sintética de integración', documentIds: [] };
    assert.equal((await request(`${prefix}/conversations/${id1}/messages`, p2.token, body)).status, 404);
    assert.equal((await request(`${prefix}/conversations/${id1}`, p2.token, undefined, 'DELETE')).status, 404);
    const result = await request(`${prefix}/conversations/${id1}/messages`, p1.token, body);
    assert.equal(result.status, 200);
    assert.match(await result.text(), /"type":"done"/);
    const replay = await request(`${prefix}/conversations/${id1}/messages`, p1.token, body);
    await replay.text();
    assert.equal(h.provider.calls.answer, 1);
    assert.equal((await (await request(prefix + '/conversation', p2.token)).json()).conversation.messages.length, 0);
    await h.pool.query('UPDATE usuario SET activo=false WHERE usuarioid=1');
    assert.equal((await request(prefix + '/conversation', p1.token)).status, 403);
  });
  await t.test('preview cannot send email, register accounts or expose unrelated writes', async () => {
    assert.equal((await request('/api/auth/recovery/send-code', null, { email: 'paciente1@example.invalid' })).status, 404);
    assert.equal((await request('/api/auth/register', null, {})).status, 404);
    assert.equal((await request('/api/agenda/me/citas', p2.token, {})).status, 404);
  });
});
