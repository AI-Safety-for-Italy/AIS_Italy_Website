// Tests for the community (server/community.js): the working groups, the
// members and their tags mirrored on Discord, the import of the old sheet,
// publishing to the site, the board's tags, and becoming an organizer. On
// invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const community = require('./community');
const members = require('./members');
const communityBuild = require('./community-build');
const contentPublish = require('./content-publish');

let botCalls;

beforeEach(() => {
  db.setDb(new PGlite());
  botCalls = [];
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN_AIS_TEAM_AREA: 'bot',
    DISCORD_GUILD_ID: 'g1',
    DISCORD_ROLE_PARTICIPANT: '111111',
    DISCORD_ROLE_ORGANIZER: '222222',
    CRM_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    CRM_KEY_SECRET: 'a-community-secret-of-at-least-thirty-two-chars',
    MEET_FAKE_MAIL: '1',
  });
  delete process.env.CONTENT_BUILD_TOKEN;
  permissions.setFetch(async (url, init = {}) => {
    botCalls.push({ url, method: init.method || 'GET' });
    // Reading someone's roles again before a change: those stored for them.
    const who = /\/members\/(\d+)$/.exec(url);
    if (who && (init.method || 'GET') === 'GET') {
      const { rows } = await db.query('select roles from app_users where discord_id = $1', [
        who[1],
      ]);
      return { ok: true, status: 200, json: async () => ({ roles: rows[0] ? rows[0].roles : [] }) };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  });
  // Publishing starts a build: here, nothing to start.
  contentPublish.setFetch(async () => ({ status: 204, text: async () => '' }));
});

