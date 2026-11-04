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

// Applies every change waiting on Discord, as the Discord tab does.
async function applyAll(user, opts = {}) {
  let plan = await community.discordPlan(opts);
  let rounds = 0;
  const done = { done: 0, failed: 0 };
  let last = '';
  // Stops when nothing moves (a stand-in Discord that keeps no roles).
  while (plan.items.length && rounds++ < 20) {
    const ids = plan.items.map((i) => i.id);
    if (ids.join() === last) break;
    last = ids.join();
    const r = await community.applyDiscord(user, { items: ids, member: opts.memberId });
    done.done += r.done;
    done.failed += r.failed;
    if (!r.done) break;
    plan = await community.discordPlan(opts);
  }
  return done;
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
  assert.deepEqual(
    { ...preview.counts },
    {
      people: 3,
      new: 3,
      update: 0,
      conflict: 0,
      unchanged: 0,
      skip: 0,
      duplicates: 0,
      published: 2,
      tagged: 2,
      onDiscord: 1,
      byName: 0,
      already: 0,
    }
  );
  // The bot cannot read the server's list here: no matching by name.
  assert.equal(preview.byName, false);
  const bea = preview.people.find((p) => p.name === 'Bea Due');
  assert.equal(bea.role, 'organizer');
  assert.equal(bea.status, 'new');
  assert.deepEqual(bea.tags, [
    { group: 'mentorship', level: 'stable' },
    { group: 'seminars', level: 'stable' },
  ]);
  assert.deepEqual(bea.discord, { id: '700000002', name: 'Bea D.', by: 'email', taken: false });
  assert.ok(!JSON.stringify(preview).includes('@example.org'));
  assert.equal((await community.listMembers(user)).members.length, 0);
  await rejects(community.importPreview(user, 'a,b\n1,2'), 400);

  botCalls = [];
  const done = await community.importConfirm(user, SHEET);
  assert.deepEqual(done, {
    imported: 3,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    linked: 1,
  });
  // Importing sends nothing to Discord: the roles wait to be applied.
  assert.deepEqual(roleCalls(), []);
  // Her two tags, and Organizzatore: she has neither role there.
  const plan = await community.discordPlan();
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.op, i.reason]),
    [
      ['Bea Due', 'add', 'group'],
      ['Bea Due', 'add', 'group'],
      ['Bea Due', 'add', 'role'],
    ]
  );
  assert.deepEqual(await applyAll(user), { done: 3, failed: 0 });
  const calls = roleCalls();
  assert.ok(calls.includes('PUT 700000002/roles/222222'));
  assert.ok(calls.includes('PUT 700000002/roles/1566885628547960922'));
  assert.ok(calls.includes('PUT 700000002/roles/1566885852347633766'));
  assert.ok(!calls.some((c) => c.startsWith('DELETE')));
  const listed = (await community.listMembers(user)).members;
  assert.deepEqual(
    listed.map((m) => [m.name, m.publish, m.groups.length]),
    [
      ['Ada Uno', true, 1],
      ['Bea Due', true, 2],
      ['Ciro Tre', false, 0],
    ]
  );
  // "Coordinamento" on the sheet counts as taking part: coordinators are
  // chosen on Working groups.
  assert.equal(listed[0].groups[0].level, 'stable');
  // The details and the sheet's rows are encrypted in the database.
  const { rows } = await db.query('select details_encrypted from community_members');
  assert.ok(rows.every((r) => !r.details_encrypted.includes('Ada')));
  const { rows: kept } = await db.query('select answers_encrypted from member_sources');
  assert.equal(kept.length, 3);
  assert.ok(kept.every((r) => !r.answers_encrypted.includes('Ada')));
  // Again: nobody twice, nothing changed, no row kept twice.
  assert.deepEqual(await community.importConfirm(user, SHEET), {
    imported: 0,
    updated: 0,
    unchanged: 3,
    skipped: 0,
    conflicts: 0,
    linked: 0,
  });
  assert.equal((await db.query('select 1 from member_sources')).rows.length, 3);
});

