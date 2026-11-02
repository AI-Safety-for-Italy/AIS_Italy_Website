// Tests for the forms (server/forms/*, api/form.js, api/app/forms.js), on
// invented data only. Run with `npm run test:meet`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const auth = require('./auth');
const permissions = require('./permissions');
const crm = require('./crm/crypto');
const audit = require('./crm/audit');
const schemaLib = require('./forms/schema');
const guard = require('./forms/guard');
const forms = require('./forms/forms');
const publicApi = require('../api/form');
const appApi = require('./routes/app/forms');

let clock = Date.now();
beforeEach(() => {
  db.setDb(new PGlite());
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-forms-secret-of-at-least-thirty-two-characters';
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  clock = Date.now();
  guard.setClock(() => clock);
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const later = (ms) => {
  clock += ms;
};

async function setRoles() {
  await permissions.saveRolePermissions([
    { roleId: 'r-forms', roleName: 'forms makers', permissions: ['forms'] },
    { roleId: 'r-forms-admin', roleName: 'forms admins', permissions: ['forms_admin'] },
    { roleId: 'r-mentors', roleName: 'mentorship', permissions: ['mentorship'] },
  ]);
}

async function member(name, roles) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

/** A form with one question of each kind. */
function fullSchema(over = {}) {
  return {
    languages: ['it', 'en'],
    title: { it: 'Candidatura di prova', en: 'Test application' },
    description: { it: 'Un modulo **inventato**.' },
    confirmation: { it: 'Grazie!' },
    items: [
      { id: 'intro', type: 'info', label: { it: 'Benvenuta' } },
      { id: 'name', type: 'short_text', label: { it: 'Nome' }, required: true },
      { id: 'email', type: 'email', label: { it: 'Email' }, required: true },
      { id: 'bio', type: 'long_text', label: { it: 'Chi sei' }, maxLength: 200 },
      { id: 'cv', type: 'url', label: { it: 'Link al CV' } },
      { id: 'hours', type: 'number', label: { it: 'Ore a settimana' }, min: 1, max: 40 },
      { id: 'page2', type: 'section', label: { it: 'Seconda parte' } },
      {
        id: 'track',
        type: 'single',
        label: { it: 'Percorso' },
        required: true,
        options: [
          { id: 'projects', label: { it: 'Progetti', en: 'Projects' } },
          { id: 'orientation', label: { it: 'Orientamento' } },
        ],
        other: true,
      },
      {
        id: 'areas',
        type: 'multi',
        label: { it: 'Aree' },
        options: [
          { id: 'interp', label: { it: 'Interpretabilità' } },
          { id: 'gov', label: { it: 'Governance' } },
          { id: 'evals', label: { it: 'Valutazioni' } },
        ],
        maxChoices: 2,
      },
      {
        id: 'city',
        type: 'dropdown',
        label: { it: 'Città' },
        options: [
          { id: 'mi', label: { it: 'Milano' } },
          { id: 'rm', label: { it: 'Roma' } },
        ],
      },
      { id: 'level', type: 'scale', label: { it: 'Esperienza' }, min: 1, max: 5 },
      { id: 'start', type: 'date', label: { it: 'Da quando' } },
      { id: 'inperson', type: 'yes_no', label: { it: 'In presenza?' } },
      { id: 'privacy', type: 'consent', label: { it: 'Acconsento al trattamento dei dati' } },
    ],
    ...over,
  };
}

const goodAnswers = (over = {}) => ({
  name: 'Ada Esempio',
  email: ' Ada@Example.org ',
  bio: 'Ricercatrice inventata.',
  cv: 'https://example.org/cv.pdf',
  hours: '6',
  track: { selected: ['projects'] },
  areas: { selected: ['interp', 'gov'] },
  city: { selected: ['mi'] },
  level: 4,
  start: '2026-12-15',
  inperson: 'no',
  privacy: true,
  ...over,
});

/** A form made by `user`, set open. */
async function openForm(user, over = {}) {
  const { id, slug } = await forms.create(user, {
    title: 'Candidatura di prova',
    schema: fullSchema(over.schema),
  });
  await forms.updateSettings(user, id, { status: 'open', ...over.settings });
  return { id, slug };
}

/** Opens the form as the public would, waits like a person, sends it. */
async function answer(slug, answers, { ip = '203.0.113.7', wait = 5000, ...extra } = {}) {
  const view = await forms.publicView(slug);
  later(wait);
  return forms.submit(slug, { version: view.version, token: view.token, answers, ...extra }, ip);
}

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

test('a form with every kind of question is accepted, cleaned and given consent versions', () => {
  const s = schemaLib.cleanSchema(fullSchema());
  assert.deepEqual(s.languages, ['it', 'en']);
  assert.equal(s.items.length, 14);
  const consent = s.items.find((i) => i.type === 'consent');
  assert.equal(consent.required, true);
  assert.match(consent.consentVersion, /^[0-9a-f]{12}$/);
  // Changing the consent text gives another version.
  const changed = schemaLib.cleanSchema(
    fullSchema({ items: [{ id: 'privacy', type: 'consent', label: { it: 'Un altro testo' } }] })
  );
  assert.notEqual(changed.items[0].consentVersion, consent.consentVersion);
  const scale = schemaLib.cleanSchema(
    fullSchema({ items: [{ id: 'x1', type: 'scale', label: { it: 'S' } }] })
  ).items[0];
  assert.deepEqual([scale.min, scale.max], [1, 5]);
  const text = s.items.find((i) => i.id === 'name');
  assert.equal(text.maxLength, 300);
  // The main language comes first, as chosen; the questions must be written in it.
  const english = schemaLib.cleanSchema({
    languages: ['en', 'it'],
    title: { en: 'T' },
    items: [{ id: 'q1', type: 'short_text', label: { en: 'Name' } }],
  });
  assert.deepEqual(english.languages, ['en', 'it']);
});

test('a broken form is refused, naming the question', () => {
  const bad = (over) =>
    assert.throws(
      () => schemaLib.cleanSchema(fullSchema(over)),
      (e) => e.status === 400
    );
  bad({ languages: [] });
  bad({ languages: ['fr'] });
  bad({ title: { en: 'only English' } }); // the main language is Italian
  bad({ items: [{ id: 'a1', type: 'wizard', label: { it: 'X' } }] });
  bad({ items: [{ id: 'Bad Id', type: 'short_text', label: { it: 'X' } }] });
  bad({
    items: [
      { id: 'a1', type: 'short_text', label: { it: 'X' } },
      { id: 'a1', type: 'email', label: { it: 'Y' } },
    ],
  });
  bad({ items: [{ id: 'a1', type: 'short_text', label: {} }] });
  bad({ items: [{ id: 'a1', type: 'single', label: { it: 'X' }, options: [] }] });
  bad({
    items: [
      {
        id: 'a1',
        type: 'single',
        label: { it: 'X' },
        options: [
          { id: 'o1', label: { it: 'A' } },
          { id: 'o1', label: { it: 'B' } },
        ],
      },
    ],
  });
  bad({ items: [{ id: 'a1', type: 'scale', label: { it: 'X' }, max: 99 }] });
  bad({ items: [{ id: 'a1', type: 'number', label: { it: 'X' }, min: 5, max: 1 }] });
  bad({ items: [{ id: 'a1', type: 'short_text', label: { it: 'x'.repeat(501) } }] });
  bad({
    items: Array.from({ length: 151 }, (_, i) => ({
      id: `q${i}`,
      type: 'info',
      label: { it: 'x' },
    })),
  });
});

// ── Answers ──────────────────────────────────────────────────────────────────

test('good answers come out clean, in the shape of their questions', () => {
  const s = schemaLib.cleanSchema(fullSchema());
  const { answers, email } = schemaLib.cleanAnswers(s, {
    ...goodAnswers(),
    injected: 'ignored',
    intro: 'ignored too',
  });
  assert.equal(email, 'ada@example.org');
  assert.equal(answers.email, 'ada@example.org');
  assert.equal(answers.hours, 6);
  assert.deepEqual(answers.track, { selected: ['projects'] });
  assert.deepEqual(answers.privacy, {
    accepted: true,
    version: s.items.find((i) => i.id === 'privacy').consentVersion,
  });
  assert.equal(answers.injected, undefined);
  assert.equal(answers.intro, undefined);
  // "Other" instead of an option.
  const other = schemaLib.cleanAnswers(
    s,
    goodAnswers({ track: { selected: [], other: 'Entrambi' } })
  ).answers;
  assert.deepEqual(other.track, { selected: [], other: 'Entrambi' });
  // Optional questions left empty are simply absent.
  const short = schemaLib.cleanAnswers(s, {
    name: 'Ada',
    email: 'ada@example.org',
    track: { selected: ['projects'] },
    privacy: true,
  }).answers;
  assert.deepEqual(Object.keys(short).sort(), ['email', 'name', 'privacy', 'track']);
});

test('each wrong answer is refused with a message on its own question', () => {
  const s = schemaLib.cleanSchema(fullSchema());
  const errorsFor = (over) => {
    try {
      schemaLib.cleanAnswers(s, goodAnswers(over));
    } catch (e) {
      assert.equal(e.status, 400);
      return e.details.errors;
    }
    return {};
  };
  assert.ok(errorsFor({ name: '' }).name);
  assert.ok(errorsFor({ name: 42 }).name);
  assert.ok(errorsFor({ email: 'not-an-email' }).email);
  assert.ok(errorsFor({ bio: 'x'.repeat(201) }).bio);
  assert.ok(errorsFor({ cv: 'javascript:alert(1)' }).cv);
  assert.ok(errorsFor({ cv: 'http://insecure.example' }).cv);
  assert.ok(errorsFor({ hours: '99' }).hours);
  assert.ok(errorsFor({ hours: 'six' }).hours);
  assert.ok(errorsFor({ track: { selected: ['made-up'] } }).track);
  assert.ok(errorsFor({ track: { selected: ['projects', 'orientation'] } }).track); // one choice only
  assert.ok(errorsFor({ track: { selected: [] } }).track); // required
  assert.ok(errorsFor({ areas: { selected: ['interp', 'gov', 'evals'] } }).areas); // at most 2
  assert.ok(errorsFor({ city: { selected: [], other: 'Torino' } }).city); // drop-downs have no "other"
  assert.ok(errorsFor({ level: 6 }).level);
  assert.ok(errorsFor({ level: 2.5 }).level);
  assert.ok(errorsFor({ start: '2026-02-30' }).start);
  assert.ok(errorsFor({ inperson: 'maybe' }).inperson);
  assert.ok(errorsFor({ privacy: false }).privacy);
  assert.ok(errorsFor({ privacy: 'true' }).privacy); // must be exactly true
  // All the wrong ones at once, each named.
  const many = errorsFor({ name: '', level: 9, privacy: false });
  assert.deepEqual(Object.keys(many).sort(), ['level', 'name', 'privacy']);
});

// ── Anti-spam ────────────────────────────────────────────────────────────────

test('the honeypot and a too-quick send are treated as bots: success shown, nothing kept', async () => {
  await setRoles();
  const maker = await member('Mara', ['r-forms']);
  const { slug } = await openForm(maker);
  const filled = await answer(slug, goodAnswers(), { website: 'http://spam.example' });
  assert.equal(filled.ok, true);
  const quick = await answer(slug, goodAnswers(), { wait: 500 });
  assert.equal(quick.ok, true);
  const { rows } = await db.query('select count(*)::int as n from form_responses');
  assert.equal(rows[0].n, 0);
});

test('a forged, foreign or old token is refused', async () => {
  await setRoles();
  const maker = await member('Mara', ['r-forms']);
  const a = await openForm(maker);
  const b = await openForm(maker);
  const view = await forms.publicView(a.slug);
  later(5000);
  await rejects(forms.submit(a.slug, { token: 'garbage', answers: goodAnswers() }, '1.2.3.4'), 400);
  const [at] = view.token.split('.');
  await rejects(
    forms.submit(a.slug, { token: `${at}.forged`, answers: goodAnswers() }, '1.2.3.4'),
    400
  );
  // A token of form A does not open form B.
  await rejects(
    forms.submit(b.slug, { token: view.token, answers: goodAnswers() }, '1.2.3.4'),
    400
  );
  // A day later the token has expired.
  later(25 * 60 * 60 * 1000);
  await rejects(
    forms.submit(a.slug, { token: view.token, answers: goodAnswers() }, '1.2.3.4'),
    400
  );
});

test('one address can send a few answers, then has to wait; the address is never stored', async () => {
  await setRoles();
  const maker = await member('Mara', ['r-forms']);
  const { slug } = await openForm(maker);
  for (let i = 0; i < guard.MAX_PER_WINDOW; i++) {
    await answer(slug, goodAnswers({ email: `p${i}@example.org` }), { ip: '198.51.100.9' });
  }
  await rejects(
    answer(slug, goodAnswers({ email: 'late@example.org' }), { ip: '198.51.100.9' }),
    429
  );
  // Another address is fine.
  await answer(slug, goodAnswers({ email: 'other@example.org' }), { ip: '198.51.100.10' });
  // After the window, the first address may send again.
  later(guard.WINDOW_MS + 1000);
  await answer(slug, goodAnswers({ email: 'again@example.org' }), { ip: '198.51.100.9' });
  const dump = JSON.stringify((await db.query('select * from form_submit_attempts')).rows);
  assert.ok(!dump.includes('198.51.100'), 'an IP address was stored');
});

// ── Who sees which form ──────────────────────────────────────────────────────

test('making forms needs the forms permission; each maker sees their own', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const luca = await member('Luca', ['r-forms']);
  const boss = await member('Bea', ['r-forms-admin']);
  const nobody = await member('Nico', []);
  await rejects(forms.create(nobody, { title: 'X' }), 403);
  assert.equal((await audit.recent())[0].action, 'denied');

  const { id, slug } = await forms.create(mara, { title: 'Iscrizione meetup' });
  assert.match(slug, /^iscrizione-meetup-[0-9a-f]{6}$/);
  assert.deepEqual(
    (await forms.list(mara)).map((f) => f.id),
    [id]
  );
  assert.deepEqual(await forms.list(luca), []);
  assert.deepEqual(
    (await forms.list(boss)).map((f) => f.id),
    [id]
  );
  assert.deepEqual(await forms.list(nobody), []);
  // Someone else's form answers 404, as if it did not exist.
  await rejects(forms.get(luca, id), 404);
  await rejects(forms.saveSchema(luca, id, fullSchema()), 404);
  await rejects(forms.updateSettings(luca, id, { status: 'open' }), 404);
  // The forms admin may change it.
  await forms.updateSettings(boss, id, { status: 'open' });
});

test('a role on the form lets its holders read the answers, but not change the form', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const team = await member('Tea', ['r-mentors']);
  const { id, slug } = await openForm(mara);
  await answer(slug, goodAnswers());
  await rejects(forms.responses(team, id), 404);
  await forms.updateSettings(mara, id, { accessRoles: ['r-mentors'] });
  const read = await forms.responses(team, id);
  assert.equal(read.responses.length, 1);
  assert.equal(read.responses[0].answers.name, 'Ada Esempio');
  assert.equal((await forms.get(team, id)).canManage, false);
  await rejects(forms.saveSchema(team, id, fullSchema()), 404);
  const lines = (await audit.recent({ subjectKey: id })).map((l) => l.action);
  assert.ok(lines.includes('form-view-responses'));
  assert.equal(lines[0], 'denied'); // the refused change is on the trail too
});

