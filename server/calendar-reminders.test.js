// Tests for the calendar's repeating events across daylight-saving changes
// (server/calendar-expand.js), its reminders and Discord announcements
// (server/calendar-reminders.js), and the copy of a poll's chosen time.
// On invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const calendars = require('./calendars');
const expand = require('./calendar-expand');
const reminders = require('./calendar-reminders');
// Paused on the site for now (calendar-reminders.js); tested as when on.
reminders.paused = false;
const notify = require('./notify');
const polls = require('./polls');

const sent = [];
beforeEach(async () => {
  await testDb.fresh();
  calendars.resetBackfill();
  sent.length = 0;
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'test-bot';
  process.env.DISCORD_GUILD_ID = '111111111';
  delete process.env.MEET_DEV_LOGIN;
  // Every Discord call is recorded: DMs (notify) and channel posts (the bot).
  const fake = async (url, opts = {}) => {
    // Reading someone's roles: Discord is down, so the stored ones stand.
    if (/\/guilds\/\d+\/members\//.test(String(url)))
      return { ok: false, status: 503, json: async () => ({}) };
    // The server's channels and roles: none, so no channel is hidden from anyone.
    if (/\/guilds\/\d+\/(channels|roles)$/.test(String(url)))
      return { ok: true, status: 200, json: async () => [] };
    sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'dm-channel' }),
    };
  };
  notify.setFetch(fake);
  permissions.setFetch(fake);
  require('./calendar-discord').reset();
});

// The roles' table is saved whole: each person's role joins those before.
let roles;
beforeEach(() => {
  roles = [];
});
async function person(name, keys = []) {
  const roleId = `r-${name.toLowerCase()}`;
  if (keys.length) roles.push({ roleId, roleName: name, permissions: keys });
  await permissions.saveRolePermissions(roles);
  const discordId = String(900000000 + Math.floor(Math.random() * 99999));
  const user = await auth.upsertDiscordUser({ discordId, name, roles: [roleId] });
  await db.query(`update app_users set notify_channel = 'discord' where id = $1`, [user.id]);
  return Object.assign(user, { discordId });
}

const iso = (d) => new Date(d).toISOString();

test('a weekly meeting stays at 18:00 in Rome across the change to winter time', () => {
  const event = {
    id: 'e1',
    starts_at: '2026-10-20T16:00:00.000Z', // 18:00 CEST
    ends_at: '2026-10-20T17:00:00.000Z',
    timezone: 'Europe/Rome',
    all_day: false,
    recurrence: { freq: 'weekly', interval: 1, count: 3 },
    exdates: [],
  };
  const list = expand.expand([event], '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z');
  assert.deepEqual(
    list.map((o) => iso(o.start)),
    ['2026-10-20T16:00:00.000Z', '2026-10-27T17:00:00.000Z', '2026-11-03T17:00:00.000Z']
  );
});