test('tags are added, moved and removed for several people; Discord only when applied', async () => {
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
  // The tags say what Discord should have; Discord is not touched.
  assert.deepEqual(roleCalls(), []);
  let now = (await community.listMembers(user)).members;
  assert.ok(now.every((m) => m.groups.some((g) => g.group === 'events')));

  botCalls = [];
  await community.setTags(user, { members: ids, action: 'move', group: 'events', to: 'community' });
  assert.deepEqual(roleCalls(), []);
  now = (await community.listMembers(user)).members;
  assert.ok(now.every((m) => !m.groups.some((g) => g.group === 'events')));

  await community.setTags(user, { members: [ids[0]], action: 'remove', group: 'community' });
  await rejects(
    community.setTags(user, { members: ids, action: 'add', group: 'nope', level: 'stable' }),
    400
  );
  await rejects(community.setTags(user, { members: [], action: 'remove', group: 'events' }), 400);

  // Linking someone says who they are on Discord, and changes nothing there;
  // applying gives them the roles of their tags.
  const ciro = now.find((m) => m.name === 'Ciro Tre');
  botCalls = [];
  await community.updateMember(user, ciro.id, { discordId: '700000003', publish: true });
  assert.deepEqual(roleCalls(), []);
  await applyAll(user);
  assert.ok(roleCalls().includes('PUT 700000003/roles/1566887710659051550'));
  await rejects(community.updateMember(user, ciro.id, { discordId: '700000002' }), 409);

  // Removing a group changes nothing on Discord at once: its role is retired,
  // and taken off from whoever holds it when applied.
  botCalls = [];
  await community.deleteGroup(user, 'community');
  assert.deepEqual(roleCalls(), []);
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
  let site = await community.siteState();
  assert.deepEqual([site.members, site.groups, site.draft], [3, 8, { members: 3, groups: 8 }]);

  // Tags and working groups reach the site on the same update: the group's
  // members (about.njk) and the group itself (community.yaml).
  await community.setTags(user, {
    members: [ciro.id],
    action: 'add',
    group: 'events',
    level: 'stable',
  });
  const events = (await community.listGroups()).find((g) => g.id === 'events');
  await community.saveGroup(user, { ...events, titleEn: 'Events and meetups' });
  site = await community.siteState();
  assert.equal(site.pending, true);
  assert.equal(site.changes, 2);
  await community.publishSite(user);
  const after = await community.publicExport();
  assert.deepEqual(after.members.find((m) => m.name === 'Ciro Tre').groups, ['events']);
  assert.equal(after.groups.find((g) => g.id === 'events').title, 'Events and meetups');
  assert.equal(communityBuild.community({}, after).working_groups, after.groups);
  assert.equal(communityBuild.members(yaml, after).published_at, after.publishedAt);
  assert.equal((await community.siteState()).pending, false);

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
  // Coordination is not taken from an application: taking part in each.
  assert.deepEqual(app.tags, [
    { group: 'events', level: 'stable' },
    { group: 'seminars', level: 'stable' },
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
  // Who coordinates is set on Working groups: approving keeps everyone taking part.
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
  // The form no longer asks who would coordinate: taking part in each.
  assert.ok(!schema.items.some((i) => i.id === 'coordinate'));
  assert.deepEqual(app.tags, [
    { group: 'technical', level: 'stable' },
    { group: 'events', level: 'stable' },
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

// ── Linking to Discord, and roles against tags ──────────────────────────────

/**
 * A Discord server with these members ({ id, username, nick?, roles }): the
 * bot's search, list and member reads, and role changes that stick.
 */
function server(people) {
  permissions.setFetch(async (url, init = {}) => {
    const method = init.method || 'GET';
    botCalls.push({ url, method });
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    const asMember = (p) => ({
      user: { id: p.id, username: p.username, global_name: p.globalName || null, avatar: null },
      nick: p.nick || null,
      roles: p.roles,
    });
    const search = /\/members\/search\?limit=\d+&query=([^&]*)/.exec(url);
    if (search) {
      const q = decodeURIComponent(search[1]).toLowerCase();
      return json(
        people
          .filter((p) => [p.username, p.nick || ''].some((n) => n.toLowerCase().startsWith(q)))
          .map(asMember)
      );
    }
    if (/\/members\?limit=1000/.test(url)) return json(people.map(asMember));
    const role = /\/members\/(\d+)\/roles\/(\d+)$/.exec(url);
    if (role) {
      const p = people.find((x) => x.id === role[1]);
      if (p && method === 'PUT' && !p.roles.includes(role[2])) p.roles.push(role[2]);
      if (p && method === 'DELETE') p.roles = p.roles.filter((r) => r !== role[2]);
      return json({}, 204);
    }
    const one = /\/members\/(\d+)$/.exec(url);
    if (one) {
      const p = people.find((x) => x.id === one[1]);
      if (p) return json(asMember(p));
      // The team signed in here: their roles as stored, as the default stand-in.
      const { rows } = await db.query('select roles from app_users where discord_id = $1', [
        one[1],
      ]);
      return rows[0] ? json({ roles: rows[0].roles }) : json({ message: 'Unknown Member' }, 404);
    }
    return json({}, 204);
  });
}

const ROLE = {
  mentorship: '1566885628547960922',
  seminars: '1566885852347633766',
  events: '1566887735308845169',
  community: '1566887710659051550',
};

test('members not linked: their accounts suggested by name, linked, or marked not on Discord', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const people = [
    { id: '800000001', username: 'adauno', nick: 'Ada Uno', roles: [ROLE.events] },
    { id: '800000002', username: 'ada_other', roles: [] },
    { id: '800000003', username: 'bea.d', roles: [] },
  ];
  server(people);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno');

  const { suggestions } = await community.discordSuggestions(user, ada.id);
  assert.deepEqual(
    suggestions.map((a) => [a.discordId, a.score]),
    [
      ['800000001', 3],
      ['800000002', 1],
    ]
  );

  // Linking gives the roles of her tags and takes none away (events was given by hand).
  botCalls = [];
  const linked = await community.linkDiscord(user, ada.id, '800000001');
  assert.equal(linked.member.discordId, '800000001');
  assert.equal(linked.member.discordUsername, 'adauno');
  assert.equal(linked.member.discordName, 'Ada Uno');
  // Nothing changes on Discord: her hand-given role stays, none is added yet.
  assert.deepEqual(roleCalls(), []);
  assert.ok(people[0].roles.includes(ROLE.events));
  // Who she is on Discord is stored encrypted.
  const { rows } = await db.query(
    'select discord_info_encrypted from community_members where id = $1',
    [ada.id]
  );
  assert.ok(!rows[0].discord_info_encrypted.includes('adauno'));
  // Taken accounts are not suggested to anyone else, nor linked twice.
  const ciro = list.find((m) => m.name === 'Ciro Tre');
  await rejects(community.linkDiscord(user, ciro.id, '800000001'), 409);
  await rejects(community.linkDiscord(user, ciro.id, '899999999'), 404);

  // Ciro is not on Discord: checked, with a note; linked people cannot be.
  const marked = await community.markAbsent(user, ciro.id, {
    absent: true,
    note: 'left the server',
  });
  assert.equal(marked.member.discordAbsent, true);
  assert.equal(marked.member.discordNote, 'left the server');
  await rejects(community.markAbsent(user, ada.id, { absent: true }), 409);
  // Linking later clears the mark.
  const later = await community.linkDiscord(user, ciro.id, '800000002');
  assert.equal(later.member.discordAbsent, false);

  // Only the members board opens this.
  const apps = await auth.upsertDiscordUser({ discordId: '900000007', name: 'Uma', roles: [] });
  await rejects(community.discordSuggestions(apps, ada.id), 403);
});

test('roles on Discord against tags here: given, adopted, taken off, or left', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const bea = list.find((m) => m.name === 'Bea Due'); // organizer; tags: mentorship, seminars
  // On Discord: seminars and events, not mentorship.
  const people = [
    { id: '800000005', username: 'bea', roles: ['222222', ROLE.seminars, ROLE.events] },
  ];
  server(people);
  await community.linkDiscord(user, bea.id, '800000005');

  let plan = await community.discordPlan();
  assert.equal(plan.checked, 1);
  assert.deepEqual(
    plan.items.map((i) => [i.op, i.group]),
    [['add', 'mentorship']]
  );
  // Events there and no tag here: nobody on the board took it away, so it
  // is not taken off unasked: the team decides.
  assert.deepEqual(
    plan.decide.map((i) => [i.kind, i.group]),
    [['group', 'events']]
  );
  assert.deepEqual(plan.perMember, { [bea.id]: 2 });

  // The missing role applied; the extra one left as it is.
  await community.applyDiscord(user, { items: [plan.items[0].id] });
  assert.ok(people[0].roles.includes(ROLE.mentorship));
  await community.decideDiscord(user, { items: [plan.decide[0].id], choice: 'ignore' });
  plan = await community.discordPlan();
  assert.deepEqual([plan.items, plan.decide], [[], []]);

  // A role there adopted as a tag here.
  people[0].roles.push(ROLE.community);
  plan = await community.discordPlan();
  await community.decideDiscord(user, { items: [plan.decide[0].id], choice: 'tag' });
  const tags = (await community.listMembers(user)).members.find((m) => m.id === bea.id).groups;
  assert.ok(tags.some((t) => t.group === 'community' && t.level === 'stable'));

  // A tag taken away on the board: its role is queued to take off, and
  // goes when applied.
  botCalls = [];
  await community.setMemberGroups(user, bea.id, { groups: ['mentorship', 'community'] });
  assert.deepEqual(roleCalls(), []);
  plan = await community.discordPlan();
  assert.deepEqual(
    plan.items.map((i) => [i.op, i.group, i.reason]),
    [['remove', 'seminars', 'untagged']]
  );
  await applyAll(user);
  assert.ok(!people[0].roles.includes(ROLE.seminars));
  assert.equal((await db.query('select 1 from discord_removals')).rows.length, 0);
  await rejects(community.decideDiscord(user, { items: [plan.items[0].id], choice: 'x' }), 400);

  // Someone whose account left the server: unlinked here.
  people.length = 0;
  plan = await community.discordPlan();
  assert.deepEqual(
    plan.gone.map((g) => g.memberId),
    [bea.id]
  );
  await community.decideDiscord(user, { items: [plan.gone[0].id], choice: 'unlink' });
  const after = (await community.listMembers(user)).members.find((m) => m.id === bea.id);
  assert.equal(after.discordId, null);
});

test('a tag change leaves Discord as it is', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const ada = (await community.listMembers(user)).members.find((m) => m.name === 'Ada Uno');
  await db.query('update community_members set discord_id = $2 where id = $1', [
    ada.id,
    '800000009',
  ]);
  botCalls = [];
  await community.setTags(user, {
    members: [ada.id],
    action: 'add',
    group: 'events',
    level: 'stable',
  });
  assert.deepEqual(roleCalls(), []);
});

test('coordinators are chosen on Working groups only', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno'); // in mentorship, taking part
  const ciro = list.find((m) => m.name === 'Ciro Tre'); // in no group
  await db.query('update community_members set discord_id = $2 where id = $1', [
    ciro.id,
    '700000003',
  ]);

  let after = (
    await community.setCoordinator(user, { group: 'mentorship', member: ada.id, on: true })
  ).members;
  assert.deepEqual(after.find((m) => m.id === ada.id).groups, [
    { group: 'mentorship', level: 'coordination' },
  ]);
  // Someone not in the group is put in it; the role follows with "Give the roles".
  botCalls = [];
  after = (await community.setCoordinator(user, { group: 'events', member: ciro.id, on: true }))
    .members;
  assert.deepEqual(after.find((m) => m.id === ciro.id).groups, [
    { group: 'events', level: 'coordination' },
  ]);
  assert.deepEqual(roleCalls(), []);
  // Putting a coordinator in the group again from Members keeps them coordinating.
  await community.setTags(user, { members: [ada.id], action: 'add', group: 'mentorship' });
  after = (await community.listMembers(user)).members;
  assert.equal(after.find((m) => m.id === ada.id).groups[0].level, 'coordination');
  // Taken back: still in the group, taking part.
  after = (await community.setCoordinator(user, { group: 'mentorship', member: ada.id, on: false }))
    .members;
  assert.deepEqual(after.find((m) => m.id === ada.id).groups, [
    { group: 'mentorship', level: 'stable' },
  ]);
  await rejects(community.setCoordinator(user, { group: 'nope', member: ada.id, on: true }), 400);
});

test('the coordination declared before becomes taking part, once', async () => {
  const pg = new PGlite();
  db.setDb(pg);
  const user = await board();
  await community.importConfirm(user, SHEET);
  const ada = (await community.listMembers(user)).members.find((m) => m.name === 'Ada Uno');
  // As on a database from before: someone coordinating, the marker not there yet.
  await db.query(`update member_groups set level = 'coordination' where member_id = $1`, [ada.id]);
  await db.query(`delete from app_settings where key = 'migration_coordinators'`);
  await pg.exec(require('./schema'));
  const levelOf = async () =>
    (await db.query('select level from member_groups where member_id = $1', [ada.id])).rows[0]
      .level;
  assert.equal(await levelOf(), 'stable');
  // Chosen again on Working groups: it stays, the migration does not run again.
  await community.setCoordinator(user, { group: 'mentorship', member: ada.id, on: true });
  await pg.exec(require('./schema'));
  assert.equal(await levelOf(), 'coordination');
});

test('before importing, the sheet is matched to Discord by name, only when sure', async () => {
  const user = await board();
  server([
    // Ada: one account with her name, as display name.
    { id: '800000021', username: 'adauno', globalName: 'Ada Uno', roles: [] },
    // Bea: two accounts with her name, written two ways: neither is taken.
    { id: '800000022', username: 'bea.due', roles: [] },
    { id: '800000023', username: 'beadue', nick: 'Due Bea', roles: [] },
    // Ciro: the username, dots as spaces.
    { id: '800000024', username: 'ciro.tre', roles: [] },
  ]);
  // Ciro's account is already someone else's on the board.
  await db.query(
    `insert into community_members (id, person_key, discord_id, details_encrypted, source)
     values ('00000000-0000-4000-8000-000000000001', 'someone', '800000024', 'x', 'board')`
  );

  const preview = await community.importPreview(user, SHEET);
  assert.equal(preview.byName, true);
  const by = (name) => preview.people.find((p) => p.name === name).discord;
  assert.deepEqual(by('Ada Uno'), { id: '800000021', name: 'Ada Uno', by: 'name', taken: false });
  assert.equal(by('Bea Due'), null);
  assert.equal(by('Ciro Tre'), null);
  assert.equal(preview.counts.byName, 1);

  botCalls = [];
  const done = await community.importConfirm(user, SHEET);
  assert.equal(done.linked, 1);
  assert.deepEqual(roleCalls(), []);
  const ada = (await community.listMembers(user)).members.find((m) => m.name === 'Ada Uno');
  assert.equal(ada.discordId, '800000021');
  assert.equal(ada.discordUsername, 'adauno');
});

test('the changes go to Discord a few at a time, until none is left', async () => {
  const user = await board();
  const people = [];
  const rows = [];
  for (let i = 0; i < 12; i++) {
    people.push({
      id: String(810000000 + i),
      username: `p${i}`,
      nick: `Persona N${i}`,
      roles: ['111111'],
    });
    rows.push([
      '10/10/2026 10.00.00',
      'Persona',
      `N${i}`,
      `p${i}@example.org`,
      '',
      'Italia',
      'Roma',
      '',
      '',
      'Partecipazione stabile',
      '',
      'Partecipazione stabile',
      CONSENT,
      'Approvato',
    ]);
  }
  server(people);
  assert.equal((await community.importConfirm(user, csv(rows))).linked, 12);
  // 12 people, 2 tags each: 24 roles, 15 per call.
  const items = (await community.discordPlan()).items.map((i) => i.id);
  assert.equal(items.length, 24);
  const first = await community.applyDiscord(user, { items });
  assert.deepEqual(first, { done: 15, failed: 0, remaining: 9, skipped: 0 });
  // The same picks again: those already done are skipped.
  const second = await community.applyDiscord(user, { items });
  assert.deepEqual(second, { done: 9, failed: 0, remaining: 0, skipped: 15 });
  assert.ok(people.every((p) => p.roles.length === 3));
  await rejects(community.applyDiscord(user, { items: [] }), 400);
});

test('the preview says why it cannot match by name', async () => {
  const user = await board();
  // Discord refuses the list: the intent is off.
  permissions.setFetch(async (url, init = {}) => {
    botCalls.push({ url, method: init.method || 'GET' });
    if (/\/members\?limit=1000/.test(url))
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: 'Missing Access', code: 50001 }),
      };
    const { rows } = await db.query('select roles from app_users where discord_id = $1', [
      (/\/members\/(\d+)$/.exec(url) || [])[1] || '',
    ]);
    return { ok: true, status: 200, json: async () => ({ roles: rows[0] ? rows[0].roles : [] }) };
  });
  let preview = await community.importPreview(user, SHEET);
  assert.equal(preview.byName, false);
  assert.match(preview.byNameProblem, /Server Members Intent/);

  // No bot on this deployment at all.
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  preview = await community.importPreview(user, SHEET);
  assert.match(preview.byNameProblem, /not set up on this deployment/);

  // The list read: no problem.
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'bot';
  server([{ id: '800000031', username: 'adauno', globalName: 'Ada Uno', roles: [] }]);
  preview = await community.importPreview(user, SHEET);
  assert.equal(preview.byName, true);
  assert.equal(preview.byNameProblem, null);
});