// ── Settings and the public page ─────────────────────────────────────────────

test('a draft is not public; an open form is, until it closes', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { id, slug } = await forms.create(mara, { title: 'Prova', schema: fullSchema() });
  await rejects(forms.publicView(slug), 404);
  await forms.updateSettings(mara, id, { status: 'open' });
  const view = await forms.publicView(slug);
  assert.equal(view.open, true);
  assert.equal(view.schema.items.length, 14);
  assert.ok(view.token);
  assert.equal(view.owner, undefined);
  assert.equal(view.settings, undefined);
  // Opening in the future, or closed: no questions, no token.
  await forms.updateSettings(mara, id, { opensAt: new Date(Date.now() + 86400000).toISOString() });
  const soon = await forms.publicView(slug);
  assert.equal(soon.open, false);
  assert.equal(soon.schema, undefined);
  assert.equal(soon.token, undefined);
  await forms.updateSettings(mara, id, { opensAt: null, status: 'closed' });
  assert.equal((await forms.publicView(slug)).open, false);
  await rejects(answer(slug, goodAnswers()), 410); // closed: refused before anything else
  await rejects(forms.publicView('../../etc'), 404);
});

test('settings are validated: dates, link, roles, and something to answer before opening', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { id } = await forms.create(mara, {
    title: 'Vuoto',
    schema: {
      languages: ['it'],
      title: { it: 'Vuoto' },
      items: [{ id: 'intro', type: 'info', label: { it: 'Solo testo' } }],
    },
  });
  await rejects(forms.updateSettings(mara, id, { status: 'open' }), 400);
  await rejects(forms.updateSettings(mara, id, { status: 'published' }), 400);
  await rejects(
    forms.updateSettings(mara, id, { opensAt: '2027-01-02', closesAt: '2027-01-01' }),
    400
  );
  await rejects(forms.updateSettings(mara, id, { slug: 'Not A Slug!' }), 400);
  await rejects(forms.updateSettings(mara, id, { accessRoles: ['ok', 'not ok!'] }), 400);
  const saved = await forms.updateSettings(mara, id, {
    slug: 'my-form',
    settings: { notifyOwner: false, oneResponsePerEmail: true },
  });
  assert.equal(saved.slug, 'my-form');
  assert.equal(saved.settings.notifyOwner, false);
  assert.equal(saved.settings.oneResponsePerEmail, true);
});

