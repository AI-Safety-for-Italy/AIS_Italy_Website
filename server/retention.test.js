// Tests for the keeping time of personal data (server/retention.js and
// /api/cron/cleanup), on invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const retention = require('./retention');
const audit = require('./crm/audit');
const cleanupApi = require('../api/cron/cleanup');

const SECRET = 'a-cron-secret-of-at-least-thirty-two-characters';

beforeEach(() => {
  db.setDb(new PGlite());
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
  for (const age of ['1 month', '23 months', '25 months', '3 years']) {
    await db.query(
      `insert into form_responses (form_id, version, answers_encrypted, submitted_at)
       values ($1, 1, 'x', now() - $2::interval)`,
      [form, age]
    );
  }
  for (const [status, age] of [
    ['pending', '1 month'],
    ['pending', '30 months'],
    ['rejected', '25 months'],
    ['rejected', '6 months'],
    ['approved', '40 months'],
  ]) {
    await db.query(
      `insert into member_applications (status, created_at) values ($1, now() - $2::interval)`,
      [status, age]
    );
  }
}

test('after 24 months answers and applications never approved are deleted; members stay', async () => {
  await seed();
  assert.deepEqual(await retention.cleanup(), { answers: 2, applications: 2 });
  const left = await db.query('select count(*)::int as n from form_responses');
  assert.equal(left.rows[0].n, 2);
  const apps = await db.query('select status from member_applications order by status');
  assert.deepEqual(
    apps.rows.map((r) => r.status),
    ['approved', 'pending', 'rejected']
  );
  const [line] = await audit.recent();
  assert.equal(line.action, 'retention-cleanup');
  assert.deepEqual(line.detail, { months: 24, answers: 2, applications: 2 });
});

test('the cleanup runs only with the secret, and not at all without one set', async () => {
  await seed();
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call({ authorization: 'Bearer wrong' })).statusCode, 401);
  const ok = await call({ authorization: `Bearer ${SECRET}` });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, { answers: 2, applications: 2 });
  delete process.env.CRON_SECRET;
  assert.equal((await call({ authorization: 'Bearer ' })).statusCode, 503);
});