test('the bar on top: accounts, Discord and website, in counts', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const bea = list.find((m) => m.name === 'Bea Due'); // tags: mentorship, seminars
  const ciro = list.find((m) => m.name === 'Ciro Tre');
  const people = [{ id: '800000041', username: 'bea', roles: ['222222', ROLE.events] }];
  server(people);
  await community.linkDiscord(user, bea.id, '800000041');
  await community.markAbsent(user, ciro.id, { absent: true });

  let s = await community.status(user);
  assert.deepEqual(s.accounts, { members: 3, linked: 1, absent: 1, toLink: 1 });
  assert.deepEqual(
    { ...s.discord, failed: undefined },
    {
      available: true,
      toApply: 2,
      toApplyMembers: 1,
      toDecide: 1,
      gone: 0,
      noRole: 0,
      failed: undefined,
      perMember: { [bea.id]: 3 },
    }
  );
  assert.equal(s.site.live, false);
  assert.ok(s.site.changes > 0);

  // Applied: the missing ones; the hand-given one stays to decide.
  await applyAll(user);
  s = await community.status(user);
  assert.equal(s.discord.toApply, 0);
  assert.equal(s.discord.toDecide, 1);

  // The website: up to date once updated, one change after a new tag.
  await community.publishSite(user);
  s = await community.status(user);
  assert.deepEqual([s.site.live, s.site.pending, s.site.changes], [true, false, 0]);
  assert.equal(s.site.perMember[bea.id], 'online');
  assert.equal(s.site.perMember[ciro.id], undefined); // not shown: no consent
  await community.setTags(user, { members: [ciro.id], action: 'add', group: 'events' });
  s = await community.status(user);
  assert.equal(s.site.pending, false); // Ciro is not shown on the site: no change there
  await community.setTags(user, { members: [bea.id], action: 'add', group: 'events' });
  s = await community.status(user);
  assert.deepEqual([s.site.pending, s.site.changes], [true, 1]);
  assert.equal(s.site.perMember[bea.id], 'changed');
  assert.deepEqual(s.site.diff.members, {
    added: [],
    removed: [],
    changed: [{ title: 'Bea Due', fields: ['groups'] }],
  });

  // Without the bot, Discord is not readable here, and the bar says so.
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  s = await community.status(user);
  assert.equal(s.discord.available, false);
  assert.match(s.discord.problem, /not set up/);
});

