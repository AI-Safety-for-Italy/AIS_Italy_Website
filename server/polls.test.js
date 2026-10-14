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

// The signed-in user the polls in these tests belong to. Idempotent, so it can
// be called wherever an owner is needed.
async function owner(name = 'Owner') {
  const user = await auth.upsertDiscordUser({ discordId: `test-${name}`, name });
  return user.id;
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

test('a new poll is listed and its slots are sorted and de-duplicated', async () => {
  const { id, token } = await polls.createPoll(
    basePoll({ slots: [`${DAY}14:00:00Z`, `${DAY}09:00:00Z`, `${DAY}09:00:00.000Z`] }),
    await owner()
  );
  assert.ok(token.length >= 20);
  const poll = await polls.getPollAdmin(id, await owner());
  assert.deepEqual(
    poll.slots.map((s) => s.start),
    [`${DAY}09:00:00.000Z`, `${DAY}14:00:00.000Z`]
  );
  assert.equal(poll.slots[0].end, `${DAY}10:00:00.000Z`);
  const list = await polls.listPolls(await owner());
  assert.equal(list.length, 1);
  assert.equal(list[0].slotCount, 2);
});

test('poll input is validated', async () => {
  await rejects(polls.createPoll(basePoll({ title: '  ' }), await owner()), 400);
  await rejects(polls.createPoll(basePoll({ slots: [] }), await owner()), 400);
  await rejects(polls.createPoll(basePoll({ slots: ['not a date'] }), await owner()), 400);
  await rejects(polls.createPoll(basePoll({ durationMinutes: 0 }), await owner()), 400);
  await rejects(polls.createPoll(basePoll({ timezone: 'Mars/Olympus' }), await owner()), 400);
});

test('answers are counted, and the public view never exposes emails', async () => {
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  const [a, b] = (await polls.getPollAdmin(id, await owner())).slots;
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

  const admin = await polls.getPollAdmin(id, await owner());
  assert.equal(admin.responses[0].email, 'giulia@example.org');
  assert.equal(admin.responses[0].votes[admin.slots[2].id], 0);
});

test('hidden responses hide names and counts too', async () => {
  const { token } = await polls.createPoll(basePoll({ hideResponses: true }), await owner());
  await polls.submitResponse(token, { name: 'Giulia', email: 'g@example.org', votes: {} });
  const pub = await polls.getPollPublic(token);
  assert.equal(pub.responses, null);
  assert.equal(pub.slots[0].yes, undefined);
  assert.equal(pub.responseCount, 1);
});

test('the same email cannot answer twice, but can edit with its token', async () => {
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  const [a] = (await polls.getPollAdmin(id, await owner())).slots;
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
  const { token } = await polls.createPoll(basePoll(), await owner());
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
  const { token } = await polls.createPoll(basePoll(), await owner());
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
  const { token } = await polls.createPoll(basePoll(), await owner());
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
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  const { editToken } = await polls.submitResponse(token, {
    name: 'Anna',
    email: 'anna@example.org',
  });
  const [answer] = (await polls.getPollAdmin(id, await owner())).responses;
  await polls.deleteResponse(id, answer.id, await owner());
  assert.equal((await polls.getPollPublic(token, editToken)).mine, null);
  await polls.submitResponse(token, { name: 'Anna', email: 'anna@example.org' });
  assert.equal((await polls.getPollAdmin(id, await owner())).responses.length, 1);
});

// Two submissions racing with the same name both pass the availability check
// before either has inserted. PGlite runs one query at a time, so the race is
// simulated by having that check report "free" while the row already exists.
function blindAvailabilityCheck(pglite) {
  const blind = (conn) => ({
    query(text, params) {
      if (/bool_or\(lower\(name\)/.test(text)) return { rows: [{ name: false, email: false }] };
      return conn.query(text, params);
    },
  });
  return {
    query: (text, params) => pglite.query(text, params),
    exec: (text) => pglite.exec(text),
    transaction: (fn) => pglite.transaction((tx) => fn(blind(tx))),
  };
}

test('a racing duplicate is stopped by the database with the right message', async () => {
  const pglite = new PGlite();
  db.setDb(pglite);
  const { token } = await polls.createPoll(basePoll(), await owner());
  await polls.submitResponse(token, { name: 'Anna', email: 'anna@example.org' });

  db.setDb(blindAvailabilityCheck(pglite));
  await assert.rejects(
    polls.submitResponse(token, { name: 'ANNA', email: 'other@example.org' }),
    (err) => err.status === 409 && err.details.field === 'name'
  );
  await assert.rejects(
    polls.submitResponse(token, { name: 'Marco', email: 'Anna@example.org' }),
    (err) => err.status === 409 && err.details.field === 'email'
  );
  const { rows } = await pglite.query('select count(*)::int as n from poll_responses');
  assert.equal(rows[0].n, 1);
});

test('other unique violations are not reported as a taken name or email', async () => {
  const pglite = new PGlite();
  db.setDb(pglite);
  const { token } = await polls.createPoll(basePoll(), await owner());
  const clash = Object.assign(new Error('duplicate vote'), {
    code: '23505',
    constraint: 'poll_votes_pkey',
  });
  db.setDb({
    query: (text, params) => pglite.query(text, params),
    exec: (text) => pglite.exec(text),
    transaction: () => Promise.reject(clash),
  });
  await assert.rejects(
    polls.submitResponse(token, { name: 'Anna', email: 'anna@example.org' }),
    (err) => err === clash
  );
});

test('the schema can be applied again to an existing database', async () => {
  const pglite = new PGlite();
  db.setDb(pglite);
  await db.ensureSchema();
  db.setDb(pglite);
  await db.ensureSchema();
  const { rows } = await pglite.query(
    "select count(*)::int as n from information_schema.tables where table_name like 'poll%'"
  );
  assert.equal(rows[0].n, 4);
});

test('votes for unknown slots are ignored; odd values and bad emails are refused', async () => {
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  const [a] = (await polls.getPollAdmin(id, await owner())).slots;
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
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  await polls.updatePoll(id, { status: 'closed' }, await owner());
  await rejects(polls.submitResponse(token, { name: 'G', email: 'g@example.org' }), 409);

  const late = await polls.createPoll(
    basePoll({ deadline: '2020-01-01T00:00:00Z' }),
    await owner()
  );
  assert.equal((await polls.getPollPublic(late.token)).open, false);
  await rejects(polls.submitResponse(late.token, { name: 'G', email: 'g@example.org' }), 409);
});

test('choosing a time marks the poll scheduled and closes voting, until cleared', async () => {
  const me = await owner();
  const { id, token } = await polls.createPoll(basePoll(), me);
  const slots = (await polls.getPollAdmin(id, me)).slots;

  const done = await polls.finalizePoll(id, { slotId: slots[1].id }, me);
  assert.equal(done.status, 'scheduled');
  assert.equal(done.finalSlotId, slots[1].id);
  const pub = await polls.getPollPublic(token);
  assert.equal(pub.finalSlot.id, slots[1].id);
  assert.equal(pub.open, false);
  await rejects(polls.submitResponse(token, { name: 'Late', email: 'l@example.org' }), 409);

  await rejects(polls.finalizePoll(id, { slotId: slots[0].id }, me), 409);
  await rejects(polls.updatePoll(id, { status: 'open' }, me), 409);

  const cleared = await polls.unschedulePoll(id, me);
  assert.equal(cleared.status, 'closed');
  assert.equal(cleared.finalSlotId, null);
  await rejects(polls.unschedulePoll(id, me), 409);
});

test('finalising with a slot from another poll is refused', async () => {
  const one = await polls.createPoll(basePoll(), await owner());
  const two = await polls.createPoll(basePoll(), await owner());
  const foreign = (await polls.getPollAdmin(two.id, await owner())).slots[0];
  await rejects(polls.finalizePoll(one.id, { slotId: foreign.id }, await owner()), 400);
});

test('deleting a poll removes its responses', async () => {
  const { id, token } = await polls.createPoll(basePoll(), await owner());
  await polls.submitResponse(token, { name: 'G', email: 'g@example.org' });
  await polls.deletePoll(id, await owner());
  await rejects(polls.getPollAdmin(id, await owner()), 404);
  const { rows } = await db.query('select count(*)::int as n from poll_responses');
  assert.equal(rows[0].n, 0);
});

test('malformed ids are a 400, not a database error', async () => {
  await rejects(polls.getPollAdmin("1' or 1=1", await owner()), 400);
  await rejects(polls.getPollPublic('nope'), 404);
});

// ── Auth ───────────────────────────────────────────────────────────────────

test('passwords are checked against their scrypt hash', () => {
  const hash = auth.hashPassword('correct horse battery');
  assert.ok(auth.verifyPassword('correct horse battery', hash));
  assert.ok(!auth.verifyPassword('wrong', hash));
  assert.ok(!auth.verifyPassword('anything', ''));
});

test('sessions name a user, expire, and cannot be forged', () => {
  const session = auth.makeSession('user-1');
  assert.equal(auth.readSession(session), 'user-1');
  assert.equal(auth.readSession(session, Date.now() + 8 * 24 * 3600 * 1000), null);
  const [, expires, sig] = session.split('.');
  assert.equal(auth.readSession(`user-2.${expires}.${sig}`), null);
  assert.equal(auth.readSession('garbage'), null);
});

function fakeRequest({ method = 'POST', url = '/api/auth', body, cookie, ip = '1.2.3.4' } = {}) {
  return {
    method,
    url,
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': ip,
      host: 'www.example.org',
    },
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

const cookieFrom = (res) =>
  []
    .concat(res.headers['set-cookie'])
    .map((c) => c.split(';')[0])
    .join('; ');

test('the admin password signs in as the admin user; repeated failures are throttled', async () => {
  process.env.ADMIN_PASSWORD_HASH = auth.hashPassword('right password');
  const handler = require('../api/auth');
  const url = '/api/auth?action=password';

  let res = fakeResponse();
  await handler(fakeRequest({ url, body: { password: 'right password' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.kind, 'admin');
  assert.ok(res.headers['set-cookie'].includes('HttpOnly'));
  const me = await auth.currentUser({ headers: { cookie: cookieFrom(res) } });
  assert.equal(me.kind, 'admin');

  for (let i = 0; i < 10; i++) {
    res = fakeResponse();
    await handler(fakeRequest({ url, body: { password: 'wrong' }, ip: '9.9.9.9' }), res);
    assert.equal(res.statusCode, 401);
  }
  res = fakeResponse();
  await handler(fakeRequest({ url, body: { password: 'right password' }, ip: '9.9.9.9' }), res);
  assert.equal(res.statusCode, 429);
});

test('polls from before accounts existed belong to the admin', async () => {
  const pglite = new PGlite();
  db.setDb(pglite);
  await db.ensureSchema();
  await pglite.query('update polls set owner_id = null');
  await pglite.query(
    `insert into polls (token, title, duration_minutes) values ('old', 'Old poll', 60)`
  );
  db.setDb(pglite); // re-runs the schema, as a new deployment would
  await db.ensureSchema();
  const { rows } = await pglite.query(
    `select u.kind from polls p join app_users u on u.id = p.owner_id where p.token = 'old'`
  );
  assert.equal(rows[0].kind, 'admin');
});

test('each user sees and changes only their own polls', async () => {
  const anna = await owner('Anna');
  const marco = await owner('Marco');
  const { id, token } = await polls.createPoll(basePoll(), anna);
  await polls.submitResponse(token, { name: 'G', email: 'g@example.org' });
  const answer = (await polls.getPollAdmin(id, anna)).responses[0];

  assert.equal((await polls.listPolls(anna)).length, 1);
  assert.equal((await polls.listPolls(marco)).length, 0);
  await rejects(polls.getPollAdmin(id, marco), 404);
  await rejects(polls.updatePoll(id, { status: 'closed' }, marco), 404);
  await rejects(polls.finalizePoll(id, { slotId: answer.id }, marco), 404);
  await rejects(polls.deleteResponse(id, answer.id, marco), 404);
  await rejects(polls.deletePoll(id, marco), 404);
  assert.equal((await polls.getPollAdmin(id, anna)).responses.length, 1);
});

test('poll endpoints refuse requests without a session', async () => {
  for (const file of ['../api/app/polls', '../api/app/poll']) {
    const res = fakeResponse();
    await require(file)(fakeRequest({ method: 'GET', url: '/x?id=1' }), res);
    assert.equal(res.statusCode, 401);
  }
});

test('non-JSON writes are refused', async () => {
  const handler = route({ POST: async () => {} });
  const res = fakeResponse();
  await handler({ method: 'POST', url: '/', headers: { 'content-type': 'text/plain' } }, res);
  assert.equal(res.statusCode, 415);
});

// ── Discord ────────────────────────────────────────────────────────────────

const discord = require('./discord');

function discordEnv() {
  Object.assign(process.env, {
    DISCORD_CLIENT_ID: 'cid',
    DISCORD_CLIENT_SECRET: 'csecret',
    DISCORD_GUILD_ID: 'guild1',
    DISCORD_ROLE_IDS: 'roleA, roleB',
  });
}

/** A stand-in for discord.com answering the three calls verify() makes. */
function fakeDiscord({ member = { roles: ['roleB'], nick: 'Anna R.' }, memberStatus = 200 } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const impl = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/oauth2/token')) {
      assert.equal(new URLSearchParams(init.body).get('code'), 'the-code');
      return reply(200, { access_token: 'tok' });
    }
    if (url.endsWith('/users/@me')) {
      return reply(200, {
        id: '42',
        username: 'anna',
        avatar: 'abc',
        email: 'Anna@x.org',
        verified: true,
      });
    }
    if (url.endsWith('/users/@me/guilds/guild1/member')) {
      return reply(memberStatus, memberStatus === 200 ? member : { code: 10004 });
    }
    throw new Error('unexpected ' + url);
  };
  impl.calls = calls;
  return impl;
}

test('Discord sign-in returns the member profile when they hold an allowed role', async () => {
  discordEnv();
  const profile = await discord.verify(
    { code: 'the-code', redirectUri: 'https://x/api/discord' },
    fakeDiscord()
  );
  assert.deepEqual(profile, {
    discordId: '42',
    name: 'Anna R.',
    avatarUrl: 'https://cdn.discordapp.com/avatars/42/abc.png?size=64',
    email: 'Anna@x.org',
  });
});

test('Discord sign-in refuses non-members and members without an allowed role', async () => {
  discordEnv();
  const args = { code: 'the-code', redirectUri: 'https://x/api/discord' };
  await assert.rejects(discord.verify(args, fakeDiscord({ memberStatus: 404 })), {
    code: 'not_member',
  });
  await assert.rejects(discord.verify(args, fakeDiscord({ member: { roles: ['other'] } })), {
    code: 'missing_role',
  });
});

test('a Discord account is created once and refreshed on later logins', async () => {
  const first = await auth.upsertDiscordUser({ discordId: '42', name: 'Anna' });
  const again = await auth.upsertDiscordUser({ discordId: '42', name: 'Anna Rossi' });
  assert.equal(first.id, again.id);
  assert.equal(again.name, 'Anna Rossi');
});

test('the Discord flow sends people to Discord and checks the state on return', async () => {
  discordEnv();
  const handler = require('../api/discord');

  const start = fakeResponse();
  await handler(fakeRequest({ method: 'GET', url: '/api/discord?next=/app/polls/' }), start);
  assert.equal(start.statusCode, 302);
  const to = new URL(start.headers.location);
  assert.equal(to.host, 'discord.com');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://www.example.org/api/discord');
  assert.match(start.headers['set-cookie'], /SameSite=Lax/);
  const state = to.searchParams.get('state');
  const cookie = cookieFrom(start);

  const back = async (query) => {
    const res = fakeResponse();
    await handler(fakeRequest({ method: 'GET', url: `/api/discord?${query}`, cookie }), res);
    return res.headers.location;
  };
  assert.equal(await back('code=c&state=forged'), '/app/login/?error=expired');
  assert.equal(await back(`error=access_denied&state=${state}`), '/app/login/?error=denied');
});

test('a successful Discord return creates the account, signs in and continues', async () => {
  discordEnv();
  const handler = require('../api/discord');
  const start = fakeResponse();
  await handler(fakeRequest({ method: 'GET', url: '/api/discord?next=/app/polls/' }), start);
  const state = new URL(start.headers.location).searchParams.get('state');

  const realFetch = global.fetch;
  global.fetch = fakeDiscord();
  try {
    const res = fakeResponse();
    await handler(
      fakeRequest({
        method: 'GET',
        url: `/api/discord?code=the-code&state=${state}`,
        cookie: cookieFrom(start),
      }),
      res
    );
    assert.equal(res.headers.location, '/app/polls/');
    const me = await auth.currentUser({ headers: { cookie: cookieFrom(res) } });
    assert.equal(me.name, 'Anna R.');
    assert.equal(me.kind, 'discord');
  } finally {
    global.fetch = realFetch;
  }
});
