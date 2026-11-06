// Tests for the people in the calendar: My calendar, invites by name and by
// address, answering from an email link or a Discord button, who sees who
// comes, and the two kinds of reminders (the event's, and one's own).
// On invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const calendars = require('./calendars');
const invites = require('./calendar-invites');
const interactions = require('./discord-interactions');
const reminders = require('./calendar-reminders');
const notify = require('./notify');
const mail = require('./mail');

const discordCalls = [];
const emails = [];
beforeEach(async () => {
  await testDb.fresh();
  calendars.resetBackfill();
  discordCalls.length = 0;
  emails.length = 0;
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'test-bot';
  process.env.DISCORD_GUILD_ID = '111111111';
  delete process.env.DISCORD_PUBLIC_KEY;
  delete process.env.MEET_DEV_LOGIN;
  const fake = async (url, opts = {}) => {
    if (/\/guilds\/\d+\/members\//.test(String(url)))
      return { ok: false, status: 503, json: async () => ({}) };
    discordCalls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ id: 'dm-channel' }) };
  };
  notify.setFetch(fake);
  permissions.setFetch(fake);
  mail.setTransportFactory(() => ({
    async sendMail(message) {
      emails.push(message);
    },
  }));
  await mail.saveSettings({
    host: 'smtp.example.org',
    port: 465,
    user: 'tech@ais4i.it',
    password: 'secret',
    fromEmail: 'tech@ais4i.it',
  });
});

let roles;
beforeEach(() => {
  roles = [];
});
async function person(name, keys = [], { channel = 'email', email } = {}) {
  const roleId = `r-${name.toLowerCase()}`;
  if (keys.length) roles.push({ roleId, roleName: name, permissions: keys });
  await permissions.saveRolePermissions(roles);
  const discordId = String(900000000 + Math.floor(Math.random() * 99999));
  const user = await auth.upsertDiscordUser({
    discordId,
    name,
    roles: [roleId],
    email: email || `${name.toLowerCase()}@example.org`,
  });
  await db.query('update app_users set notify_channel = $2 where id = $1', [user.id, channel]);
  return Object.assign(user, { discordId });
}

const iso = (d) => new Date(d).toISOString();
const SITE = 'https://www.example.org';

function soon(hours = 3) {
  const d = new Date(Date.now() + hours * 3600000);
  d.setUTCSeconds(0, 0);
  return d;
}

async function myCalendar(user) {
  return (await calendars.listCalendars(user)).calendars.find((c) => c.personal);
}

test('My calendar is its owner’s alone, not even the calendar admins’', async () => {
  const anna = await person('Anna');
  const admin = await person('Admin', ['calendar_admin']);
  const mine = await myCalendar(anna);
  assert.equal(mine.name, 'My calendar');
  assert.equal(mine.level, 'manage');
  assert.ok(!(await calendars.listCalendars(admin)).calendars.some((c) => c.id === mine.id));
  const { id } = await calendars.createEvent(anna, {
    calendarId: mine.id,
    title: 'Dentist',
    start: iso(soon()),
    end: iso(soon(4)),
  });
  await assert.rejects(calendars.getEvent(admin, id), (e) => e.status === 404);
  // Nothing to share, nothing to archive.
  const after = await calendars.updateCalendar(anna, mine.id, {
    name: 'Mine',
    isPublic: true,
    access: { view: { all: true } },
  });
  assert.equal(after.isPublic, false);
  assert.ok(!(await calendars.listCalendars(admin)).calendars.some((c) => c.id === mine.id));
  await assert.rejects(calendars.archiveCalendar(anna, mine.id, true), (e) => e.status === 400);
});

