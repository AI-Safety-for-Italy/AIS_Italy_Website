// Tests for the local groups (server/local-groups.js): the board with its
// leads kept encrypted, the site part that never sees them, publishing the
// map, and the build taking the published cities over community.yaml's.
// On invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const localGroups = require('./local-groups');
const localGroupsBuild = require('./local-groups-build');
const contentPublish = require('./content-publish');
const contentApi = require('../api/content');

beforeEach(async () => {
  await testDb.fresh();
  Object.assign(process.env, {
    CRM_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CRM_KEY_SECRET: 'a-local-groups-secret-of-at-least-thirty-two-chars',
  });
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.CONTENT_BUILD_TOKEN;
  delete process.env.MEET_DEV_LOGIN;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
  contentPublish.setFetch(async () => ({ status: 204, text: async () => '' }));
});

// The roles' table is saved whole: each person's role joins those before.
let roles;
beforeEach(() => {
  roles = [];
});
async function person(name, keys) {
  const roleId = `r-${name.toLowerCase()}`;
  roles.push({ roleId, roleName: name, permissions: keys });
  await permissions.saveRolePermissions(roles);
  const id = String(900000000 + Math.floor(Math.random() * 99999));
  return auth.upsertDiscordUser({ discordId: id, name, roles: [roleId] });
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

const LEADS = [{ name: 'Carla Invent', email: 'Carla@example.org', phone: '+39 333 000 0000' }];

test('the board starts with the cities of community.yaml, on the map where they are', async () => {
  const board = await person('Board', ['local_groups']);
  const { groups, statuses } = await localGroups.listBoard(board);
  assert.deepEqual(
    groups.map((g) => g.city),
    ['Genova', 'Milano', 'Padova', 'Torino', 'Trento', 'Trieste', 'Udine']
  );
  assert.ok(groups.every((g) => g.status === 'active' && g.onSite && !g.leads.length));
  assert.deepEqual(
    statuses.map((s) => s.key),
    ['starting', 'active', 'paused']
  );
});

test('a group keeps its leads and WhatsApp link encrypted, for the board only', async () => {
  const board = await person('Board', ['local_groups']);
  const { group } = await localGroups.saveGroup(board, {
    city: 'Bologna',
    leads: LEADS.concat([{ name: '', email: '', phone: '' }]),
    whatsapp: 'https://chat.whatsapp.com/InventedInvite',
    notes: 'Meets at the library',
  });
  assert.equal(group.status, 'starting');
  assert.deepEqual(group.leads, [
    { name: 'Carla Invent', email: 'carla@example.org', phone: '+39 333 000 0000' },
  ]);
  assert.equal(group.whatsapp, 'https://chat.whatsapp.com/InventedInvite');
  const { rows } = await db.query('select * from local_groups where id = $1', [group.id]);
  assert.ok(!JSON.stringify(rows[0]).includes('example.org'));
  assert.ok(!JSON.stringify(rows[0]).includes('InventedInvite'));

  // Site content → Local groups sees the city, never who leads it.
  const editor = await person('Editor', ['local_groups_site']);
  const site = await localGroups.listSite(editor);
  const text = JSON.stringify(site);
  assert.ok(text.includes('Bologna'));
  assert.ok(!text.includes('Carla') && !text.includes('InventedInvite'));
  // …and holding that key opens nothing of the board.
  await rejects(localGroups.listBoard(editor), 403);
  await rejects(localGroups.saveGroup(editor, { city: 'Bari' }), 403);
  await rejects(localGroups.listSite(board), 403);
});

test('the board refuses what would not do', async () => {
  const board = await person('Board', ['local_groups']);
  await rejects(localGroups.saveGroup(board, { city: '' }), 400);
  await rejects(localGroups.saveGroup(board, { city: 'milano' }), 409);
  await rejects(localGroups.saveGroup(board, { city: 'Bari', status: 'gone' }), 400);
  await rejects(
    localGroups.saveGroup(board, { city: 'Bari', whatsapp: 'javascript:alert(1)' }),
    400
  );
  await rejects(localGroups.saveGroup(board, { city: 'Bari', leads: [{ email: 'a@b.it' }] }), 400);
  await rejects(
    localGroups.saveGroup(board, { city: 'Bari', leads: [{ name: 'X', email: 'nope' }] }),
    400
  );
});

test('moving, changing and removing a group', async () => {
  const board = await person('Board', ['local_groups']);
  const { group } = await localGroups.saveGroup(board, { city: 'Bari', leads: LEADS });
  assert.equal((await localGroups.setStatus(board, group.id, 'paused')).group.status, 'paused');
  await rejects(localGroups.setStatus(board, group.id, 'nope'), 400);
  const changed = await localGroups.saveGroup(
    board,
    { city: 'Bari', status: 'active', leads: [] },
    group.id
  );
  assert.deepEqual(changed.group.leads, []);
  assert.equal(changed.group.updatedBy, 'Board');
  await localGroups.deleteGroup(board, group.id);
  await rejects(localGroups.deleteGroup(board, group.id), 404);
  const { rows } = await db.query(
    "select detail from crm_audit where action = 'local-groups-edit' order by id"
  );
  // The trail says what was done, never who leads it.
  assert.ok(!JSON.stringify(rows).includes('Carla'));
  assert.equal(rows.length, 4);
});

test('publishing the map: the cities ticked, with their pin and link, reach the build', async () => {
  const board = await person('Board', ['local_groups']);
  const editor = await person('Editor', ['local_groups_site']);
  const { group: bologna } = await localGroups.saveGroup(board, { city: 'Bologna' });

  // Never published: the YAML is the site, and the public answer says so.
  assert.deepEqual(await localGroups.publicExport(), { live: false, cities: [] });
  const before = await localGroups.listSite(editor);
  assert.equal(before.site.live, false);

  const groups = before.groups.map((g) => ({
    id: g.id,
    show: g.city !== 'Udine' && g.city !== 'Bologna',
    link: g.city === 'Milano' ? 'https://chat.whatsapp.com/Invented' : '',
    x: g.x,
    y: g.y,
  }));
  // A city shown needs its pin.
  await rejects(
    localGroups.publishSite(editor, {
      groups: groups.map((g) => (g.id === bologna.id ? { ...g, show: true } : g)),
    }),
    400
  );
  await rejects(
    localGroups.publishSite(editor, {
      groups: groups.map((g) => (g.id === bologna.id ? { ...g, show: true, x: 900, y: 1 } : g)),
    }),
    400
  );
  await rejects(
    localGroups.publishSite(editor, {
      groups: groups.map((g) => (g.id === bologna.id ? { ...g, link: 'ftp://x.it' } : g)),
    }),
    400
  );
  await rejects(localGroups.publishSite(board, { groups }), 403);

  const r = await localGroups.publishSite(editor, {
    groups: groups.map((g) => (g.id === bologna.id ? { ...g, show: true, x: 166, y: 190.04 } : g)),
  });
  assert.equal(r.site.live, true);
  assert.equal(r.site.pending, false);

  const res = {
    headers: {},
    setHeader() {},
    end(t) {
      this.body = JSON.parse(t);
    },
  };
  await contentApi(
    { method: 'GET', url: '/api/content?part=local-groups', headers: {}, socket: {} },
    res
  );
  assert.equal(res.body.live, true);
  assert.deepEqual(
    res.body.cities.map((c) => c.name),
    ['Bologna', 'Genova', 'Milano', 'Padova', 'Torino', 'Trento', 'Trieste']
  );
  assert.deepEqual(res.body.cities[0], { name: 'Bologna', x: 166, y: 190 });
  assert.equal(res.body.cities[2].link, 'https://chat.whatsapp.com/Invented');

  // The build puts them in place of community.yaml's cities, keeping its texts.
  const yaml = { local_groups: { title: 'Find your local group', cities: [{ name: 'Old' }] } };
  const merged = localGroupsBuild.community(yaml, res.body);
  assert.equal(merged.local_groups.title, 'Find your local group');
  assert.equal(merged.local_groups.cities.length, 7);
  assert.deepEqual(localGroupsBuild.community(yaml, { live: false }), yaml);

  // A change on the board shows as pending on the site part.
  await localGroups.saveGroup(board, { city: 'Bologna centro' }, bologna.id);
  assert.equal((await localGroups.listSite(editor)).site.pending, true);

  // Going back: the YAML is the site again.
  await localGroups.unpublishSite(editor);
  assert.equal((await localGroups.publicExport()).live, false);
});

test('the build keeps only cities it can draw, and links that are web addresses', () => {
  const out = localGroupsBuild.community(
    { local_groups: {} },
    {
      live: true,
      cities: [
        { name: 'Ok', x: 1, y: 2, link: 'https://ok.it' },
        { name: 'Bad link', x: 1, y: 2, link: 'javascript:alert(1)' },
        { name: 'No pin' },
        { x: 1, y: 2 },
      ],
    }
  );
  assert.deepEqual(out.local_groups.cities, [
    { name: 'Ok', x: 1, y: 2, link: 'https://ok.it' },
    { name: 'Bad link', x: 1, y: 2 },
  ]);
});

test('a build from a site that answers with an error stops', async () => {
  process.env.CONTENT_SOURCE = 'https://example.org';
  try {
    localGroupsBuild.setFetch(async () => ({ ok: false, status: 500 }));
    await assert.rejects(localGroupsBuild.load(), /keeps its current map/);
    // A site deployed before this answers with the seminars: never published there.
    localGroupsBuild.setFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ live: true, entries: [] }),
    }));
    assert.deepEqual(await localGroupsBuild.load(), { live: false });
  } finally {
    delete process.env.CONTENT_SOURCE;
  }
});

