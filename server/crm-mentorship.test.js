// Tests for the mentorship board (server/crm/mentorship.js and its API), on the
// invented sheets of server/crm/fixtures.js. Run with `npm run test:meet`.
//
// The invented people: mentors Ada (in all three lists), Bruno, Dario (to
// contact), Elena and Fabio (applied); mentee Gino; Carla has no email.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const sheets = require('./sheets');
const crm = require('./crm/crypto');
const audit = require('./crm/audit');
const mentorship = require('./crm/mentorship');
const api = require('../api/app/crm/mentorship');

beforeEach(() => {
  db.setDb(new PGlite());
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-crm-secret-of-at-least-thirty-two-characters';
  process.env.CRM_SHEETS_FAKE = '1';
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  sheets.setForTests();
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

const ADA = () => crm.personKey('ada@example.org');
const GINO = () => crm.personKey('gino@example.org');
const ELENA = () => crm.personKey('elena@example.org');
const FABIO = () => crm.personKey('fabio@example.org');
const BRUNO = () => crm.personKey('bruno@example.org');

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

async function setRoles() {
  await permissions.saveRolePermissions([
    { roleId: 'r-mentors', roleName: 'mentorship team', permissions: ['mentorship'] },
    { roleId: 'r-people', roleName: 'people team', permissions: ['people'] },
  ]);
}

async function call({ method = 'GET', url = '/api/app/crm/mentorship', user, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.cookie = `${auth.COOKIE}=${auth.makeSession(user.id)}`;
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  await api({ method, url, headers, body, socket: {} }, res);
  return res;
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

const byName = (list, name) => list.find((c) => c.name === name);

// ── Reading ──────────────────────────────────────────────────────────────────

test('the three lists become one card per person and role', async () => {
  const board = await mentorship.board(await admin());
  assert.deepEqual(
    board.mentors.map((m) => m.name),
    ['Ada Esempio', 'Bruno Prova', 'Dario Test', 'Elena Campione', 'Fabio Marcatore']
  );
  assert.deepEqual(
    board.mentees.map((m) => m.name),
    ['Gino Mentee']
  );
  const ada = byName(board.mentors, 'Ada Esempio');
  assert.deepEqual(ada.sources.sort(), [
    'mentees_interest',
    'mentors_applications',
    'mentors_prospective',
  ]);
  assert.equal(ada.key, ADA());
  assert.equal(ada.project, 'Sonde lineari sui modelli piccoli');
  assert.equal(ada.capacity, 2);
  assert.equal(ada.referrer, 'Bruno Prova');
  // Carla has no email: listed apart, never tracked.
  assert.deepEqual(board.unlinked, [
    { kind: 'mentor', source: 'mentors_prospective', row: 4, name: 'Carla Finta' },
  ]);
  assert.deepEqual(board.problems, []);
  // The board itself carries no contact details.
  assert.ok(!JSON.stringify(board).includes('@'));
});

test('where each person is comes from the sheets until the team moves them', async () => {
  const board = await mentorship.board(await admin());
  const status = (list, name) => byName(list, name).status;
  assert.equal(status(board.mentors, 'Ada Esempio'), 'applied');
  assert.equal(status(board.mentors, 'Bruno Prova'), 'to_contact');
  assert.equal(status(board.mentors, 'Dario Test'), 'to_contact');
  assert.equal(status(board.mentees, 'Gino Mentee'), 'interested');
  const track = (list, name) => byName(list, name).track;
  assert.equal(track(board.mentors, 'Ada Esempio'), 'projects');
  assert.equal(track(board.mentors, 'Elena Campione'), 'both');
  assert.equal(track(board.mentors, 'Fabio Marcatore'), 'orientation');
  assert.equal(track(board.mentors, 'Bruno Prova'), 'orientation');
  assert.equal(track(board.mentors, 'Dario Test'), null);
  assert.equal(track(board.mentees, 'Gino Mentee'), 'projects');
});

test('the sheets’ free answers are read sensibly', () => {
  assert.equal(mentorship.yes('Sì'), true);
  assert.equal(mentorship.yes(' si '), true);
  assert.equal(mentorship.yes('Yes, by email'), true);
  assert.equal(mentorship.yes('No'), false);
  assert.equal(mentorship.yes(''), false);
  assert.equal(mentorship.trackOf('Progetti, Orientamento'), 'both');
  assert.equal(mentorship.trackOf('AI safety projects'), 'projects');
  assert.equal(mentorship.trackOf('Orientamento professionale'), 'orientation');
  assert.equal(mentorship.trackOf('boh'), null);
  assert.deepEqual(mentorship.kindsOf('Mentor'), ['mentor']);
  assert.deepEqual(mentorship.kindsOf('Mentee'), ['mentee']);
  assert.deepEqual(mentorship.kindsOf('Mentor e mentee'), ['mentor', 'mentee']);
  assert.deepEqual(mentorship.kindsOf(''), ['mentee']);
});

test('one person shows every sheet they are in, and contact details only to the mentorship team', async () => {
  const me = await admin();
  const full = await mentorship.person(me, ['mentorship'], ADA(), 'mentor');
  assert.equal(full.email, 'ada@example.org');
  assert.equal(full.sheets.length, 3);
  const app = full.sheets.find((s) => s.source === 'mentors_applications');
  assert.equal(app.fields.cv, 'https://example.org/cv/ada.pdf');
  assert.equal(app.row, 2);

  const cut = await mentorship.person(me, ['people'], ADA(), 'mentor');
  assert.equal(cut.email, undefined);
  const text = JSON.stringify(cut.sheets);
  assert.ok(!text.includes('@') && !text.includes('/cv/'));
  assert.equal(
    cut.sheets.find((s) => s.source === 'mentors_applications').fields.project_title,
    'Sonde lineari sui modelli piccoli'
  );

  const lines = await audit.recent({ subjectKey: ADA() });
  assert.deepEqual(
    lines.map((l) => l.action),
    ['view-person', 'view-person']
  );
  await rejects(
    mentorship.person(me, ['mentorship'], crm.personKey('nobody@example.org'), 'mentor'),
    404
  );
  await rejects(mentorship.person(me, ['mentorship'], 'not-a-key', 'mentor'), 400);
  await rejects(mentorship.person(me, ['mentorship'], ADA(), 'boss'), 400);
});

// ── Changes ──────────────────────────────────────────────────────────────────

test('moving someone along is stored by key, audited, and validated', async () => {
  const me = await admin();
  await mentorship.update(me, BRUNO(), 'mentor', { status: 'contacted', track: 'projects' });
  let bruno = byName((await mentorship.board(me)).mentors, 'Bruno Prova');
  assert.equal(bruno.status, 'contacted');
  assert.equal(bruno.track, 'projects');
  assert.equal(bruno.statusSet, true);
  const [line] = await audit.recent({ subjectKey: BRUNO() });
  assert.deepEqual(line.detail, {
    kind: 'mentor',
    from: 'to_contact',
    to: 'contacted',
    track: 'projects',
  });

  await rejects(mentorship.update(me, BRUNO(), 'mentor', { status: 'hired' }), 400);
  await rejects(mentorship.update(me, BRUNO(), 'mentor', { status: 'interested' }), 400); // a mentee's status
  await rejects(mentorship.update(me, BRUNO(), 'mentor', { status: 'matched' }), 400);
  await rejects(mentorship.update(me, BRUNO(), 'mentor', { track: 'cooking' }), 400);
  await rejects(mentorship.update(me, BRUNO(), 'mentor', { owner: 'someone' }), 400);
  await rejects(
    mentorship.update(me, crm.personKey('ghost@example.org'), 'mentor', { status: 'contacted' }),
    404
  );

  // Clearing the track falls back to what the sheets say.
  await mentorship.update(me, BRUNO(), 'mentor', { track: null });
  bruno = byName((await mentorship.board(me)).mentors, 'Bruno Prova');
  assert.equal(bruno.track, 'orientation');
});

test('a team member can take someone on, and drop them', async () => {
  await setRoles();
  const maria = await member('Maria', ['r-mentors']);
  await mentorship.update(maria, ELENA(), 'mentor', { owner: 'me' });
  assert.equal(byName((await mentorship.board(maria)).mentors, 'Elena Campione').owner, 'Maria');
  await mentorship.update(maria, ELENA(), 'mentor', { owner: 'none' });
  assert.equal(byName((await mentorship.board(maria)).mentors, 'Elena Campione').owner, null);
});

test('notes are encrypted at rest, shown in clear to the team, and tied to their person', async () => {
  const me = await admin();
  await mentorship.addNote(me, ADA(), 'mentor', 'Preferisce le chiamate al mattino.');
  const { rows } = await db.query('select * from crm_notes');
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].body_encrypted.includes('mattino'));
  const ada = await mentorship.person(me, ['mentorship'], ADA(), 'mentor');
  assert.equal(ada.notes[0].body, 'Preferisce le chiamate al mattino.');
  assert.equal(ada.notes[0].author, me.name);
  assert.equal(byName((await mentorship.board(me)).mentors, 'Ada Esempio').notes, 1);

  // Moved onto someone else's key, the note does not open.
  await db.query('update crm_notes set person_key = $1', [ELENA()]);
  const elena = await mentorship.person(me, ['mentorship'], ELENA(), 'mentor');
  assert.match(elena.notes[0].body, /cannot be opened/);

  await rejects(mentorship.addNote(me, ADA(), 'mentor', '   '), 400);
  await rejects(mentorship.addNote(me, ADA(), 'mentor', 'x'.repeat(4001)), 400);
  await rejects(mentorship.addNote(me, crm.personKey('ghost@example.org'), 'mentor', 'hi'), 404);
});

// ── Pairing ──────────────────────────────────────────────────────────────────

test('only selected people on the same track can be paired, a mentee only once', async () => {
  const me = await admin();
  await rejects(mentorship.createMatch(me, ADA(), GINO(), 'projects'), 409); // nobody selected yet
  await mentorship.update(me, ADA(), 'mentor', { status: 'selected' });
  await rejects(mentorship.createMatch(me, ADA(), GINO(), 'projects'), 409); // Gino not selected
  await mentorship.update(me, GINO(), 'mentee', { status: 'selected' });
  await mentorship.update(me, FABIO(), 'mentor', { status: 'selected' });
  await rejects(mentorship.createMatch(me, FABIO(), GINO(), 'projects'), 409); // Fabio: orientation
  await rejects(mentorship.createMatch(me, ADA(), GINO(), 'cooking'), 400);

  const { overCapacity } = await mentorship.createMatch(me, ADA(), GINO(), 'projects');
  assert.equal(overCapacity, false);
  let board = await mentorship.board(me);
  assert.equal(byName(board.mentors, 'Ada Esempio').status, 'matched');
  assert.equal(byName(board.mentees, 'Gino Mentee').status, 'matched');
  assert.equal(board.matches.length, 1);
  assert.equal(board.matches[0].mentor.name, 'Ada Esempio');
  assert.equal(board.matches[0].mentee.name, 'Gino Mentee');

  // Gino already has a mentor.
  await mentorship.update(me, ELENA(), 'mentor', { status: 'selected' });
  await rejects(mentorship.createMatch(me, ELENA(), GINO(), 'projects'), 409);
  // While paired, moving them by hand is refused.
  await rejects(mentorship.update(me, GINO(), 'mentee', { status: 'declined' }), 409);

  await mentorship.endMatch(me, board.matches[0].id);
  board = await mentorship.board(me);
  assert.equal(byName(board.mentors, 'Ada Esempio').status, 'selected');
  assert.equal(byName(board.mentees, 'Gino Mentee').status, 'selected');
  assert.equal(board.matches.length, 0);
  await rejects(
    mentorship.endMatch(
      me,
      board.matches[0] ? board.matches[0].id : '00000000-0000-0000-0000-000000000000'
    ),
    404
  );
  // The ended pair is kept, and both histories say what happened.
  const { rows } = await db.query('select status from crm_matches');
  assert.deepEqual(
    rows.map((r) => r.status),
    ['ended']
  );
  const gino = await audit.recent({ subjectKey: GINO() });
  assert.deepEqual(
    gino.filter((l) => l.action === 'set-match').map((l) => l.detail.action),
    ['end', 'create']
  );
});

// ── The API ──────────────────────────────────────────────────────────────────

test('the API lets in only the mentorship permission', async () => {
  await setRoles();
  const maria = await member('Maria', ['r-mentors']);
  const paolo = await member('Paolo', ['r-people']);
  const nico = await member('Nico', []);
  assert.equal((await call({})).statusCode, 401);
  assert.equal((await call({ user: nico })).statusCode, 403);
  assert.equal((await call({ user: paolo })).statusCode, 403);
  const ok = await call({ user: maria });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.mentors.length, 5);
  assert.equal(ok.headers['Cache-Control'], 'no-store');
  const post = (user, action, body) =>
    call({ method: 'POST', url: `/api/app/crm/mentorship?action=${action}`, user, body });
  assert.equal(
    (await post(paolo, 'note', { key: ADA(), kind: 'mentor', body: 'hi' })).statusCode,
    403
  );
  assert.equal(
    (await post(maria, 'note', { key: ADA(), kind: 'mentor', body: 'hi' })).statusCode,
    201
  );
  assert.equal(
    (await post(maria, 'update', { key: ADA(), kind: 'mentor', status: 'selected', evil: 1 }))
      .statusCode,
    200
  );
  assert.equal((await post(maria, 'drop-table', {})).statusCode, 400);
  const person = await call({
    url: `/api/app/crm/mentorship?key=${ADA()}&kind=mentor`,
    user: maria,
  });
  assert.equal(person.body.email, 'ada@example.org');
});

test('a change re-reads the Discord roles, even right after signing in', async () => {
  await setRoles();
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'bot';
  process.env.DISCORD_GUILD_ID = 'guild1';
  const maria = await member('Maria', ['r-mentors']);
  permissions.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ roles: [] }) }));
  // Reading within five minutes of signing in: the stored roles stand.
  assert.equal((await call({ user: maria })).statusCode, 200);
  // Writing: Discord is asked, says the role is gone, and the change is refused.
  const res = await call({
    method: 'POST',
    url: '/api/app/crm/mentorship?action=update',
    user: maria,
    body: { key: ADA(), kind: 'mentor', status: 'selected' },
  });
  assert.equal(res.statusCode, 403);
  const { rows } = await db.query('select * from crm_people_state');
  assert.equal(rows.length, 0);
});