test('a monthly meeting keeps its weekday: the second Tuesday, the last Friday', () => {
  const second = {
    id: 'e2',
    starts_at: '2026-01-13T09:00:00.000Z',
    ends_at: '2026-01-13T10:00:00.000Z',
    timezone: 'UTC',
    recurrence: { freq: 'monthly', interval: 1, count: 4 },
  };
  assert.deepEqual(
    expand
      .expand([second], '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
      .map((o) => iso(o.start).slice(0, 10)),
    ['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14']
  );
  const last = {
    ...second,
    id: 'e3',
    starts_at: '2026-01-30T09:00:00.000Z',
    ends_at: '2026-01-30T10:00:00.000Z',
  };
  assert.deepEqual(
    expand
      .expand([last], '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
      .map((o) => iso(o.start).slice(0, 10)),
    ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']
  );
});

test('a daily series far in the past lists only the days asked for', () => {
  const event = {
    id: 'e4',
    starts_at: '2020-01-01T08:00:00.000Z',
    ends_at: '2020-01-01T08:30:00.000Z',
    timezone: 'Europe/Rome',
    recurrence: { freq: 'daily', interval: 1, until: '2030-01-01' },
    exdates: ['2026-03-03T08:00:00.000Z'],
  };
  const list = expand.expand([event], '2026-03-01T00:00:00Z', '2026-03-06T00:00:00Z');
  assert.deepEqual(
    list.map((o) => iso(o.start).slice(0, 10)),
    ['2026-03-01', '2026-03-02', '2026-03-04', '2026-03-05']
  );
});

test('reminders reach who turned notifications on and who said going, once', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const follower = await person('Follower');
  const goer = await person('Goer');
  const quiet = await person('Quiet');
  const cal = await calendars.createCalendar(maker, {
    name: 'Team',
    announce: [{ channelId: '222222222', name: 'general', minutes: [60] }],
  });
  const start = new Date(Date.now() + 2 * 3600000);
  start.setUTCSeconds(0, 0);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Planning',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    reminders: [{ minutes: 60, channels: ['discord'] }],
    video: { kind: 'discord', channelId: '333333333', name: 'Voice' },
  });
  await calendars.savePrefs(follower, { notify: true });
  await calendars.getPrefs(quiet);
  await calendars.rsvp(goer, id, iso(start), 'yes');

  // Too early: nothing.
  let result = await reminders.run({ now: new Date(start.getTime() - 90 * 60000) });
  assert.deepEqual(result, { reminders: 0, announcements: 0 });

  // An hour before: the follower and the goer, and the channel.
  sent.length = 0;
  result = await reminders.run({ now: new Date(start.getTime() - 59 * 60000) });
  assert.deepEqual(result, { reminders: 2, announcements: 1 });
  const dms = sent.filter((s) => s.url.endsWith('/users/@me/channels'));
  assert.deepEqual(
    dms.map((s) => s.body.recipient_id).sort(),
    [follower.discordId, goer.discordId].sort()
  );
  const post = sent.find((s) => s.url.includes('/channels/222222222/messages'));
  assert.match(post.body.content, /Planning/);
  assert.match(post.body.content, /<#333333333>/);

  // The next run sends nothing again.
  sent.length = 0;
  result = await reminders.run({ now: new Date(start.getTime() - 55 * 60000) });
  assert.deepEqual(result, { reminders: 0, announcements: 0 });
});

test("an event's own channels replace its calendar's; an empty list announces nowhere", async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, {
    name: 'Team',
    announce: [{ channelId: '222222222', name: 'general', minutes: [0] }],
  });
  const start = new Date(Date.now() + 3600000);
  start.setUTCSeconds(0, 0);
  const body = (title, announce) => ({
    calendarId: cal.id,
    title,
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    announce,
  });
  await calendars.createEvent(
    maker,
    body('Own channel', [{ channelId: '444444444', name: 'x', minutes: [0] }])
  );
  await calendars.createEvent(maker, body('Nowhere', []));
  await calendars.createEvent(maker, body('Inherits', null));
  await reminders.run({ now: new Date(start.getTime() + 60000) });
  const posts = sent.filter((s) => s.url.includes('/messages') && s.url.includes('/channels/'));
  const where = posts.map((p) => [
    p.url.split('/channels/')[1].split('/')[0],
    p.body.content.match(/\*\*(.+?)\*\*/)[1],
  ]);
  assert.deepEqual(where.sort(), [
    ['222222222', 'Inherits'],
    ['444444444', 'Own channel'],
  ]);
});

test("a poll's chosen time lands in the calendar chosen, and leaves it when changed", async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Meetings' });
  const first = new Date(Date.now() + 5 * 86400000);
  first.setUTCHours(10, 0, 0, 0);
  const poll = await polls.createPoll(
    {
      title: 'Kick-off',
      durationMinutes: 45,
      timezone: 'Europe/Rome',
      location: 'https://meet.example.org/abc',
      slots: [iso(first)],
    },
    maker.id
  );
  const admin = await polls.getPollAdmin(poll.id, maker.id);
  await polls.finalizePoll(poll.id, { slotId: admin.slots[0].id }, maker.id);
  await calendars.setPollCalendar(maker, poll.id, cal.id);
  const range = { from: iso(first.getTime() - 86400000), to: iso(first.getTime() + 86400000) };
  let { events } = await calendars.listEvents(maker, range);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Kick-off');
  assert.equal(events[0].video.url, 'https://meet.example.org/abc');
  assert.equal(new Date(events[0].end) - new Date(events[0].start), 45 * 60000);
  assert.equal(events[0].source.kind, 'poll');

  await polls.unschedulePoll(poll.id, maker.id);
  await calendars.syncFromPoll(poll.id);
  ({ events } = await calendars.listEvents(maker, range));
  assert.equal(events.length, 0);
});