// ── Answers stored ───────────────────────────────────────────────────────────

test('an answer is stored encrypted, bound to its form and response', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { id, slug } = await openForm(mara);
  const sent = await answer(slug, goodAnswers());
  assert.deepEqual(sent.confirmation, { it: 'Grazie!' });
  const { rows } = await db.query('select * from form_responses');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].respondent_key, crm.personKey('ada@example.org'));
  const dump = JSON.stringify(rows);
  assert.ok(!/Ada|example\.org|Ricercatrice|projects/.test(dump), 'an answer is stored in clear');
  // Readable to the maker.
  const read = await forms.responses(mara, id);
  assert.equal(read.responses[0].answers.email, 'ada@example.org');
  // Moved onto another response row, the ciphertext does not open.
  await answer(slug, goodAnswers({ email: 'bruno@example.org', name: 'Bruno' }));
  const both = (
    await db.query('select id, answers_encrypted from form_responses order by submitted_at')
  ).rows;
  await db.query('update form_responses set answers_encrypted = $1 where id = $2', [
    both[0].answers_encrypted,
    both[1].id,
  ]);
  const after = await forms.responses(mara, id);
  assert.equal(after.responses.find((r) => r.id === both[1].id).answers.unreadable, true);
});

test('wrong answers are refused with their errors, and nothing is stored', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { slug } = await openForm(mara);
  await assert.rejects(answer(slug, goodAnswers({ email: 'nope', privacy: false })), (e) => {
    assert.equal(e.status, 400);
    assert.deepEqual(Object.keys(e.details.errors).sort(), ['email', 'privacy']);
    return true;
  });
  assert.equal((await db.query('select count(*)::int as n from form_responses')).rows[0].n, 0);
});

