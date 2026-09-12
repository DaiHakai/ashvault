// Phase 2 server: passwordless accounts and an authoritative persistent run.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GameSession } from './game.js';
import { creationCatalogue } from './content.js';
import { createStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';
const secret = process.env.AUTH_SECRET ?? (isProduction ? null : 'ashvault-local-development-secret-change-before-launch');
if (!secret) throw new Error('AUTH_SECRET must be set in production.');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(here, '..', 'public')));
const store = createStore();
const sessions = new Map(); // account ID -> live cache; Postgres is the source of truth.

app.get('/health', (_req, res) => res.json({ ok: true, storage: process.env.DATABASE_URL ? 'postgres' : 'memory' }));

function cookies(header = '') { return Object.fromEntries(header.split(';').map((p) => p.trim().split(/=(.*)/s, 2)).filter(([k]) => k)); }
function sign(value) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function token(accountId) {
  const payload = Buffer.from(JSON.stringify({ sub: accountId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function tokenAccount(value) {
  if (!value?.includes('.')) return null;
  const [payload, signature] = value.split('.'); const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return body.exp > Date.now() ? body.sub : null; } catch { return null; }
}
function sessionCookie(value, maxAge = 0) {
  return [`ashvault_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', isProduction ? 'Secure' : '', maxAge ? `Max-Age=${maxAge}` : 'Max-Age=0'].filter(Boolean).join('; ');
}
async function accountFor(req, res) {
  const id = tokenAccount(cookies(req.headers.cookie).ashvault_session); const account = id && await store.getAccount(id);
  if (!account) { res.status(401).json({ error: 'Sign in to enter Ashvault.' }); return null; }
  return account;
}
async function gameFor(account) {
  if (sessions.has(account.id)) return sessions.get(account.id);
  const saved = await store.loadSave(account.id); const game = saved ? GameSession.restore(saved) : new GameSession();
  sessions.set(account.id, game); return game;
}
async function save(account, game) { await store.save(account.id, game.saveState()); }
function gamePayload(game, entries = game.takeRecent()) {
  return { sessionId: game.id, statPool: game.publicStatPool(), catalogue: creationCatalogue(), entries, state: game.snapshot() };
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const created = await store.createAccount(req.body ?? {}); const { account, vaultKey } = created;
    res.setHeader('Set-Cookie', sessionCookie(token(account.id), 60 * 60 * 24 * 30)); res.status(201).json({ account, vaultKey });
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/auth/restore', async (req, res) => {
  try { const account = await store.restore(req.body ?? {}); res.setHeader('Set-Cookie', sessionCookie(token(account.id), 60 * 60 * 24 * 30)); res.json({ account }); }
  catch (error) { res.status(401).json({ error: error.message }); }
});
app.post('/api/auth/logout', (_req, res) => { res.setHeader('Set-Cookie', sessionCookie('')); res.status(204).end(); });
app.get('/api/auth/me', async (req, res) => { const account = await accountFor(req, res); if (account) res.json({ account }); });

app.post('/api/session', async (req, res) => {
  const account = await accountFor(req, res); if (!account) return;
  const game = await gameFor(account); await save(account, game); res.json({ account, ...gamePayload(game) });
});
app.get('/api/session', async (req, res) => {
  const account = await accountFor(req, res); if (!account) return;
  const game = await gameFor(account); res.json({ account, ...gamePayload(game, game.entries) });
});
app.post('/api/character', async (req, res) => {
  const account = await accountFor(req, res); if (!account) return;
  const game = await gameFor(account);
  try { game.beginGame(req.body ?? {}); await save(account, game); res.json(game.response()); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/command', async (req, res) => {
  const account = await accountFor(req, res); if (!account) return;
  if (typeof req.body?.input !== 'string') return res.status(400).json({ error: 'input must be a string' });
  const game = await gameFor(account); const result = game.command(req.body.input); await save(account, game); res.json(result);
});
app.post('/api/restart', async (req, res) => {
  const account = await accountFor(req, res); if (!account) return;
  const game = await gameFor(account); const result = game.command('restart'); await save(account, game);
  res.json({ ...result, statPool: game.publicStatPool(), catalogue: creationCatalogue() });
});

await store.init();
app.listen(PORT, () => console.log(`Ashvault online server listening on http://localhost:${PORT}`));
