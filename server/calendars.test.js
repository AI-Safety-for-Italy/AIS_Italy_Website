// Tests for the calendar (server/calendars.js): the three levels of each
// calendar and who holds them, events single and repeating, who comes, each
// member's choices, the .ics links, and the copies of the site's seminars and
// of polls. On invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const calendars = require('./calendars');
const feed = require('./calendar-feed');
const content = require('./content');
const contentPublish = require('./content-publish');

beforeEach(async () => {
  await testDb.fresh();
  calendars.resetBackfill();
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.MEET_DEV_LOGIN;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
  contentPublish.setFetch(async () => ({ status: 204, text: async () => '' }));
});

let roles;
beforeEach(() => {
  roles = [];
});

/** A member with these permission keys (through a role of their own) and extra roles. */
async function person(name, keys = [], extraRoles = []) {
  const roleId = `r-${name.toLowerCase()}`;
  roles.push({ roleId, roleName: name, permissions: keys });
  await permissions.saveRolePermissions(roles.filter((r) => r.permissions.length));
  const discordId = String(900000000 + Math.floor(Math.random() * 99999));
  const user = await auth.upsertDiscordUser({ discordId, name, roles: [roleId, ...extraRoles] });
  return Object.assign(user, { discordId });
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

const IN_A_WEEK = new Date(Date.now() + 7 * 86400000);
IN_A_WEEK.setUTCHours(16, 0, 0, 0);
const iso = (d) => new Date(d).toISOString();
const plus = (d, minutes) => new Date(new Date(d).getTime() + minutes * 60000);

function eventBody(calendarId, extra = {}) {
  return {
    calendarId,
    title: 'Reading group',
    start: iso(IN_A_WEEK),
    end: iso(plus(IN_A_WEEK, 60)),
    timezone: 'Europe/Rome',
    ...extra,
  };
}

async function eventsOf(
  user,
  from = plus(IN_A_WEEK, -60 * 24),
  to = plus(IN_A_WEEK, 60 * 24 * 60)
) {
  return (await calendars.listEvents(user, { from: iso(from), to: iso(to) })).events;
}

test('the site has its two public calendars, Seminars and Events, once', async () => {
  const anyone = await person('Anyone');
  const { calendars: list, canCreate } = await calendars.listCalendars(anyone);
  assert.deepEqual(
    list.map((c) => [c.name, c.system, c.isPublic, c.level]),
    [
      ['My calendar', null, false, 'manage'],
      ['Seminars', 'seminars', true, 'view'],
      ['Events', 'events', true, 'view'],
    ]
  );
  assert.equal(canCreate, false);
  await db.ensureSchema();
  // The two of the site, and Anyone's own.
  const { rows } = await db.query('select count(*)::int as n from calendars');
  assert.equal(rows[0].n, 3);
});

test('creating a calendar needs calendar_create, and its creator manages it', async () => {
  const plain = await person('Plain');
  await rejects(calendars.createCalendar(plain, { name: 'Team' }), 403);
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Team meetings', color: '#7c3aed' });
  assert.equal(cal.level, 'manage');
  assert.equal(cal.slug, 'team-meetings');
  assert.equal(cal.color, '#7c3aed');
  // By default every member sees it, and only its creator writes in it.
  assert.equal((await calendars.listCalendars(plain)).calendars.length, 4);
  await rejects(calendars.createEvent(plain, eventBody(cal.id)), 403);
});

test('the three levels go to all members, roles and people, each including the one below', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const viewer = await person('Viewer', [], ['r-board']);
  const editor = await person('Editor');
  const manager = await person('Manager');
  const outsider = await person('Outsider');
  const cal = await calendars.createCalendar(maker, {
    name: 'Board',
    access: {
      view: { roles: [{ id: 'r-board', name: 'Board' }] },
      edit: { people: [{ discordId: editor.discordId, name: 'Editor' }] },
      manage: { people: [{ discordId: manager.discordId, name: 'Manager' }] },
    },
  });
  const levelFor = async (u) =>
    ((await calendars.listCalendars(u)).calendars.find((c) => c.id === cal.id) || {}).level || null;
  assert.equal(await levelFor(viewer), 'view');
  assert.equal(await levelFor(editor), 'edit');
  assert.equal(await levelFor(manager), 'manage');
  assert.equal(await levelFor(outsider), null);

  // Seeing is not writing; writing is not changing who has access.
  await rejects(calendars.createEvent(viewer, eventBody(cal.id)), 403);
  const made = await calendars.createEvent(editor, eventBody(cal.id));
  await rejects(calendars.updateCalendar(editor, cal.id, { name: 'Mine' }), 403);
  // Edit changes every event, not only its own.
  await calendars.createEvent(maker, eventBody(cal.id, { title: 'By the maker' }));
  const theirs = (await eventsOf(editor)).find((e) => e.title === 'By the maker');
  await calendars.updateEvent(editor, theirs.id, eventBody(cal.id, { title: 'Renamed' }));
  // An outsider learns nothing about the calendar or its events.
  await rejects(calendars.getEvent(outsider, made.id), 404);
  await rejects(calendars.createEvent(outsider, eventBody(cal.id)), 404);

  await calendars.updateCalendar(manager, cal.id, { access: { view: { all: true } } });
  assert.equal(await levelFor(outsider), 'view');
});