test('one answer per email, when the form asks for it', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { slug } = await openForm(mara, { settings: { settings: { oneResponsePerEmail: true } } });
  await answer(slug, goodAnswers());
  await rejects(answer(slug, goodAnswers({ email: 'ADA@example.org' })), 409);
  await answer(slug, goodAnswers({ email: 'bruno@example.org' }));
});

test('two answers from one email sent together: only one is kept', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { slug } = await openForm(mara, { settings: { settings: { oneResponsePerEmail: true } } });
  const first = await forms.publicView(slug);
  const second = await forms.publicView(slug);
  later(5000);
  const send = (view) =>
    forms.submit(
      slug,
      { version: view.version, token: view.token, answers: goodAnswers() },
      '203.0.113.7'
    );
  const results = await Promise.allSettled([send(first), send(second)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.status, 409);
  assert.equal((await db.query('select count(*)::int as n from form_responses')).rows[0].n, 1);
});

test('changing a form with answers makes a new version; old answers keep their questions', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { id, slug } = await openForm(mara);
  // No answers yet: saving overwrites version 1.
  assert.deepEqual(
    await forms.saveSchema(mara, id, fullSchema({ title: { it: 'Titolo nuovo' } })),
    { version: 1 }
  );
  await answer(slug, goodAnswers());
  const removed = fullSchema();
  removed.items = removed.items.filter((i) => i.id !== 'bio');
  assert.deepEqual(await forms.saveSchema(mara, id, removed), { version: 2 });
  await answer(slug, goodAnswers({ email: 'bruno@example.org' }));
  const read = await forms.responses(mara, id);
  assert.deepEqual(read.responses.map((r) => r.version).sort(), [1, 2]);
  assert.ok(read.versions[1].items.some((i) => i.id === 'bio'));
  assert.ok(!read.versions[2].items.some((i) => i.id === 'bio'));
  assert.equal(read.responses.find((r) => r.version === 1).answers.bio, 'Ricercatrice inventata.');
  // The link cannot change any more.
  await rejects(forms.updateSettings(mara, id, { slug: 'new-link' }), 409);
});

test('a form with answers is closed, not deleted, unless by a forms admin', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const boss = await member('Bea', ['r-forms-admin']);
  const draft = await forms.create(mara, { title: 'Bozza' });
  await forms.remove(mara, draft.id);
  const { id, slug } = await openForm(mara);
  await answer(slug, goodAnswers());
  await rejects(forms.remove(mara, id), 409);
  await forms.remove(boss, id);
  assert.equal((await db.query('select count(*)::int as n from form_responses')).rows[0].n, 0);
});

// ── The APIs ─────────────────────────────────────────────────────────────────