test('the board as CSV: one row per group, formulas kept as text, for the board only', async () => {
  const board = await person('Board', ['local_groups']);
  const editor = await person('Editor', ['local_groups_site']);
  await localGroups.saveGroup(board, {
    city: 'Bari',
    leads: LEADS.concat([{ name: '=HYPERLINK("x")', email: 'b@example.org' }]),
    // A cell that starts like a formula.
    whatsapp: 'https://chat.whatsapp.com/Invented',
    notes: 'Line one, with "quotes"',
  });
  await localGroups.saveGroup(board, { city: 'Bergamo', notes: '=1+1' });
  const { filename, csv } = await localGroups.exportCsv(board);
  assert.match(filename, /^local-groups-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv
    .replace(/^\ufeff/, '')
    .trim()
    .split('\r\n');
  assert.equal(lines[0], 'City,Status,Leads,Emails,Phones,WhatsApp,On the site,Notes,Last changed');
  assert.equal(lines.length, 10);
  assert.ok(lines.find((l) => l.startsWith('Bergamo,')).includes("'=1+1"));
  const bari = lines.find((l) => l.startsWith('Bari,'));
  assert.ok(bari.includes('"Carla Invent; =HYPERLINK(""x"")"'));
  assert.ok(bari.includes('carla@example.org; b@example.org'));
  assert.ok(bari.includes(`'+39 333 000 0000`));
  assert.ok(bari.includes('"Line one, with ""quotes"""'));
  await rejects(localGroups.exportCsv(editor), 403);
  const { rows } = await db.query("select detail from crm_audit where action = 'export'");
  assert.equal(rows[0].detail.part, 'local-groups');
});