test('without its encryption keys the CRM refuses to run', async () => {
  const me = await admin();
  delete process.env.CRM_ENCRYPTION_KEY;
  assert.equal((await call({ user: me })).statusCode, 503);
});

test('after reading, moving, noting and pairing, the database holds no name, email or note', async () => {
  const me = await admin();
  await mentorship.board(me);
  await mentorship.person(me, ['mentorship'], ADA(), 'mentor');
  await mentorship.addNote(me, ADA(), 'mentor', 'Testo riservato della nota');
  await mentorship.update(me, ADA(), 'mentor', { status: 'selected', owner: 'me' });
  await mentorship.update(me, GINO(), 'mentee', { status: 'selected' });
  await mentorship.createMatch(me, ADA(), GINO(), 'projects');
  const dump = JSON.stringify(
    await Promise.all(
      ['crm_people_state', 'crm_notes', 'crm_matches', 'crm_audit'].map(
        async (t) => (await db.query(`select * from ${t}`)).rows
      )
    )
  );
  assert.ok(!dump.includes('@'), 'an email reached the database');
  assert.ok(
    !/Ada|Gino|Esempio|Mentee|Sonde/.test(dump),
    'a name or an answer reached the database'
  );
  assert.ok(!dump.includes('riservato'), 'a note is stored in clear');
});
