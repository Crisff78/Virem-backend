const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { errorHandler, notFoundHandler } = require('../middleware/error-handler');

test('Express 5 forwards async rejections with safe compatible error bodies in every environment', async () => {
  const app = express();
  app.use(express.json());
  app.post('/body', (_req, res) => res.json({ success: true }));
  app.get('/fail/:status', async (req) => {
    await Promise.resolve();
    const error = new Error('SELECT password FROM usuario; postgres://admin:secret@db');
    error.status = Number(req.params.status);
    error.detail = 'private SQL'; error.stack = 'private stack'; error.expose = true;
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const status of [400, 401, 403, 404, 500, 0, 200, 999]) {
      const response = await fetch(url + '/fail/' + status);
      assert.equal(response.status, status >= 400 && status <= 599 ? status : 500);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.error, body.message);
      assert.doesNotMatch(JSON.stringify(body), /SELECT|password|postgres:|secret|private|stack|detail/);
    }
    const missing = await fetch(url + '/missing?token=secret');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /secret|token|missing/);
    const invalid = await fetch(url + '/body', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"secret":' });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(await invalid.text(), /secret|SyntaxError|JSON/);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('already-sent responses delegate to Express instead of writing another body', () => {
  const error = new Error('private');
  let forwarded;
  errorHandler(error, {}, { headersSent: true, json() { assert.fail('Must not write'); } }, value => { forwarded = value; });
  assert.equal(forwarded, error);
});