async function board() {
  await permissions.saveRolePermissions([
    { roleId: 'r-board', roleName: 'Board', permissions: ['members', 'community'] },
  ]);
  return auth.upsertDiscordUser({ discordId: '900000001', name: 'Elisa', roles: ['r-board'] });
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

const roleCalls = () =>
  botCalls
    .filter((c) => /\/roles\//.test(c.url))
    .map((c) => `${c.method} ${c.url.replace(/^.*\/members\//, '')}`);

// A members sheet as Google exports it, with invented people.
const HEADER = [
  'Informazioni cronologiche',
  'Nome',
  'Cognome',
  'Indirizzo email ',
  'Sito o profilo professionale',
  'Paese in cui ti trovi attualmente',
  'Città in cui vivi attualmente',
  'Quali aree ti interessano di più?',
  'Come ti piacerebbe partecipare alla community?',
  'Programma di mentorship',
  'Eventi',
  'Seminari',
  'Consenso alla pubblicazione del profilo nella Community',
  'Stato',
];
const CONSENT =
  'Acconsento alla pubblicazione delle informazioni sopra indicate nella sezione "Community" del sito web.';
function csv(rows) {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}
const SHEET = csv([
  // Legacy (before approvals): in, published (before the consent question).
  [
    '01/05/2026 10.00.00',
    'Ada',
    'Uno',
    'ada@example.org',
    'https://ada.example',
    'Italia',
    'Italia',
    'AI governance e policy',
    '',
    'Coordinamento (o co-coordinamento)',
    '',
    '',
    '',
    '',
  ],
  // Approved, consented, stable in two groups, saltuaria in one.
  [
    '10/10/2026 10.00.00',
    'Bea',
    'Due',
    'bea@example.org',
    '',
    'Italia',
    'Milano',
    '',
    'Come membro organizzatore: voglio contribuire',
    'Partecipazione stabile',
    'Partecipazione saltuaria',
    'Partecipazione stabile',
    CONSENT,
    'Approvato',
  ],
  // Approved without consent: in, not published.
  [
    '11/10/2026 10.00.00',
    'Ciro',
    'Tre',
    'ciro@example.org',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'Approvato',
  ],
  // Not approved yet, and rejected: out.
  [
    '12/10/2026 10.00.00',
    'Dino',
    'Quattro',
    'dino@example.org',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    CONSENT,
    '',
  ],
  [
    '13/10/2026 10.00.00',
    'Eva',
    'Cinque',
    'eva@example.org',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    CONSENT,
    'Rifiutato',
  ],
]);

test('the eight working groups are there, each a Discord role; new ones need theirs', async () => {
  const user = await board();
  const groups = await community.listGroups();
  assert.deepEqual(
    groups.map((g) => g.id),
    [
      'mentorship',
      'governance-and-funding',
      'seminars',
      'technical',
      'education',
      'communications',
      'community',
      'events',
    ]
  );
  assert.equal(groups[0].discordRoleId, '1566885628547960922');

  await rejects(community.saveGroup(user, { titleEn: 'Policy', titleIt: 'Policy' }), 400);
  await rejects(
    community.saveGroup(user, {
      titleEn: 'Policy',
      titleIt: 'Policy',
      discordRoleId: '1566885628547960922',
    }),
    409
  );
  const { group } = await community.saveGroup(user, {
    titleEn: 'Policy research',
    titleIt: 'Ricerca sulle policy',
    discordRoleId: '1566899999999999999',
  });
  assert.equal(group.id, 'policy-research');
  assert.equal(group.position, 9);
  // Someone without `members` may not.
  const other = await auth.upsertDiscordUser({ discordId: '900000002', name: 'Sid', roles: [] });
  await rejects(
    community.saveGroup(other, { titleEn: 'X', titleIt: 'X', discordRoleId: '123456789' }),
    403
  );

  const ids = (await community.listGroups()).map((g) => g.id).reverse();
  await community.reorderGroups(user, ids);
  assert.equal((await community.listGroups())[0].id, 'policy-research');
  await rejects(community.reorderGroups(user, ids.slice(1)), 400);
});

test('the old sheet comes in after a preview: approved people, consent, the stable levels as tags', async () => {
  const user = await board();
  // Bea signed in here once: matched to her Discord account by email.
  await auth.upsertDiscordUser({
    discordId: '700000002',
    name: 'Bea D.',
    email: 'bea@example.org',
  });

  const preview = await community.importPreview(user, SHEET);
  assert.deepEqual(preview.counts, {
    people: 3,
    published: 2,
    tagged: 2,
    onDiscord: 1,
    already: 0,
  });
  const bea = preview.people.find((p) => p.name === 'Bea Due');
  assert.equal(bea.role, 'organizer');
  assert.deepEqual(bea.tags, [
    { group: 'mentorship', level: 'stable' },
    { group: 'seminars', level: 'stable' },
  ]);
  assert.equal(bea.discord.id, '700000002');
  assert.ok(!JSON.stringify(preview).includes('@example.org'));
  assert.equal((await community.listMembers(user)).members.length, 0);
  await rejects(community.importPreview(user, 'a,b\n1,2'), 400);

  const done = await community.importConfirm(user, SHEET);
  assert.deepEqual(done, { imported: 3, updated: 0, discordFailed: 0 });
  // Bea got her tags on Discord: her two groups given, the others taken away.
  const calls = roleCalls();
  assert.ok(calls.includes('PUT 700000002/roles/1566885628547960922'));
  assert.ok(calls.includes('PUT 700000002/roles/1566885852347633766'));
  assert.ok(calls.includes('DELETE 700000002/roles/1566887735308845169'));
  const listed = (await community.listMembers(user)).members;
  assert.deepEqual(
    listed.map((m) => [m.name, m.publish, m.groups.length]),
    [
      ['Ada Uno', true, 1],
      ['Bea Due', true, 2],
      ['Ciro Tre', false, 0],
    ]
  );
  assert.equal(listed[0].groups[0].level, 'coordination');
  // The details are encrypted in the database.
  const { rows } = await db.query('select details_encrypted from community_members');
  assert.ok(rows.every((r) => !r.details_encrypted.includes('Ada')));
  // Again: nobody twice.
  assert.deepEqual(await community.importConfirm(user, SHEET), {
    imported: 0,
    updated: 3,
    discordFailed: 0,
  });
});

test('tags are added, moved and removed for several people, and Discord follows', async () => {
  const user = await board();
  await auth.upsertDiscordUser({
    discordId: '700000002',
    name: 'Bea D.',
    email: 'bea@example.org',
  });
  await community.importConfirm(user, SHEET);
  const all = (await community.listMembers(user)).members;
  const ids = all.map((m) => m.id);
  botCalls = [];

  await community.setTags(user, { members: ids, action: 'add', group: 'events', level: 'stable' });
  assert.ok(roleCalls().includes('PUT 700000002/roles/1566887735308845169'));
  let now = (await community.listMembers(user)).members;
  assert.ok(now.every((m) => m.groups.some((g) => g.group === 'events')));

  botCalls = [];
  await community.setTags(user, { members: ids, action: 'move', group: 'events', to: 'community' });
  assert.ok(roleCalls().includes('DELETE 700000002/roles/1566887735308845169'));
  assert.ok(roleCalls().includes('PUT 700000002/roles/1566887710659051550'));
  now = (await community.listMembers(user)).members;
  assert.ok(now.every((m) => !m.groups.some((g) => g.group === 'events')));

  await community.setTags(user, { members: [ids[0]], action: 'remove', group: 'community' });
  await rejects(
    community.setTags(user, { members: ids, action: 'add', group: 'nope', level: 'stable' }),
    400
  );
  await rejects(
    community.setTags(user, { members: ids, action: 'add', group: 'events', level: 'boss' }),
    400
  );
  await rejects(community.setTags(user, { members: [], action: 'remove', group: 'events' }), 400);

  // Linking someone's Discord account gives them their tags there.
  const ciro = now.find((m) => m.name === 'Ciro Tre');
  botCalls = [];
  await community.updateMember(user, ciro.id, { discordId: '700000003', publish: true });
  assert.ok(roleCalls().includes('PUT 700000003/roles/1566887710659051550'));
  await rejects(community.updateMember(user, ciro.id, { discordId: '700000002' }), 409);

  // Removing a group takes its role from everyone in it; the role stays on Discord.
  botCalls = [];
  await community.deleteGroup(user, 'community');
  assert.ok(roleCalls().includes('DELETE 700000003/roles/1566887710659051550'));
  assert.ok(!(await community.listGroups()).some((g) => g.id === 'community'));
});

test('the site shows only what is published, and only who consented', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  // Never published: the site keeps its YAML.
  assert.deepEqual(await community.publicExport(), { live: false, groups: [], members: [] });
  assert.equal((await community.siteState()).live, false);
  const yaml = { last_updated: '2026-01-01', members: [{ id: 1, name: 'From the YAML' }] };
  assert.equal(communityBuild.members(yaml, await community.publicExport()), yaml);

  await community.publishSite(user);
  const out = await community.publicExport();
  assert.equal(out.live, true);
  assert.deepEqual(
    out.members.map((m) => [m.name, m.groups]),
    [
      ['Ada Uno', ['mentorship']],
      ['Bea Due', ['mentorship', 'seminars']],
    ]
  );
  assert.ok(!JSON.stringify(out).includes('Ciro'));
  assert.ok(!JSON.stringify(out).includes('@'));
  assert.equal(out.groups.length, 8);
  assert.deepEqual(communityBuild.members(yaml, out).members, out.members);
  assert.equal(communityBuild.community({ intro: 'x' }, out).working_groups.length, 8);
  assert.equal((await community.siteState()).pending, false);

  // A change is not online until published again.
  const ciro = (await community.listMembers(user)).members.find((m) => m.name === 'Ciro Tre');
  await community.updateMember(user, ciro.id, { publish: true });
  assert.equal((await community.siteState()).pending, true);
  assert.ok(!JSON.stringify(await community.publicExport()).includes('Ciro'));
  await community.publishSite(user);
  assert.ok(JSON.stringify(await community.publicExport()).includes('Ciro'));

  await community.unpublishSite(user);
  assert.equal((await community.publicExport()).live, false);
});

test('an application carries its tags; whoever approves can change them; joining applies them', async () => {
  const user = await board();
  const { id } = await members.createApplication(
    {
      name: 'Gaia Sei',
      email: 'gaia@example.org',
      requestedRole: 'organizer',
      tags: [
        { group: 'events', level: 'stable' },
        { group: 'seminars', level: 'coordination' },
        { group: 'nope', level: 'boss' },
      ],
      profile: 'https://gaia.example',
      location: 'Roma, Italia',
      publish: true,
    },
    { source: 'iscrizione' }
  );
  const [app] = (await members.listApplications(user)).applications;
  assert.deepEqual(app.tags, [
    { group: 'events', level: 'stable' },
    { group: 'seminars', level: 'coordination' },
  ]);
  // Approving with one tag changed; in dev mode the join link works at once.
  process.env.MEET_FAKE_MAIL = '1';
  await mail().saveSettings({
    host: 'smtp.x',
    port: 465,
    fromEmail: 'tech@ais4i.it',
    password: 'p',
  });
  await members.decide(
    user,
    id,
    { decision: 'approve', role: 'organizer', tags: [{ group: 'events', level: 'coordination' }] },
    { siteOrigin: 'https://x' }
  );
  const { rows } = await db.query('select * from member_applications where id = $1', [id]);
  // Who coordinates is set on Members: approving keeps everyone as taking part.
  assert.deepEqual(rows[0].tags, [{ group: 'events', level: 'stable' }]);

  // Joining (as Discord would: completeJoinDev stands in) puts her in the
  // community with her tags and publish consent.
  await db.query(`update member_applications set join_token = 'x' where id = $1`, [id]);
  const row = (await db.query('select * from member_applications where id = $1', [id])).rows[0];
  await members.joinCommunity(row, '700000009');
  const [gaia] = (await community.listMembers(user)).members;
  assert.equal(gaia.name, 'Gaia Sei');
  assert.equal(gaia.role, 'organizer');
  assert.equal(gaia.publish, true);
  assert.equal(gaia.location, 'Roma, Italia');
  assert.deepEqual(gaia.groups, [{ group: 'events', level: 'stable' }]);
  assert.ok(roleCalls().includes('PUT 700000009/roles/1566887735308845169'));
});

test('a participant asks to become an organizer; approving gives the role and the tags', async () => {
  const user = await board();
  const paolo = await auth.upsertDiscordUser({
    discordId: '700000010',
    name: 'Paolo',
    email: 'paolo@example.org',
    roles: ['111111'],
  });
  const orga = await auth.upsertDiscordUser({
    discordId: '700000011',
    name: 'Olga',
    roles: ['111111', '222222'],
  });
  assert.deepEqual(await members.upgradeState(paolo), { can: true, pending: false });
  assert.equal((await members.upgradeState(orga)).can, false);
  await rejects(members.requestUpgrade(orga, {}), 403);

  const schema = await members.upgradeSchema();
  assert.equal(schema.items[0].options.length, 8);
  await rejects(members.requestUpgrade(paolo, { hours: '4' }), 400);
  await members.requestUpgrade(paolo, {
    groups: { selected: ['technical', 'events'] },
    coordinate: { selected: ['events'] },
    hours: '6',
  });
  assert.deepEqual(await members.upgradeState(paolo), { can: false, pending: true });
  await rejects(
    members.requestUpgrade(paolo, { groups: { selected: ['events'] }, hours: '1' }),
    409
  );

  const [app] = (await members.listApplications(user)).applications;
  assert.equal(app.kind, 'upgrade');
  assert.deepEqual(app.tags, [
    { group: 'events', level: 'coordination' },
    { group: 'technical', level: 'stable' },
  ]);
  botCalls = [];
  await members.decide(user, app.id, { decision: 'approve' }, { siteOrigin: 'https://x' });
  assert.ok(roleCalls().includes('PUT 700000010/roles/222222'));
  assert.ok(roleCalls().includes('PUT 700000010/roles/1566885921062658079'));
  const [member] = (await community.listMembers(user)).members;
  assert.equal(member.role, 'organizer');
  assert.equal(member.groups.length, 2);
});

function mail() {
  return require('./mail');
}

test('the members board and the applications are given apart', async () => {
  await permissions.saveRolePermissions([
    { roleId: 'r-apps', roleName: 'Applications', permissions: ['members'] },
    { roleId: 'r-community', roleName: 'Community', permissions: ['community'] },
  ]);
  const apps = await auth.upsertDiscordUser({
    discordId: '900000009',
    name: 'Pia',
    roles: ['r-apps'],
  });
  const team = await auth.upsertDiscordUser({
    discordId: '900000008',
    name: 'Rea',
    roles: ['r-community'],
  });
  await rejects(community.listMembers(apps), 403);
  assert.ok((await members.listApplications(apps)).applications);
  assert.ok((await community.listMembers(team)).members);
  await rejects(members.listApplications(team), 403);
});

test('who held the applications before keeps the members board, once', async () => {
  const pg = new PGlite();
  db.setDb(pg);
  await db.query('select 1');
  // As on a database from before the split: the marker not there yet.
  await db.query(`delete from app_settings where key = 'migration_community_key'`);
  await db.query(
    `insert into content_role_permissions (role_id, role_name, permissions) values ('r-old', 'Old', '{members}')`
  );
  const roleOf = async () =>
    (await db.query(`select permissions from content_role_permissions where role_id = 'r-old'`))
      .rows[0].permissions;
  await pg.exec(require('./schema'));
  assert.deepEqual(await roleOf(), ['members', 'community']);
  // Taken away later, it stays away: the migration does not run again.
  await db.query(
    `update content_role_permissions set permissions = '{members}' where role_id = 'r-old'`
  );
  await pg.exec(require('./schema'));
  assert.deepEqual(await roleOf(), ['members']);
});