test('invited by name or by address: they see the event, and answer from the email', async () => {
  const anna = await person('Anna');
  const marco = await person('Marco');
  const mine = await myCalendar(anna);
  const start = soon(24);
  const { id } = await calendars.createEvent(anna, {
    calendarId: mine.id,
    title: 'Coffee',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
  });
  await invites.setInvites(anna, id, {
    members: [marco.id],
    emails: 'guest@elsewhere.org, ',
  });
  // Marco sees it in his calendar, invited, without seeing Anna's calendar.
  const window = { from: iso(start.getTime() - 86400000), to: iso(start.getTime() + 86400000) };
  const his = (await calendars.listEvents(marco, window)).events;
  assert.deepEqual(
    his.map((e) => [e.title, e.invited]),
    [['Coffee', true]]
  );
  const card = await calendars.getEvent(marco, id);
  assert.equal(card.calendar.name, 'Anna’s calendar');
  assert.equal(card.canEdit, false);
  await assert.rejects(
    calendars.updateEvent(marco, id, { title: 'x', start: iso(start), end: iso(start) }),
    (e) => e.status === 403
  );

  // The invites go out: the guest by email with the answers, Marco as he chose.
  const out = await invites.sendInvites(anna, id, { site: SITE });
  assert.deepEqual(out, { sent: 2, failed: 0 });
  const guestMail = emails.find((m) => m.to === 'guest@elsewhere.org');
  assert.equal(guestMail.icalEvent.method, 'REQUEST');
  assert.match(guestMail.icalEvent.content, new RegExp(`UID:${id}@ais4i.it`));
  const yes = guestMail.text.match(/Going: (\S+)/)[1];
  const token = new URL(yes).searchParams.get('t');
  // Sent once: a second send goes to nobody new.
  assert.deepEqual(await invites.sendInvites(anna, id, { site: SITE }), { sent: 0, failed: 0 });

  // The guest answers through the link: the page shows the event and who comes.
  const page = await invites.byLink(token, 'yes');
  assert.equal(page.title, 'Coffee');
  assert.equal(page.rsvp.mine, 'yes');
  assert.deepEqual(page.rsvp.people.map((p) => [p.name, p.answer]).sort(), [
    ['Marco', null],
    ['guest@elsewhere.org', 'yes'],
  ]);
  // A link altered by a single character answers nothing.
  await assert.rejects(invites.byLink(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), 'no'), (e) => e.status === 404);

  // Marco answers in the calendar; Anna sees both, with names.
  await calendars.rsvp(marco, id, iso(start), 'maybe');
  const hers = await calendars.getEvent(anna, id);
  assert.deepEqual(hers.rsvp.counts, { yes: 1, maybe: 1, no: 0, waiting: 0 });
  assert.equal(hers.invites.length, 2);
  // Taken off the list: the invite and the event leave Marco's calendar.
  await invites.setInvites(anna, id, { members: [], emails: ['guest@elsewhere.org'] });
  assert.equal((await calendars.listEvents(marco, window)).events.length, 0);
});

test('who sees who comes: the calendar decides, those invited see each other', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const member = await person('Member');
  const guest = await person('Guest');
  const cal = await calendars.createCalendar(maker, { name: 'Team', attendeesVisible: 'counts' });
  const start = soon(30);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'All hands',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
  });
  await calendars.rsvp(maker, id, iso(start), 'yes');
  await calendars.rsvp(member, id, iso(start), 'yes');
  // A member of the calendar: the numbers only.
  let card = await calendars.getEvent(member, id);
  assert.equal(card.rsvp.namesHidden, true);
  assert.equal(card.rsvp.people, null);
  assert.equal(card.rsvp.counts.yes, 2);
  // Its editor: the names.
  assert.equal((await calendars.getEvent(maker, id)).rsvp.people.length, 2);
  // Someone invited: the names, as in a poll.
  await invites.setInvites(maker, id, { members: [guest.id] });
  card = await calendars.getEvent(guest, id);
  assert.equal(card.rsvp.namesHidden, false);
  // The calendar opens it to its members.
  await calendars.updateCalendar(maker, cal.id, { attendeesVisible: 'members' });
  assert.equal((await calendars.getEvent(member, id)).rsvp.namesHidden, false);
});

test('a Discord button answers for whoever clicks, signed by Discord only', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  process.env.DISCORD_PUBLIC_KEY = raw.toString('hex');
  const maker = await person('Maker', ['calendar_create']);
  const cal = await calendars.createCalendar(maker, { name: 'Team' });
  const start = soon(5);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Planning',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
  });
  const [row] = invites.discordButtons(id, start);
  const body = JSON.stringify({
    type: 3,
    data: { custom_id: row.components[0].custom_id },
    member: { roles: [], user: { id: '987654321098', username: 'newbie' } },
  });
  const ts = '1700000000';
  const signature = crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  assert.equal(interactions.verify(body, signature, ts), true);
  assert.equal(interactions.verify(body + ' ', signature, ts), false);
  assert.deepEqual(await interactions.handle({ type: 1 }), { type: 1 });

  // Someone who never signed in: made a member, and answers (Team is open to all).
  const reply = await interactions.handle(JSON.parse(body));
  assert.equal(reply.data.flags, 64);
  assert.match(reply.data.content, /Going/);
  const card = await calendars.getEvent(maker, id);
  assert.deepEqual(
    card.rsvp.people.map((p) => [p.name, p.answer]),
    [['newbie', 'yes']]
  );
  // A calendar they do not see: refused.
  const closed = await calendars.createCalendar(maker, {
    name: 'Board',
    access: { view: { all: false } },
  });
  const other = await calendars.createEvent(maker, {
    calendarId: closed.id,
    title: 'Secret',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
  });
  const denied = await interactions.handle({
    type: 3,
    data: { custom_id: invites.discordButtons(other.id, start)[0].components[0].custom_id },
    member: { roles: [], user: { id: '987654321098', username: 'newbie' } },
  });
  assert.match(denied.data.content, /cannot answer/);
});

