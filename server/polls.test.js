// Tests for the meeting-poll server code, against a real Postgres (PGlite,
// in memory). Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const polls = require('./polls');
const auth = require('./auth');
const { route } = require('./http');

beforeEach(() => db.setDb(new PGlite()));

const DAY = '2026-11-03T';
const basePoll = (over = {}) => ({
  title: 'Board meeting',
  description: 'Quarterly review',
  location: 'Online',
  durationMinutes: 60,
  timezone: 'Europe/Rome',
  slots: [`${DAY}09:00:00Z`, `${DAY}10:00:00Z`, `${DAY}14:00:00Z`],
  ...over,
});

function fakeCalendar() {
  const calls = [];
  return {
    calls,
    async createEvent(e) {
      calls.push(['create', e]);
      return { id: 'evt1', htmlLink: 'https://calendar/evt1', meetLink: 'https://meet/x' };
    },
    async deleteEvent(id) {
      calls.push(['delete', id]);
    },
  };
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

test('a new poll is listed and its slots are sorted and de-duplicated', async () => {
  const { id, token } = await polls.createPoll(
    basePoll({ slots: [`${DAY}14:00:00Z`, `${DAY}09:00:00Z`, `${DAY}09:00:00.000Z`] })
  );
  assert.ok(token.length >= 20);
  const poll = await polls.getPollAdmin(id);
  assert.deepEqual(
    poll.slots.map((s) => s.start),
    [`${DAY}09:00:00.000Z`, `${DAY}14:00:00.000Z`]
  );
  assert.equal(poll.slots[0].end, `${DAY}10:00:00.000Z`);
  const list = await polls.listPolls();
  assert.equal(list.length, 1);
  assert.equal(list[0].slotCount, 2);
});

test('poll input is validated', async () => {
  await rejects(polls.createPoll(basePoll({ title: '  ' })), 400);
  await rejects(polls.createPoll(basePoll({ slots: [] })), 400);
  await rejects(polls.createPoll(basePoll({ slots: ['not a date'] })), 400);
  await rejects(polls.createPoll(basePoll({ durationMinutes: 0 })), 400);
  await rejects(polls.createPoll(basePoll({ timezone: 'Mars/Olympus' })), 400);
});

test('answers are counted, and the public view never exposes emails', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  const [a, b] = (await polls.getPollAdmin(id)).slots;
  await polls.submitResponse(token, {
    name: 'Giulia',
    email: 'Giulia@Example.org',
    votes: { [a.id]: 2, [b.id]: 1 },
  });
  await polls.submitResponse(token, {
    name: 'Marco',
    email: 'marco@example.org',
    votes: { [a.id]: 2 },
  });

  const pub = await polls.getPollPublic(token);
  assert.equal(pub.id, undefined);
  assert.equal(pub.token, undefined);
  assert.ok(!JSON.stringify(pub).includes('@'));
  assert.deepEqual(
    pub.slots.map((s) => [s.yes, s.maybe]),
    [
      [2, 0],
      [0, 1],
      [0, 0],
    ]
  );
  assert.equal(pub.responses.length, 2);

  const admin = await polls.getPollAdmin(id);
  assert.equal(admin.responses[0].email, 'giulia@example.org');
  assert.equal(admin.responses[0].votes[admin.slots[2].id], 0);
});

test('hidden responses hide names and counts too', async () => {
  const { token } = await polls.createPoll(basePoll({ hideResponses: true }));
  await polls.submitResponse(token, { name: 'Giulia', email: 'g@example.org', votes: {} });
  const pub = await polls.getPollPublic(token);
  assert.equal(pub.responses, null);
  assert.equal(pub.slots[0].yes, undefined);
  assert.equal(pub.responseCount, 1);
});

test('the same email cannot answer twice, but can edit with its token', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  const [a] = (await polls.getPollAdmin(id)).slots;
  const { editToken } = await polls.submitResponse(token, {
    name: 'Giulia',
    email: 'g@example.org',
    votes: { [a.id]: 2 },
  });
  await rejects(
    polls.submitResponse(token, { name: 'Other', email: 'G@example.org', votes: {} }),
    409
  );
  await polls.submitResponse(token, {
    name: 'Giulia R.',
    email: 'g@example.org',
    votes: { [a.id]: 0 },
    editToken,
  });
  const mine = (await polls.getPollPublic(token, editToken)).mine;
  assert.equal(mine.name, 'Giulia R.');
  assert.equal(mine.votes[a.id], 0);
  await rejects(
    polls.submitResponse(token, { name: 'X', email: 'x@example.org', editToken: 'nope' }),
    403
  );
});

