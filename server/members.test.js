// Tests for the member applications board (/app/members/): the submission,
// who may decide, the email with the join link, and joining through Discord.
// Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const members = require('./members');
const permissions = require('./permissions');

let sent;
let botCalls;

beforeEach(() => {
  db.setDb(new PGlite());
  sent = [];
  botCalls = [];
  process.env.MEET_FAKE_MAIL = '0';
  mail.setTransportFactory(() => ({
    sendMail: async (m) => sent.push(m),
    close() {},
  }));
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN_AIS_TEAM_AREA: 'bot',
    DISCORD_GUILD_ID: 'g1',
    DISCORD_CLIENT_ID: 'c1',
    DISCORD_CLIENT_SECRET: 's1',
    DISCORD_ROLE_PARTICIPANT: 'r-part',
    DISCORD_ROLE_ORGANIZER: 'r-org',
  });
  delete process.env.MEET_DEV_LOGIN;
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  delete process.env.CRM_ENCRYPTION_KEY_PREVIOUS;
  process.env.CRM_KEY_SECRET = 'a-members-secret-of-at-least-thirty-two-chars';
  // The bot: reading a member's roles (before deciding) and the join calls.
  permissions.setFetch(async (url, init = {}) => {
    botCalls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.includes('/members/d-elisabetta') && init.method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ roles: ['r-board'] }) };
    }
    return { ok: true, status: url.endsWith('/members/u-new') ? 201 : 204, json: async () => ({}) };
  });
});

async function setUp() {
  await mail.saveSettings({ host: 'smtp.x', port: 465, fromEmail: 'tech@ais4i.it', password: 'p' });
  await permissions.saveRolePermissions([
    { roleId: 'r-board', roleName: 'Board', permissions: ['members'] },
  ]);
  return {
    board: await auth.upsertDiscordUser({
      discordId: 'd-elisabetta',
      name: 'Elisabetta',
      roles: ['r-board'],
    }),
    other: await auth.upsertDiscordUser({ discordId: 'd-other', name: 'Other', roles: ['r-x'] }),
  };
}

const application = (over = {}) => ({
  name: 'Giulia Bianchi',
  email: 'Giulia@Example.com',
  requestedRole: 'organizer',
  answers: [
    { label: 'Città', value: 'Torino' },
    { label: 'Aree', value: ['Governance', 'Interpretability'] },
  ],
  ...over,
});

const ORIGIN = { siteOrigin: 'https://www.ais4i.it' };

// Discord's OAuth endpoints for the join link.
const oauth = async (url) => {
  if (url.endsWith('/oauth2/token'))
    return { ok: true, json: async () => ({ access_token: 'at' }) };
  return {
    ok: true,
    json: async () => ({ id: 'u-new', username: 'giulia_b', global_name: 'Giulia' }),
  };
};

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