test('every text channel is listed, private ones the bot is not in greyed out', async () => {
  const discord = require('./calendar-discord');
  discord.reset();
  const G = '111111111';
  const VIEW = String(1 << 10);
  const SEND = String(1 << 11);
  const answers = {
    [`/guilds/${G}/channels`]: [
      { id: 'cat-team', type: 4, name: 'Team', position: 1 },
      { id: 'cat-open', type: 4, name: 'Community', position: 0 },
      { id: '201', type: 0, name: 'general', position: 0, parent_id: 'cat-open' },
      {
        id: '202',
        type: 0,
        name: 'board',
        position: 0,
        parent_id: 'cat-team',
        permission_overwrites: [{ id: G, type: 0, deny: VIEW, allow: '0' }],
      },
      {
        id: '203',
        type: 0,
        name: 'organizers',
        position: 1,
        parent_id: 'cat-team',
        permission_overwrites: [
          { id: G, type: 0, deny: VIEW, allow: '0' },
          { id: 'r-bot', type: 0, deny: '0', allow: String((1 << 10) | (1 << 11)) },
        ],
      },
      { id: '301', type: 2, name: 'Voice', position: 2, parent_id: 'cat-open' },
    ],
    [`/guilds/${G}/roles`]: [
      { id: G, permissions: String((1 << 10) | (1 << 11)) },
      { id: 'r-bot', permissions: SEND },
    ],
    '/users/@me': { id: 'bot-1' },
    [`/guilds/${G}/members/bot-1`]: { roles: ['r-bot'] },
  };
  permissions.setFetch(async (url) => {
    const path = String(url).replace('https://discord.com/api/v10', '');
    return {
      ok: path in answers,
      status: path in answers ? 200 : 404,
      json: async () => answers[path],
    };
  });
  const { text, voice } = await discord.channels();
  assert.deepEqual(
    text.map((c) => [c.category, c.name, c.canPost]),
    [
      ['Community', 'general', true],
      ['Team', 'board', false],
      ['Team', 'organizers', true],
    ]
  );
  assert.deepEqual(
    voice.map((c) => c.name),
    ['Voice']
  );
  discord.reset();
});

test('who writes events sees, and announces in, only the channels they see on Discord', async () => {
  const discord = require('./calendar-discord');
  const G = '111111111';
  const VIEW = String(1 << 10);
  const maker = await person('Maker', ['calendar_create']);
  const board = await person('Board');
  const admin = await person('Admin', ['calendar_admin']);
  const answers = {
    [`/guilds/${G}/channels`]: [
      { id: '201000001', type: 0, name: 'general', position: 0 },
      {
        id: '202000002',
        type: 0,
        name: 'board',
        position: 1,
        permission_overwrites: [
          { id: G, type: 0, deny: VIEW, allow: '0' },
          { id: 'r-board', type: 0, deny: '0', allow: VIEW },
        ],
      },
    ],
    [`/guilds/${G}/roles`]: [{ id: G, permissions: String((1 << 10) | (1 << 11)) }],
    '/users/@me': { id: 'bot-1' },
  };
  permissions.setFetch(async (url, opts = {}) => {
    const path = String(url).replace('https://discord.com/api/v10', '');
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({}) };
    // Someone's roles: Discord is down, so the stored ones stand.
    if (path.includes('/members/')) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: path in answers,
      status: path in answers ? 200 : 404,
      json: async () => answers[path],
    };
  });
  discord.reset();
  const names = async (u) =>
    (await discord.channelsFor(await calendars.whoIs(u))).text.map((c) => c.name);
  assert.deepEqual(await names(maker), ['general']);
  assert.deepEqual(await names(board), ['general', 'board']);
  assert.deepEqual(await names(admin), ['general', 'board']);

  const boardChannel = [{ channelId: '202000002', name: 'board', minutes: [60] }];
  await assert.rejects(
    calendars.createCalendar(maker, { name: 'Team', announce: boardChannel }),
    /channel you see/
  );
  // Board members' calendar, which the maker may edit: they keep its channel.
  const cal = await calendars.createCalendar(admin, {
    name: 'Board',
    announce: boardChannel,
    access: { view: { all: true }, edit: { all: true } },
  });
  const start = new Date(Date.now() + 86400000);
  start.setUTCSeconds(0, 0);
  const body = (announce) => ({
    calendarId: cal.id,
    title: 'Meeting',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    announce,
  });
  const general = { channelId: '201000001', name: 'general', minutes: [0] };
  const { id } = await calendars.createEvent(maker, body(boardChannel));
  await calendars.updateEvent(maker, id, body([...boardChannel, general]));

  // A calendar of their own, with no channel yet: #board is not theirs to add.
  const own = await calendars.createCalendar(maker, { name: 'Mine', announce: [general] });
  await assert.rejects(
    calendars.createEvent(maker, { ...body(boardChannel), calendarId: own.id }),
    /channel you see/
  );
  discord.reset();
});

