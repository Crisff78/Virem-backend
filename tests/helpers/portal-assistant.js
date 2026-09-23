// Local/test harness only. Production never imports this module.
// Login, JWT verification, role checks and assistant handlers are the real modules.
// The database and unrelated portal read models are synthetic. Tests default to a fake provider.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { assistantDatabase } = require('./assistant-db');
const { syntheticProvider } = require('./synthetic-provider');
const { createStore } = require('../../services/patient-assistant/store');
const { createAssistantRouter } = require('../../routes/patient-assistant.routes');

const PASSWORD = 'PacientePrueba9!';

async function createPortalHarness({ delay = 100, assistantProvider } = {}) {
  const pool = await assistantDatabase();
  // No dotenv, pg connection, real credentials, reminder workers or mail services.
  const env = { NODE_ENV: 'development', JWT_SECRET: randomBytes(32).toString('hex'), REQUIRE_EMAIL_VERIFICATION: 'true' };
  const root = path.resolve(__dirname, '../..');
  const cache = new Map();
  const blocked = () => { throw new Error('External service disabled in synthetic portal'); };
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const realRequire = createRequire(file);
    function isolatedRequire(name) {
        if (name === 'axios') return { post: blocked, get: blocked };
        if (name === 'nodemailer') return { createTransport: blocked };
        if (name.includes('exequatur.provider')) return { consultarExequaturSNS: blocked };
        if (!name.startsWith('.')) return realRequire(name);
        const resolved = realRequire.resolve(name);
        if (resolved === path.join(root, 'config/db.js')) return pool;
        return load(resolved);
    }
    vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process'], { filename: file })(
      isolatedRequire, module, module.exports, { env },
    );
    return module.exports;
  }
  try {
    for (const sql of [
      `ALTER TABLE usuario ADD COLUMN email TEXT, ADD COLUMN passwordhash TEXT,
        ADD COLUMN fechacreacion TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN account_status TEXT DEFAULT 'activa', ADD COLUMN email_verificado BOOLEAN DEFAULT TRUE`,
      `CREATE TABLE usuario_perfil(usuarioid INTEGER PRIMARY KEY, foto_url TEXT, meta_json JSONB, updated_at TIMESTAMPTZ)`,
      `CREATE TABLE paciente(pacienteid INTEGER PRIMARY KEY, usuarioid INTEGER, nombres TEXT, apellidos TEXT,
        fechanacimiento DATE, genero TEXT, cedula TEXT, telefono TEXT, fecharegistro TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE medico(medicoid INTEGER PRIMARY KEY, usuarioid INTEGER, nombrecompleto TEXT)`,
      `INSERT INTO paciente(pacienteid,usuarioid,nombres,apellidos) VALUES
        (1,1,'Paciente sintético','Uno'),(2,2,'Paciente sintético','Dos'),(4,4,'Paciente sintético','Inactivo')`,
      `INSERT INTO medico VALUES(3,3,'Profesional sintético')`,
    ]) await pool.query(sql);
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, email] of [[1, 'paciente1@example.invalid'], [2, 'paciente2@example.invalid'], [3, 'medico@example.invalid'], [4, 'inactivo@example.invalid']]) {
      await pool.query('UPDATE usuario SET email=$1,passwordhash=$2 WHERE usuarioid=$3', [email, hash, id]);
    }
    const { requireAuth } = load('routes/middleware/auth.js');
    const { requireRole } = load('routes/middleware/access-control.js');
    const authRouter = load('routes/auth.routes.js');
    const app = express();
    app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/ }));
    const store = createStore(pool), provider = assistantProvider?.adapter || syntheticProvider({ delay });
    app.use('/api/patient-assistant', createAssistantRouter({ store, provider, authenticate: requireAuth, patientOnly: requireRole(1) }));
    app.use(express.json({ limit: '32kb' }));
    app.use('/api/auth', (req, res, next) => {
      // Registration, recovery and all delivery-capable routes stay unreachable.
      if ((req.method === 'POST' && req.path === '/login') || (req.method === 'GET' && req.path === '/me')) return next();
      res.status(404).json({ success: false, message: 'Operación fuera de la validación sintética.' });
    }, authRouter);
    app.get('/health', (_req, res) => res.json({ synthetic: true, database: 'PGlite memory',
      openai: assistantProvider?.kind === 'openai', provider: assistantProvider?.kind || 'synthetic' }));
    app.get('/api/users/me/paciente-profile', requireAuth, requireRole(1), async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM paciente WHERE usuarioid=$1', [req.user.usuarioid]);
      res.json({ success: true, profile: { ...rows[0], nombreCompleto: `${rows[0].nombres} ${rows[0].apellidos}` } });
    });
    // Empty fixtures let the real portal mount its existing background modules.
    app.get(['/api/agenda/me/citas', '/api/agenda/me/notificaciones', '/api/agenda/me/conversaciones',
      '/api/paciente/me/recetas', '/api/medicos', '/api/medicos/especialidades'], requireAuth, (_req, res) =>
      res.json({ success: true, citas: [], notificaciones: [], conversaciones: [], recetas: [], medicos: [], especialidades: [], data: [] }));
    app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta fuera de la validación sintética.' }));
    return { app, pool, provider, store, secret: env.JWT_SECRET };
  } catch (error) { await pool.end(); throw error; }
}
module.exports = { createPortalHarness, PASSWORD };