test('one member’s groups set by hand are saved here only; coordinators stay', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const ada = (await community.listMembers(user)).members.find((m) => m.name === 'Ada Uno');
  const people = [{ id: '800000009', username: 'ada', roles: ['111111'] }];
  server(people);
  await community.linkDiscord(user, ada.id, '800000009');
  await community.setMemberGroups(user, ada.id, { groups: ['events', 'mentorship'] });
  await community.setCoordinator(user, { group: 'mentorship', member: ada.id, on: true });
  await applyAll(user);
  const roleOf = new Map((await community.listGroups()).map((g) => [g.id, g.discordRoleId]));

  botCalls = [];
  const r = await community.setMemberGroups(user, ada.id, { groups: ['mentorship', 'community'] });
  assert.deepEqual([r.added, r.left, r.roleChanged], [['community'], ['events'], false]);
  assert.deepEqual(roleCalls(), []);
  const groups = Object.fromEntries(r.member.groups.map((g) => [g.group, g.level]));
  assert.deepEqual(groups, { mentorship: 'coordination', community: 'stable' });
  // Her page lists what waits on Discord; applying it from there.
  const page = await community.memberDetail(user, ada.id);
  assert.deepEqual(page.discord.items.map((i) => `${i.op} ${i.group}`).sort(), [
    'add community',
    'remove events',
  ]);
  await applyAll(user, { memberId: ada.id });
  assert.deepEqual(roleCalls().sort(), [
    `DELETE 800000009/roles/${roleOf.get('events')}`,
    `PUT 800000009/roles/${roleOf.get('community')}`,
  ]);

  await rejects(community.setMemberGroups(user, ada.id, { groups: ['nope'] }), 400);
  await rejects(community.setMemberGroups(user, ada.id, { groups: 'events' }), 400);
  await rejects(community.setMemberGroups(user, ada.id, { role: 'boss' }), 400);
});