test('a submission is validated and keeps the answers as the form gave them', async () => {
  await rejects(members.createApplication(application({ email: 'nope' })), 400);
  await rejects(members.createApplication(application({ name: ' ' })), 400);
  await rejects(members.createApplication(application({ requestedRole: 'admin' })), 400);
  const { id } = await members.createApplication(application(), { source: 'iscrizione' });
  const { rows } = await db.query('select * from member_applications where id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].source, 'iscrizione');
  const { board } = await setUp();
  const [a] = (await members.listApplications(board)).applications;
  assert.equal(a.name, 'Giulia Bianchi');
  assert.equal(a.email, 'giulia@example.com');
  assert.deepEqual(a.answers[1], { label: 'Aree', value: 'Governance, Interpretability' });
});

test('who applied is stored encrypted: no name, email or answer in the clear', async () => {
  const { id } = await members.createApplication(application());
  const { rows } = await db.query('select * from member_applications where id = $1', [id]);
  const stored = JSON.stringify(rows[0]);
  for (const plain of ['Giulia', 'giulia@example.com', 'Torino', 'Governance']) {
    assert.ok(!stored.toLowerCase().includes(plain.toLowerCase()), plain);
  }
  assert.ok(rows[0].details_encrypted);
  // Bound to its row: copied onto another application, it does not open.
  const other = await members.createApplication(application({ email: 'sara@example.org' }));
  await db.query('update member_applications set details_encrypted = $1 where id = $2', [
    rows[0].details_encrypted,
    other.id,
  ]);
  const { board } = await setUp();
  const list = (await members.listApplications(board)).applications;
  assert.match(list.find((x) => x.id === other.id).name, /cannot be opened/);
  // Without the keys, nothing is taken.
  delete process.env.CRM_KEY_SECRET;
  await rejects(members.createApplication(application()), 503);
});

test('applying twice is spotted by the email, without storing it', async () => {
  const { board } = await setUp();
  await members.createApplication(application());
  await members.createApplication(application({ email: ' GIULIA@example.com ' }));
  await members.createApplication(application({ email: 'sara@example.org' }));
  const list = (await members.listApplications(board)).applications;
  assert.deepEqual(list.map((a) => a.duplicates).sort(), [0, 1, 1]);
});

test('the board needs a recent sign-in, and every look and decision is on the audit trail', async () => {
  const { board, other } = await setUp();
  const { id } = await members.createApplication(application());
  await db.query(`update app_users set last_login_at = now() - interval '2 days' where id = $1`, [
    board.id,
  ]);
  await rejects(members.listApplications(board), 401);
  await db.query('update app_users set last_login_at = now() where id = $1', [board.id]);
  await members.listApplications(board);
  await members.decide(board, id, { decision: 'approve', role: 'organizer', note: 'ok' }, ORIGIN);
  await rejects(members.listApplications(other), 403);
  const { rows } = await db.query('select action, subject_key, detail from crm_audit order by id');
  const actions = rows.map((r) => r.action);
  assert.deepEqual(actions, ['member-list', 'member-decide', 'denied']);
  assert.equal(rows[1].subject_key, id);
  assert.deepEqual(rows[1].detail, { decision: 'approve', role: 'organizer' });
  assert.ok(!JSON.stringify(rows).includes('giulia'));
});

test('only the members permission sees and decides, and roles are read again first', async () => {
  const { board, other } = await setUp();
  const { id } = await members.createApplication(application());
  await rejects(members.listApplications(other), 403);
  await rejects(members.decide(other, id, { decision: 'reject' }, ORIGIN), 403);
  const list = await members.listApplications(board);
  assert.equal(list.applications.length, 1);
  assert.equal(list.mailReady, true);
  assert.ok(list.roles.every((r) => r.ready));
  await members.decide(board, id, { decision: 'reject', note: 'spam' }, ORIGIN);
  assert.ok(botCalls.some((c) => c.url.endsWith('/members/d-elisabetta')));
  assert.equal(sent.length, 0);
  // A rejection by mistake can still be approved, once.
  await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  assert.equal(sent.length, 1);
  await rejects(members.decide(board, id, { decision: 'reject' }, ORIGIN), 409);
});

test('approving emails a personal link once, even when clicked twice', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await rejects(members.decide(board, id, { decision: 'approve', role: 'admin' }, ORIGIN), 400);
  const r = await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  assert.equal(r.invite.sent, true);
  assert.equal(r.application.status, 'approved');
  assert.equal(r.application.role, 'participant');
  assert.equal(r.application.decidedBy, 'Elisabetta');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'giulia@example.com');
  assert.match(sent[0].text, /https:\/\/www\.ais4i\.it\/api\/join\?t=[\w-]{20,}/);
  assert.match(sent[0].text, /Partecipante/);
  await rejects(
    members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN),
    409
  );
  assert.equal(sent.length, 1);
});

test('the link adds the person to the server with the chosen role, and works once', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await members.decide(board, id, { decision: 'approve', role: 'organizer' }, ORIGIN);
  const token = sent[0].text.match(/t=([\w-]+)/)[1];

  await members.completeJoin(token, { code: 'c', redirectUri: 'https://x/api/join' }, oauth);
  const add = botCalls.find(
    (c) => c.method === 'PUT' && c.url.endsWith('/guilds/g1/members/u-new')
  );
  assert.deepEqual(add.body, { access_token: 'at', roles: ['r-org'] });
  assert.ok(
    botCalls.some((c) => c.method === 'PUT' && c.url.endsWith('/members/u-new/roles/r-org'))
  );

  const [a] = (await members.listApplications(board)).applications;
  assert.equal(a.discordName, 'Giulia');
  assert.ok(a.joinedAt);
  await assert.rejects(members.checkJoinToken(token), (err) => err.code === 'used');
});

