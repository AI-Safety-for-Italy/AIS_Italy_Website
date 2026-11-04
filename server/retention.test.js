// Tests for the keeping time of personal data (server/retention.js and
// /api/cron/cleanup), on invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const retention = require('./retention');
const audit = require('./crm/audit');
const cleanupApi = require('../api/cron/cleanup');

const SECRET = 'a-cron-secret-of-at-least-thirty-two-characters';

beforeEach(async () => {
  await testDb.fresh();
  process.env.CRON_SECRET = SECRET;
});

async function call(headers = {}) {
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
  await cleanupApi(
    {
      method: 'POST',
      url: '/api/cron/cleanup',
      headers: { 'content-type': 'application/json', ...headers },
      body: {},
      socket: {},
    },
    res
  );
  return res;
}

async function seed() {
  const { rows } = await db.query(
    `insert into forms (slug, title) values ('prova', 'Prova') returning id`
  );
  const form = rows[0].id;
  for (const age of ['1 month', '11 months', '13 months', '3 years']) {
    await db.query(
      `insert into form_responses (form_id, version, answers_encrypted, submitted_at)
       values ($1, 1, 'x', now() - $2::interval)`,
      [form, age]
    );
  }
  for (const [status, age] of [
    ['pending', '1 month'],
    ['pending', '14 months'],
    ['rejected', '13 months'],
    ['rejected', '6 months'],
    ['approved', '40 months'],
  ]) {
    await db.query(
      `insert into member_applications (status, created_at) values ($1, now() - $2::interval)`,
      [status, age]
    );
  }
  // Mentorship board: a key per person, the records, and what the team wrote.
  // Sara is selected, Tom is not.
  const people = [
    ['sara', 'import', '14 months'], // selected: stays until 24 months
    ['tom', 'import', '14 months'], // not selected: goes at 12
    ['uma', 'board', '2 months'], // recent: stays
    ['vic', 'import', '30 months'], // past 24 months: goes whatever the state
    ['wes', 'form', '14 months'], // from a form: goes with its answer, not here
  ];
  for (const [name, origin, age] of people) {
    await db.query(
      `insert into crm_records (id, source, person_key, origin, data_encrypted, created_at)
       values (gen_random_uuid(), 'mentors_prospective', $1, $2, 'x', now() - $3::interval)`,
      [key(name), origin, age]
    );
  }
  for (const name of ['sara', 'vic']) {
    await db.query(
      `insert into crm_people_state (person_key, kind, status) values ($1, 'mentor', 'selected')`,
      [key(name)]
    );
  }
  for (const name of ['sara', 'tom', 'vic', 'uma']) {
    await db.query(
      `insert into crm_notes (person_key, body_encrypted, author_name) values ($1, 'x', 'Test')`,
      [key(name)]
    );
  }
}

const key = (name) => name.padEnd(32, '0');

test('after 12 months answers and applications never approved are deleted; members stay', async () => {
  await seed();
  const counts = await retention.cleanup();
  assert.equal(counts.answers, 2);
  assert.equal(counts.applications, 2);
  const left = await db.query('select count(*)::int as n from form_responses');
  assert.equal(left.rows[0].n, 2);
  const apps = await db.query('select status from member_applications order by status');
  assert.deepEqual(
    apps.rows.map((r) => r.status),
    ['approved', 'pending', 'rejected']
  );
});

test('the board keeps the selected for 24 months, the others for 12, and forgets who is gone', async () => {
  await seed();
  const counts = await retention.cleanup();
  const kept = await db.query('select person_key from crm_records order by person_key');
  assert.deepEqual(
    kept.rows.map((r) => r.person_key),
    [key('sara'), key('uma'), key('wes')]
  );
  assert.equal(counts.boardRecords, 2);
  // Notes and status follow the records: Tom and Vic are gone, Sara and Uma stay.
  const notes = await db.query('select person_key from crm_notes order by person_key');
  assert.deepEqual(
    notes.rows.map((r) => r.person_key),
    [key('sara'), key('uma')]
  );
  assert.equal(counts.boardNotes, 2);
  const state = await db.query('select person_key from crm_people_state');
  assert.deepEqual(
    state.rows.map((r) => r.person_key),
    [key('sara')]
  );
  const [line] = await audit.recent();
  assert.equal(line.action, 'retention-cleanup');
  assert.equal(line.detail.months, 12);
  assert.ok(!JSON.stringify(line.detail).includes('sara'));
});