// ── One-off announcements: now, and at a day and time chosen ───────────────

// The server's text channels, as the bot sees them, and any `extra` ones;
// every post is recorded.
function fakeGuild(extra = []) {
  const discord = require('./calendar-discord');
  discord.reset();
  const G = '111111111';
  const VIEW = String(1 << 10);
  const answers = {
    [`/guilds/${G}/channels`]: [
      { id: '201', type: 0, name: 'general', position: 0 },
      {
        id: '202',
        type: 0,
        name: 'board',
        position: 1,
        permission_overwrites: [{ id: G, type: 0, deny: VIEW, allow: '0' }],
      },
      ...extra,
    ],
    [`/guilds/${G}/roles`]: [{ id: G, permissions: String((1 << 10) | (1 << 11)) }],
    '/users/@me': { id: 'bot-1' },
    [`/guilds/${G}/members/bot-1`]: { roles: [] },
  };
  permissions.setFetch(async (url, opts = {}) => {
    const path = String(url).replace('https://discord.com/api/v10', '');
    if (path in answers) return { ok: true, status: 200, json: async () => answers[path] };
    // Reading someone's roles: Discord is down, so the stored ones stand.
    if (/\/guilds\/\d+\/members\//.test(path))
      return { ok: false, status: 503, json: async () => ({}) };
    sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
  });
}
const posts = (channel) => sent.filter((s) => s.url.includes(`/channels/${channel}/messages`));

test('"Announce now" posts in the channel chosen, once a while, for whoever edits', async () => {
  fakeGuild();
  const announce = require('./calendar-announce');
  const maker = await person('Maker', ['calendar_create']);
  const reader = await person('Reader');
  const cal = await calendars.createCalendar(maker, { name: 'Team', view_all: true });
  const start = new Date(Date.now() + 5 * 3600000);
  start.setUTCSeconds(0, 0);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'General Meeting',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    video: { kind: 'discord', channelId: '333333333', name: 'generale' },
  });
  const card = await announce.announceNow(
    maker,
    id,
    { occurrence: iso(start), channelId: '201' },
    { site: 'https://x.test' }
  );
  const [post] = posts('201');
  assert.match(post.body.content, /\*\*General Meeting\*\* starts in 5 hours/);
  assert.match(post.body.content, /<#333333333>/);
  assert.deepEqual(
    card.oneOff.list.map((a) => [a.name, a.status]),
    [['general', 'sent']]
  );
  await assert.rejects(
    announce.announceNow(maker, id, { occurrence: iso(start), channelId: '201' }),
    { status: 429 }
  );
  // A channel the bot cannot write in, and someone who cannot edit the event.
  await assert.rejects(
    announce.announceNow(maker, id, { occurrence: iso(start), channelId: '202' }),
    { status: 400 }
  );
  await assert.rejects(
    announce.announceNow(reader, id, { occurrence: iso(start), channelId: '201' }),
    (err) => err.status === 403 || err.status === 404
  );
  assert.equal(posts('201').length, 1);
  require('./calendar-discord').reset();
});