async function call(handler, { method = 'GET', url, user, body, ip = '192.0.2.1' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
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
  await handler({ method, url, headers, body, socket: {} }, res);
  return res;
}

test('the public API opens and takes a form without signing in', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { slug } = await openForm(mara);
  const view = await call(publicApi, { url: `/api/form?f=${slug}` });
  assert.equal(view.statusCode, 200);
  later(5000);
  const sent = await call(publicApi, {
    method: 'POST',
    url: `/api/form?f=${slug}`,
    body: { version: view.body.version, token: view.body.token, answers: goodAnswers() },
  });
  assert.equal(sent.statusCode, 201);
  assert.deepEqual(sent.body, { ok: true, confirmation: { it: 'Grazie!' } });
  assert.equal((await call(publicApi, { url: '/api/form?f=no-such-form' })).statusCode, 404);
  delete process.env.CRM_ENCRYPTION_KEY;
  assert.equal((await call(publicApi, { url: `/api/form?f=${slug}` })).statusCode, 503);
});

test('the private API needs a sign-in and answers per user', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  assert.equal((await call(appApi, { url: '/api/app/forms' })).statusCode, 401);
  const created = await call(appApi, {
    method: 'POST',
    url: '/api/app/forms',
    user: mara,
    body: { title: 'Dalla API' },
  });
  assert.equal(created.statusCode, 201);
  const list = await call(appApi, { url: '/api/app/forms', user: mara });
  assert.equal(list.body.forms.length, 1);
  assert.equal(list.headers['Cache-Control'], 'no-store');
  const nico = await member('Nico', []);
  assert.equal(
    (await call(appApi, { url: `/api/app/forms?id=${created.body.id}`, user: nico })).statusCode,
    404
  );
  assert.equal(
    (
      await call(appApi, {
        method: 'PUT',
        url: `/api/app/forms?id=${created.body.id}&part=nonsense`,
        user: mara,
        body: {},
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await call(appApi, {
        method: 'POST',
        url: '/api/app/forms',
        user: await admin(),
        body: { title: 'Admin' },
      })
    ).statusCode,
    201
  );
});

test('every template is a valid form, and a form can start from one', async () => {
  const templates = require('./forms/templates');
  for (const { key } of templates.list()) {
    const schema = schemaLib.cleanSchema(templates.schemaFor(key, 'Prova'));
    assert.ok(schemaLib.answerable(schema).length > 0, key);
  }
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const { id } = await forms.create(mara, { title: 'Da modello', template: 'mentor_call' });
  const form = await forms.get(mara, id);
  assert.ok(form.schema.items.some((i) => i.id === 'project_title'));
  assert.ok(form.schema.items.some((i) => i.type === 'consent'));
  // An unknown template falls back to the blank one.
  const blank = await forms.get(
    mara,
    (
      await forms.create(mara, { title: 'X', template: 'nope' })
    ).id
  );
  assert.deepEqual(
    blank.schema.items.map((i) => i.id),
    ['name', 'email']
  );
});

// ── The community's registration form ───────────────────────────────────────

const signupAnswers = (over = {}) => ({
  first_name: 'Giulia',
  last_name: 'Bianchi',
  email: 'Giulia@Example.org',
  involvement: { selected: ['active'] },
  areas: { selected: ['governance', 'ethics'] },
  publish: 'yes',
  privacy: true,
  ...over,
});

/** The board's list, oldest first, as someone with `members` sees it. */
async function applications() {
  const { rows } = await db.query('select count(*)::int as n from member_applications');
  if (!rows[0].n) return [];
  return (await require('./members').listApplications(await admin())).applications.reverse();
}

test('the sign-up template comes wired to the members board, but only for forms admins', async () => {
  await setRoles();
  const root = await admin();
  const mara = await member('Mara', ['r-forms']);
  const wired = await forms.get(
    root,
    (
      await forms.create(root, { title: 'Iscrizione', template: 'community_signup' })
    ).id
  );
  assert.equal(wired.settings.membership.emailItem, 'email');
  assert.equal(wired.settings.membership.roles.active, 'organizer');
  const plain = await forms.get(
    mara,
    (
      await forms.create(mara, { title: 'Iscrizione', template: 'community_signup' })
    ).id
  );
  assert.equal(plain.settings.membership, null);
  const other = await forms.get(
    root,
    (
      await forms.create(root, { title: 'Altro', template: 'mentor_call' })
    ).id
  );
  assert.equal(other.settings.membership, null);
});

test('an answer to the sign-up form also reaches the board, with the role asked for', async () => {
  const root = await admin();
  const { id, slug } = await forms.create(root, {
    title: 'Iscrizione',
    template: 'community_signup',
  });
  await forms.updateSettings(root, id, { status: 'open' });
  await answer(slug, signupAnswers());
  await answer(
    slug,
    signupAnswers({ email: 'sara@example.org', involvement: { selected: ['discord'] } })
  );

  const rows = await applications();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Giulia Bianchi');
  assert.equal(rows[0].email, 'giulia@example.org');
  assert.equal(rows[0].requestedRole, 'organizer');
  assert.equal(rows[1].requestedRole, 'participant');
  assert.equal(rows[0].source, slug);
  assert.equal(rows[0].status, 'pending');
  const shown = Object.fromEntries(rows[0].answers.map((a) => [a.label, a.value]));
  assert.equal(
    shown['Aree'] || shown['Quali aree ti interessano di più?'],
    'AI governance e policy, Etica dell’AI e impatto sociale'.replace('’', "'")
  );
  assert.equal(
    shown["Acconsenti alla pubblicazione del tuo profilo nella sezione 'Community' del sito?"],
    'Sì'
  );
  // The answers are kept with the form too, encrypted.
  const stored = await forms.responses(root, id);
  assert.equal(stored.responses.length, 2);
});

test('a bot, a wrong answer or a form that is not wired sends nothing to the board', async () => {
  const root = await admin();
  const { id, slug } = await forms.create(root, {
    title: 'Iscrizione',
    template: 'community_signup',
  });
  await forms.updateSettings(root, id, { status: 'open' });
  await answer(slug, signupAnswers(), { website: 'http://spam.example' });
  await answer(slug, signupAnswers({ email: 'not-an-email' })).catch(() => {});
  assert.equal((await applications()).length, 0);

  // Unwired: the answer is kept, the board sees nothing.
  await forms.updateSettings(root, id, { settings: { membership: null } });
  await answer(slug, signupAnswers());
  assert.equal((await applications()).length, 0);
  assert.equal((await forms.responses(root, id)).responses.length, 1);
});

test('only forms admins may link a form to the board, and the mapping must fit the questions', async () => {
  await setRoles();
  const root = await admin();
  const mara = await member('Mara', ['r-forms']);
  const { id } = await forms.create(mara, { title: 'Mio', template: 'community_signup' });
  const mapping = {
    nameItem: 'first_name',
    surnameItem: 'last_name',
    emailItem: 'email',
    roleItem: 'involvement',
    roles: { active: 'organizer' },
  };
  await rejects(forms.updateSettings(mara, id, { settings: { membership: mapping } }), 403);
  await forms.updateSettings(root, id, { settings: { membership: mapping } });
  // Changing nothing is no change: the owner may save other settings.
  await forms.updateSettings(mara, id, { settings: { membership: mapping, notifyOwner: false } });
  await rejects(forms.updateSettings(mara, id, { settings: { membership: null } }), 403);

  const bad = [
    { ...mapping, emailItem: 'first_name' }, // not an email question
    { ...mapping, nameItem: 'nope' },
    { ...mapping, nameItem: undefined },
    { ...mapping, roles: { ghost: 'organizer' } },
    { ...mapping, roles: { active: 'god' } },
    'yes',
  ];
  for (const membership of bad) {
    await rejects(forms.updateSettings(root, id, { settings: { membership } }), 400);
  }
});

// ── Telling the owner ────────────────────────────────────────────────────────

test('the owner hears that someone answered, never what, and only if they asked', async () => {
  const mail = require('./mail');
  const sent = [];
  process.env.MEET_FAKE_MAIL = '0';
  mail.setTransportFactory(() => ({ sendMail: async (m) => sent.push(m), close() {} }));
  await mail.saveSettings({ host: 'smtp.x', port: 465, fromEmail: 'tech@ais4i.it', password: 'p' });
  try {
    await setRoles();
    const mara = await member('Mara', ['r-forms']);
    await auth.updateProfile(mara.id, { notifyChannel: 'email', notifyEmail: 'mara@example.org' });
    const { id, slug } = await openForm(mara);
    const send = async (answers, extra = {}) => {
      const view = (await call(publicApi, { url: `/api/form?f=${slug}` })).body;
      later(5000);
      return call(publicApi, {
        method: 'POST',
        url: `/api/form?f=${slug}`,
        body: { version: view.version, token: view.token, answers, ...extra },
      });
    };

    assert.equal((await send(goodAnswers())).statusCode, 201);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'mara@example.org');
    assert.match(sent[0].subject, /Candidatura di prova/);
    assert.ok(sent[0].text.includes(`/app/forms/edit/?id=${id}`));
    for (const said of ['Ada', 'example.org/cv', 'Ricercatrice']) {
      assert.ok(!JSON.stringify(sent[0]).includes(said), said);
    }

    // A bot is not stored, so nobody is told.
    await send(goodAnswers({ email: 'b@example.org' }), { website: 'http://spam.example' });
    assert.equal(sent.length, 1);

    // Switched off: nothing.
    await forms.updateSettings(mara, id, { settings: { notifyOwner: false } });
    assert.equal((await send(goodAnswers({ email: 'c@example.org' }))).statusCode, 201);
    assert.equal(sent.length, 1);

    // A form made with the admin password has no owner to tell.
    const root = await admin();
    const made = await forms.create(root, { title: 'Senza proprietario', schema: fullSchema() });
    await forms.updateSettings(root, made.id, { status: 'open' });
    assert.deepEqual(await forms.notifyOwner(made.id, 'https://x'), []);
  } finally {
    process.env.MEET_FAKE_MAIL = '1';
  }
});