test('the form answer of someone selected stays until 24 months', async () => {
  const { rows } = await db.query(
    `insert into forms (slug, title) values ('sel', 'Sel') returning id`
  );
  const answer = async (age) =>
    (
      await db.query(
        `insert into form_responses (form_id, version, answers_encrypted, submitted_at)
         values ($1, 1, 'x', now() - $2::interval) returning id`,
        [rows[0].id, age]
      )
    ).rows[0].id;
  const kept = await answer('14 months');
  const old = await answer('30 months');
  for (const [name, id] of [
    ['xena', kept],
    ['yuri', old],
  ]) {
    await db.query(
      `insert into crm_records (id, source, person_key, origin, data_encrypted, response_id)
       values (gen_random_uuid(), 'mentees_applications', $1, 'form', 'x', $2)`,
      [key(name), id]
    );
    await db.query(
      `insert into crm_people_state (person_key, kind, status) values ($1, 'mentee', 'matched')`,
      [key(name)]
    );
  }
  await retention.cleanup();
  const left = await db.query('select id from form_responses');
  assert.deepEqual(
    left.rows.map((r) => r.id),
    [kept]
  );
});

test('before the first import nothing about the board is deleted', async () => {
  await db.query(
    `insert into crm_notes (person_key, body_encrypted, author_name) values ('p', 'x', 'Test')`
  );
  await db.query(
    `insert into crm_people_state (person_key, kind, status) values ('p', 'mentor', 'applied')`
  );
  await retention.cleanup();
  assert.equal((await db.query('select 1 from crm_notes')).rows.length, 1);
  assert.equal((await db.query('select 1 from crm_people_state')).rows.length, 1);
});

test('a running pairing keeps what the team wrote; an ended one goes with the person', async () => {
  await seed();
  // Tom's records go, but he is paired with Sara right now: his state stays.
  await db.query(
    `insert into crm_people_state (person_key, kind, status) values ($1, 'mentee', 'matched')`,
    [key('tom')]
  );
  await db.query(
    `insert into crm_matches (mentor_key, mentee_key, track) values ($1, $2, 'projects')`,
    [key('sara'), key('tom')]
  );
  await db.query(
    `insert into crm_matches (mentor_key, mentee_key, track, status, ended_at)
     values ($1, $2, 'projects', 'ended', now())`,
    [key('sara'), key('vic')]
  );
  await retention.cleanup();
  const states = await db.query('select person_key from crm_people_state order by person_key');
  assert.ok(states.rows.some((r) => r.person_key === key('tom')));
  const matches = await db.query('select status from crm_matches');
  assert.deepEqual(
    matches.rows.map((r) => r.status),
    ['active']
  );
});

test('old approved applications keep name and email, not the answers', async () => {
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-crm-secret-of-at-least-thirty-two-characters';
  const members = require('./members');
  const cryptoCrm = require('./crm/crypto');
  const make = async (age) => {
    const { id } = await members.createApplication({
      name: 'Ada Esempio',
      email: 'ada@example.org',
      answers: [{ label: 'Perché', value: 'Risposta riservata' }],
    });
    await db.query(
      `update member_applications set status = 'approved', created_at = now() - $2::interval where id = $1`,
      [id, age]
    );
    return id;
  };
  const old = await make('14 months');
  const recent = await make('2 months');
  const counts = await retention.cleanup();
  assert.equal(counts.approvedTrimmed, 1);
  const open = async (id) => {
    const { rows } = await db.query(
      'select details_encrypted from member_applications where id = $1',
      [id]
    );
    return JSON.parse(cryptoCrm.decrypt(rows[0].details_encrypted, `member:${id}`));
  };
  assert.deepEqual(await open(old), { name: 'Ada Esempio', email: 'ada@example.org', answers: [] });
  assert.equal((await open(recent)).answers.length, 1);
  // A second run has nothing left to trim.
  assert.equal((await retention.cleanup()).approvedTrimmed, 0);
});

test('the cleanup runs only with the secret, and not at all without one set', async () => {
  await seed();
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call({ authorization: 'Bearer wrong' })).statusCode, 401);
  const ok = await call({ authorization: `Bearer ${SECRET}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.answers, 2);
  assert.equal(ok.body.applications, 2);
  delete process.env.CRON_SECRET;
  assert.equal((await call({ authorization: 'Bearer ' })).statusCode, 503);
});

test("a mentor's draft for the site goes with their last record, not before the first import", async () => {
  await db.query(`insert into crm_site_profiles (person_key, data_encrypted) values ('gone', 'x')`);
  // Nothing imported yet: the draft stays.
  await retention.cleanup();
  assert.equal((await db.query('select 1 from crm_site_profiles')).rows.length, 1);
  await db.query(`insert into crm_site_profiles (person_key, data_encrypted) values ('kept', 'x')`);
  await db.query(
    `insert into crm_records (id, source, person_key, origin, data_encrypted)
     values (gen_random_uuid(), 'mentors_prospective', 'kept', 'board', 'x')`
  );
  assert.equal((await retention.cleanup()).siteDrafts, 1);
  const { rows } = await db.query('select person_key from crm_site_profiles');
  assert.deepEqual(
    rows.map((r) => r.person_key),
    ['kept']
  );
});
