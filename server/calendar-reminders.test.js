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
    sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'dm-channel' }),
    };
  };
  notify.setFetch(fake);
  permissions.setFetch(fake);
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
