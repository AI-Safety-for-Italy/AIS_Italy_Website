// Tests for the CRM board's foundations (server/crm/*, server/sheets.js):
// protection of what is stored, the audit trail, who may read what, and the
// read-only sheet reader. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const sheets = require('./sheets');
const cryptoCrm = require('./crm/crypto');
const audit = require('./crm/audit');
const access = require('./access');
const sources = require('./crm/sources');
const contentApi = require('./routes/app/content');
const mentorshipApi = require('./routes/app/crm/mentorship');
const authApi = require('../api/auth');

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const SECRET = 'a-crm-secret-of-at-least-thirty-two-characters';

beforeEach(() => {
  db.setDb(new PGlite());
  process.env.CRM_ENCRYPTION_KEY = KEY_A;
  delete process.env.CRM_ENCRYPTION_KEY_PREVIOUS;
  process.env.CRM_KEY_SECRET = SECRET;
  process.env.CRM_SHEETS_FAKE = '1';
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  sheets.setForTests();
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function request({ method = 'GET', url = '/', user, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.cookie = `${auth.COOKIE}=${auth.makeSession(user.id)}`;
  return { method, url, headers, body, socket: {} };
}

async function call(handler, options) {
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
  await handler(request(options), res);
  return res;
}

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

// The shared admin account, as if it had just signed in with the password.
async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

async function setRoles() {
  await permissions.saveRolePermissions([
    { roleId: 'r-mentors', roleName: 'mentorship team', permissions: ['mentorship'] },
    { roleId: 'r-people', roleName: 'people team', permissions: ['people'] },
    { roleId: 'r-content', roleName: 'communication', permissions: ['seminar', 'event'] },
  ]);
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

// ── Keys and encryption ──────────────────────────────────────────────────────

test('a person key is stable, ignores case and spaces, and is not the email', () => {
  const key = cryptoCrm.personKey('ada@example.org');
  assert.equal(key, cryptoCrm.personKey('  Ada@Example.ORG '));
  assert.notEqual(key, cryptoCrm.personKey('bruno@example.org'));
  assert.ok(!key.includes('ada') && !key.includes('example'));
  assert.equal(key.length, 32);
  assert.equal(cryptoCrm.personKey(''), null);
  assert.equal(cryptoCrm.personKey('not an email'), null);
  // Without the secret nobody can recompute it, and another secret gives another key.
  process.env.CRM_KEY_SECRET = 'a-different-secret-of-at-least-32-characters';
  assert.notEqual(cryptoCrm.personKey('ada@example.org'), key);
});

test('notes are encrypted, tied to their person, and refuse tampering', () => {
  const blob = cryptoCrm.encrypt('Ha detto che preferisce le mattine', 'person-1');
  assert.ok(!blob.includes('mattine'));
  assert.equal(cryptoCrm.decrypt(blob, 'person-1'), 'Ha detto che preferisce le mattine');
  // The same text encrypts differently each time.
  assert.notEqual(blob, cryptoCrm.encrypt('Ha detto che preferisce le mattine', 'person-1'));
  // Copied onto another person's row, it does not open.
  assert.equal(cryptoCrm.decrypt(blob, 'person-2'), null);
  // A changed byte does not open either.
  const parts = blob.split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[0] ^= 1;
  assert.equal(
    cryptoCrm.decrypt([...parts.slice(0, 3), body.toString('base64url')].join('.'), 'person-1'),
    null
  );
  assert.equal(cryptoCrm.decrypt('garbage', 'person-1'), null);
  assert.equal(cryptoCrm.decrypt('', 'person-1'), null);
});

test('rotating the encryption key keeps old notes readable and writes with the new one', () => {
  const old = cryptoCrm.encrypt('old note', 'p');
  process.env.CRM_ENCRYPTION_KEY = KEY_B;
  assert.equal(cryptoCrm.decrypt(old, 'p'), null);
  process.env.CRM_ENCRYPTION_KEY_PREVIOUS = KEY_A;
  assert.equal(cryptoCrm.decrypt(old, 'p'), 'old note');
  const fresh = cryptoCrm.encrypt('new note', 'p');
  delete process.env.CRM_ENCRYPTION_KEY_PREVIOUS;
  assert.equal(cryptoCrm.decrypt(fresh, 'p'), 'new note');
});

test('without keys the CRM refuses to protect nothing', () => {
  assert.equal(cryptoCrm.configured(), true);
  delete process.env.CRM_ENCRYPTION_KEY;
  assert.equal(cryptoCrm.configured(), false);
  assert.throws(() => cryptoCrm.encrypt('x'), /CRM_ENCRYPTION_KEY/);
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => cryptoCrm.encrypt('x'), /32 bytes/);
  process.env.CRM_ENCRYPTION_KEY = KEY_A;
  process.env.CRM_KEY_SECRET = 'short';
  assert.throws(() => cryptoCrm.personKey('ada@example.org'), /CRM_KEY_SECRET/);
});

// ── Audit trail ──────────────────────────────────────────────────────────────

test('the audit trail records who did what, newest first, per person if asked', async () => {
  const me = await admin();
  await audit.record(me, 'view-list', null, { source: 'mentors_prospective' });
  await audit.record(me, 'view-person', 'key-1');
  await audit.record(me, 'set-status', 'key-1', { from: 'contacted', to: 'replied' });
  const all = await audit.recent();
  assert.deepEqual(
    all.map((a) => a.action),
    ['set-status', 'view-person', 'view-list']
  );
  assert.equal(all[0].userName, me.name);
  assert.deepEqual(all[0].detail, { from: 'contacted', to: 'replied' });
  assert.equal((await audit.recent({ subjectKey: 'key-1' })).length, 2);
  await assert.rejects(audit.record(me, 'invented-action'), /Unknown audit action/);
});

test('the audit trail cannot be rewritten, even by a stray query', async () => {
  const me = await admin();
  await audit.record(me, 'view-person', 'key-1');
  await assert.rejects(db.query(`update crm_audit set user_name = 'someone else'`), /append-only/);
  await assert.rejects(db.query('delete from crm_audit'), /append-only/);
  await assert.rejects(db.query('truncate crm_audit'), /append-only/);
  assert.equal((await audit.recent()).length, 1);
});

test('deleting a user does not touch the audit trail', async () => {
  const user = await member('Temp', []);
  await audit.record(user, 'view-list');
  await db.query('delete from app_users where id = $1', [user.id]);
  const [line] = await audit.recent();
  assert.equal(line.userName, 'Temp');
});

// ── Permissions: content and CRM are separate areas ──────────────────────────

test('a permission opens only its own area', () => {
  assert.deepEqual(permissions.areas(['mentorship']), {
    content: false,
    crm: true,
    forms: false,
    members: false,
  });
  assert.deepEqual(permissions.areas(['seminar']), {
    content: true,
    crm: false,
    forms: false,
    members: false,
  });
  assert.deepEqual(permissions.areas(['manage', 'finance']), {
    content: true,
    crm: true,
    forms: false,
    members: false,
  });
  assert.deepEqual(permissions.areas([]), {
    content: false,
    crm: false,
    forms: false,
    members: false,
  });
  assert.deepEqual(permissions.areas(permissions.KEYS), {
    content: true,
    crm: true,
    forms: true,
    members: true,
  });
});

test('a CRM-only member is shut out of the content tool, and the other way round', async () => {
  await setRoles();
  const mentor = await member('Maria', ['r-mentors']);
  const writer = await member('Walter', ['r-content']);

  assert.equal((await call(contentApi, { url: '/api/app/content', user: mentor })).statusCode, 403);
  assert.equal((await call(contentApi, { url: '/api/app/content', user: writer })).statusCode, 200);
  assert.equal(
    (
      await call(contentApi, {
        method: 'POST',
        url: '/api/app/content?action=preview',
        user: mentor,
        body: {},
      })
    ).statusCode,
    403
  );

  const seenByMentor = (await call(authApi, { url: '/api/auth', user: mentor })).body;
  assert.deepEqual(seenByMentor.areas, { content: false, crm: true, forms: false, members: false });
  const seenByWriter = (await call(authApi, { url: '/api/auth', user: writer })).body;
  assert.deepEqual(seenByWriter.areas, { content: true, crm: false, forms: false, members: false });
  assert.deepEqual((await call(authApi, { url: '/api/auth' })).body.areas, {
    content: false,
    crm: false,
    forms: false,
    members: false,
  });
});

test('the new permissions are on the permissions table, and roles with one may sign in', async () => {
  const keys = permissions.PERMISSIONS.map((p) => p.key);
  for (const key of ['mentorship', 'people', 'finance', 'crm_admin']) assert.ok(keys.includes(key));
  await setRoles();
  assert.equal(await permissions.anyContentRole(['r-mentors']), true);
  assert.equal(await permissions.anyContentRole(['r-nothing']), false);
});

// ── The door every CRM endpoint goes through ─────────────────────────────────

test('a CRM permission is needed, and a refusal is on the audit trail', async () => {
  await setRoles();
  const mentor = await member('Maria', ['r-mentors']);
  const people = await member('Paolo', ['r-people']);
  const nobody = await member('Nico', []);

  assert.deepEqual(await access.authorize(mentor, 'mentorship'), ['mentorship']);
  await rejects(access.authorize(people, 'mentorship'), 403);
  await rejects(access.authorize(nobody, 'people'), 403);
  const denied = (await audit.recent()).filter((a) => a.action === 'denied');
  assert.equal(denied.length, 2);
  assert.deepEqual(denied[0].detail, { needs: 'people' });
  assert.equal(denied[0].userName, 'Nico');
  // The content permissions go through the same door (no recent sign-in asked).
  const writer = await member('Wanda', ['r-content']);
  assert.deepEqual(await access.authorize(writer, 'seminar'), ['seminar', 'event']);
  await assert.rejects(access.authorize(mentor, 'nonsense'), /Unknown permission/);
  // The shared admin account has every permission.
  assert.ok((await access.authorize(await admin(), 'finance')).includes('finance'));
});

test('a refused content permission is on the audit trail too', async () => {
  await setRoles();
  const writer = await member('Wanda', ['r-content']);
  await rejects(access.authorize(writer, 'manage'), 403);
  const denied = (await audit.recent()).filter((a) => a.action === 'denied');
  assert.equal(denied.length, 1);
  assert.deepEqual(denied[0].detail, { needs: 'manage' });
});

test('a sign-in older than a day has to be done again', async () => {
  await setRoles();
  const mentor = await member('Maria', ['r-mentors']);
  await access.authorize(mentor, 'mentorship');
  await db.query(`update app_users set last_login_at = now() - interval '25 hours' where id = $1`, [
    mentor.id,
  ]);
  await rejects(access.authorize(mentor, 'mentorship'), 401);
  // Signing in again (which stamps last_login_at) lets them back in.
  const again = await member('Maria', ['r-mentors']);
  await access.authorize(again, 'mentorship');
});

test('roles are read again from Discord when the last check is old, and a lost role locks the door', async () => {
  await setRoles();
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA = 'bot';
  process.env.DISCORD_GUILD_ID = 'guild1';
  const mentor = await member('Maria', ['r-mentors']);
  let calls = 0;
  let current = ['r-mentors'];
  permissions.setFetch(async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ roles: current }) };
  });
  // Just signed in: the roles are fresh, Discord is not asked.
  await access.authorize(mentor, 'mentorship');
  assert.equal(calls, 0);
  // Ten minutes later it is asked, and still says yes.
  await db.query(
    `update app_users set roles_checked_at = now() - interval '10 minutes' where id = $1`,
    [mentor.id]
  );
  await access.authorize(mentor, 'mentorship');
  assert.equal(calls, 1);
  // Then the role is taken away on Discord: the next stale check closes the door.
  current = ['r-somewhere-else'];
  await db.query(
    `update app_users set roles_checked_at = now() - interval '10 minutes' where id = $1`,
    [mentor.id]
  );
  await rejects(access.authorize(mentor, 'mentorship'), 403);
  // Within the five minutes it does not ask again.
  const before = calls;
  await rejects(access.authorize(mentor, 'mentorship'), 403);
  assert.equal(calls, before);
});

