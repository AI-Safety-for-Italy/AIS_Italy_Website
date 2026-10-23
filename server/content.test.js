// Tests for the content tool (/app/content/): permissions from Discord roles,
// validation, versions, the import from events.yaml and what the build gets.
// Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const content = require('./content');
const permissions = require('./permissions');
const contentBuild = require('./content-build');
const publish = require('./content-publish');
const md = require('../src/assets/js/meet/markdown-lite');

beforeEach(() => {
  db.setDb(new PGlite());
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

const NEXT_YEAR = String(new Date().getFullYear() + 1);
const DAY = `${NEXT_YEAR}-03-12`;

const seminar = (over = {}) => ({
  type: 'seminar',
  day: DAY,
  time: '18:30',
  speaker: 'Carlo Martinucci',
  title: 'Watermarking AI Text',
  title_it: 'Watermarking AI Text',
  description_md: 'How **watermarks** work. See [the post](https://example.org/post).',
  description_md_it: 'Come funzionano i **watermark**.',
  details: [
    {
      label: 'Speaker',
      label_it: 'Relatore',
      value: 'Carlo Martinucci',
      value_it: 'Carlo Martinucci',
      link: 'https://www.linkedin.com/in/carlomartinucci/',
    },
  ],
  register_link: 'https://luma.com/abc',
  ...over,
});

async function setRoles(table) {
  await permissions.saveRolePermissions(table);
}

const TABLE = [
  { roleId: 'r-direttivo', roleName: 'Direttivo', permissions: permissions.KEYS },
  {
    roleId: 'r-communication',
    roleName: 'communication',
    permissions: ['seminar', 'event', 'media', 'blog', 'others'],
  },
  { roleId: 'r-blog', roleName: 'blog', permissions: ['blog'] },
];

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(`select * from app_users where kind = 'admin'`);
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

// ── Markdown ─────────────────────────────────────────────────────────────────

test('the Markdown keeps only its own few tags and escapes everything else', () => {
  assert.equal(
    md.toHtml('Hello **world**, *see* [this](https://x.org/a?b=1&c=2).\n\n- one\n- two'),
    '<p>Hello <strong>world</strong>, <em>see</em> <a href="https://x.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">this</a>.</p><ul><li>one</li><li>two</li></ul>'
  );
  assert.equal(
    md.toHtml('<script>alert(1)</script>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
  );
  // Only https, mailto and site paths become links.
  assert.equal(md.toHtml('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(md.toHtml('[x](" onmouseover="a)'), '<p>[x](&quot; onmouseover=&quot;a)</p>');
  assert.equal(md.toHtml(''), '');
});

test('hand-written HTML turns into Markdown and back', () => {
  const html =
    '<p>Starting from <strong>the paper</strong>, see <a href="https://x.org" target="_blank" rel="noopener noreferrer">his post</a>.</p><p>Second.</p>';
  const text = md.fromHtml(html);
  assert.equal(text, 'Starting from **the paper**, see [his post](https://x.org).\n\nSecond.');
  assert.equal(
    md.toHtml(text),
    '<p>Starting from <strong>the paper</strong>, see <a href="https://x.org" target="_blank" rel="noopener noreferrer">his post</a>.</p><p>Second.</p>'
  );
});

// ── Entries ──────────────────────────────────────────────────────────────────

test('the form becomes an events.yaml entry, with the date lines written out', () => {
  const entry = content.toEntry(seminar({ day: '2026-10-29' }));
  assert.equal(entry.date, 'Thursday 29 October 2026, 18:30 (CET)');
  assert.equal(entry.date_it, 'Giovedì 29 ottobre 2026, ore 18:30 (CET)');
  assert.equal(entry.category, 'seminar');
  assert.equal(entry.register_text, 'Register for free on Luma');
  assert.equal(entry.register_target, '_blank');
  assert.match(entry.description, /<strong>watermarks<\/strong>/);
  // Summer time.
  assert.equal(
    content.toEntry(seminar({ day: '2026-10-15' })).date,
    'Thursday 15 October 2026, 18:30 (CEST)'
  );
  // An end time, as for the Milan meetup.
  const meetup = content.toEntry(
    seminar({ type: 'event', day: '2026-10-05', time: '18:00', end_time: '20:30' })
  );
  assert.equal(meetup.date, 'Monday 5 October 2026, 18:00–20:30 (CEST)');
  assert.equal(meetup.date_it, 'Lunedì 5 ottobre 2026, ore 18:00–20:30 (CEST)');
  assert.equal(content.toForm({ date: 'Monday 5 October 2026, 18:00–20:30' }).end_time, '20:30');
  assert.throws(
    () => content.toEntry(seminar({ end_time: '17:00' })),
    (e) => e.status === 400
  );
  // A seminar still to be confirmed gets the usual placeholder title.
  const tbc = content.toEntry(seminar({ tbc: true, title: '', title_it: '' }));
  assert.equal(tbc.title, 'Title coming soon');
  assert.equal(tbc.title_it, 'Titolo in arrivo');
});

test('the form is validated', () => {
  const bad = (over) =>
    assert.throws(
      () => content.toEntry(seminar(over)),
      (e) => e.status === 400
    );
  bad({ type: 'party' });
  bad({ day: '2026-02-30' });
  bad({ time: '25:00' });
  bad({ title_it: '' });
  bad({ description_md_it: '' });
  bad({ register_link: 'http://insecure.example' });
  bad({ details: [{ label: 'Speaker', value: 'Carlo' }] });
  bad({ details: [{ ...seminar().details[0], link: 'javascript:alert(1)' }] });
});

test('editing keeps the fields the form does not know about', () => {
  const previous = { agenda: [{ time: '18:30', title: 'Talk' }], stream_text: 'Live' };
  const entry = content.toEntry(seminar(), previous);
  assert.deepEqual(entry.agenda, previous.agenda);
  assert.equal(entry.stream_text, 'Live');
  const form = content.toForm(entry);
  assert.equal(form.time, '18:30');
  assert.equal(form.description_md, seminar().description_md);
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('what a member may publish follows their Discord roles', async () => {
  await setRoles(TABLE);
  const blogger = await member('Bea', ['r-blog', 'r-unrelated']);
  const comms = await member('Carla', ['r-communication']);
  const nobody = await member('Nico', ['r-partecipanti']);
  assert.deepEqual(await permissions.forUser(blogger), ['blog']);
  assert.deepEqual(await permissions.forUser(comms), [
    'seminar',
    'event',
    'media',
    'blog',
    'others',
  ]);
  assert.deepEqual(await permissions.forUser(nobody), []);
  assert.deepEqual(await permissions.forUser(await admin()), permissions.KEYS);

  await rejects(content.saveItem(blogger, seminar()), 403);
  await rejects(content.saveItem(nobody, seminar()), 403);
  const { id } = await content.saveItem(comms, seminar());
  assert.ok(id);
  assert.equal(await permissions.anyContentRole(['r-blog']), true);
  assert.equal(await permissions.anyContentRole(['r-partecipanti']), false);
});

test('only the author, or someone allowed to edit others, may change an item', async () => {
  await setRoles([
    ...TABLE,
    { roleId: 'r-seminars', roleName: 'seminars', permissions: ['seminar'] },
  ]);
  const anna = await member('Anna', ['r-seminars']);
  const bruno = await member('Bruno', ['r-seminars']);
  const carla = await member('Carla', ['r-communication']);
  const { id } = await content.saveItem(anna, seminar());
  await rejects(content.saveItem(bruno, seminar({ title: 'Changed' }), id), 403);
  await rejects(content.deleteItem(bruno, id), 403);
  await content.saveItem(anna, seminar({ title: 'Changed by Anna' }), id);
  await content.saveItem(carla, seminar({ title: 'Changed by Carla' }), id);
  const item = await content.getItem(id, carla);
  assert.equal(item.title, 'Changed by Carla');
  assert.equal(item.createdBy, 'Anna');
  assert.equal(item.updatedBy, 'Carla');
  // Anna may publish seminars but not events.
  await rejects(content.saveItem(anna, seminar({ type: 'event' }), id), 403);
});

test('roles are read again from Discord before publishing', async () => {
  await setRoles(TABLE);
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'bot';
  process.env.DISCORD_GUILD_ID = 'guild1';
  const carla = await member('Carla', ['r-communication']);
  // On Discord she no longer holds the role.
  permissions.setFetch(async (url) => {
    assert.match(url, /\/guilds\/guild1\/members\/test-Carla$/);
    return { ok: true, status: 200, json: async () => ({ roles: ['r-partecipanti'] }) };
  });
  await rejects(content.saveItem(carla, seminar()), 403);
  assert.deepEqual(await permissions.forUser(carla), []);
  // Left the server altogether.
  await auth.upsertDiscordUser({
    discordId: 'test-Carla',
    name: 'Carla',
    roles: ['r-communication'],
  });
  permissions.setFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  await rejects(content.saveItem(carla, seminar()), 403);
  // Discord down: the stored roles stand.
  await auth.upsertDiscordUser({
    discordId: 'test-Carla',
    name: 'Carla',
    roles: ['r-communication'],
  });
  permissions.setFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.ok((await content.saveItem(carla, seminar())).id);
});

test('the permissions table is validated and replaced as a whole', async () => {
  await rejects(
    permissions.saveRolePermissions([{ roleId: 'x', roleName: 'X', permissions: ['fly'] }]),
    400
  );
  await rejects(
    permissions.saveRolePermissions([{ roleId: 'bad id!', roleName: 'X', permissions: [] }]),
    400
  );
  await setRoles(TABLE);
  // A role left with nothing ticked is dropped.
  const table = await permissions.saveRolePermissions([
    { roleId: 'r-blog', roleName: 'blog', permissions: ['blog'] },
    { roleId: 'r-direttivo', roleName: 'Direttivo', permissions: [] },
  ]);
  assert.deepEqual(table, [{ roleId: 'r-blog', roleName: 'blog', permissions: ['blog'] }]);
});

// ── Versions ─────────────────────────────────────────────────────────────────

test('every change is a version, and an earlier one can be put back', async () => {
  const me = await admin();
  const { id } = await content.saveItem(me, seminar());
  await content.saveItem(me, seminar({ title: 'Second title' }), id);
  await content.deleteItem(me, id);
  let item = await content.getItem(id, me);
  assert.equal(item.deleted, true);
  assert.deepEqual(
    item.versions.map((v) => v.action),
    ['delete', 'update', 'create']
  );
  const first = item.versions[2].id;
  await content.restoreVersion(me, id, first);
  item = await content.getItem(id, me);
  assert.equal(item.deleted, false);
  assert.equal(item.title, 'Watermarking AI Text');
  assert.equal(item.versions[0].action, 'restore');
  const activity = await content.recentActivity();
  assert.equal(activity[0].action, 'restore');
  assert.equal(activity.length, 4);
});

test('a new item needs a day still to come and gets a free address', async () => {
  const me = await admin();
  await rejects(content.saveItem(me, seminar({ day: '2020-01-02' })), 400);
  const a = await content.saveItem(me, seminar());
  const b = await content.saveItem(me, seminar());
  assert.equal(a.entry.anchor, 'seminar-watermarking-ai-text');
  assert.equal(b.entry.anchor, 'seminar-watermarking-ai-text-2');
  const tbc = await content.saveItem(me, seminar({ tbc: true, title: '', title_it: '' }));
  assert.equal(tbc.entry.anchor, `seminar-${DAY}`);
});

// ── Import and build ─────────────────────────────────────────────────────────

test('the YAML entries are imported once, and the build switches over only when live', async () => {
  const yamlEvents = {
    upcoming_events: [
      {
        id: 1,
        anchor: 'mentorship-program',
        category: 'mentorship',
        featured: true,
        title: 'Mentorship',
      },
      {
        id: 6,
        anchor: 'seminar-watermarking',
        category: 'seminar',
        day: '2026-10-29',
        title: 'Watermarking',
        title_it: 'Watermarking',
        status: 'Upcoming',
        description: '<p>See <strong>this</strong>.</p>',
        register_link: 'https://luma.com/x',
        register_text: 'Register',
      },
    ],
    past_events: [
      {
        id: 5,
        anchor: 'seminar-direction-of-refusal',
        category: 'seminar',
        day: '2026-10-15',
        title: 'Refusal',
        status: 'Past',
      },
      {
        id: 4,
        anchor: 'meetup-milano-2026',
        category: 'event',
        day: '2026-10-07',
        title: 'Meetup',
      },
    ],
  };
  const all = [...yamlEvents.upcoming_events, ...yamlEvents.past_events];
  assert.deepEqual(await content.importEntries(all), { imported: 3, skipped: 1 });
  assert.deepEqual(await content.importEntries(all), { imported: 0, skipped: 4 });

  const exported = await content.exportForBuild();
  assert.equal(exported.live, false);
  // Not live yet: the YAML is the site.
  assert.equal(contentBuild.merge(yamlEvents, exported, '2026-10-22'), yamlEvents);

  await content.setLive(true);
  const merged = contentBuild.merge(yamlEvents, await content.exportForBuild(), '2026-10-22');
  assert.deepEqual(
    merged.upcoming_events.map((e) => e.anchor),
    ['mentorship-program', 'seminar-watermarking']
  );
  assert.deepEqual(
    merged.past_events.map((e) => e.anchor),
    ['seminar-direction-of-refusal', 'meetup-milano-2026']
  );
  // An entry without a day cannot be imported, so the YAML keeps it.
  const undated = { anchor: 'old-event', category: 'event', title: 'No day' };
  const withUndated = contentBuild.merge(
    { ...yamlEvents, past_events: [...yamlEvents.past_events, undated] },
    await content.exportForBuild(),
    '2026-10-22'
  );
  assert.equal(withUndated.past_events.at(-1).anchor, 'old-event');
  // On the day after, the seminar is past: no registration button, Past chip.
  const later = contentBuild.merge(yamlEvents, await content.exportForBuild(), '2026-10-30');
  const done = later.past_events[0];
  assert.equal(done.anchor, 'seminar-watermarking');
  assert.equal(done.status, 'Past');
  assert.equal(done.status_it, 'Concluso');
  assert.equal(done.register_link, undefined);
  // The imported HTML can be edited as Markdown.
  const me = await admin();
  const list = await content.listItems(me);
  const item = await content.getItem(
    list.items.find((i) => i.slug === 'seminar-watermarking').id,
    me
  );
  assert.equal(item.form.description_md, 'See **this**.');
  assert.equal(item.versions[0].action, 'import');
});

test('a deleted item leaves the site at the next build', async () => {
  const me = await admin();
  await content.setLive(true);
  const { id } = await content.saveItem(me, seminar());
  assert.equal((await content.exportForBuild()).entries.length, 1);
  await content.deleteItem(me, id);
  assert.equal((await content.exportForBuild()).entries.length, 0);
});

// ── After publishing ─────────────────────────────────────────────────────────

test('publishing starts the deploy workflow and tells the team channel', async () => {
  const calls = [];
  publish.setFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, status: url.includes('github') ? 204 : 200, text: async () => '' };
  });
  Object.assign(process.env, {
    CONTENT_BUILD_TOKEN: 'gh-token',
    CONTENT_BUILD_REF: 'dev',
    DISCORD_CONTENT_CHANNEL_ID: 'chan1',
    DISCORD_BOT_TOKEN_AIS_TEAM_AREA: 'bot',
  });
  try {
    const me = await admin();
    const result = await content.saveItem(me, seminar());
    const out = await publish.afterSave({ user: me, result, siteOrigin: 'https://www.ais4i.it' });
    assert.deepEqual(out.build, { started: true, detail: 'rebuilding dev' });
    assert.deepEqual(out.announcement, { sent: true });
    assert.match(calls[0].url, /\/actions\/workflows\/deploy\.yml\/dispatches$/);
    assert.deepEqual(calls[0].body, { ref: 'dev' });
    assert.equal(calls[0].auth, 'Bearer gh-token');
    assert.match(calls[1].url, /\/channels\/chan1\/messages$/);
    assert.match(calls[1].body.content, /Admin published the seminar \*\*Watermarking AI Text\*\*/);
    assert.match(
      calls[1].body.content,
      /https:\/\/www\.ais4i\.it\/seminars\/#seminar-watermarking-ai-text/
    );
    assert.deepEqual(calls[1].body.allowed_mentions, { parse: [] });

    // GitHub refusing does not undo the save; it is reported.
    publish.setFetch(async () => ({ ok: false, status: 403, text: async () => 'nope' }));
    const failed = await publish.triggerBuild();
    assert.equal(failed.started, false);
  } finally {
    for (const k of ['CONTENT_BUILD_TOKEN', 'CONTENT_BUILD_REF', 'DISCORD_CONTENT_CHANNEL_ID']) {
      delete process.env[k];
    }
  }
});