test('calendar_admin manages every calendar, the site ones too', async () => {
  const admin = await person('Admin', ['calendar_admin']);
  const { calendars: list } = await calendars.listCalendars(admin);
  assert.ok(list.every((c) => c.level === 'manage'));
  const seminars = list.find((c) => c.system === 'seminars');
  await calendars.updateCalendar(admin, seminars.id, {
    announce: [{ channelId: '123456789', name: '#general', minutes: [1440, 60] }],
  });
  await rejects(calendars.archiveCalendar(admin, seminars.id, true), 400);
});

test('a repeating event: one occurrence, the following ones, the whole series', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Weekly' });
  const { id } = await calendars.createEvent(
    maker,
    eventBody(cal.id, { recurrence: { freq: 'weekly', interval: 1, count: 6 } })
  );
  let list = await eventsOf(maker);
  assert.equal(list.length, 6);
  assert.ok(list.every((e) => e.recurring && e.seriesId === id));

  // The third alone: renamed, an hour later.
  const third = list[2];
  await calendars.updateEvent(
    maker,
    id,
    eventBody(cal.id, {
      title: 'Special',
      start: iso(plus(third.start, 60)),
      end: iso(plus(third.end, 60)),
    }),
    { scope: 'this', occurrence: third.occurrence }
  );
  list = await eventsOf(maker);
  assert.equal(list.length, 6);
  assert.equal(list[2].title, 'Special');
  assert.equal(list[2].start, iso(plus(third.start, 60)));
  assert.equal(list[3].title, 'Reading group');

  // The fourth is skipped.
  await calendars.deleteEvent(maker, id, { scope: 'this', occurrence: list[3].occurrence });
  list = await eventsOf(maker);
  assert.equal(list.length, 5);

  // From the fifth on: a new series.
  const fifth = list[3];
  await calendars.updateEvent(
    maker,
    id,
    eventBody(cal.id, {
      title: 'New rhythm',
      start: fifth.start,
      end: fifth.end,
      recurrence: { freq: 'weekly', interval: 2, count: 3 },
    }),
    { scope: 'following', occurrence: fifth.occurrence }
  );
  list = await eventsOf(maker, plus(IN_A_WEEK, -60), plus(IN_A_WEEK, 60 * 24 * 90));
  assert.deepEqual(
    list.map((e) => e.title),
    ['Reading group', 'Reading group', 'Special', 'New rhythm', 'New rhythm', 'New rhythm']
  );

  // The whole first series goes.
  await calendars.deleteEvent(maker, id, { scope: 'all' });
  list = await eventsOf(maker, plus(IN_A_WEEK, -60), plus(IN_A_WEEK, 60 * 24 * 90));
  assert.deepEqual(
    list.map((e) => e.title),
    ['New rhythm', 'New rhythm', 'New rhythm']
  );
});