test('the members come out as a CSV file, formulas kept as text', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const ada = (await community.listMembers(user)).members.find((m) => m.name === 'Ada Uno');
  await community.setMemberGroups(user, ada.id, { groups: ['events'] });
  await community.updateMember(user, ada.id, { areas: '=HYPERLINK("x")' });
  const { filename, csv } = await community.exportCsv(user);
  assert.match(filename, /^members-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv.slice(1).trim().split('\r\n');
  assert.match(lines[0], /^Name,Role,Working groups,Coordinates/);
  const row = lines.find((l) => l.startsWith('Ada Uno,'));
  assert.ok(row.includes('Events'), row);
  assert.ok(row.includes(`"'=HYPERLINK(""x"")"`), row);
  assert.equal(lines.length, (await community.listMembers(user)).members.length + 1);

  const outsider = await auth.upsertDiscordUser({ discordId: '900000077', name: 'Ugo' });
  await rejects(community.exportCsv(outsider), 403);
});

test('Partecipante and Organizzatore are checked like the groups’ roles', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno'); // participant
  const bea = list.find((m) => m.name === 'Bea Due'); // organizer
  const people = [
    { id: '800000051', username: 'ada', roles: [ROLE.mentorship] },
    { id: '800000052', username: 'bea', roles: ['111111', ROLE.mentorship, ROLE.seminars] },
  ];
  server(people);
  await community.linkDiscord(user, ada.id, '800000051');
  await community.linkDiscord(user, bea.id, '800000052');

  let plan = await community.discordPlan();
  const mainOf = (name) =>
    plan.items.filter((i) => i.name === name && i.reason === 'role').map((i) => [i.roleId, i.main]);
  assert.deepEqual(mainOf('Ada Uno'), [['111111', 'missing']]);
  assert.deepEqual(mainOf('Bea Due'), [['222222', 'differs']]);
  // The roles are named as on Discord (here, without its list: the board's names).
  assert.equal(plan.items.find((i) => i.name === 'Ada Uno').roleName, 'Partecipante');

  // Bea is a participant after all: the board follows Discord.
  const beaItem = plan.items.find((i) => i.name === 'Bea Due');
  await community.decideDiscord(user, { items: [beaItem.id], choice: 'here' });
  assert.equal(
    (await community.listMembers(user)).members.find((m) => m.id === bea.id).role,
    'participant'
  );
  // Ada's applied.
  await applyAll(user);
  assert.ok(people[0].roles.includes('111111'));

  // Made an organizer on her page: Organizzatore waits; applied, it is given.
  botCalls = [];
  await community.setMemberGroups(user, bea.id, { role: 'organizer' });
  assert.deepEqual(roleCalls(), []);
  await applyAll(user);
  assert.deepEqual(roleCalls(), ['PUT 800000052/roles/222222']);
  // And back: Organizzatore queued to take off (Partecipante she has).
  botCalls = [];
  await community.setMemberGroups(user, bea.id, { role: 'participant' });
  plan = await community.discordPlan();
  assert.deepEqual(
    plan.items.map((i) => [i.op, i.roleId, i.reason]),
    [['remove', '222222', 'role']]
  );
  await applyAll(user);
  assert.deepEqual(roleCalls(), ['DELETE 800000052/roles/222222']);

  // Organizzatore given by hand on Discord to a participant: to decide, not
  // taken off unasked; left as it is, it is not listed again.
  people[0].roles.push('222222');
  plan = await community.discordPlan();
  assert.deepEqual(
    plan.decide.map((i) => [i.name, i.kind]),
    [['Ada Uno', 'main']]
  );
  await community.decideDiscord(user, { items: [plan.decide[0].id], choice: 'ignore' });
  assert.deepEqual((await community.discordPlan()).decide, []);
});

test('people on the server with no role: put on the board, or left', async () => {
  const user = await board();
  const people = [
    { id: '800000061', username: 'gino', nick: 'Gino', roles: [] },
    { id: '800000062', username: 'lia', nick: 'Lia', roles: [ROLE.events] },
    { id: '800000063', username: 'max', nick: 'Max', roles: [] },
    { id: '800000064', username: 'nora', nick: 'Nora', roles: ['111111'] },
  ];
  server(people);
  let plan = await community.discordPlan();
  assert.deepEqual(
    plan.noRole.map((p) => p.username),
    ['gino', 'lia', 'max']
  );
  assert.equal((await community.status(user)).discord.noRole, 3);

  // Put on the board as participants: here only; their role then waits.
  botCalls = [];
  const r = await community.decideDiscord(user, {
    items: ['norole:800000061', 'norole:800000062'],
    choice: 'participant',
  });
  assert.equal(r.done, 2);
  assert.deepEqual(roleCalls(), []);
  const members = (await community.listMembers(user)).members;
  const gino = members.find((m) => m.discordId === '800000061');
  assert.deepEqual([gino.name, gino.role, gino.publish], ['Gino', 'participant', false]);
  plan = await community.discordPlan();
  assert.equal(plan.items.filter((i) => i.roleId === '111111').length, 2);
  await applyAll(user);
  assert.ok(people[0].roles.includes('111111'));

  await community.decideDiscord(user, { items: ['norole:800000063'], choice: 'ignore' });
  plan = await community.discordPlan();
  assert.deepEqual(plan.noRole, []);
  // Left as they are, and listed again when undone.
  const { ignored } = await community.ignoredList(user);
  assert.deepEqual(
    ignored.map((i) => i.id),
    ['ok-norole:800000063']
  );
  await community.unignore(user, { ids: ['ok-norole:800000063'] });
  assert.deepEqual(
    (await community.discordPlan()).noRole.map((p) => p.username),
    ['max']
  );

  await rejects(community.decideDiscord(user, { items: ['norole:x'], choice: 'participant' }), 400);
  await rejects(community.decideDiscord(user, { items: ['norole:800000063'], choice: 'x' }), 400);
  const outsider = await auth.upsertDiscordUser({ discordId: '900000078', name: 'Ugo' });
  await rejects(
    community.decideDiscord(outsider, { items: ['norole:800000063'], choice: 'ignore' }),
    403
  );
});