test('a name already used on the poll is refused, ignoring case and spacing', async () => {
  const { token } = await polls.createPoll(basePoll());
  await polls.submitResponse(token, { name: 'Anna Rossi', email: 'anna@example.org' });
  await assert.rejects(
    polls.submitResponse(token, { name: '  anna   ROSSI ', email: 'other@example.org' }),
    (err) => err.status === 409 && err.details.field === 'name' && err.details.code === 'name_taken'
  );
  await assert.rejects(
    polls.submitResponse(token, { name: 'Someone', email: 'ANNA@example.org' }),
    (err) => err.status === 409 && err.details.field === 'email'
  );
});

test('the availability check reports taken names and emails, except your own', async () => {
  const { token } = await polls.createPoll(basePoll());
  const { editToken } = await polls.submitResponse(token, {
    name: 'Anna Rossi',
    email: 'anna@example.org',
  });
  assert.deepEqual(
    await polls.checkAvailability(token, { name: 'ANNA rossi', email: 'Anna@Example.org' }),
    { nameTaken: true, emailTaken: true }
  );
  assert.deepEqual(await polls.checkAvailability(token, { name: 'Marco', email: '' }), {
    nameTaken: false,
    emailTaken: false,
  });
  assert.deepEqual(
    await polls.checkAvailability(token, {
      name: 'Anna Rossi',
      email: 'anna@example.org',
      e: editToken,
    }),
    { nameTaken: false, emailTaken: false }
  );
});

test("editing cannot take another participant's name", async () => {
  const { token } = await polls.createPoll(basePoll());
  await polls.submitResponse(token, { name: 'Anna', email: 'anna@example.org' });
  const { editToken } = await polls.submitResponse(token, {
    name: 'Marco',
    email: 'm@example.org',
  });
  await assert.rejects(
    polls.submitResponse(token, { name: 'anna', email: 'm@example.org', editToken }),
    (err) => err.details && err.details.field === 'name'
  );
});

test('once the admin removes an answer, that person can answer again', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  const { editToken } = await polls.submitResponse(token, {
    name: 'Anna',
    email: 'anna@example.org',
  });
  const [answer] = (await polls.getPollAdmin(id)).responses;
  await polls.deleteResponse(id, answer.id);
  assert.equal((await polls.getPollPublic(token, editToken)).mine, null);
  await polls.submitResponse(token, { name: 'Anna', email: 'anna@example.org' });
  assert.equal((await polls.getPollAdmin(id)).responses.length, 1);
});

test('votes for unknown slots are ignored; odd values and bad emails are refused', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  const [a] = (await polls.getPollAdmin(id)).slots;
  await polls.submitResponse(token, { name: 'G', email: 'g@example.org', votes: { x: 2 } });
  const { rows } = await db.query('select count(*)::int as n from poll_votes');
  assert.equal(rows[0].n, 3);
  await rejects(
    polls.submitResponse(token, { name: 'H', email: 'h@example.org', votes: { [a.id]: 7 } }),
    400
  );
  await rejects(polls.submitResponse(token, { name: 'H', email: 'not-an-email' }), 400);
});

test('closed polls and past deadlines refuse answers', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  await polls.updatePoll(id, { status: 'closed' });
  await rejects(polls.submitResponse(token, { name: 'G', email: 'g@example.org' }), 409);

  const late = await polls.createPoll(basePoll({ deadline: '2020-01-01T00:00:00Z' }));
  assert.equal((await polls.getPollPublic(late.token)).open, false);
  await rejects(polls.submitResponse(late.token, { name: 'G', email: 'g@example.org' }), 409);
});

test('finalising invites the chosen people plus extra guests, once', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  const slots = (await polls.getPollAdmin(id)).slots;
  await polls.submitResponse(token, { name: 'Giulia', email: 'g@example.org', votes: {} });
  await polls.submitResponse(token, { name: 'Marco', email: 'm@example.org', votes: {} });
  const marco = (await polls.getPollAdmin(id)).responses.find((r) => r.name === 'Marco');

  const calendar = fakeCalendar();
  const done = await polls.finalizePoll(
    id,
    {
      slotId: slots[1].id,
      responseIds: [marco.id],
      extraEmails: ['Boss@Example.org', 'm@example.org'],
      createMeet: true,
    },
    calendar
  );
  const [kind, event] = calendar.calls[0];
  assert.equal(kind, 'create');
  assert.deepEqual(
    event.attendees.map((a) => a.email),
    ['m@example.org', 'boss@example.org']
  );
  assert.equal(event.start.toISOString(), `${DAY}10:00:00.000Z`);
  assert.equal(event.end.toISOString(), `${DAY}11:00:00.000Z`);
  assert.equal(event.createMeet, true);
  assert.equal(done.status, 'scheduled');
  assert.equal(done.finalSlotId, slots[1].id);
  assert.equal(done.meetLink, 'https://meet/x');

  const pub = await polls.getPollPublic(token);
  assert.equal(pub.finalSlot.id, slots[1].id);
  assert.equal(pub.open, false);

  await rejects(polls.finalizePoll(id, { slotId: slots[0].id }, calendar), 409);
  await rejects(polls.updatePoll(id, { status: 'open' }), 409);

  const undone = await polls.unschedulePoll(id, calendar);
  assert.deepEqual(calendar.calls[1], ['delete', 'evt1']);
  assert.equal(undone.status, 'closed');
  assert.equal(undone.finalSlotId, null);
});