test('a failed join is recorded, and a fresh link replaces an expired one', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  const token = sent[0].text.match(/t=([\w-]+)/)[1];

  permissions.setFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  await assert.rejects(
    members.completeJoin(token, { code: 'c', redirectUri: 'r' }, oauth),
    (err) => err.code === 'failed'
  );
  let [a] = (await members.listApplications(board)).applications;
  assert.match(a.joinError, /403/);

  await db.query(`update member_applications set join_expires_at = now() - interval '1 day'`);
  await assert.rejects(members.checkJoinToken(token), (err) => err.code === 'expired');
  await members.resendInvite(board, id, ORIGIN);
  const fresh = sent[1].text.match(/t=([\w-]+)/)[1];
  assert.notEqual(fresh, token);
  assert.equal((await members.checkJoinToken(fresh)).id, id);
  await assert.rejects(members.checkJoinToken(token), (err) => err.code === 'invalid');
});

// ── The join link stays safe ─────────────────────────────────────────────────

const oauthAs =
  (email, verified = true) =>
  async (url) => {
    if (url.endsWith('/oauth2/token'))
      return { ok: true, json: async () => ({ access_token: 'at' }) };
    return {
      ok: true,
      json: async () => ({
        id: 'u-new',
        username: 'giulia_b',
        global_name: 'Giulia',
        email,
        verified,
      }),
    };
  };

test('the database keeps only a hash of the join link, never the link itself', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  const token = sent[0].text.match(/t=([\w-]+)/)[1];
  const { rows } = await db.query('select * from member_applications where id = $1', [id]);
  assert.ok(!JSON.stringify(rows[0]).includes(token));
  assert.equal((await members.checkJoinToken(token)).id, id);
  // The stored value is no key: used as a link it lets nobody in.
  await assert.rejects(members.checkJoinToken(rows[0].join_token), (err) => err.code === 'invalid');
});

test('two clicks at once on the link: one joins, the other is told it was used', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  const token = sent[0].text.match(/t=([\w-]+)/)[1];
  const results = await Promise.allSettled([
    members.completeJoin(token, { code: 'c1', redirectUri: 'r' }, oauthAs('giulia@example.com')),
    members.completeJoin(token, { code: 'c2', redirectUri: 'r' }, oauthAs('giulia@example.com')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected');
  assert.equal(refused.reason.code, 'used');
  const adds = botCalls.filter((c) => c.method === 'PUT' && c.url.endsWith('/members/u-new'));
  assert.equal(adds.length, 1);
});

test('a failed join frees the link again, so the person can retry', async () => {
  const { board } = await setUp();
  const { id } = await members.createApplication(application());
  await members.decide(board, id, { decision: 'approve', role: 'participant' }, ORIGIN);
  const token = sent[0].text.match(/t=([\w-]+)/)[1];
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(members.completeJoin(token, { code: 'c', redirectUri: 'r' }, failing));
  assert.equal((await members.checkJoinToken(token)).id, id);
  await members.completeJoin(token, { code: 'c', redirectUri: 'r' }, oauthAs('giulia@example.com'));
  await assert.rejects(members.checkJoinToken(token), (err) => err.code === 'used');
});

test('the board flags a link used by a Discord account with another email', async () => {
  const { board } = await setUp();
  const first = await members.createApplication(application());
  const second = await members.createApplication(application({ email: 'sara@example.org' }));
  await members.decide(board, first.id, { decision: 'approve', role: 'participant' }, ORIGIN);
  await members.decide(board, second.id, { decision: 'approve', role: 'participant' }, ORIGIN);
  const [t1, t2] = sent.map((m) => m.text.match(/t=([\w-]+)/)[1]);
  await members.completeJoin(t1, { code: 'c', redirectUri: 'r' }, oauthAs('Giulia@Example.com'));
  await members.completeJoin(t2, { code: 'c', redirectUri: 'r' }, oauthAs('someone@else.org'));
  const list = (await members.listApplications(board)).applications;
  assert.equal(list.find((a) => a.id === first.id).joinEmailMatch, true);
  assert.equal(list.find((a) => a.id === second.id).joinEmailMatch, false);
});