test('roles set for several at once wait for Discord; an organizer’s waiting request closes', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno');
  const ciro = list.find((m) => m.name === 'Ciro Tre');
  const people = [
    { id: '800000071', username: 'ada', roles: ['111111'] },
    { id: '800000073', username: 'ciro', roles: ['111111'] },
  ];
  server(people);
  await community.linkDiscord(user, ada.id, '800000071');
  await community.linkDiscord(user, ciro.id, '800000073');
  // Ada asked to become an organizer, from the dashboard.
  const adaUser = await auth.upsertDiscordUser({
    discordId: '800000071',
    name: 'Ada',
    roles: ['111111'],
  });
  await members.requestUpgrade(adaUser, { groups: { selected: ['events'] }, hours: '3' });

  botCalls = [];
  const r = await community.setRoles(user, { members: [ada.id, ciro.id], role: 'organizer' });
  assert.ok(r.members.every((m) => m.role === 'organizer'));
  assert.deepEqual(roleCalls(), []);
  // Her request is approved with it: Applications says what the board says.
  const [app] = (await members.listApplications(user)).applications;
  assert.deepEqual([app.kind, app.status, app.role], ['upgrade', 'approved', 'organizer']);
  assert.equal(app.memberId, ada.id);
  await applyAll(user);
  assert.ok(people.every((p) => p.roles.includes('222222')));

  // Back to participant: Organizzatore taken off when applied.
  await community.setRoles(user, { members: [ciro.id], role: 'participant' });
  await applyAll(user);
  assert.ok(!people[1].roles.includes('222222'));
  await rejects(community.setRoles(user, { members: [ciro.id], role: 'boss' }), 400);
  await rejects(community.setRoles(user, { members: [], role: 'participant' }), 400);
});

test('members matched again when sure, then every change applied from the board', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno'); // participant, tag mentorship
  const bea = list.find((m) => m.name === 'Bea Due'); // organizer, linked by email on import
  const ciro = list.find((m) => m.name === 'Ciro Tre'); // participant, no tags
  await community.linkDiscord(user, bea.id, null);
  const people = [
    // Ada: her full name as a nickname, one account only; the other role.
    { id: '800000091', username: 'ada', nick: 'Ada Uno', roles: ['222222', ROLE.events] },
    // Bea signed in here with her email: matched by email.
    { id: '700000002', username: 'bea', roles: ['111111'] },
    // Two accounts with Ciro's name: not sure, left to link by hand.
    { id: '800000093', username: 'ciro1', nick: 'Ciro Tre', roles: [] },
    { id: '800000094', username: 'ciro2', nick: 'Ciro Tre', roles: [] },
  ];
  server(people);
  await auth.upsertDiscordUser({
    discordId: '700000002',
    name: 'Bea D.',
    email: 'bea@example.org',
  });

  const m = await community.rematch(user);
  assert.deepEqual(
    { linked: m.linked, byEmail: m.byEmail, byName: m.byName, left: m.left },
    { linked: 2, byEmail: 1, byName: 1, left: 1 }
  );
  const now = (await community.listMembers(user)).members;
  assert.equal(now.find((x) => x.id === ada.id).discordId, '800000091');
  assert.equal(now.find((x) => x.id === ciro.id).discordId, null);

  // What the board says goes when applied; what Discord has beyond it waits
  // for a choice: Ada's Organizzatore and Events.
  const r = await applyAll(user);
  assert.equal(r.failed, 0);
  assert.ok(people[0].roles.includes(ROLE.mentorship));
  assert.ok(people[1].roles.includes('222222'));
  assert.ok(people[1].roles.includes(ROLE.mentorship) && people[1].roles.includes(ROLE.seminars));
  let plan = await community.discordPlan();
  assert.deepEqual(
    plan.decide.map((i) => [i.name, i.kind, i.group || null]),
    [
      ['Ada Uno', 'group', 'events'],
      ['Ada Uno', 'main', null],
    ]
  );
  // Taken off: queued, then applied.
  await community.decideDiscord(user, { items: plan.decide.map((i) => i.id), choice: 'remove' });
  plan = await community.discordPlan();
  assert.deepEqual(plan.decide, []);
  // Events and Organizzatore off, Partecipante on.
  assert.deepEqual(plan.items.map((i) => `${i.op} ${i.roleName}`).sort(), [
    'add Partecipante',
    'remove Eventi',
    'remove Organizzatore',
  ]);
  await applyAll(user);
  assert.deepEqual(people[0].roles.sort(), ['111111', ROLE.mentorship].sort());
  plan = await community.discordPlan();
  assert.deepEqual([plan.items, plan.decide], [[], []]);
});

// ── Data from several sources, merged (server/member-merge.js) ──────────────

const merge = require('./member-merge');