test('an email in a field nobody listed is still cut for those without mentorship', () => {
  const record = {
    key: 'k',
    name: 'Ada',
    new_question: 'Scrivimi a ada@example.org',
    form_email: 'ada@example.org',
  };
  assert.deepEqual(access.redact(record, ['people']), { key: 'k', name: 'Ada' });
  assert.deepEqual(access.redact(record, ['mentorship']), record);
});

test('fields only some permissions may read are not sent to the others', async () => {
  const record = {
    key: 'k',
    name: 'Ada Esempio',
    email: 'ada@example.org',
    cv: 'https://example.org/cv',
    track: 'projects',
  };
  assert.deepEqual(access.redact(record, ['people']), {
    key: 'k',
    name: 'Ada Esempio',
    track: 'projects',
  });
  assert.deepEqual(access.redact(record, ['mentorship']), record);
  assert.deepEqual(access.redact(record, []), { key: 'k', name: 'Ada Esempio', track: 'projects' });
});

// ── The sheet reader ─────────────────────────────────────────────────────────

test('rows come back as header → value, with short rows padded', () => {
  assert.deepEqual(sheets.rowsFromValues([['A', 'B', ''], ['1'], ['2', ' x ', 'ignored']]), [
    { A: '1', B: '' },
    { A: '2', B: 'x' },
  ]);
  assert.deepEqual(sheets.rowsFromValues([]), []);
  assert.deepEqual(sheets.rowsFromValues(undefined), []);
});

function serviceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    json: JSON.stringify({
      client_email: 'reader@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    publicKey,
  };
}

const SHEET = 'abcdefghij0123456789ABCDEFGHIJ';

test('the sheet reader signs in read-only, reads one tab, and keeps it in memory for a while', async () => {
  const key = serviceAccount();
  process.env.CRM_SHEETS_FAKE = '0';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = key.json;
  let clock = 1_000_000;
  const calls = [];
  sheets.setForTests({
    clock: () => clock,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok-1', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          values: [
            ['Nome', 'Email'],
            ['Ada', 'ada@example.org'],
          ],
        }),
      };
    },
  });

  const rows = await sheets.readRows({ spreadsheetId: SHEET, tab: 'Risposte del modulo 1' });
  assert.deepEqual(rows, [{ Nome: 'Ada', Email: 'ada@example.org' }]);

  // The sign-in asked for the read-only scope, and the signature is genuine.
  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const [head, claims, signature] = assertion.split('.');
  const claim = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(claim.iss, 'reader@project.iam.gserviceaccount.com');
  assert.ok(
    crypto
      .createVerify('RSA-SHA256')
      .update(`${head}.${claims}`)
      .verify(key.publicKey, signature, 'base64url')
  );
  // The sheet request: the id and tab are encoded, the token is a bearer, and nothing writes.
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1');
  assert.ok(calls[1].url.includes(`/${SHEET}/values/Risposte%20del%20modulo%201?`));
  assert.ok(calls.every((c) => (c.init.method || 'GET') !== 'PUT' && c.init.method !== 'PATCH'));

  // Asked again soon: from memory. After two minutes: read again, with the same token.
  await sheets.readRows({ spreadsheetId: SHEET, tab: 'Risposte del modulo 1' });
  assert.equal(calls.length, 2);
  clock += 3 * 60 * 1000;
  await sheets.readRows({ spreadsheetId: SHEET, tab: 'Risposte del modulo 1' });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.includes('/values/'));
});

