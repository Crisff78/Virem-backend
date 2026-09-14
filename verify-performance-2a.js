/**
 * Run: node --test verify-performance-2a.js
 * Uses the real Express agenda router on an isolated loopback HTTP server.
 * Real JWT middleware; synthetic doctor identity; DB access is forbidden.
 * Does not load .env or send requests to your running application/database.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const express = require('express');
const jwt = require('jsonwebtoken');

const secret = randomBytes(32).toString('hex');
let databaseCalls = 0;
const forbidDatabase = async () => { databaseCalls++; throw new Error('Invalid input reached the database'); };
const dependencies = {
  express, jsonwebtoken: jwt, crypto: require('node:crypto'),
  '../config/db': { connect: forbidDatabase, query: forbidDatabase },
  '../realtime/socket': {}, './rf-core': {}, './user-profile.store': {}, axios: {},
  '../services/agenda-service': {}, '../services/livekit.service': {},
};
function load(relative) {
  const module = { exports: {} };
  const dependencyRequire = name => {
    if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
    return dependencies[name];
  };
  // Compile in this realm so Express receives native Promises from async handlers.
  const evaluate = vm.compileFunction(fs.readFileSync(path.join(__dirname, relative), 'utf8'),
    ['module', 'require', 'process', 'console'], { filename: relative });
  evaluate(module, dependencyRequire, { env: { NODE_ENV: 'test', JWT_SECRET: secret } }, console);
  return module.exports;
}
const platform = load('services/platform-core.js');
dependencies['../services/platform-core'] = platform;
dependencies['./middleware/auth'] = load('routes/middleware/auth.js');
const app = express();
app.use(express.json());
app.use('/api/agenda', load('routes/agenda.routes.js'));
const server = http.createServer(app);
let endpoint;
const token = jwt.sign({ usuarioid: 999999, rolid: 2 }, secret, { expiresIn: '1m' });

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  endpoint = `http://127.0.0.1:${server.address().port}/api/agenda/medico/me/disponibilidades/recurrente`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

for (const daysCount of [99999, 91, 0, -1, 1.5, '90', null, 1e100]) {
  test(`HTTP rejects daysCount=${JSON.stringify(daysCount)} before SQL`, { timeout: 5000 }, async () => {
    const start = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daysCount, pattern: [{ dayOfWeek: 1, start: '08:00', end: '09:00' }],
        modalidad: 'virtual', slotMinutos: 30 }),
    });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.success, false);
    assert.match(data.message, /daysCount/);
    assert.ok(performance.now() - start < 2000, 'Invalid input must fail within two seconds');
    assert.equal(databaseCalls, 0);
  });
}

test('the shared validator accepts integer boundaries and rejects nonfinite values', () => {
  for (const value of [1, 30, 90]) assert.equal(platform.isValidDaysCount(value), true);
  for (const value of [NaN, Infinity, -Infinity, undefined, true, {}, []]) {
    assert.equal(platform.isValidDaysCount(value), false);
  }
});

test('the HTTP route still requires authentication', async () => {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daysCount: 99999 }), signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 401);
  assert.equal(databaseCalls, 0);
});