test('the merge rules: gaps filled, newer answers taken, the board kept, nothing lowered', () => {
  const row = {
    role: 'organizer',
    publish: true,
    discord_id: null,
    joined_on: '2026-05-01',
    updated_at: '2026-06-01T00:00:00Z',
    field_sources: {
      location: { source: 'board', at: '2026-07-01T00:00:00Z' },
      areas: { source: 'sheet', at: '2026-05-01T00:00:00Z' },
    },
  };
  const current = {
    row,
    details: { name: 'Ada Uno', profile: '', location: 'Roma', areas: 'Alignment' },
    groups: ['events'],
  };
  const incoming = {
    source: 'sheet',
    at: '2026-08-01T00:00:00Z',
    details: { name: 'Ada Uno', profile: 'https://ada', location: 'Milano', areas: 'Policy' },
    role: 'participant',
    publish: false,
    groups: ['events', 'seminars'],
    discordId: '800000001',
    joinedOn: '2026-04-01',
  };
  const c = merge.compare(current, incoming);
  // The gap, and consent: the newer answer says no, the yes there is older
  // and nobody's on the board.
  assert.deepEqual(c.set, { profile: 'https://ada', publish: false });
  assert.deepEqual(
    c.conflicts.map((x) => x.field),
    ['location', 'areas'] // the board's, and an older import's: newer here, shown
  );
  assert.deepEqual(c.groups, ['seminars']); // only added
  assert.equal(c.discordId, '800000001');
  assert.equal(c.joinedOn, '2026-04-01'); // the earliest
  assert.equal(c.set.role, undefined); // never lowered
  const taken = merge.takeConflicts(c, ['areas']);
  assert.equal(taken.set.areas, 'Policy');
  assert.deepEqual(
    taken.conflicts.map((x) => x.field),
    ['location']
  );
  // An application (nobody previews it) takes what is not the board's.
  const auto = merge.compare(current, { ...incoming, source: 'application' }, { auto: true });
  assert.equal(auto.set.areas, 'Policy');
  assert.equal(auto.set.location, undefined);
  assert.ok(auto.kept.includes('location'));
  // An older answer changes nothing it disagrees with.
  const old = merge.compare(current, { ...incoming, at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(old.conflicts, []);
  assert.ok(old.kept.includes('location') && old.kept.includes('areas'));
  // The board set the groups after this answer: none added.
  const later = { ...row, field_sources: { groups: { source: 'board', at: '2026-09-01' } } };
  assert.deepEqual(merge.compare({ ...current, row: later }, incoming).groups, []);
  // An account someone else has is flagged, not taken.
  const t = merge.compare(current, incoming, { discordTaken: true });
  assert.deepEqual([t.discordId, t.discordTaken], [null, true]);
});

test('the old sheet again, after changes on the board: gaps filled, the board kept, conflicts asked', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  const ada = list.find((m) => m.name === 'Ada Uno');
  const bea = list.find((m) => m.name === 'Bea Due');
  const ciro = list.find((m) => m.name === 'Ciro Tre');
  // On the board: Ada's place changed, Bea out of seminars, Ciro made hidden.
  await community.updateMember(user, ada.id, { location: 'Torino' });
  await community.setMemberGroups(user, bea.id, { groups: ['mentorship'] });
  // As if Ada's place was changed on the board before her newer answer below.
  await db.query(
    `update community_members set field_sources = field_sources ||
       '{"location": {"source": "board", "at": "2026-10-15T00:00:00.000Z"}}' where id = $1`,
    [ada.id]
  );

  // The same sheet: nothing changes, the board's choices stay.
  let preview = await community.importPreview(user, SHEET);
  assert.deepEqual(
    preview.people.map((p) => [p.name, p.status]),
    [
      ['Ada Uno', 'unchanged'],
      ['Bea Due', 'unchanged'],
      ['Ciro Tre', 'unchanged'],
    ]
  );
  await community.importConfirm(user, SHEET);
  let now = (await community.listMembers(user)).members;
  assert.equal(now.find((m) => m.id === ada.id).location, 'Torino');
  assert.deepEqual(
    now.find((m) => m.id === bea.id).groups.map((g) => g.group),
    ['mentorship']
  );

  // A newer export: Ada answered again from Napoli, with a profile; Ciro
  // added his city; and someone new.
  const NEWER = csv([
    [
      '20/10/2026 10.00.00',
      'Ada',
      'Uno',
      'ada@example.org',
      'https://ada.example',
      'Italia',
      'Napoli',
      'AI governance e policy',
      '',
      'Coordinamento (o co-coordinamento)',
      '',
      '',
      '',
      'Approvato',
    ],
    [
      '21/10/2026 10.00.00',
      'Ciro',
      'Tre',
      'ciro@example.org',
      '',
      'Italia',
      'Bari',
      '',
      '',
      '',
      '',
      '',
      '',
      'Approvato',
    ],
    [
      '22/10/2026 10.00.00',
      'Fede',
      'Sette',
      'fede@example.org',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      CONSENT,
      'Approvato',
    ],
  ]);
  preview = await community.importPreview(user, NEWER);
  const by = (n) => preview.people.find((p) => p.name === n);
  // Ada: her place was set on the board: a conflict, kept unless taken.
  assert.equal(by('Ada Uno').status, 'conflict');
  assert.deepEqual(
    by('Ada Uno').conflicts.map((c) => [c.field, c.here, c.there]),
    [['location', 'Torino', 'Napoli, Italia']]
  );
  // Ciro: a gap filled.
  assert.deepEqual([by('Ciro Tre').status, by('Ciro Tre').fill], ['update', ['Place']]);
  assert.equal(by('Fede Sette').status, 'new');
  assert.equal(preview.counts.conflict, 1);

  // Imported without deciding: the board's place stays.
  let done = await community.importConfirm(user, NEWER);
  assert.deepEqual([done.imported, done.updated, done.conflicts], [1, 2, 1]);
  now = (await community.listMembers(user)).members;
  assert.equal(now.find((m) => m.id === ada.id).location, 'Torino');
  assert.equal(now.find((m) => m.id === ciro.id).location, 'Bari, Italia');
  // Decided: the sheet's taken.
  preview = await community.importPreview(user, NEWER);
  const key = preview.people.find((p) => p.name === 'Ada Uno').key;
  done = await community.importConfirm(user, NEWER, { [key]: { take: ['location'] } });
  assert.equal(done.conflicts, 0);
  now = (await community.listMembers(user)).members;
  assert.equal(now.find((m) => m.id === ada.id).location, 'Napoli, Italia');
  // Every answer kept on the member, once each: Ada's two rows.
  const page = await community.memberDetail(user, ada.id);
  assert.equal(page.sources.length, 2);
  assert.ok(page.sources[1].answers.some((a) => a.value === 'Napoli'));
  // The history says what happened to her.
  const actions = page.history.map((h) => h.action);
  assert.ok(actions.includes('community-import'));
  assert.ok(actions.includes('community-member'));
});

test('a name only is never enough: a possible duplicate is asked', async () => {
  const user = await board();
  // Someone added from Discord (no email): Ada, by her nickname.
  const people = [{ id: '800000101', username: 'ada', nick: 'Ada Uno', roles: [] }];
  server(people);
  await community.decideDiscord(user, { items: ['norole:800000101'], choice: 'participant' });
  // Not the server's list on import (so no Discord match): only her name.
  permissions.setFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  let preview = await community.importPreview(user, SHEET);
  const ada = preview.people.find((p) => p.name === 'Ada Uno');
  // Without an email of her own, the one there is surely her: merged by default.
  assert.equal(ada.duplicate, 'merge');
  assert.equal(ada.duplicateOf.hasEmail, false);
  // Kept apart if the team says so.
  preview = await community.importPreview(user, SHEET, { [ada.key]: { duplicate: 'skip' } });
  assert.equal(preview.people.find((p) => p.name === 'Ada Uno').status, 'skip');
  await community.importConfirm(user, SHEET);
  const list = (await community.listMembers(user)).members;
  assert.equal(list.filter((m) => m.name === 'Ada Uno').length, 1);
  const merged = list.find((m) => m.name === 'Ada Uno');
  assert.equal(merged.discordId, '800000101');
  assert.equal(merged.publish, true); // her consent on the sheet
});

test('an application never lowers a role nor overwrites the board', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const bea = (await community.listMembers(user)).members.find((m) => m.name === 'Bea Due');
  await community.updateMember(user, bea.id, { location: 'Firenze' });
  // Bea applies again, as a participant, from elsewhere.
  await community.fromApplication({
    email: 'bea@example.org',
    name: 'Bea Due',
    location: 'Genova',
    profile: 'https://bea.example',
    role: 'participant',
    tags: [{ group: 'events', level: 'stable' }],
    at: new Date(),
  });
  const after = (await community.listMembers(user)).members.find((m) => m.id === bea.id);
  assert.equal(after.role, 'organizer');
  assert.equal(after.location, 'Firenze');
  assert.equal(after.profile, 'https://bea.example');
  assert.deepEqual(after.groups.map((g) => g.group).sort(), ['events', 'mentorship', 'seminars']);
  // Logged as automatic.
  const { history } = await community.memberDetail(user, bea.id);
  const auto = history.find((h) => h.userName === 'Automatic (join link)');
  assert.deepEqual(auto.detail.kept, ['location']);
});