test('the sheet reader refuses odd ids and says what to fix without leaking anything', async () => {
  const key = serviceAccount();
  process.env.CRM_SHEETS_FAKE = '0';
  // No key: not set up.
  await rejects(sheets.readRows({ spreadsheetId: SHEET, tab: 'T' }), 503);
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = key.json;
  // Nothing odd reaches a URL.
  await rejects(sheets.readRows({ spreadsheetId: '../../etc/passwd', tab: 'T' }), 400);
  await rejects(sheets.readRows({ spreadsheetId: `${SHEET}?x=1`, tab: 'T' }), 400);
  await rejects(sheets.readRows({ spreadsheetId: SHEET, tab: '' }), 400);
  await rejects(sheets.readRows({ spreadsheetId: SHEET, tab: 'a'.repeat(200) }), 400);

  const answer = (status) => async (url) =>
    String(url).includes('oauth2')
      ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
      : {
          ok: false,
          status,
          json: async () => ({ error: { message: 'secret detail: sheet title' } }),
        };
  sheets.setForTests({ fetch: answer(403) });
  await assert.rejects(
    sheets.readRows({ spreadsheetId: SHEET, tab: 'T' }),
    (e) =>
      e.status === 502 &&
      /shared with the service account/.test(e.message) &&
      !/secret detail/.test(e.message)
  );
  sheets.setForTests({ fetch: answer(404) });
  await assert.rejects(
    sheets.readRows({ spreadsheetId: SHEET, tab: 'T' }),
    (e) => e.status === 502 && /No such sheet/.test(e.message)
  );
  sheets.setForTests({ fetch: answer(500) });
  await rejects(sheets.readRows({ spreadsheetId: SHEET, tab: 'T' }), 502);
});