test('the event’s reminders and one’s own: each as chosen, sent once', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const ada = await person('Ada', [], { channel: 'email' });
  const bo = await person('Bo', [], { channel: 'discord' });
  const cy = await person('Cy');
  const cal = await calendars.createCalendar(maker, { name: 'Seminars club' });
  const start = soon(26);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Talk',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    reminders: [{ minutes: 1440, channels: ['discord'] }],
  });
  // Ada takes the calendar's reminders by email, and adds her own an hour before.
  await calendars.savePrefs(ada, {
    notify: true,
    selection: {
      [cal.id]: { dashboard: true, via: 'email', own: [{ minutes: 60, channels: ['email'] }] },
    },
  });
  // Bo does not follow the calendar, but wants this one event 15 minutes before.
  await calendars.getPrefs(bo);
  await calendars.setEventPrefs(bo, id, { own: [{ minutes: 15, channels: ['discord'] }] });
  // Cy follows, but switched this event's reminders off.
  await calendars.savePrefs(cy, { notify: true });
  await calendars.setEventPrefs(cy, id, { eventReminders: 'off' });
  // An address invited gets the event's reminder by email.
  await invites.setInvites(maker, id, { emails: ['guest@elsewhere.org'] });

  const at = (minutes) => new Date(start.getTime() - minutes * 60000 + 30000);
  emails.length = 0;
  discordCalls.length = 0;
  let r = await reminders.run({ now: at(1440), origin: SITE });
  // A day before: Ada by email (her channel, not the event's), the guest by email.
  assert.deepEqual(emails.map((m) => m.to).sort(), ['ada@example.org', 'guest@elsewhere.org']);
  assert.match(emails.find((m) => m.to === 'ada@example.org').text, /set by whoever organises it/);
  assert.match(emails[0].text, /Going: https:\/\/www\.example\.org\/rsvp\/\?t=/);
  assert.equal(r.reminders, 2);
  assert.deepEqual(
    discordCalls.filter((c) => c.url.endsWith('/users/@me/channels')),
    []
  );
  // An hour before: Ada's own.
  emails.length = 0;
  r = await reminders.run({ now: at(60), origin: SITE });
  assert.deepEqual(
    emails.map((m) => m.to),
    ['ada@example.org']
  );
  assert.match(emails[0].text, /One of your own reminders/);
  // A quarter of an hour before: Bo's, on Discord.
  discordCalls.length = 0;
  r = await reminders.run({ now: at(15), origin: SITE });
  assert.deepEqual(
    discordCalls
      .filter((c) => c.url.endsWith('/users/@me/channels'))
      .map((c) => c.body.recipient_id),
    [bo.discordId]
  );
  // Nothing twice.
  assert.equal((await reminders.run({ now: at(14), origin: SITE })).reminders, 0);
  // Ada's card says what she gets.
  const card = await calendars.getEvent(ada, id);
  assert.equal(card.myReminders.via, 'email');
  assert.deepEqual(card.myReminders.calendarOwn, [{ minutes: 60, channels: ['email'] }]);
});

test('a reminder of an event one declined does not come', async () => {
  const maker = await person('Maker', ['calendar_create']);
  const ada = await person('Ada');
  const cal = await calendars.createCalendar(maker, { name: 'Team' });
  const start = soon(2);
  const { id } = await calendars.createEvent(maker, {
    calendarId: cal.id,
    title: 'Sync',
    start: iso(start),
    end: iso(start.getTime() + 3600000),
    reminders: [{ minutes: 60, channels: ['email'] }],
  });
  await calendars.savePrefs(ada, { notify: true });
  await calendars.rsvp(ada, id, iso(start), 'no');
  emails.length = 0;
  await reminders.run({ now: new Date(start.getTime() - 59 * 60000), origin: SITE });
  assert.deepEqual(emails, []);
});
