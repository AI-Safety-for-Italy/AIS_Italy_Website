// Tests for the matching after the mentee selection (server/crm/matching.js
// and its API), on invented data only. Run with `npm run test:meet`.
//
// Three mentors run three projects: Ada Rossi (2 places), Bruno Verdi (1),
// and Carla Neri and Dario Blu together (1). The mentees ranked the projects
// in the application form; the selection scored them.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const crm = require('./crm/crypto');
const guard = require('./forms/guard');
const forms = require('./forms/forms');
const records = require('./crm/records');
const mentorship = require('./crm/mentorship');
const review = require('./crm/review');
const matching = require('./crm/matching');
const api = require('./routes/app/crm/review');

let clock = Date.now();
beforeEach(async () => {
  await testDb.fresh();
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-matching-secret-of-at-least-thirty-two-characters';
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  clock = Date.now();
  guard.setClock(() => clock);
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

const key = (name) => crm.personKey(`${name.toLowerCase()}@example.org`);

const SCHEMA = {
  languages: ['it'],
  title: { it: 'Candidatura mentee' },
  items: [
    { id: 'name', type: 'short_text', label: { it: 'Nome' }, required: true },
    { id: 'email', type: 'email', label: { it: 'Email' } },
    {
      id: 'progetti',
      type: 'ranking',
      label: { it: 'Quali progetti ti interessano?' },
      options: [
        { id: 'o_evals', label: { it: 'Valutare i chatbot (Rossi)' } },
        { id: 'o_secur', label: { it: 'Rischi nella sicurezza (Verdi)' } },
        { id: 'o_moral', label: { it: 'Scelte morali (Neri, Blu)' } },
      ],
      rankCount: 1,
      rankMode: 'atLeast',
    },
  ],
};

async function makeForm(me) {
  const { id, slug } = await forms.create(me, { title: 'Candidatura mentee', schema: SCHEMA });
  await forms.updateSettings(me, id, { status: 'open' });
  return { id, slug };
}

async function answer(slug, name, ranked, { email = true } = {}) {
  const view = await forms.publicView(slug);
  clock += 5000;
  const answers = { name, progetti: ranked };
  if (email) answers.email = `${name.toLowerCase()}@example.org`;
  return forms.submit(slug, { version: view.version, token: view.token, answers }, '203.0.113.9');
}

async function mentor(me, name, surname, places, tracks = 'Progetti') {
  await records.add(
    'mentors_applications',
    {
      name: `${name} ${surname}`,
      email: `${name.toLowerCase()}@example.org`,
      tracks,
      mentees: String(places),
    },
    { origin: 'form' }
  );
  await mentorship.update(me, key(name), 'mentor', { status: 'selected' });
}

async function mentee(name, tracks = 'Progetti di AI safety') {
  await records.add(
    'mentees_applications',
    { name, email: `${name.toLowerCase()}@example.org`, tracks },
    { origin: 'form' }
  );
}

/** Every criterion of every section at `value`, by one reviewer. */
async function score(me, name, value) {
  for (const s of (await review.getSettings()).sections) {
    const scores = {};
    review.slots(s).forEach((c) => {
      scores[c.key] = value;
    });
    await db.query(
      `insert into review_scores (person_key, part, reviewer_id, reviewer_name, scores)
       values ($1, $2, $3, $4, $5)`,
      [key(name), s.key, me.id, me.name, scores]
    );
  }
}

/** The whole cast: mentors, mentees, answers, scores. */
async function cast() {
  const me = await admin();
  await mentor(me, 'Ada', 'Rossi', 2);
  await mentor(me, 'Bruno', 'Verdi', 1);
  await mentor(me, 'Carla', 'Neri', 1);
  await mentor(me, 'Dario', 'Blu', 1);
  const people = [
    ['Lia', ['o_secur', 'o_evals'], 5],
    ['Marco', ['o_secur'], 4],
    ['Nina', ['o_evals', 'o_moral'], 3],
    ['Olga', ['o_moral', 'o_secur', 'o_evals'], 2],
  ];
  const form = await makeForm(me);
  for (const [name, ranked, value] of people) {
    await mentee(name);
    await answer(form.slug, name, ranked);
    await score(me, name, value);
    await mentorship.update(me, key(name), 'mentee', { status: 'selected' });
  }
  return { me, form };
}

async function call({ method = 'GET', url, user, body }) {
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

// ── The stable matching on its own ───────────────────────────────────────────

const pref = (project, score, position) => ({ project, score, position });

test('the stable matching keeps each project to its places and the best by score', () => {
  const got = matching.stableMatch(
    [
      { id: 'a', free: 1 },
      { id: 'b', free: 1 },
    ],
    [
      { key: 'x', prefs: [pref('a', 3, 1), pref('b', 2.7, 2)] },
      { key: 'y', prefs: [pref('a', 4, 1)] },
      { key: 'z', prefs: [pref('a', 5, 1), pref('b', 4.7, 2)] },
    ]
  );
  // Everyone wants a: z is best there; x falls back to b; y has nothing else.
  assert.deepEqual(got, { z: 'a', x: 'b' });
});

test('a place given up for a better candidate goes to the next choice, and no place is no pair', () => {
  const got = matching.stableMatch(
    [
      { id: 'a', free: 1 },
      { id: 'b', free: 0 },
      { id: 'c', free: Infinity },
    ],
    [
      { key: 'x', prefs: [pref('a', 3, 1), pref('b', 4, 2), pref('c', 2, 3)] },
      { key: 'y', prefs: [pref('b', 5, 1), pref('a', 4, 2)] },
    ]
  );
  // b has no room; y takes a from x, who ends on c.
  assert.deepEqual(got, { y: 'a', x: 'c' });
  // No score loses to a score; equal scores go to the higher place.
  assert.deepEqual(
    matching.stableMatch(
      [{ id: 'a', free: 1 }],
      [
        { key: 'x', prefs: [pref('a', null, 1)] },
        { key: 'y', prefs: [pref('a', 3, 2)] },
      ]
    ),
    { y: 'a' }
  );
  assert.deepEqual(
    matching.stableMatch(
      [{ id: 'a', free: 1 }],
      [
        { key: 'x', prefs: [pref('a', 3, 2)] },
        { key: 'y', prefs: [pref('a', 3, 1)] },
      ]
    ),
    { y: 'a' }
  );
});

test('the mentors of a project are guessed from the surnames in its brackets', () => {
  const mentors = [
    { key: 'k1', name: 'Ada Rossi' },
    { key: 'k2', name: 'Carla Neri' },
    { key: 'k3', name: 'Dario Blu' },
    { key: 'k4', name: 'Elena Rossi' },
    { key: 'k5', name: 'Lorenzo Pacchiardi' },
  ];
  const guess = matching.suggestMapping(
    [
      { id: 'a', label: 'Valutazione dei chatbot (Pacchiardi)' },
      { id: 'b', label: 'Scelte morali (Neri, Blu)' },
      { id: 'c', label: 'Due Rossi (Rossi)' },
      { id: 'd', label: 'Senza nessuno' },
      { id: 'e', label: 'Con (parentesi) prima (Ada Rossi e Dario Blu)' },
    ],
    mentors
  );
  // Two Rossi: left to the admins, unless the first name tells them apart.
  assert.deepEqual(guess, { a: ['k5'], b: ['k2', 'k3'], e: ['k1', 'k3'] });
});

// ── The form's answers ───────────────────────────────────────────────────────

test('the ranking is read as ids, newest answer each, through every version of the form', async () => {
  const me = await admin();
  const form = await makeForm(me);
  await answer(form.slug, 'Lia', ['o_moral', 'o_evals']);
  await answer(form.slug, 'Senzamail', ['o_evals'], { email: false });
  // The form changes after the first answers: an option goes, one comes.
  const items = SCHEMA.items.map((i) =>
    i.id === 'progetti'
      ? {
          ...i,
          options: [
            { id: 'o_evals', label: { it: 'Valutare i chatbot (Rossi)' } },
            { id: 'o_new', label: { it: 'Nuovo progetto (Verdi)' } },
          ],
        }
      : i
  );
  await forms.saveSchema(me, form.id, { ...SCHEMA, items });
  await answer(form.slug, 'Marco', ['o_new']);

  const read = await forms.rankingAnswers(form.id, 'progetti');
  assert.deepEqual(
    read.options.map((o) => o.id),
    ['o_evals', 'o_new', 'o_secur', 'o_moral']
  );
  // The option taken out keeps its label, for Lia's answer.
  assert.equal(read.options.find((o) => o.id === 'o_moral').label, 'Scelte morali (Neri, Blu)');
  const byKey = new Map(read.answers.map((a) => [a.respondentKey, a.ids]));
  assert.deepEqual(byKey.get(key('Lia')), ['o_moral', 'o_evals']);
  assert.deepEqual(byKey.get(key('Marco')), ['o_new']);
  assert.deepEqual(byKey.get(null), ['o_evals']);
  assert.equal(await forms.rankingAnswers(form.id, 'name'), null);

  // The answers themselves are untouched.
  const { rows } = await db.query('select count(*)::int as n from form_responses');
  assert.equal(rows[0].n, 3);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('each project lists who ranked it by the adjusted score, and the suggestion pairs them', async () => {
  const { me, form } = await cast();
  await matching.saveSettings(me, { formId: form.id, question: 'progetti', penalty: 0 });

  // Not mapped yet: guesses, and no suggestion.
  let page = await matching.view(me);
  const evals = page.projects.find((p) => p.id === 'o_evals');
  assert.equal(evals.mapped, false);
  assert.deepEqual(evals.guess, [key('Ada')]);
  assert.deepEqual(page.projects.find((p) => p.id === 'o_moral').guess, [
    key('Carla'),
    key('Dario'),
  ]);
  assert.deepEqual(page.suggestion, []);

  const projects = {};
  page.projects.forEach((p) => {
    projects[p.id] = { mentors: p.guess, places: null };
  });
  await matching.saveSettings(me, { projects });
  page = await matching.view(me);

  // Penalty 0: the score alone. Lia 5 (2nd choice), Nina 3 (1st), Olga 2 (3rd).
  const list = (id) => page.projects.find((p) => p.id === id).candidates.map((c) => c.name);
  assert.deepEqual(list('o_evals'), ['Lia', 'Nina', 'Olga']);
  assert.deepEqual(list('o_secur'), ['Lia', 'Marco', 'Olga']);
  assert.equal(page.projects.find((p) => p.id === 'o_evals').places, 2);
  // Co-mentors share the project's places: not Neri 1 + Blu 1.
  assert.equal(page.projects.find((p) => p.id === 'o_moral').places, 1);

  // Verdi has one place: Lia gets it, Marco has nothing else; Nina and Olga
  // get their first choices.
  const got = Object.fromEntries(page.suggestion.map((s) => [s.name, s.project]));
  assert.deepEqual(got, { Lia: 'o_secur', Nina: 'o_evals', Olga: 'o_moral' });
  assert.equal(page.suggestion.find((s) => s.name === 'Lia').ready, true);

  // A strong penalty puts a first choice before a better score.
  await matching.saveSettings(me, { penalty: 2.5 });
  page = await matching.view(me);
  assert.deepEqual(list('o_evals'), ['Nina', 'Lia', 'Olga']);
  const nina = page.projects.find((p) => p.id === 'o_evals').candidates[0];
  assert.equal(nina.position, 1);
  assert.equal(nina.adjusted, 3);
  assert.equal(page.projects.find((p) => p.id === 'o_evals').candidates[1].adjusted, 2.5);

  // Places set by hand win over the board's.
  await matching.saveSettings(me, {
    projects: { ...projects, o_secur: { mentors: [key('Bruno')], places: 2 } },
  });
  page = await matching.view(me);
  const both = page.suggestion
    .filter((s) => s.project === 'o_secur')
    .map((s) => s.name)
    .sort();
  assert.deepEqual(both, ['Lia', 'Marco']);
});

test('confirming a pair is the board’s match: it leaves the pool and takes a place', async () => {
  const { me, form } = await cast();
  await matching.saveSettings(me, {
    formId: form.id,
    question: 'progetti',
    penalty: 0,
    projects: { o_secur: { mentors: [key('Bruno')], places: null } },
  });
  await matching.confirm(me, { project: 'o_secur', menteeKey: key('Marco'), track: 'projects' });
  const page = await matching.view(me);
  const secur = page.projects.find((p) => p.id === 'o_secur');
  assert.equal(secur.taken, 1);
  assert.equal(secur.candidates.find((c) => c.name === 'Marco').here, true);
  assert.equal(secur.candidates.find((c) => c.name === 'Marco').matchedTo, 'Bruno Verdi');
  // No place left on Verdi's project: nobody is suggested there.
  assert.deepEqual(page.suggestion, []);
  const board = await mentorship.board(me);
  assert.equal(board.matches.length, 1);
});

test('a co-mentored project is one pair with all its mentors, ended all together', async () => {
  const { me, form } = await cast();
  await matching.saveSettings(me, {
    formId: form.id,
    question: 'progetti',
    projects: { o_moral: { mentors: [key('Carla'), key('Dario')], places: null } },
  });
  await matching.confirm(me, { project: 'o_moral', menteeKey: key('Nina'), track: 'projects' });

  let board = await mentorship.board(me);
  assert.equal(board.matches.length, 1);
  assert.equal(board.matches[0].mentor.name, 'Carla Neri');
  assert.deepEqual(
    board.matches[0].coMentors.map((c) => c.name),
    ['Dario Blu']
  );
  const status = (name) =>
    board.mentors.concat(board.mentees).find((c) => c.name.startsWith(name)).status;
  assert.equal(status('Carla'), 'matched');
  assert.equal(status('Dario'), 'matched');
  assert.equal(board.mentors.find((c) => c.name === 'Dario Blu').matches, 1);
  // Each one's page names the pair: the mentee sees both mentors.
  const nina = await mentorship.person(me, ['mentorship'], key('Nina'), 'mentee');
  assert.equal(nina.matches[0].otherName, 'Carla Neri & Dario Blu');
  const dario = await mentorship.person(me, ['mentorship'], key('Dario'), 'mentor');
  assert.equal(dario.matches[0].otherName, 'Nina');
  assert.deepEqual(dario.matches[0].coMentors, ['Carla Neri']);
  // While paired, the co-mentor cannot be moved by hand either.
  await assert.rejects(
    mentorship.update(me, key('Dario'), 'mentor', { status: 'declined' }),
    (e) => e.status === 409
  );

  const page = await matching.view(me);
  const moral = page.projects.find((p) => p.id === 'o_moral');
  assert.equal(moral.taken, 1);
  assert.equal(moral.places, 1);
  assert.equal(moral.candidates.find((c) => c.name === 'Nina').matchedTo, 'Carla Neri & Dario Blu');

  await mentorship.endMatch(me, board.matches[0].id);
  board = await mentorship.board(me);
  assert.equal(status('Carla'), 'selected');
  assert.equal(status('Dario'), 'selected');
  assert.equal(status('Nina'), 'selected');

  // A project with no mentor in the setup cannot be paired with.
  await assert.rejects(
    matching.confirm(me, { project: 'o_evals', menteeKey: key('Lia'), track: 'projects' }),
    (e) => e.status === 400
  );
});

test('the pool: selected mentees only, or everyone not rejected', async () => {
  const { me, form } = await cast();
  await mentorship.update(me, key('Nina'), 'mentee', { status: 'interview' });
  await mentorship.update(me, key('Olga'), 'mentee', { status: 'declined' });
  await matching.saveSettings(me, {
    formId: form.id,
    question: 'progetti',
    penalty: 0,
    projects: { o_evals: { mentors: [key('Ada')], places: null } },
  });
  const names = async (pool) =>
    (await matching.view(me, { pool })).suggestion.map((s) => s.name).sort();
  assert.deepEqual(await names('selected'), ['Lia']);
  assert.deepEqual(await names('all'), ['Lia', 'Nina']);
  // Rejected: not even in the list.
  const page = await matching.view(me);
  assert.ok(!page.projects[0].candidates.some((c) => c.name === 'Olga'));
});

test('career orientation lists its mentees by score and the mentors who take them', async () => {
  const me = await admin();
  await mentor(me, 'Ada', 'Rossi', 2, 'Progetti, Orientamento');
  await mentor(me, 'Bruno', 'Verdi', 1, 'Progetti');
  await mentee('Pia', 'Orientamento professionale');
  await mentee('Rita', 'Orientamento professionale');
  await score(me, 'Pia', 2);
  await score(me, 'Rita', 4);
  const page = await matching.view(me);
  assert.deepEqual(
    page.orientation.mentees.map((m) => m.name),
    ['Rita', 'Pia']
  );
  assert.deepEqual(
    page.orientation.mentors.map((m) => m.name),
    ['Ada Rossi']
  );
  // Nothing set up: no projects, and the page still opens.
  assert.deepEqual(page.projects, []);
});

test('career orientation: a shared draft by fit, checked, filled, then paired', async () => {
  const me = await admin();
  await mentor(me, 'Ada', 'Rossi', 1, 'Orientamento');
  await mentor(me, 'Elena', 'Gialli', 1, 'Orientamento');
  for (const [name, value] of [
    ['Pia', 2],
    ['Rita', 4],
    ['Ugo', 3],
  ]) {
    await mentee(name, 'Orientamento professionale');
    await score(me, name, value);
    await mentorship.update(me, key(name), 'mentee', { status: 'selected' });
  }
  const ADA_K = key('Ada');
  const ELENA_K = key('Elena');
  const A = matching.AFFINITY;

  let o = (await matching.view(me)).orientation;
  assert.equal(o.check.selected, 3);
  assert.deepEqual(o.check.unassigned, ['Rita', 'Ugo', 'Pia']);
  assert.equal(o.check.placesLeft, 2);
  // Nothing judged yet: nothing to suggest.
  assert.deepEqual(o.suggestion, []);

  // The admins judge the fit. Rita fits Ada only a little, Elena well; Ugo
  // fits Elena strongly too; Pia fits Ada.
  await matching.saveDraft(me, {
    menteeKey: key('Rita'),
    affinity: { [ADA_K]: A.ok, [ELENA_K]: A.strong },
  });
  await matching.saveDraft(me, {
    menteeKey: key('Ugo'),
    affinity: { [ELENA_K]: A.strong, [ADA_K]: A.no },
  });
  await matching.saveDraft(me, { menteeKey: key('Pia'), affinity: { [ADA_K]: A.strong } });
  o = (await matching.view(me)).orientation;
  // Elena has one place: Rita has the higher score for the same fit; Ugo will
  // not go to Ada ("no"); Pia gets Ada.
  const got = Object.fromEntries(o.suggestion.map((x) => [x.menteeKey, x.mentorName]));
  assert.deepEqual(got, { [key('Rita')]: 'Elena Gialli', [key('Pia')]: 'Ada Rossi' });

  // A proposal by hand, with a note, keeps the fit marks; the note is encrypted.
  await matching.saveDraft(me, {
    menteeKey: key('Ugo'),
    mentorKey: ADA_K,
    note: 'Vuole lavorare in policy',
  });
  const { rows } = await db.query(`select value from app_settings where key = 'matching_drafts'`);
  assert.ok(!JSON.stringify(rows[0].value).includes('policy'));
  o = (await matching.view(me)).orientation;
  const ugo = o.mentees.find((p) => p.name === 'Ugo');
  assert.equal(ugo.draft.note, 'Vuole lavorare in policy');
  assert.equal(ugo.draft.affinity[ELENA_K], A.strong);
  assert.deepEqual(o.check.misfit, ['Ugo']);
  assert.deepEqual(o.check.unassigned, ['Rita', 'Pia']);
  // Ugo takes Ada's one place: Pia has nowhere to go now.
  assert.deepEqual(
    o.suggestion.map((x) => x.mentorName),
    ['Elena Gialli']
  );
  assert.equal(o.mentors.find((m) => m.name === 'Ada Rossi').proposed, 1);

  // The gaps filled from the fit, then everything paired.
  await matching.saveDraft(me, { menteeKey: key('Ugo'), mentorKey: ELENA_K });
  await matching.saveDraft(me, { menteeKey: key('Rita'), mentorKey: null });
  // Elena is taken by Ugo; Ada's one place goes to Pia (strong fit) over Rita (fits).
  assert.deepEqual(await matching.fillDrafts(me), { filled: 1 });
  o = (await matching.view(me)).orientation;
  const proposal = (name) => o.mentees.find((p) => p.name === name).draft.mentorKey;
  assert.equal(proposal('Pia'), ADA_K);
  assert.equal(proposal('Ugo'), ELENA_K);
  // Rita is left: both places are proposed, and the check says so.
  assert.equal(o.mentees.find((p) => p.name === 'Rita').draft.mentorKey, null);
  assert.deepEqual(o.check.unassigned, ['Rita']);
  assert.equal(o.check.placesLeft, 0);

  await matching.confirm(me, { mentorKey: ADA_K, menteeKey: key('Pia'), track: 'orientation' });
  o = (await matching.view(me)).orientation;
  const pia = o.mentees.find((p) => p.name === 'Pia');
  assert.equal(pia.matchedTo, 'Ada Rossi');
  assert.equal(pia.draft, null);
  assert.equal((await matching.getDrafts())[key('Pia')], undefined);

  // What is refused.
  await assert.rejects(
    matching.saveDraft(me, { menteeKey: key('Rita'), affinity: { [ADA_K]: 5 } }),
    (e) => e.status === 400
  );
  await assert.rejects(
    matching.saveDraft(me, { menteeKey: key('Rita'), mentorKey: key('Rita') }),
    (e) => e.status === 400
  );
  await assert.rejects(
    matching.saveDraft(me, { menteeKey: key('Rita'), note: 'x'.repeat(501) }),
    (e) => e.status === 400
  );
});

test('the setup refuses what is not the form’s, and only the panel admins get in', async () => {
  const { me, form } = await cast();
  await assert.rejects(
    matching.saveSettings(me, { formId: form.id, question: 'name' }),
    (e) => e.status === 400
  );
  await matching.saveSettings(me, { formId: form.id, question: 'progetti' });
  await assert.rejects(
    matching.saveSettings(me, { projects: { o_nope: { mentors: [], places: 1 } } }),
    (e) => e.status === 400
  );
  await assert.rejects(
    matching.saveSettings(me, { projects: { o_evals: { mentors: [key('Lia')] } } }),
    (e) => e.status === 400
  );
  await assert.rejects(matching.saveSettings(me, { penalty: -1 }), (e) => e.status === 400);

  const boss = await auth.upsertDiscordUser({ discordId: 'test-bea', name: 'Bea', roles: [] });
  const ann = await auth.upsertDiscordUser({ discordId: 'test-ann', name: 'Ann', roles: [] });
  await permissions.savePermissions(
    { roles: [], people: [{ userId: boss.id, permissions: ['review_admin'] }] },
    me
  );
  await review.setReviewer(boss, { add: ann.id });
  assert.equal(
    (await call({ url: '/api/app/crm/review?action=matching', user: ann })).statusCode,
    403
  );
  await matching.saveSettings(me, { projects: { o_evals: { mentors: [key('Ada')] } } });
  const ok = await call({ url: '/api/app/crm/review?action=matching&pool=all', user: boss });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.projects.length, 3);
  const made = await call({
    method: 'POST',
    url: '/api/app/crm/review?action=match',
    user: boss,
    body: { project: 'o_evals', menteeKey: key('Nina'), track: 'projects' },
  });
  assert.equal(made.statusCode, 201);
  // On the board's record, once for each of the two.
  const { rows } = await db.query(
    `select count(*)::int as n from crm_audit where action = 'set-match'`
  );
  assert.equal(rows[0].n, 2);
});