test('moving the whole series moves every occurrence by as much', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Daily' });
  const { id } = await calendars.createEvent(
    maker,
    eventBody(cal.id, { recurrence: { freq: 'daily', interval: 1, count: 3 } })
  );
  const [, second] = await eventsOf(maker);
  await calendars.updateEvent(
    maker,
    id,
    eventBody(cal.id, {
      start: iso(plus(second.start, 30)),
      end: iso(plus(second.end, 30)),
      recurrence: { freq: 'daily', interval: 1, count: 3 },
    }),
    { scope: 'all', occurrence: second.occurrence }
  );
  const list = await eventsOf(maker);
  assert.deepEqual(
    list.map((e) => e.start),
    [0, 1, 2].map((n) => iso(plus(IN_A_WEEK, 30 + n * 24 * 60)))
  );
});

test('all-day events run over whole days', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Holidays' });
  const day = iso(IN_A_WEEK).slice(0, 10);
  const next = iso(plus(IN_A_WEEK, 24 * 60 * 2)).slice(0, 10);
  await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Conference',
    allDay: true,
    startDate: day,
    endDate: next,
  });
  const [e] = await eventsOf(maker);
  assert.equal(e.allDay, true);
  assert.equal(e.start, `${day}T00:00:00.000Z`);
  assert.equal(new Date(e.end) - new Date(e.start), 3 * 86400000);
  await rejects(
    calendars.createEvent(maker, {
      calendarId: cal.id,
      title: 'Backwards',
      allDay: true,
      startDate: next,
      endDate: day,
    }),
    400
  );
});

test('members answer going, maybe or no, per occurrence', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const member = await person('Member');
  const cal = await calendars.createCalendar(maker, { name: 'Open' });
  const { id } = await calendars.createEvent(
    maker,
    eventBody(cal.id, { recurrence: { freq: 'weekly', interval: 1, count: 2 } })
  );
  const [first, second] = await eventsOf(member);
  let card = await calendars.rsvp(member, id, first.occurrence, 'yes');
  assert.equal(card.rsvp.mine, 'yes');
  assert.deepEqual(card.rsvp.counts, { yes: 1, maybe: 0, no: 0, waiting: 0 });
  card = await calendars.getEvent(member, id, second.occurrence);
  assert.equal(card.rsvp.mine, null);
  card = await calendars.rsvp(member, id, first.occurrence, null);
  assert.equal(card.rsvp.counts.yes, 0);
  await rejects(calendars.rsvp(member, id, iso(plus(first.start, 7)), 'yes'), 404);
});

test('the personal link carries the chosen calendars, and stops at a lost permission', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const member = await person('Member', [], ['r-team']);
  const team = await calendars.createCalendar(maker, {
    name: 'Team',
    access: { view: { roles: [{ id: 'r-team', name: 'Team' }] } },
  });
  const other = await calendars.createCalendar(maker, { name: 'Other' });
  await calendars.createEvent(maker, eventBody(team.id, { title: 'Team call' }));
  await calendars.createEvent(
    maker,
    eventBody(other.id, {
      title: 'Other; with, commas',
      recurrence: {
        freq: 'monthly',
        interval: 1,
        until: iso(plus(IN_A_WEEK, 60 * 24 * 100)).slice(0, 10),
      },
    })
  );

  const prefs = await calendars.getPrefs(member);
  assert.ok(prefs.feedToken.length >= 20);
  // By default, every calendar one sees: both, and the two of the site.
  assert.ok(prefs.calendars.every((c) => c.choice.dashboard && c.choice.ics && !c.choice.notify));
  let ics = feed.build(await calendars.personalFeed(prefs.feedToken));
  assert.match(ics, /SUMMARY:Team call/);
  assert.match(ics, /SUMMARY:Other\\; with\\, commas/);
  assert.match(ics, /RRULE:FREQ=MONTHLY;BYDAY=/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));

  // Simple mode: the dashboard and the link go together.
  await calendars.savePrefs(member, { selection: { [other.id]: { dashboard: false } } });
  ics = feed.build(await calendars.personalFeed(prefs.feedToken));
  assert.doesNotMatch(ics, /Other/);
  assert.equal(
    (await eventsOf(member)).some((e) => e.title.startsWith('Other')),
    false
  );

  // Advanced: each its own.
  await calendars.savePrefs(member, {
    advanced: true,
    selection: { [other.id]: { dashboard: false, ics: true, notify: true } },
  });
  ics = feed.build(await calendars.personalFeed(prefs.feedToken));
  assert.match(ics, /Other/);
  assert.equal(
    (await eventsOf(member)).some((e) => e.title.startsWith('Other')),
    false
  );

  // Without the role, the team's events leave the link at the next read.
  await db.query(`update app_users set roles = '{}' where id = $1`, [member.id]);
  ics = feed.build(await calendars.personalFeed(prefs.feedToken));
  assert.doesNotMatch(ics, /Team call/);

  // A new link: the old one is gone.
  const renewed = await calendars.regenerateFeed(member);
  assert.notEqual(renewed.feedToken, prefs.feedToken);
  assert.equal(await calendars.personalFeed(prefs.feedToken), null);
});

