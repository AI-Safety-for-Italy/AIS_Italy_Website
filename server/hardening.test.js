// Tests for the safety rails around every tool: local stand-ins that stay
// off on Vercel, who may change permissions, what the shared admin password
// opens in production, the headers of the private pages, and the links put
// in emails. Run with `npm run test:meet`.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const members = require('./members');
const authApi = require('../api/auth');

const ENV = ['VERCEL', 'VERCEL_ENV', 'MEET_DEV_LOGIN', 'SITE_URL'];
let saved;

beforeEach(() => {
  db.setDb(new PGlite());
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  ENV.forEach((k) => delete process.env[k]);
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

afterEach(() => {
  ENV.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

function request({ method = 'GET', url = '/', user, body, headers = {} } = {}) {
  const all = { 'content-type': 'application/json', ...headers };
  if (user) all.cookie = `${auth.COOKIE}=${auth.makeSession(user.id)}`;
  return { method, url, headers: all, body, socket: {} };
}

async function call(handler, options) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  await handler(request(options), res);
  return res;
}

// ── 1. Local stand-ins stay local ───────────────────────────────────────────

test('the stand-in sign-in works on a developer machine', async () => {
  process.env.MEET_DEV_LOGIN = '1';
  assert.equal((await call(authApi, { url: '/api/auth' })).body.devLogin, true);
  const res = await call(authApi, {
    method: 'POST',
    url: '/api/auth?action=dev',
    body: { name: 'Dev', roles: ['dev-admin'] },
  });
  assert.equal(res.statusCode, 200);
});

test('on Vercel the stand-ins stay off, whatever MEET_DEV_LOGIN says', async () => {
  process.env.MEET_DEV_LOGIN = '1';
  process.env.VERCEL = '1';
  const info = (await call(authApi, { url: '/api/auth' })).body;
  assert.equal(info.devLogin, false);
  assert.equal(info.devRoles, undefined);
  const res = await call(authApi, {
    method: 'POST',
    url: '/api/auth?action=dev',
    body: { name: 'Intruder', roles: ['dev-admin'] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['Set-Cookie'], undefined);
  assert.equal(members.devMode(), false);
  assert.deepEqual(await permissions.guildRoles(), []);
});
