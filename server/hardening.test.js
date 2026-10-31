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

const permissionsApi = require('./routes/app/permissions');

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
    call(permissionsApi, {
      method: 'PUT',
      url: '/api/app/permissions',
      user: manager,
      body: { roles: table },
    });

  const roles = await call(permissionsApi, { url: '/api/app/permissions', user: manager });
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
  const roles = await call(permissionsApi, { url: '/api/app/permissions', user: root });
  assert.equal(roles.body.canGrantAll, true);
  const res = await call(permissionsApi, {
    method: 'PUT',
    url: '/api/app/permissions',
    user: root,
    body: { roles: tableOf([['r-team', ['forms_admin', 'members', 'mentorship']]]) },
  });
  assert.equal(res.statusCode, 200);
});

test('a person given keys by name gets them on top of their roles, and may sign in', async () => {
  await permissions.saveRolePermissions(tableOf([['r-comms', ['blog']]]));
  const root = await admin();
  const sara = await member('Sara', ['r-comms']);
  const nora = await member('Nora', []);
  assert.equal(await permissions.anyContentRole([], 'test-Nora'), false);

  const res = await call(permissionsApi, {
    method: 'PUT',
    url: '/api/app/permissions',
    user: root,
    body: {
      roles: tableOf([['r-comms', ['blog']]]),
      people: [
        { userId: sara.id, permissions: ['forms'] },
        { userId: nora.id, permissions: ['event'] },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await permissions.forUser(sara), ['blog', 'forms']);
  assert.deepEqual(await permissions.forUser(nora), ['event']);
  // No role at all, but keys by name: the Discord sign-in lets her in.
  assert.equal(await permissions.anyContentRole([], 'test-Nora'), true);

  // The page lists them, and who else could be added.
  const page = await call(permissionsApi, { url: '/api/app/permissions', user: root });
  assert.deepEqual(
    page.body.people.map((p) => [p.name, p.permissions]),
    [
      ['Nora', ['event']],
      ['Sara', ['forms']],
    ]
  );
  assert.deepEqual(page.body.candidates.map((p) => p.name).sort(), ['Nora', 'Sara']);

  // Every change leaves a line on the audit trail, with the keys only.
  const { rows } = await db.query(
    `select user_name, detail from crm_audit where action = 'permissions-change'`
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail.keys.sort(), ['event', 'forms']);
});

test('a content manager cannot give personal-data keys to a person either', async () => {
  await permissions.saveRolePermissions(tableOf([['r-comms', ['manage']]]));
  const manager = await member('Carla', ['r-comms']);
  const tom = await member('Tom', []);
  const put = (people) =>
    call(permissionsApi, {
      method: 'PUT',
      url: '/api/app/permissions',
      user: manager,
      body: { roles: tableOf([['r-comms', ['manage']]]), people },
    });
  assert.equal((await put([{ userId: tom.id, permissions: ['blog'] }])).statusCode, 200);
  for (const key of ['members', 'mentorship', 'forms']) {
    const res = await put([{ userId: tom.id, permissions: ['blog', key] }]);
    assert.equal(res.statusCode, 403, key);
  }
  assert.deepEqual(await permissions.forUser(tom), ['blog']);
});

test('the board, with manage_all, hands out every key but manage_all itself', async () => {
  const root = await admin();
  const tom = await member('Tom', []);
  const save = (user, roles, people) =>
    call(permissionsApi, {
      method: 'PUT',
      url: '/api/app/permissions',
      user,
      body: { roles, people },
    });
  // Only the shared admin gives manage_all; it brings manage with it.
  const board = tableOf([['r-board', ['manage_all']]]);
  assert.equal((await save(root, board, [])).statusCode, 200);
  const anna = await member('Anna', ['r-board']);
  assert.deepEqual(await permissions.forUser(anna), ['manage', 'manage_all']);
  const page = await call(permissionsApi, { url: '/api/app/permissions', user: anna });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.grantable.includes('members'));
  assert.ok(!page.body.grantable.includes('manage_all'));

  // Personal-data keys, to a role or a person: fine for the board.
  const res = await save(
    anna,
    [...board, ...tableOf([['r-mentors', ['mentorship', 'members']]])],
    [{ userId: tom.id, permissions: ['forms_admin'] }]
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await permissions.forUser(tom), ['forms_admin']);

  // But not manage_all: neither giving it nor taking it away.
  const keep = tableOf([
    ['r-board', ['manage_all']],
    ['r-mentors', ['mentorship', 'members']],
  ]);
  const give = await save(anna, keep, [
    { userId: tom.id, permissions: ['forms_admin', 'manage_all'] },
  ]);
  assert.equal(give.statusCode, 403);
  const takeAway = await save(
    anna,
    tableOf([
      ['r-board', ['manage']],
      ['r-mentors', ['mentorship', 'members']],
    ]),
    [{ userId: tom.id, permissions: ['forms_admin'] }]
  );
  assert.equal(takeAway.statusCode, 403);

  // And an old sign-in is asked to sign in again before changing anything.
  await db.query(`update app_users set last_login_at = now() - interval '2 days' where id = $1`, [
    anna.id,
  ]);
  assert.equal((await save(anna, keep, [])).statusCode, 401);
});

test('only accounts signed in with Discord can be given keys by name', async () => {
  const root = await admin();
  for (const userId of [root.id, '00000000-0000-0000-0000-000000000000', 'nope']) {
    const res = await call(permissionsApi, {
      method: 'PUT',
      url: '/api/app/permissions',
      user: root,
      body: { roles: [], people: [{ userId, permissions: ['blog'] }] },
    });
    assert.equal(res.statusCode, 400, userId);
  }
});

test('without manage, the permissions page is refused', async () => {
  const someone = await member('Ugo', []);
  const res = await call(permissionsApi, { url: '/api/app/permissions', user: someone });
  assert.equal(res.statusCode, 403);
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

// ── 6. The private pages cannot be framed by another site ──────────────────

test('the private pages and the API cannot be framed, and are not sniffed', () => {
  const vercel = require('../vercel.json');
  const paths = ['/app/', '/app/members/', '/form/', '/join/', '/meet/', '/api/form', '/api/auth'];
  for (const path of paths) {
    const headers = {};
    for (const rule of vercel.headers) {
      // Vercel's sources here are path patterns: "/(a|b)/(.*)" and the like.
      if (new RegExp(`^${rule.source}$`).test(path)) {
        rule.headers.forEach((h) => (headers[h.key] = h.value));
      }
    }
    assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'", path);
    assert.equal(headers['X-Frame-Options'], 'DENY', path);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff', path);
  }
});

// ── 7. Links in emails come from a fixed address ────────────────────────────

const { siteUrl } = require('./http');

test('links in emails use SITE_URL when set, whatever host the request names', () => {
  const req = { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } };
  assert.equal(siteUrl(req), 'https://evil.example');
  process.env.SITE_URL = 'https://www.ais4i.it/';
  assert.equal(siteUrl(req), 'https://www.ais4i.it');
});

test('an approval email points to SITE_URL, not to the host of the request', async () => {
  const mail = require('./mail');
  const membersApi = require('./routes/app/members');
  const sent = [];
  const fakeMail = process.env.MEET_FAKE_MAIL;
  process.env.MEET_FAKE_MAIL = '0';
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-hardening-secret-of-at-least-thirty-two-chars';
  process.env.DISCORD_ROLE_PARTICIPANT = 'r-part';
  process.env.MEET_DEV_LOGIN = '1'; // role ids from the local stand-ins
  mail.setTransportFactory(() => ({ sendMail: async (m) => sent.push(m), close() {} }));
  try {
    await mail.saveSettings({
      host: 'smtp.x',
      port: 465,
      fromEmail: 'tech@ais4i.it',
      password: 'p',
    });
    process.env.SITE_URL = 'https://www.ais4i.it';
    const root = await admin();
    const { id } = await members.createApplication({
      name: 'Giulia Bianchi',
      email: 'g@example.org',
    });
    const res = await call(membersApi, {
      method: 'POST',
      url: `/api/app/members?action=decide&id=${id}`,
      user: root,
      body: { decision: 'approve', role: 'participant' },
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /https:\/\/www\.ais4i\.it\/api\/join\?t=/);
    assert.ok(!sent[0].text.includes('evil.example'));
  } finally {
    if (fakeMail === undefined) delete process.env.MEET_FAKE_MAIL;
    else process.env.MEET_FAKE_MAIL = fakeMail;
    delete process.env.DISCORD_ROLE_PARTICIPANT;
  }
});

// ── 5. Sessions end when the member signs out or leaves Discord ────────────

test('signing out ends every session of the account, on every device', async () => {
  const user = await auth.upsertDiscordUser({ discordId: 'test-Ada', name: 'Ada', roles: [] });
  const laptop = await auth.sessionFor(user.id);
  const phone = await auth.sessionFor(user.id);
  const who = (cookie) =>
    call(authApi, { url: '/api/auth', headers: { cookie: `${auth.COOKIE}=${cookie}` } });
  assert.equal((await who(laptop)).body.user.name, 'Ada');

  const out = await call(authApi, {
    method: 'DELETE',
    url: '/api/auth',
    headers: { cookie: `${auth.COOKIE}=${laptop}` },
  });
  assert.equal(out.statusCode, 200);
  assert.equal((await who(laptop)).body.user, null);
  assert.equal((await who(phone)).body.user, null);

  // Signing in again works, with a cookie the old ones cannot stand for.
  const again = await auth.sessionFor(user.id);
  assert.equal((await who(again)).body.user.name, 'Ada');
});

test('leaving the Discord server ends the sessions too', async () => {
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'bot';
  process.env.DISCORD_GUILD_ID = 'g1';
  try {
    const user = await auth.upsertDiscordUser({ discordId: 'd-gone', name: 'Gone', roles: ['r1'] });
    const cookie = await auth.sessionFor(user.id);
    permissions.setFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    await permissions.refreshRoles(user);
    const res = await call(authApi, {
      url: '/api/auth',
      headers: { cookie: `${auth.COOKIE}=${cookie}` },
    });
    assert.equal(res.body.user, null);
  } finally {
    delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
    delete process.env.DISCORD_GUILD_ID;
  }
});

// ── One function for the whole /api/app/ (the hosting plan counts them) ─────

test('/api/app/* reaches each handler through one function, on Vercel and locally', async () => {
  const router = require('../api/app');
  const { routeOf } = router;
  // Locally: the path. On Vercel: the rewrite's __route (vercel.json).
  assert.equal(routeOf({ url: '/api/app/forms?id=1' }), 'forms');
  assert.equal(routeOf({ url: '/api/app?__route=crm/mentorship&id=2' }), 'crm/mentorship');
  assert.equal(routeOf({ url: '/api/app/settings/' }), 'settings');
  // Every handler of server/routes/app/ is routed, and nothing else.
  const fs = require('fs');
  const path = require('path');
  const files = [];
  (function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else files.push(prefix + name.replace(/\.js$/, ''));
    }
  })(path.join(__dirname, 'routes', 'app'), '');
  assert.deepEqual(Object.keys(router.ROUTES).sort(), files.sort());
  // An unknown route is a 404, not a crash.
  const res = await call(router, { url: '/api/app/nope' });
  assert.equal(res.statusCode, 404);
  const vercel = require('../vercel.json');
  assert.ok(vercel.rewrites.some((r) => r.source === '/api/app/:route*'));
});