test('an announcement planned for a time goes then, once; a skipped occurrence is left out', async () => {
  fakeGuild();
  const announce = require('./calendar-announce');
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Team' });
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCMinutes(0, 0, 0);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Weekly',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    recurrence: { freq: 'weekly', interval: 1, count: 3 },
  });
  const second = new Date(start.getTime() + 7 * 86400000);
  const at = new Date(start.getTime() - 26 * 3600000);
  await announce.plan(maker, id, { occurrence: iso(start), channelId: '201', sendAt: iso(at) });
  const card = await announce.plan(maker, id, {
    occurrence: iso(second),
    channelId: '201',
    sendAt: iso(second.getTime() - 3600000),
  });
  assert.deepEqual(
    card.oneOff.list.map((a) => a.status),
    ['planned']
  );
  // Not a time past, nor one after the event.
  await assert.rejects(
    announce.plan(maker, id, {
      occurrence: iso(start),
      channelId: '201',
      sendAt: iso(Date.now() - 3600000),
    }),
    { status: 400 }
  );
  await assert.rejects(
    announce.plan(maker, id, {
      occurrence: iso(start),
      channelId: '201',
      sendAt: iso(start.getTime() + 2 * 3600000),
    }),
    { status: 400 }
  );

  let result = await reminders.run({ now: new Date(at.getTime() - 60000) });
  assert.equal(result.announcements, 0);
  result = await reminders.run({ now: new Date(at.getTime() + 60000) });
  assert.equal(result.announcements, 1);
  assert.match(posts('201')[0].body.content, /\*\*Weekly\*\* starts in 26 hours/);
  result = await reminders.run({ now: new Date(at.getTime() + 11 * 60000) });
  assert.equal(result.announcements, 0);

  // The second occurrence is skipped: its planned announcement does not go.
  await calendars.deleteEvent(maker, id, { scope: 'this', occurrence: iso(second) });
  result = await reminders.run({ now: new Date(second.getTime() - 3600000 + 60000) });
  assert.equal(result.announcements, 0);
  assert.equal(posts('201').length, 1);
  const { rows } = await db.query('select outcome from calendar_announcements order by send_at');
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ['sent', 'skipped']
  );
  require('./calendar-discord').reset();
});

test('a planned announcement can be taken back before it goes, by whoever edits', async () => {
  fakeGuild();
  const announce = require('./calendar-announce');
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Team' });
  const start = new Date(Date.now() + 86400000);
  start.setUTCSeconds(0, 0);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Once',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
  });
  const card = await announce.plan(maker, id, {
    occurrence: iso(start),
    channelId: '201',
    sendAt: iso(start.getTime() - 3600000),
  });
  const after = await announce.cancel(maker, card.oneOff.list[0].id);
  assert.deepEqual(after.oneOff.list, []);
  await assert.rejects(announce.cancel(maker, card.oneOff.list[0].id), { status: 404 });
  require('./calendar-discord').reset();
});

