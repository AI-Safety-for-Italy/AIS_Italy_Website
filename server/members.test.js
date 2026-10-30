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
  assert.equal(rows[0].email, 'giulia@example.com');
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(rows[0].answers[1], { label: 'Aree', value: 'Governance, Interpretability' });
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