test('a group removed or given another role: its old role listed to take off', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const bea = (await community.listMembers(user)).members.find((m) => m.name === 'Bea Due');
  const people = [
    { id: '800000111', username: 'bea', roles: ['222222', ROLE.mentorship, ROLE.seminars] },
  ];
  server(people);
  await community.linkDiscord(user, bea.id, '800000111');
  assert.deepEqual((await community.discordPlan()).items, []);

  // Seminars gets another role: the old one to take off, the new one to give.
  const seminars = (await community.listGroups()).find((g) => g.id === 'seminars');
  botCalls = [];
  await community.saveGroup(user, { ...seminars, discordRoleId: '1566885852347630000' });
  assert.deepEqual(roleCalls(), []);
  let plan = await community.discordPlan();
  assert.deepEqual(
    plan.items.map((i) => [i.op, i.roleId, i.reason]),
    [
      ['add', '1566885852347630000', 'group'],
      ['remove', ROLE.seminars, 'retired'],
    ]
  );
  // Mentorship removed: its role retired.
  await community.deleteGroup(user, 'mentorship');
  plan = await community.discordPlan();
  assert.ok(plan.items.some((i) => i.roleId === ROLE.mentorship && i.reason === 'retired'));
  await applyAll(user);
  assert.deepEqual(people[0].roles.sort(), ['1566885852347630000', '222222'].sort());
  assert.deepEqual((await community.discordPlan()).items, []);
});

test('a member’s page: their answers, their applications, what waits, their history', async () => {
  const user = await board();
  const { id } = await members.createApplication(
    { name: 'Gaia Sei', email: 'gaia@example.org', answers: [{ label: 'Why?', value: 'Safety' }] },
    { source: 'iscrizione' }
  );
  await mail().saveSettings({
    host: 'smtp.x',
    port: 465,
    fromEmail: 'tech@ais4i.it',
    password: 'p',
  });
  await members.decide(
    user,
    id,
    { decision: 'approve', role: 'participant' },
    { siteOrigin: 'https://x' }
  );
  // Approved, not joined yet: the board lists her as invited.
  let list = await community.listMembers(user);
  assert.deepEqual(
    list.invited.map((i) => i.name),
    ['Gaia Sei']
  );
  assert.equal(list.applications, true);
  await db.query('update member_applications set joined_at = now() where id = $1', [id]);
  const row = (await db.query('select * from member_applications where id = $1', [id])).rows[0];
  await members.joinCommunity(row, '700000021');
  list = await community.listMembers(user);
  assert.deepEqual(list.invited, []);
  const gaia = list.members[0];
  const page = await community.memberDetail(user, gaia.id);
  assert.deepEqual(
    page.applications.map((a) => [a.kind, a.status, a.answers[0].value]),
    [['join', 'approved', 'Safety']]
  );
  assert.ok(!JSON.stringify(page.applications).includes('gaia@example.org'));
  assert.equal(page.site.status, 'hidden');
  assert.deepEqual(
    page.history.map((h) => h.action),
    ['community-member', 'member-decide']
  );
  assert.ok(page.roles.some((r) => r.key === 'participant'));
  // Viewing is on the audit trail, not in her history.
  const { rows } = await db.query(
    `select 1 from crm_audit where subject_key = $1 and detail->>'action' = 'view'`,
    [gaia.id]
  );
  assert.equal(rows.length, 1);
  // Applications links to her page.
  const [app] = (await members.listApplications(user)).applications;
  assert.equal(app.memberId, gaia.id);
  const outsider = await auth.upsertDiscordUser({ discordId: '900000079', name: 'Ugo' });
  await rejects(community.memberDetail(outsider, gaia.id), 403);
});

test('a difference left as it is can be listed again', async () => {
  const user = await board();
  await community.importConfirm(user, SHEET);
  const bea = (await community.listMembers(user)).members.find((m) => m.name === 'Bea Due');
  const people = [{ id: '800000121', username: 'bea', roles: ['222222', ROLE.mentorship] }];
  server(people);
  await community.linkDiscord(user, bea.id, '800000121');
  let plan = await community.discordPlan();
  const seminars = plan.items.find((i) => i.group === 'seminars');
  await community.decideDiscord(user, { items: [seminars.id], choice: 'ignore' });
  assert.deepEqual((await community.discordPlan()).items, []);
  const { ignored } = await community.ignoredList(user);
  assert.deepEqual(
    ignored.map((i) => [i.kind, i.name, i.group]),
    [['group-missing', 'Bea Due', 'seminars']]
  );
  await community.unignore(user, { ids: [ignored[0].id] });
  plan = await community.discordPlan();
  assert.deepEqual(
    plan.items.map((i) => i.group),
    ['seminars']
  );
  await rejects(community.unignore(user, { ids: ['ok-group:x:y:z'] }), 400);
});