test('finalising with a slot from another poll is refused', async () => {
  const one = await polls.createPoll(basePoll());
  const two = await polls.createPoll(basePoll());
  const foreign = (await polls.getPollAdmin(two.id)).slots[0];
  await rejects(polls.finalizePoll(one.id, { slotId: foreign.id }, fakeCalendar()), 400);
});

test('deleting a poll removes its responses', async () => {
  const { id, token } = await polls.createPoll(basePoll());
  await polls.submitResponse(token, { name: 'G', email: 'g@example.org' });
  await polls.deletePoll(id);
  await rejects(polls.getPollAdmin(id), 404);
  const { rows } = await db.query('select count(*)::int as n from poll_responses');
  assert.equal(rows[0].n, 0);
});

test('malformed ids are a 400, not a database error', async () => {
  await rejects(polls.getPollAdmin("1' or 1=1"), 400);
  await rejects(polls.getPollPublic('nope'), 404);
});

// ── Auth ───────────────────────────────────────────────────────────────────

test('passwords are checked against their scrypt hash', () => {
  const hash = auth.hashPassword('correct horse battery');
  assert.ok(auth.verifyPassword('correct horse battery', hash));
  assert.ok(!auth.verifyPassword('wrong', hash));
  assert.ok(!auth.verifyPassword('anything', ''));
});

test('sessions expire and cannot be forged', () => {
  const session = auth.makeSession(Date.now());
  assert.ok(auth.isValidSession(session));
  assert.ok(!auth.isValidSession(session, Date.now() + 8 * 24 * 3600 * 1000));
  const [, sig] = session.split('.');
  assert.ok(!auth.isValidSession(`${Date.now() + 1e12}.${sig}`));
  assert.ok(!auth.isValidSession('garbage'));
});

function fakeRequest({ method = 'POST', body, cookie, ip = '1.2.3.4' } = {}) {
  return {
    method,
    url: '/api/admin/session',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': ip },
    body,
  };
}

function fakeResponse() {
  const res = {
    headers: {},
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = v;
    },
    end(body) {
      res.body = body && JSON.parse(body);
    },
  };
  return res;
}

test('logging in sets a cookie that signs the admin in; repeated failures are throttled', async () => {
  process.env.ADMIN_PASSWORD_HASH = auth.hashPassword('right password');
  const handler = require('../api/admin/session');

  let res = fakeResponse();
  await handler(fakeRequest({ body: { password: 'right password' } }), res);
  assert.equal(res.statusCode, 200);
  const cookie = res.headers['set-cookie'].split(';')[0];
  assert.ok(res.headers['set-cookie'].includes('HttpOnly'));
  assert.ok(auth.isAdmin({ headers: { cookie } }));

  for (let i = 0; i < 10; i++) {
    res = fakeResponse();
    await handler(fakeRequest({ body: { password: 'wrong' }, ip: '9.9.9.9' }), res);
    assert.equal(res.statusCode, 401);
  }
  res = fakeResponse();
  await handler(fakeRequest({ body: { password: 'right password' }, ip: '9.9.9.9' }), res);
  assert.equal(res.statusCode, 429);
});

test('admin endpoints refuse requests without a session', async () => {
  const handler = require('../api/admin/polls');
  const res = fakeResponse();
  await handler(fakeRequest({ method: 'GET' }), res);
  assert.equal(res.statusCode, 401);
});

test('non-JSON writes are refused', async () => {
  const handler = route({ POST: async () => {} });
  const res = fakeResponse();
  await handler({ method: 'POST', url: '/', headers: { 'content-type': 'text/plain' } }, res);
  assert.equal(res.statusCode, 415);
});