// ── Reviewing the answers ────────────────────────────────────────────────────

test('a reader moves an answer along; outsiders and odd statuses are refused', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const team = await member('Tea', ['r-mentors']);
  const stranger = await member('Sid', []);
  const { id, slug } = await openForm(mara);
  await answer(slug, goodAnswers());
  await forms.updateSettings(mara, id, { accessRoles: ['r-mentors'] });
  const [first] = (await forms.responses(team, id)).responses;
  assert.equal(first.status, 'new');

  await forms.setResponseStatus(team, id, first.id, 'accepted');
  const after = await forms.responses(mara, id);
  assert.equal(after.responses[0].status, 'accepted');
  assert.deepEqual(after.statuses, ['new', 'reviewing', 'accepted', 'rejected']);
  assert.equal(after.canManage, true);
  assert.equal((await forms.responses(team, id)).canManage, false);

  await rejects(forms.setResponseStatus(team, id, first.id, 'starred'), 400);
  await rejects(forms.setResponseStatus(stranger, id, first.id, 'rejected'), 404);
  await rejects(forms.setResponseStatus(team, id, crypto.randomUUID(), 'new'), 404);
  const trail = await audit.recent({ subjectKey: first.id });
  assert.deepEqual(trail[0].detail, { status: 'accepted' });
});