test('the invented sheets can never be served on the live site', async () => {
  process.env.VERCEL_ENV = 'production';
  try {
    await rejects(sources.load('mentors_prospective'), 500);
  } finally {
    delete process.env.VERCEL_ENV;
  }
  process.env.VERCEL_ENV = 'preview';
  try {
    assert.equal((await sources.load('mentors_prospective')).records.length, 4);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

// ── Sources: mapping the columns, reading the people ─────────────────────────

test('columns are found by header text, an exact match winning over a prefix', () => {
  const headers = [
    'nome completo (CO-MENTOR)',
    'Nome   Completo',
    'Quali aree tematiche si allineano?',
    'Area tematica',
    'Email',
  ];
  const columns = sources.mapColumns('mentors_applications', headers);
  assert.equal(columns.name, 'Nome   Completo');
  assert.equal(columns.co_mentor, 'nome completo (CO-MENTOR)');
  assert.equal(columns.areas, 'Quali aree tematiche si allineano?');
  assert.equal(columns.project_area, 'Area tematica');
  assert.equal(columns.email, 'Email');
  assert.equal(columns.cv, null);
  // Accents and case do not matter.
  assert.equal(
    sources.mapColumns('mentors_applications', ['MODALITA DEGLI INCONTRI']).mode,
    'MODALITA DEGLI INCONTRI'
  );
});

test('the prospective mentors load with opaque keys, and what is odd is flagged', async () => {
  const data = await sources.load('mentors_prospective');
  assert.deepEqual(data.missing, []);
  assert.equal(data.records.length, 4);
  const [ada, bruno, carla, dario] = data.records;
  assert.equal(ada.name, 'Ada Esempio');
  assert.equal(ada.email, 'ada@example.org');
  assert.equal(ada.key, cryptoCrm.personKey('ada@example.org'));
  assert.equal(ada.track, 'projects');
  assert.equal(ada.row, 2);
  assert.equal(bruno.contacted, 'No');
  assert.equal(carla.key, null); // no email: cannot be tracked
  assert.equal(data.withoutEmail, 1);
  assert.equal(dario.contacted, ''); // a short row, padded
  assert.equal(dario.email, 'dario@example.org');
});

test('the same person in two sheets gets the same key, whatever the spelling of the email', async () => {
  const prospective = (await sources.load('mentors_prospective')).records.find(
    (r) => r.name === 'Ada Esempio'
  );
  const applied = (await sources.load('mentors_applications')).records.find(
    (r) => r.name === 'Ada Esempio'
  );
  assert.equal(applied.email, 'ada@example.org'); // "  Ada@Example.org " in the sheet
  assert.equal(applied.key, prospective.key);
  const interest = (await sources.load('mentees_interest')).records.find(
    (r) => r.name === 'Ada Esempio'
  );
  assert.equal(interest.key, prospective.key);
});

test('applications keep their project and co-mentor, and blank rows are dropped', async () => {
  const apps = await sources.load('mentors_applications');
  const elena = apps.records.find((r) => r.name === 'Elena Campione');
  assert.equal(elena.project_title, 'Mappa dei regolamenti');
  assert.equal(elena.co_mentor, 'Bruno Prova');
  assert.equal(elena.mentees, '3');
  const interest = await sources.load('mentees_interest');
  assert.equal(interest.records.length, 2); // the third row is empty
  assert.equal(interest.records.find((r) => r.name === 'Gino Mentee').applying_as, 'Mentee');
});

test('markup in an answer stays text: the source never turns it into HTML', async () => {
  const apps = await sources.load('mentors_applications');
  const fabio = apps.records.find((r) => r.name === 'Fabio Marcatore');
  assert.equal(fabio.project_abstract, '<img src=x onerror=alert(1)> abstract');
});

test('a sheet that lost a column still loads, and says which field is missing', async () => {
  const fixtures = require('./crm/fixtures');
  const values = fixtures.values('mentors_prospective');
  const drop = values[0].indexOf('Contattato');
  const trimmed = values.map((row) => row.filter((_, i) => i !== drop));
  const saved = fixtures.SHEETS.mentors_prospective;
  fixtures.SHEETS.mentors_prospective = trimmed;
  try {
    const data = await sources.load('mentors_prospective');
    assert.deepEqual(data.missing, ['contacted']);
    assert.equal(data.records.length, 4);
  } finally {
    fixtures.SHEETS.mentors_prospective = saved;
  }
});

test('unknown sources and unset spreadsheets are refused plainly', async () => {
  await rejects(sources.load('payroll'), 404);
  process.env.CRM_SHEETS_FAKE = '0';
  await rejects(sources.load('mentors_prospective'), 409);
});

test('which spreadsheet each source reads is validated, saved, and audited', async () => {
  const me = await admin();
  const defaults = await sources.getConfig();
  assert.equal(defaults.mentors_prospective.tab, 'Mentors');
  assert.equal(defaults.mentors_prospective.spreadsheetId, '');
  const saved = await sources.saveConfig(me, {
    mentors_prospective: { spreadsheetId: SHEET, tab: 'Mentors' },
  });
  assert.equal(saved.mentors_prospective.spreadsheetId, SHEET);
  assert.equal(saved.mentees_interest.spreadsheetId, '');
  await rejects(
    sources.saveConfig(me, {
      mentors_prospective: { spreadsheetId: 'https://docs.google.com/x', tab: 'T' },
    }),
    400
  );
  assert.equal((await audit.recent())[0].action, 'change-settings');
});

test('the sheets page takes an address or an id, and only crm_admin may use it', async () => {
  assert.equal(
    sources.sheetId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`),
    SHEET
  );
  assert.equal(sources.sheetId(` ${SHEET} `), SHEET);
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'reader@x.iam' });

  await permissions.saveRolePermissions([
    { roleId: 'r-admin', roleName: 'crm admins', permissions: ['crm_admin'] },
    { roleId: 'r-mentors', roleName: 'mentorship team', permissions: ['mentorship'] },
  ]);
  const boss = await member('Bea', ['r-admin']);
  const mentor = await member('Ugo', ['r-mentors']);
  const url = '/api/app/crm/mentorship?action=sources';

  assert.equal((await call(mentorshipApi, { url, user: mentor })).statusCode, 403);
  assert.equal(
    (await call(mentorshipApi, { method: 'PUT', url, user: mentor, body: {} })).statusCode,
    403
  );
  const put = await call(mentorshipApi, {
    method: 'PUT',
    url,
    user: boss,
    body: {
      mentors_prospective: {
        spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET}/edit`,
      },
    },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.body.serviceAccount, 'reader@x.iam');
  assert.equal(put.body.sources.find((x) => x.id === 'mentors_prospective').spreadsheetId, SHEET);
  const got = await call(mentorshipApi, { url, user: boss });
  assert.equal(got.body.sources.length, Object.keys(sources.SOURCES).length);
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
});

test('nothing in the database holds an email or an answer, however much was read', async () => {
  const me = await admin();
  for (const id of Object.keys(sources.SOURCES)) {
    const { records } = await sources.load(id);
    for (const r of records)
      if (r.key) await audit.record(me, 'view-person', r.key, { source: id });
  }
  await sources.saveConfig(me, { mentors_prospective: { spreadsheetId: SHEET, tab: 'Mentors' } });
  const dump = JSON.stringify([
    (await db.query('select * from crm_audit')).rows,
    (await db.query('select * from app_settings')).rows,
  ]);
  assert.ok(!dump.includes('@'), 'an email reached the database');
  assert.ok(!dump.includes('example.org'));
  assert.ok(!/Ada|Bruno|Esempio|Prova/.test(dump), 'a name reached the database');
});
