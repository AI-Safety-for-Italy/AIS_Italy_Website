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

// ── 2. `manage` hands out content keys only ─────────────────────────────────

const contentApi = require('../api/app/content');

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

const tableOf = (rows) =>
  rows.map(([roleId, permissions]) => ({ roleId, roleName: roleId, permissions }));

test('a content manager changes content keys, but cannot give anyone the CRM, forms or members', async () => {
  await permissions.saveRolePermissions(
    tableOf([
      ['r-comms', ['manage', 'blog']],
      ['r-mentors', ['mentorship']],
    ])
  );
  const manager = await member('Carla', ['r-comms']);
  const put = (table) =>
    call(contentApi, {
      method: 'PUT',
      url: '/api/app/content?action=roles',
      user: manager,
      body: { table },
    });

  const roles = await call(contentApi, { url: '/api/app/content?action=roles', user: manager });
  assert.equal(roles.body.canGrantAll, false);

  // Content keys: fine, and the CRM row is kept as it is.
  let res = await put(
    tableOf([
      ['r-comms', ['manage', 'blog', 'event']],
      ['r-mentors', ['mentorship']],
    ])
  );
  assert.equal(res.statusCode, 200);

  // Giving themselves forms_admin, CRM or members: refused, nothing saved.
  for (const extra of ['forms_admin', 'crm_admin', 'members']) {
    res = await put(
      tableOf([
        ['r-comms', ['manage', 'blog', 'event', extra]],
        ['r-mentors', ['mentorship']],
      ])
    );
    assert.equal(res.statusCode, 403, extra);
  }
  // Nor taking the CRM away from someone else, or dropping their row.
  res = await put(tableOf([['r-comms', ['manage', 'blog', 'event']]]));
  assert.equal(res.statusCode, 403);
  const saved = await permissions.listRolePermissions();
  assert.deepEqual(
    saved.map((r) => [r.roleId, r.permissions]),
    [
      ['r-comms', ['event', 'blog', 'manage']],
      ['r-mentors', ['mentorship']],
    ]
  );
});

test('the shared admin can hand out every key', async () => {
  const root = await admin();
  const roles = await call(contentApi, { url: '/api/app/content?action=roles', user: root });
  assert.equal(roles.body.canGrantAll, true);
  const res = await call(contentApi, {
    method: 'PUT',
    url: '/api/app/content?action=roles',
    user: root,
    body: { table: tableOf([['r-team', ['forms_admin', 'members', 'mentorship']]]) },
  });
  assert.equal(res.statusCode, 200);
});

// ── 3. The admin password and personal data in production ──────────────────

test('in production the admin password opens content and permissions, not personal data', async () => {
  const root = await admin();
  assert.ok((await permissions.forUser(root)).includes('forms_admin'));
  process.env.VERCEL_ENV = 'preview';
  assert.ok((await permissions.forUser(root)).includes('members'));
  process.env.VERCEL_ENV = 'production';
  const perms = await permissions.forUser(root);
  assert.ok(perms.includes('manage'));
  for (const key of [
    'mentorship',
    'people',
    'finance',
    'crm_admin',
    'forms',
    'forms_admin',
    'members',
  ]) {
    assert.ok(!perms.includes(key), key);
  }
  const info = (await call(authApi, { url: '/api/auth', user: root })).body;
  assert.deepEqual(info.areas, { content: true, crm: false, forms: false, members: false });
});