test('a public calendar is read without signing in; a private one is not', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const open = await calendars.createCalendar(maker, { name: 'Open day', isPublic: true });
  const closed = await calendars.createCalendar(maker, { name: 'Closed' });
  await calendars.createEvent(maker, eventBody(open.id, { title: 'Open talk' }));
  await calendars.createEvent(maker, eventBody(closed.id, { title: 'Secret' }));
  assert.ok((await calendars.publicCalendars()).some((c) => c.slug === 'open-day'));
  assert.equal(await calendars.publicFeed('closed'), null);
  const data = await calendars.publicFeed('open-day');
  assert.match(feed.build(data), /SUMMARY:Open talk/);
  const { events } = await calendars.publicEvents({
    from: iso(plus(IN_A_WEEK, -60)),
    to: iso(plus(IN_A_WEEK, 120)),
  });
  assert.deepEqual(
    events.map((e) => e.title),
    ['Open talk']
  );
});

test('a seminar of the site lands in Seminars, follows its changes, and can go elsewhere', async () => {
  const editor = await person('Editor', ['seminar', 'calendar_create']);
  const day = iso(IN_A_WEEK).slice(0, 10);
  const saved = await content.saveItem(editor, {
    type: 'seminar',
    day,
    time: '18:30',
    end_time: '20:00',
    title: 'Interpretability',
    title_it: 'Interpretabilità',
  });
  let list = await eventsOf(editor);
  const copy = list.find((e) => e.title === 'Interpretability');
  assert.ok(copy);
  assert.equal(copy.source.kind, 'content');
  assert.equal(copy.canEdit, false);
  await rejects(calendars.updateEvent(editor, copy.id, eventBody(copy.calendarId)), 409);

  const mine = await calendars.createCalendar(editor, { name: 'Mine' });
  await content.saveItem(
    editor,
    {
      type: 'seminar',
      day,
      time: '18:30',
      title: 'Interpretability 2',
      title_it: 'I2',
      calendar: mine.id,
    },
    saved.id
  );
  list = await eventsOf(editor);
  assert.equal(list.find((e) => e.title === 'Interpretability 2').calendarId, mine.id);

  await content.saveItem(
    editor,
    { type: 'seminar', day, title: 'Interpretability 3', title_it: 'I3', calendar: 'none' },
    saved.id
  );
  assert.equal(
    (await eventsOf(editor)).some((e) => e.title.startsWith('Interpretability')),
    false
  );

  await content.saveItem(
    editor,
    { type: 'seminar', day, title: 'All day', title_it: 'Tutto il giorno', calendar: '' },
    saved.id
  );
  const allDay = (await eventsOf(editor)).find((e) => e.title === 'All day');
  assert.equal(allDay.allDay, true);
  await content.deleteItem(editor, saved.id);
  assert.equal(
    (await eventsOf(editor)).some((e) => e.title === 'All day'),
    false
  );

  // A calendar one cannot add to is refused before anything is saved.
  const other = await person('Other', ['seminar']);
  await rejects(
    content.saveItem(other, {
      type: 'seminar',
      day,
      title: 'Nope',
      title_it: 'No',
      calendar: mine.id,
    }),
    403
  );
});