test('only a manager deletes an answer, and it is gone for good', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const team = await member('Tea', ['r-mentors']);
  const { id, slug } = await openForm(mara);
  await answer(slug, goodAnswers());
  await answer(slug, goodAnswers({ email: 'bea@example.org' }));
  await forms.updateSettings(mara, id, { accessRoles: ['r-mentors'] });
  const [one] = (await forms.responses(mara, id)).responses;

  await rejects(forms.deleteResponse(team, id, one.id), 404);
  await forms.deleteResponse(mara, id, one.id);
  const { rows } = await db.query('select id from form_responses where form_id = $1', [id]);
  assert.deepEqual(
    rows.map((r) => r.id),
    (await forms.responses(mara, id)).responses.map((r) => r.id)
  );
  assert.equal(rows.length, 1);
  assert.ok(!rows.some((r) => r.id === one.id));
  await rejects(forms.deleteResponse(mara, id, one.id), 404);
  assert.equal((await audit.recent({ subjectKey: one.id }))[0].action, 'form-delete-response');
});

test('the CSV export: managers only, every version, and no formula runs in a spreadsheet', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const team = await member('Tea', ['r-mentors']);
  const { id, slug } = await openForm(mara);
  await answer(slug, goodAnswers({ bio: '=HYPERLINK("http://evil.example","x")' }));
  // A new version without "bio", and a new question: both columns stay.
  const schema = fullSchema();
  schema.items = schema.items.filter((i) => i.id !== 'bio');
  schema.items.push({ id: 'extra', type: 'short_text', label: { it: 'Nuova, "con" virgole' } });
  await forms.saveSchema(mara, id, schema);
  await answer(slug, goodAnswers({ email: 'bea@example.org', extra: '+39 333' }), {
    ip: '203.0.113.9',
  });
  await forms.updateSettings(mara, id, { accessRoles: ['r-mentors'] });

  await rejects(forms.exportCsv(team, id), 404);
  const before = (await audit.recent({ subjectKey: id })).length;
  const { filename, csv } = await forms.exportCsv(mara, id);
  assert.match(filename, /^candidatura-di-prova-[0-9a-f]{6}-answers\.csv$/);
  assert.ok(csv.startsWith('﻿Submitted,Status,Version,'));
  const [header, older, newer] = csv.slice(1).trim().split('\r\n');
  assert.ok(header.includes('"Nuova, ""con"" virgole"'));
  assert.ok(header.includes('Chi sei'));
  assert.ok(older.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`));
  assert.ok(newer.includes("'+39 333"));
  assert.ok(older.includes('Interpretabilità, Governance'));
  const trail = await audit.recent({ subjectKey: id });
  // The export adds one line of its own, not also a "viewed the answers" one.
  assert.equal(trail.length, before + 1);
  assert.equal(trail[0].action, 'form-export');
});

test('a long name still reaches the board; if the board refuses, nothing is kept and the person is told', async () => {
  const root = await admin();
  const { id, slug } = await forms.create(root, {
    title: 'Iscrizione',
    template: 'community_signup',
  });
  await forms.updateSettings(root, id, { status: 'open' });
  const long = 'Maria '.repeat(46).trim(); // 275 characters, fine for a short answer
  await answer(slug, signupAnswers({ first_name: long }));
  const [app] = await applications();
  assert.equal(app.name, long + ' Bianchi');

  const members = require('./members');
  const original = members.createApplication;
  members.createApplication = async () => {
    throw new Error('the board is down');
  };
  try {
    await assert.rejects(answer(slug, signupAnswers({ email: 'sara@example.org' })));
  } finally {
    members.createApplication = original;
  }
  assert.equal((await forms.responses(root, id)).responses.length, 1);
  assert.equal((await applications()).length, 1);
});

test('the sign-up form gets the address the site join buttons open, once', async () => {
  const { JOIN_SLUG } = require('./forms/membership');
  const site = require('../src/data/site.js');
  assert.equal(site.forms.mailingList, `/form/?f=${JOIN_SLUG}`);
  const root = await admin();
  const first = await forms.create(root, { title: 'Iscrizione', template: 'community_signup' });
  assert.equal(first.slug, JOIN_SLUG);
  // Taken: the next one gets a random address, as any other form.
  const second = await forms.create(root, { title: 'Iscrizione', template: 'community_signup' });
  assert.notEqual(second.slug, JOIN_SLUG);
  const plain = await forms.create(root, { title: 'Iscrizione', template: 'blank' });
  assert.notEqual(plain.slug, JOIN_SLUG);
});

test('a mentee application form feeds the mentorship board, and goes with its answer', async () => {
  await setRoles();
  const root = await admin();
  const { id, slug } = await forms.create(root, {
    title: 'Candidatura mentee',
    template: 'mentee_application',
  });
  assert.equal(slug, 'candidatura-mentee');
  assert.equal((await forms.get(root, id)).settings.crm, 'mentees_applications');
  await forms.updateSettings(root, id, { status: 'open' });

  await answer(slug, {
    privacy: true,
    name: 'Gino Mentee',
    email: 'gino@example.org',
    tracks: { selected: ['projects'] },
    motivation: 'Voglio imparare.',
    hours: '5',
  });
  const { rows } = await db.query('select origin, response_id, source from crm_records');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, 'form');
  assert.equal(rows[0].source, 'mentees_applications');
  assert.ok(rows[0].response_id);

  const { mentees } = await require('./crm/mentorship').board(root);
  const gino = mentees.find((m) => m.name === 'Gino Mentee');
  assert.equal(gino.status, 'applied');

  const [one] = (await forms.responses(root, id)).responses;
  await forms.deleteResponse(root, id, one.id);
  assert.equal((await db.query('select 1 from crm_records')).rows.length, 0);
});

test('only forms admins link a form to the mentorship board, and only to a known list', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const boss = await member('Bea', ['r-forms-admin']);
  const { id } = await forms.create(mara, { title: 'Mentor', template: 'mentor_call' });
  // A maker's copy of the template is not linked.
  assert.equal((await forms.get(mara, id)).settings.crm, null);
  await rejects(forms.updateSettings(mara, id, { settings: { crm: 'mentors_applications' } }), 403);
  // Saving the unchanged value is fine for her.
  await forms.updateSettings(mara, id, { settings: { crm: null } });
  await rejects(forms.updateSettings(boss, id, { settings: { crm: 'everyone' } }), 400);
  await forms.updateSettings(boss, id, { settings: { crm: 'mentors_applications' } });
  assert.equal((await forms.get(boss, id)).settings.crm, 'mentors_applications');
});

// ── Show only if ─────────────────────────────────────────────────────────────

const branching = (extra = {}) => ({
  languages: ['it'],
  title: { it: 'Ramo' },
  items: [
    {
      id: 'kind',
      type: 'single',
      label: { it: 'Come?' },
      options: [
        { id: 'active', label: { it: 'Attivo' } },
        { id: 'discord', label: { it: 'Solo Discord' } },
      ],
    },
    {
      id: 'what',
      type: 'short_text',
      required: true,
      label: { it: 'Cosa?' },
      showIf: { item: 'kind', values: ['active'] },
    },
    {
      id: 'page2',
      type: 'section',
      label: { it: 'Pagina' },
      showIf: { item: 'kind', values: ['active'] },
    },
    { id: 'hours', type: 'number', required: true, label: { it: 'Ore?' } },
    { id: 'page3', type: 'section', label: { it: 'Fine' } },
    { id: 'note', type: 'short_text', label: { it: 'Nota' } },
    ...(extra.items || []),
  ],
});

test('a hidden question loses its answer and its "required"; a section hides what follows it', () => {
  const schema = schemaLib.cleanSchema(branching());
  const hidden = schemaLib.cleanAnswers(schema, {
    kind: { selected: ['discord'] },
    what: 'sbirciare',
    hours: 5,
    note: 'ciao',
  });
  assert.deepEqual(hidden.answers, { kind: { selected: ['discord'] }, note: 'ciao' });
  assert.deepEqual([...schemaLib.visibleIds(schema, hidden.answers)], ['kind', 'page3', 'note']);
  // Shown: required applies again.
  assert.throws(
    () => schemaLib.cleanAnswers(schema, { kind: { selected: ['active'] } }),
    (err) => Boolean(err.details.errors.what && err.details.errors.hours)
  );
  const shown = schemaLib.cleanAnswers(schema, {
    kind: { selected: ['active'] },
    what: 'x',
    hours: 3,
  });
  assert.equal(shown.answers.hours, 3);
});

test('a "show only if" must point to an earlier choice question and real answers', () => {
  const bad = (items) =>
    assert.throws(
      () => schemaLib.cleanSchema(branching({ items })),
      (err) => err.status === 400 && Boolean(err.details.field)
    );
  const info = (showIf) => ({ id: 'zz', type: 'info', label: { it: 'Z' }, showIf });
  bad([info({ item: 'ghost', values: ['a'] })]);
  bad([
    info({ item: 'later', values: ['yes'] }),
    { id: 'later', type: 'yes_no', label: { it: 'L' } },
  ]);
  bad([info({ item: 'zz', values: ['yes'] })]);
  bad([info({ item: 'what', values: ['x'] })]); // a text question
  bad([info({ item: 'kind', values: ['nope'] })]);
  bad([info({ item: 'kind', values: [] })]);
});

test('the editor sees who reads the answers: the owner and whoever holds forms_admin', async () => {
  await setRoles();
  const mara = await member('Mara', ['r-forms']);
  const team = await member('Tea', ['r-mentors']);
  const { id } = await openForm(mara);
  await forms.updateSettings(mara, id, { accessRoles: ['r-mentors'] });
  const readers = (await forms.get(mara, id)).readers;
  assert.equal(readers.owner, 'Mara');
  assert.deepEqual(readers.allFormsRoles, ['forms admins']);
  assert.deepEqual(readers.allFormsPeople, []);
  assert.equal((await forms.get(team, id)).readers, undefined); // a reader cannot change the form
});

test('a consent cannot be shown only if…, on its own or through its section', () => {
  const consent = { id: 'ok', type: 'consent', required: true, label: { it: 'Acconsento' } };
  const refused = (items) =>
    assert.throws(
      () => schemaLib.cleanSchema(branching({ items })),
      (err) => err.status === 400 && err.details.field === 'ok'
    );
  refused([{ ...consent, showIf: { item: 'kind', values: ['active'] } }]);
  // After page3 (shown to everyone) it is fine; under a hidden section it is not.
  schemaLib.cleanSchema(branching({ items: [consent] }));
  refused([
    {
      id: 'more',
      type: 'section',
      label: { it: 'Altro' },
      showIf: { item: 'kind', values: ['active'] },
    },
    consent,
  ]);
});

test('the registration form keeps its name, email and role questions always shown', async () => {
  const root = await admin();
  const { id } = await forms.create(root, { title: 'Iscrizione', template: 'community_signup' });
  const { schema, settings } = await forms.get(root, id);
  const gate = { id: 'gate', type: 'yes_no', label: { it: 'Vuoi?' } };
  const hiding = (itemId) => ({
    ...schema,
    items: [
      gate,
      ...schema.items.map((it) =>
        it.id === itemId ? { ...it, showIf: { item: 'gate', values: ['yes'] } } : it
      ),
    ],
  });
  // Saving questions that would hide a mapped one is refused...
  for (const mapped of ['first_name', 'email', 'involvement']) {
    await rejects(forms.saveSchema(root, id, hiding(mapped)), 400);
  }
  // ...and so is mapping a question that is already conditional.
  await forms.updateSettings(root, id, { settings: { membership: null } });
  await forms.saveSchema(root, id, hiding('email'));
  await rejects(
    forms.updateSettings(root, id, { settings: { membership: settings.membership } }),
    400
  );
});
