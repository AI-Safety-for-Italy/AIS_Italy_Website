// Tests for the banners and the home page boxes (server/highlights.js): where
// they start from, who may change them, what the site gets.
// Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const highlights = require('./highlights');
const highlightsBuild = require('./highlights-build');

beforeEach(() => {
  db.setDb(new PGlite());
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

async function member(name, roles) {
  await permissions.saveRolePermissions([
    { roleId: 'r-site', roleName: 'site', permissions: ['homepage'] },
    { roleId: 'r-seminars', roleName: 'seminars', permissions: ['seminar'] },
  ]);
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

async function rejects(promise, status, field) {
  await assert.rejects(
    promise,
    (err) => err.status === status && (!field || (err.details && err.details.field) === field)
  );
}

test('they start as the site shows them today, switched on', async () => {
  const yaml = highlights.fromYaml();
  assert.ok(yaml.banners.length >= 1 && yaml.banners.every((b) => b.on && b.text));
  assert.equal(yaml.spotlights[0].kind, 'mentorship');
  assert.equal(yaml.spotlights[0].on, true);
  assert.ok(yaml.spotlights[0].primary_link);
  // What the YAML says passes the checks the page's saves go through.
  assert.doesNotThrow(() => highlights.check(yaml));

  // Nothing saved: the site keeps its YAML.
  assert.deepEqual(await highlights.publicExport(), { live: false, banners: [], spotlights: [] });
  const sara = await member('Sara', ['r-site']);
  const got = await highlights.get(sara);
  assert.equal(got.banners[0].text, yaml.banners[0].text);
  assert.equal(got.updatedBy, null);
  // Opening the page saved it: the site now reads the same from here.
  const out = await highlights.publicExport();
  assert.equal(out.live, true);
  assert.equal(out.banners[0].text, yaml.banners[0].text);
  assert.equal(out.spotlights[0].title, yaml.spotlights[0].title);
  assert.ok(!('on' in out.banners[0]));
});

test('only who holds "Banners & spotlight"', async () => {
  const ugo = await member('Ugo', ['r-seminars']);
  await rejects(highlights.get(ugo), 403);
  await rejects(highlights.save(ugo, { banners: [], spotlights: [] }), 403);
});

test('saving: limits, links, what is off stays off the site, no overwriting', async () => {
  const sara = await member('Sara', ['r-site']);
  const start = await highlights.get(sara);
  const banner = (text, on) => ({
    on,
    text,
    text_it: `${text} (it)`,
    link: '/events/',
    link_text: 'Go',
  });
  await rejects(
    highlights.save(sara, { banners: [1, 2, 3, 4].map((n) => banner(`B${n}`, true)) }),
    400,
    'banners'
  );
  await rejects(
    highlights.save(sara, { banners: [{ ...banner('B', true), link: 'javascript:alert(1)' }] }),
    400,
    'banners.0.link'
  );
  await rejects(
    highlights.save(sara, { banners: [{ on: true, text: '' }] }),
    400,
    'banners.0.text'
  );
  await rejects(
    highlights.save(sara, {
      spotlights: [{ on: true, kind: 'event', label: 'Next', title: 'T', primary_text: 'Go' }],
    }),
    400,
    'spotlights.0.primary_link'
  );

  const saved = await highlights.save(sara, {
    updatedAt: start.updatedAt,
    banners: [banner('First', true), banner('Off', false), banner('Third', true)],
    spotlights: [
      { ...start.spotlights[0], on: false },
      {
        on: true,
        kind: 'event',
        label: 'Next event',
        title: 'Meetup in Milan',
        day: '5',
        month: 'Dec',
        lines: [
          { text: 'Friday 5 December', text_it: '' },
          { text: '', text_it: '' },
        ],
        primary_text: 'Register',
        primary_link: 'https://luma.com/x',
      },
    ],
  });
  assert.equal(saved.updatedBy, 'Sara');
  assert.deepEqual(saved.spotlights[1].lines, [{ text: 'Friday 5 December' }]);

  const out = await highlights.publicExport();
  assert.deepEqual(
    out.banners.map((b) => b.text),
    ['First', 'Third']
  );
  assert.deepEqual(
    out.spotlights.map((s) => s.title),
    ['Meetup in Milan']
  );
  // The off one is kept for later.
  assert.equal((await highlights.get(sara)).spotlights[0].kind, 'mentorship');

  // Someone else saved since this page was opened.
  await rejects(
    highlights.save(sara, { updatedAt: start.updatedAt, banners: [], spotlights: [] }),
    409
  );
});

test('the build: the banners in global.announcements, the boxes on the home page', async () => {
  const yaml = { announcements: [{ text: 'From the YAML' }], nav: [] };
  const notLive = { live: false, banners: [], spotlights: [] };
  assert.equal(highlightsBuild.global(yaml, notLive), yaml);
  assert.deepEqual(highlightsBuild.spotlights(notLive), { live: false, spotlights: [] });

  const live = { live: true, banners: [], spotlights: [{ title: 'X' }] };
  // No banner on means no bar, not the featured event.
  assert.deepEqual(highlightsBuild.global(yaml, live), {
    announcements: [],
    nav: [],
    banners_managed: true,
  });
  assert.deepEqual(highlightsBuild.spotlights(live).spotlights, [{ title: 'X' }]);

  // From the site: a 404 or a site without this part yet keeps the YAML;
  // an error stops the build.
  process.env.CONTENT_SOURCE = 'https://site.example';
  try {
    highlightsBuild.setFetch(async () => ({ status: 404, ok: false }));
    assert.equal((await highlightsBuild.load()).live, false);
    highlightsBuild.setFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ live: true, entries: [] }),
    }));
    assert.equal((await highlightsBuild.load()).live, false);
    highlightsBuild.setFetch(async () => ({ status: 500, ok: false }));
    await assert.rejects(highlightsBuild.load());
    highlightsBuild.setFetch(async (url) => {
      assert.equal(url, 'https://site.example/api/content?part=highlights');
      return { status: 200, ok: true, json: async () => live };
    });
    assert.deepEqual(await highlightsBuild.load(), live);
  } finally {
    delete process.env.CONTENT_SOURCE;
  }
});