test("the server's members and roles are searched only by who gives access to a calendar", async () => {
  const plain = await person('Plain');
  const maker = await person('Maker', ['calendar_create']);
  const manager = await person('Manager');
  assert.equal(await calendars.sharesCalendars(plain), false);
  assert.equal(await calendars.sharesCalendars(maker), true);
  await calendars.createCalendar(maker, {
    name: 'Shared',
    access: { manage: { people: [{ discordId: manager.discordId, name: 'Manager' }] } },
  });
  assert.equal(await calendars.sharesCalendars(manager), true);
});

test("the site's items from before the calendar are in the public feeds at the first read", async () => {
  const day = iso(IN_A_WEEK).slice(0, 10);
  await content.importEntries([
    {
      category: 'seminar',
      anchor: 'old-seminar',
      day,
      time: '18:30',
      title: 'Old seminar',
      title_it: 'Vecchio',
    },
  ]);
  // As before the calendar existed: no copy, no marker.
  await db.query("delete from calendar_events where source = 'content'");
  await db.query("delete from app_settings where key = 'migration_calendar_content_times'");
  calendars.resetBackfill();
  const data = await calendars.publicFeed('seminars');
  assert.match(feed.build(data), /SUMMARY:Old seminar/);
});

test('a seminar imported from the YAML takes its hours from its date line', async () => {
  const day = iso(IN_A_WEEK).slice(0, 10);
  await content.importEntries([
    {
      category: 'seminar',
      anchor: 'yaml-seminar',
      day,
      date: 'Thursday 12 November 2026, 18:30–19:45 (CET)',
      title: 'From the YAML',
      title_it: 'Dal YAML',
    },
    {
      category: 'event',
      anchor: 'yaml-event',
      day,
      date: 'Thursday 12 November 2026, 17:00 (CET)',
      title: 'Start only',
      title_it: 'Solo inizio',
    },
  ]);
  const anyone = await person('Anyone');
  const list = await eventsOf(anyone);
  const seminar = list.find((e) => e.title === 'From the YAML');
  const event = list.find((e) => e.title === 'Start only');
  assert.equal(seminar.allDay, false);
  const local = (at) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(at));
  assert.deepEqual([local(seminar.start), local(seminar.end)], ['18:30', '19:45']);
  assert.equal(event.allDay, false);
  assert.deepEqual([local(event.start), local(event.end)], ['17:00', '18:00']);
});

test('the copies made all day before get their hours, and keep their id and who comes', async () => {
  const day = iso(IN_A_WEEK).slice(0, 10);
  await content.importEntries([
    {
      category: 'seminar',
      anchor: 'kept-seminar',
      day,
      date: 'Thursday 12 November 2026, 18:30 (CET)',
      title: 'Kept',
      title_it: 'Tenuto',
    },
  ]);
  const anyone = await person('Anyone');
  // As the first version left it: all day, with an answer on it.
  const { rows } = await db.query(
    "select id from calendar_events where source = 'content' and title = 'Kept'"
  );
  const id = rows[0].id;
  const midnight = new Date(`${day}T00:00:00Z`);
  await db.query(
    `update calendar_events set all_day = true, starts_at = $2, ends_at = $3 where id = $1`,
    [id, midnight, new Date(midnight.getTime() + 86400000)]
  );
  await calendars.rsvp(anyone, id, midnight.toISOString(), 'yes');
  await db.query("delete from app_settings where key = 'migration_calendar_content_times'");
  calendars.resetBackfill();

  const [copy] = (await eventsOf(anyone)).filter((e) => e.title === 'Kept');
  assert.equal(copy.id, id);
  assert.equal(copy.allDay, false);
  const card = await calendars.getEvent(anyone, id, copy.occurrence);
  assert.equal(card.rsvp.mine, 'yes');
  const { rows: contentRows } = await db.query(
    "select count(*)::int as n from content_items where slug = 'kept-seminar'"
  );
  assert.equal(contentRows[0].n, 1);
});