test('one-off announcements go only in a channel the member sees, or one the event already uses', async () => {
  const G = '111111111';
  const VIEW = String(1 << 10);
  // #committee: hidden from everyone but the Committee role and the bot.
  fakeGuild([
    {
      id: '203000003',
      type: 0,
      name: 'committee',
      position: 2,
      permission_overwrites: [
        { id: G, type: 0, deny: VIEW, allow: '0' },
        { id: 'r-committee', type: 0, deny: '0', allow: VIEW },
        { id: 'bot-1', type: 1, deny: '0', allow: String((1 << 10) | (1 << 11)) },
      ],
    },
  ]);
  const announce = require('./calendar-announce');
  const maker = await person('Maker', ['calendar_create']);
  const committee = await person('Committee', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, {
    name: 'Shared',
    access: { view: { all: true }, edit: { all: true } },
  });
  const start = new Date(Date.now() + 2 * 86400000);
  start.setUTCMinutes(0, 0, 0);
  const event = (announceIn) => ({
    calendarId: cal.id,
    title: 'Meeting',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    announce: announceIn,
  });
  const { id } = await calendars.createEvent(maker, event([]));
  const occurrence = iso(start);
  const sendAt = iso(start.getTime() - 3600000);

  await assert.rejects(
    announce.announceNow(maker, id, { occurrence, channelId: '203000003' }),
    /channel you see/
  );
  await assert.rejects(
    announce.plan(maker, id, { occurrence, channelId: '203000003', sendAt }),
    /channel you see/
  );
  await announce.plan(committee, id, { occurrence, channelId: '203000003', sendAt });

  // Once the event announces in #committee, whoever edits it may use it too.
  const committeeChannel = [{ channelId: '203000003', name: 'committee', minutes: [60] }];
  const { id: other } = await calendars.createEvent(committee, event(committeeChannel));
  await announce.announceNow(maker, other, { occurrence, channelId: '203000003' });
  assert.equal(posts('203000003').length, 1);
  require('./calendar-discord').reset();
});

test('paused, no reminder goes and none is spent; the announcements still do', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const follower = await person('Follower');
  const cal = await calendars.createCalendar(maker, {
    name: 'Paused',
    announce: [{ channelId: '444444444', name: 'general', minutes: [60] }],
  });
  const start = new Date(Date.now() + 2 * 3600000);
  start.setUTCSeconds(0, 0);
  await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Quiet one',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    reminders: [{ minutes: 60, channels: ['discord'] }],
  });
  await calendars.savePrefs(follower, { notify: true });

  reminders.paused = true;
  try {
    const result = await reminders.run({ now: new Date(start.getTime() - 59 * 60000) });
    assert.deepEqual(result, { reminders: 0, announcements: 1 });
  } finally {
    reminders.paused = false;
  }
  // On again, the reminder still due goes.
  const result = await reminders.run({ now: new Date(start.getTime() - 58 * 60000) });
  assert.equal(result.reminders, 1);
});

test('with CALENDAR_WHATSAPP set, a reminder carries a link that writes it on WhatsApp', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Team' });
  const start = new Date(Date.now() + 2 * 3600000);
  start.setUTCSeconds(0, 0);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Planning',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    reminders: [{ minutes: 60, channels: ['discord'] }],
  });
  const { rows } = await db.query('select * from calendar_events where id = $1', [id]);
  const [occ] = expand.expand(
    rows,
    new Date(start.getTime() - 60000),
    new Date(start.getTime() + 60000),
    []
  );
  try {
    delete process.env.CALENDAR_WHATSAPP;
    let msg = reminders.message(occ, cal, 60, 'https://example.org');
    assert.ok(!msg.lines.some((l) => l && l.label === 'Send on WhatsApp'));

    process.env.CALENDAR_WHATSAPP = '+39 345 000 0000';
    msg = reminders.message(occ, cal, 60, 'https://example.org');
    const wa = msg.lines.find((l) => l && l.label === 'Send on WhatsApp');
    assert.match(wa.link, /^https:\/\/wa\.me\/393450000000\?text=/);
    const text = decodeURIComponent(wa.link.split('?text=')[1]);
    assert.match(text, /\*Planning\* starts in 1 hour · Team/);
    assert.match(text, /https:\/\/example\.org\/app\/calendar\/\?event=/);

    process.env.CALENDAR_WHATSAPP = 'choose';
    msg = reminders.message(occ, cal, 60, 'https://example.org');
    assert.match(
      msg.lines.find((l) => l && l.label === 'Send on WhatsApp').link,
      /^https:\/\/wa\.me\/\?text=/
    );

    // A guest invited by address never gets it.
    msg = reminders.message(occ, cal, 60, 'https://example.org', [], { guest: true });
    assert.ok(!msg.lines.some((l) => l && l.label === 'Send on WhatsApp'));
  } finally {
    delete process.env.CALENDAR_WHATSAPP;
  }
});
