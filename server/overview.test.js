// Tests for the to-do counts of the personal area (server/overview.js,
// /api/app/overview), on invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const { overview } = require('./overview');

beforeEach(() => {
  db.setDb(new PGlite());
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.VERCEL_ENV;
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

async function poll(owner, { answered = false, status = 'open' } = {}) {
  await db.query(
    `insert into polls (token, title, duration_minutes, owner_id, status, all_answered_at)
     values (md5(random()::text), 'Prova', 60, $1, $2, $3)`,
    [owner.id, status, answered ? new Date() : null]
  );
}

async function form(owner, roles = []) {
  const { rows } = await db.query(
    `insert into forms (slug, title, owner_id, access_roles) values (md5(random()::text), 'F', $1, $2)
     returning id`,
    [owner ? owner.id : null, roles]
  );
  return rows[0].id;
}

async function answer(formId, status = 'new') {
  await db.query(
    `insert into form_responses (form_id, version, answers_encrypted, status) values ($1, 1, 'x', $2)`,
    [formId, status]
  );
}

test('each member sees the counts of the tools they may open, and only those', async () => {
  await permissions.saveRolePermissions([
    { roleId: 'r-forms', roleName: 'forms', permissions: ['forms'] },
    { roleId: 'r-board', roleName: 'board', permissions: ['members'] },
    { roleId: 'r-readers', roleName: 'readers', permissions: ['forms'] },
  ]);
  const mara = await member('Mara', ['r-forms']);
  const elisa = await member('Elisa', ['r-board']);
  const tea = await member('Tea', ['r-readers']);
  const nobody = await member('Sid', []);

  await poll(mara, { answered: true });
  await poll(mara);
  await poll(mara, { answered: true, status: 'scheduled' });
  const own = await form(mara);
  const shared = await form(null, ['r-readers']);
  await answer(own);
  await answer(own);
  await answer(own, 'accepted');
  await answer(shared);
  await db.query(
    `insert into member_applications (status) values ('pending'), ('pending'), ('approved')`
  );

  const m = await overview(mara);
  assert.deepEqual(Object.keys(m.tools).sort(), ['forms', 'polls']);
  assert.equal(m.tools.polls.count, 1);
  assert.equal(m.tools.polls.open, 2);
  assert.equal(m.tools.forms.count, 2);

  const e = await overview(elisa);
  assert.deepEqual(Object.keys(e.tools).sort(), ['members', 'polls']);
  assert.equal(e.tools.members.count, 2);
  assert.equal(e.tools.members.label, 'applications to review');

  // A role on a form counts its answers for its readers.
  assert.equal((await overview(tea)).tools.forms.count, 1);
  assert.deepEqual(Object.keys((await overview(nobody)).tools), ['polls']);
});
