// Tests for the interviews of the mentee selection (server/crm/interviews.js
// and its API), on invented data only. Run with `npm run test:meet`.
//
// Two projects: "Valutare i chatbot" (Ada Rossi) and "Rischi nella
// sicurezza" (Bruno Verdi). Lia and Nina are on the first one's shortlist,
// Marco on the second's. Bea is an admin of the selection; Ivo and Ugo
// interview; Rea only reviews.
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
const interviews = require('./crm/interviews');
const retention = require('./retention');
const api = require('./routes/app/crm/interviews');
const authApi = require('../api/auth');

let clock = Date.now();
beforeEach(async () => {
  await testDb.fresh();
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.CRM_KEY_SECRET = 'an-interviews-secret-of-at-least-thirty-two-chars';
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

const member = (name) => auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles: [] });
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
      ],
      rankCount: 1,
      rankMode: 'atLeast',
    },
  ],
};

/** The cast: mentors, mentees who ranked the projects, the shortlists, the team. */
async function cast() {
  const root = await admin();
  for (const [name, surname] of [
    ['Ada', 'Rossi'],
    ['Bruno', 'Verdi'],
  ]) {
    await records.add(
      'mentors_applications',
      {
        name: `${name} ${surname}`,
        email: `${name.toLowerCase()}@example.org`,
        tracks: 'Progetti',
        mentees: '2',
      },
      { origin: 'form' }
    );
    await mentorship.update(root, key(name), 'mentor', { status: 'selected' });
  }
  const { id, slug } = await forms.create(root, { title: 'Candidatura', schema: SCHEMA });
  await forms.updateSettings(root, id, { status: 'open' });
  for (const [name, ranked] of [
    ['Lia', ['o_evals']],
    ['Nina', ['o_evals', 'o_secur']],
    ['Marco', ['o_secur']],
  ]) {
    await records.add(
      'mentees_applications',
      {
        name,
        email: `${name.toLowerCase()}@example.org`,
        tracks: 'Progetti di AI safety',
        motivation: `${name} vuole lavorare sulla sicurezza.`,
      },
      { origin: 'form' }
    );
    const view = await forms.publicView(slug);
    clock += 5000;
    await forms.submit(
      slug,
      {
        version: view.version,
        token: view.token,
        answers: { name, email: `${name.toLowerCase()}@example.org`, progetti: ranked },
      },
      '203.0.113.9'
    );
  }
  await matching.saveSettings(root, { formId: id, question: 'progetti', penalty: 0 });
  await matching.saveSettings(root, {
    projects: {
      o_evals: { mentors: [key('Ada')], places: 2 },
      o_secur: { mentors: [key('Bruno')], places: 2 },
    },
  });
  await matching.saveShortlist(root, { project: 'o_evals', add: [key('Lia'), key('Nina')] });
  await matching.saveShortlist(root, { project: 'o_secur', add: [key('Marco')] });

  const bea = await member('Bea');
  const ivo = await member('Ivo');
  const ugo = await member('Ugo');
  const rea = await member('Rea');
  await permissions.savePermissions(
    { roles: [], people: [{ userId: bea.id, permissions: ['review_admin'] }] },
    root
  );
  await review.setReviewer(bea, { add: rea.id });
  await interviews.setInterviewer(bea, { add: ivo.id });
  await interviews.setInterviewer(bea, { add: ugo.id });
  return { root, bea, ivo, ugo, rea };
}

async function call({
  method = 'GET',
  url = '/api/app/crm/interviews',
  user,
  body,
  handler = api,
}) {
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
  await handler({ method, url, headers, body, socket: {} }, res);
  return res;
}

const allScores = (value) => {
  const out = {};
  interviews.DEFAULT_CRITERIA.forEach((c) => {
    out[c.key] = value;
  });
  return out;
};

// ── Who may do what ──────────────────────────────────────────────────────────

test('only the admins and the interviewers get in; only the admins set it up', async () => {
  const { bea, ivo, rea } = await cast();
  const stranger = await member('Zed');
  assert.equal((await call({ user: stranger })).statusCode, 403);
  // A reviewer is not an interviewer.
  assert.equal((await call({ user: rea })).statusCode, 403);
  assert.equal((await call({ user: ivo })).statusCode, 200);
  assert.equal((await call({ user: bea })).statusCode, 200);
  assert.equal(
    (await call({ url: '/api/app/crm/interviews?action=admin', user: ivo })).statusCode,
    403
  );
  const assign = await call({
    method: 'POST',
    url: '/api/app/crm/interviews?action=assign',
    user: ivo,
    body: { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null },
  });
  assert.equal(assign.statusCode, 403);
  // The tool shows up for an interviewer, as it does for a reviewer.
  const me = await call({ url: '/api/auth', user: ivo, handler: authApi });
  assert.equal(me.body.areas.review, true);
  // Their tab shows to the interviewers and the admins, not to a reviewer.
  assert.equal(me.body.areas.interviews, true);
  assert.equal(
    (await call({ url: '/api/auth', user: bea, handler: authApi })).body.areas.interviews,
    true
  );
  const reviewer = (await call({ url: '/api/auth', user: rea, handler: authApi })).body.areas;
  assert.equal(reviewer.review, true);
  assert.equal(reviewer.interviews, undefined);
  assert.equal(
    (await call({ url: '/api/auth', user: stranger, handler: authApi })).body.areas.review,
    false
  );
});

// ── Assignments ──────────────────────────────────────────────────────────────

test('a shortlist given whole or in part: each interviewer sees only theirs', async () => {
  const { bea, ivo, ugo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.assign(bea, {
    project: 'o_evals',
    interviewerId: ugo.id,
    menteeKeys: [key('Nina')],
  });
  const names = async (user) =>
    (await call({ user })).body.assignments.map((a) => [a.project.id, a.people.map((p) => p.name)]);
  assert.deepEqual(await names(ivo), [['o_evals', ['Lia', 'Nina']]]);
  assert.deepEqual(await names(ugo), [['o_evals', ['Nina']]]);

  // Someone not on the shortlist, a project with no mentors, someone not an interviewer.
  await assert.rejects(
    interviews.assign(bea, {
      project: 'o_evals',
      interviewerId: ugo.id,
      menteeKeys: [key('Marco')],
    }),
    (e) => e.status === 400
  );
  await assert.rejects(
    interviews.assign(bea, { project: 'o_nope', interviewerId: ugo.id, menteeKeys: null }),
    (e) => e.status === 400
  );
  await assert.rejects(
    interviews.assign(bea, { project: 'o_evals', interviewerId: bea.id, menteeKeys: null }),
    (e) => e.status === 400
  );

  // The admins' page: the projects with their mentors, shortlist and interviewers.
  const page = (await call({ url: '/api/app/crm/interviews?action=admin', user: bea })).body;
  const evals = page.projects.find((p) => p.id === 'o_evals');
  assert.deepEqual(
    evals.mentors.map((m) => m.name),
    ['Ada Rossi']
  );
  assert.deepEqual(
    evals.shortlist
      .find((m) => m.name === 'Nina')
      .interviewers.map((i) => i.name)
      .sort(),
    ['Ivo', 'Ugo']
  );
  // Taken back, and an interviewer removed takes their assignments with them.
  await interviews.unassign(bea, {
    id: evals.assignments.find((a) => a.interviewerId === ugo.id).id,
  });
  assert.deepEqual(await names(ugo), []);
  await interviews.setInterviewer(bea, { remove: ivo.id });
  const { rows } = await db.query('select count(*)::int as n from interview_assignments');
  assert.equal(rows[0].n, 0);
});

test('who leaves the shortlist leaves the interviewer’s list; what was written stays', async () => {
  const { root, bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.save(ivo, { project: 'o_evals', key: key('Lia'), notes: 'Ottima.' });
  await matching.saveShortlist(root, { project: 'o_evals', remove: [key('Lia')] });
  const mine = (await call({ user: ivo })).body.assignments[0].people.map((p) => p.name);
  assert.deepEqual(mine, ['Nina']);
  await assert.rejects(
    interviews.save(ivo, { project: 'o_evals', key: key('Lia'), notes: 'x' }),
    (e) => e.status === 403
  );
  const read = await interviews.session(
    bea,
    { admin: true },
    {
      project: 'o_evals',
      key: key('Lia'),
      interviewerId: ivo.id,
    }
  );
  assert.equal(read.interview.notes, 'Ottima.');
  assert.equal(read.readOnly, true);
});

// ── One interview ────────────────────────────────────────────────────────────

test('an interview: the questions every one asks stay, own questions, notes, the grid', async () => {
  const { bea, ivo, ugo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  const url = `/api/app/crm/interviews?action=session&project=o_evals&key=${key('Lia')}`;
  const first = (await call({ url, user: ivo })).body;
  assert.equal(first.person.name, 'Lia');
  // The application, as written (not made anonymous).
  const texts = first.application.flatMap((s) => s.items.map((i) => i.text));
  assert.ok(texts.includes('Lia vuole lavorare sulla sicurezza.'));
  // The whole application, the contacts too.
  assert.ok(texts.includes('lia@example.org'));
  // The questions asked in every interview come first, the others by choice.
  assert.deepEqual(
    first.items.map((i) => [i.id, i.required]),
    [
      ['q_intro', true],
      ['q_project', true],
    ]
  );

  // A plan leaving out the required ones gets them back; an own question.
  const saved = await call({
    method: 'PUT',
    url: '/api/app/crm/interviews?action=session',
    user: ivo,
    body: {
      project: 'o_evals',
      key: key('Lia'),
      own: [{ id: 'own_paper', text: 'Quale paper ti ha colpito?' }],
      plan: ['q_questions', 'own_paper'],
      notesByItem: { own_paper: 'Ha citato il paper sui sleeper agents.' },
      notes: 'Molto preparata.',
      transcript: 'WEBVTT\n\n00:00.000 --> 00:02.000\nBuongiorno!',
      scores: { motivation: 5 },
    },
  });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.deepEqual(
    (await call({ url, user: ivo })).body.items.map((i) => i.id),
    ['q_intro', 'q_project', 'q_questions', 'own_paper']
  );
  assert.equal(saved.body.state, 'started');
  assert.equal(saved.body.mean, null);

  // Done needs the whole grid.
  await assert.rejects(
    interviews.save(ivo, { project: 'o_evals', key: key('Lia'), done: true }),
    (e) => e.status === 400
  );
  const done = await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Lia'),
    scores: allScores(4),
    done: true,
    heldOn: '2026-11-20',
  });
  assert.equal(done.state, 'done');
  assert.equal(done.mean, 4);

  const again = (await call({ url, user: ivo })).body;
  assert.equal(again.interview.notes, 'Molto preparata.');
  assert.match(again.interview.transcript, /Buongiorno/);
  assert.equal(again.interview.heldOn, '2026-11-20');
  assert.equal(again.items[3].note, 'Ha citato il paper sui sleeper agents.');

  // Nothing written is in the clear in the database.
  const { rows } = await db.query('select * from interview_sessions');
  const raw = JSON.stringify(rows);
  ['Molto preparata', 'Buongiorno', 'sleeper', 'Quale paper'].forEach((t) =>
    assert.ok(!raw.includes(t), t)
  );

  // Another interviewer cannot open it; an admin reads it, not as theirs.
  assert.equal((await call({ url, user: ugo })).statusCode, 403);
  assert.equal((await call({ url, user: bea })).statusCode, 403);
  const asAdmin = await call({ url: `${url}&interviewer=${ivo.id}`, user: bea });
  assert.equal(asAdmin.body.readOnly, true);
  assert.equal(asAdmin.body.interview.mean, 4);
});

test('a question required in some projects only, and the setup saved by two at once', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.assign(bea, { project: 'o_secur', interviewerId: ivo.id, menteeKeys: null });
  const page = await interviews.adminPage(bea);
  const questions = [
    ...page.settings.questions.map((q) => ({ ...q, required: 'none' })),
    { text: 'Hai esperienza di red teaming?', required: 'projects', projects: ['o_secur'] },
  ];
  await interviews.saveSettings(bea, { questions, version: page.settings.version });
  await assert.rejects(
    interviews.saveSettings(bea, { weight: 2, version: page.settings.version }),
    (e) => e.status === 409
  );
  const ask = async (project, name) =>
    (await interviews.session(ivo, { interviewer: true }, { project, key: key(name) })).items.map(
      (i) => i.text
    );
  assert.deepEqual(await ask('o_secur', 'Marco'), ['Hai esperienza di red teaming?']);
  assert.deepEqual(await ask('o_evals', 'Lia'), []);
  // Bad input refused.
  const fresh = await interviews.getSettings();
  await assert.rejects(
    interviews.saveSettings(bea, { criteria: [], version: fresh.version }),
    (e) => e.status === 400
  );
  await assert.rejects(
    interviews.saveSettings(bea, { weight: 99, version: fresh.version }),
    (e) => e.status === 400
  );
});

// ── The scores for the summary ───────────────────────────────────────────────

test('the interviews’ means by mentee: done ones only, stepped aside left out', async () => {
  const { bea, ivo, ugo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ugo.id, menteeKeys: null });
  await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Lia'),
    scores: allScores(5),
    done: true,
  });
  await interviews.save(ugo, {
    project: 'o_evals',
    key: key('Lia'),
    scores: allScores(3),
    done: true,
  });
  await interviews.save(ugo, { project: 'o_evals', key: key('Nina'), conflict: true, done: true });
  await interviews.save(ivo, { project: 'o_evals', key: key('Nina'), scores: allScores(2) });
  const res = await call({ url: '/api/app/crm/interviews?action=scores', user: bea });
  assert.equal(res.body.weight, 1);
  assert.equal(res.body.people[key('Lia')].mean, 4);
  assert.equal(res.body.people[key('Lia')].count, 2);
  assert.equal(res.body.people[key('Nina')], undefined);
  assert.equal(
    (await call({ url: '/api/app/crm/interviews?action=scores', user: ivo })).statusCode,
    403
  );
});

// ── Nothing else changes ─────────────────────────────────────────────────────

test('the selection, the matching and the board read the same before and after', async () => {
  const { root, bea, ivo } = await cast();
  const settingsRows = async () =>
    (
      await db.query(
        `select key, value from app_settings
         where key in ('review_settings', 'matching_settings', 'matching_shortlists')
         order by key`
      )
    ).rows;
  const snapshot = async () => ({
    summary: (await review.summary(root, { record: false })).people,
    matching: (await matching.view(root, { pool: 'all' })).projects,
    board: (await mentorship.roster()).mentees.map((c) => [c.key, c.status]),
    scores: (await db.query('select * from review_scores order by person_key')).rows,
    settings: await settingsRows(),
  });
  const before = await snapshot();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.saveSettings(bea, { weight: 3 });
  await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Lia'),
    scores: allScores(5),
    notes: 'n',
    done: true,
  });
  await interviews.scores(bea);
  await interviews.adminPage(bea);
  assert.deepEqual(await snapshot(), before);
});

test('the interviews go with the application, and keep their interviewer’s account', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.save(ivo, { project: 'o_evals', key: key('Lia'), notes: 'x' });
  await interviews.save(ivo, { project: 'o_evals', key: key('Nina'), notes: 'y' });
  // An old account with an interview is not deleted.
  await db.query(`update app_users set last_login_at = now() - interval '5 years' where id = $1`, [
    ivo.id,
  ]);
  await db.query(
    `delete from crm_records where source = 'mentees_applications' and person_key = $1`,
    [key('Lia')]
  );
  await db.query(`update form_responses set deleted_at = now() where respondent_key = $1`, [
    key('Lia'),
  ]);
  const counts = await retention.cleanup();
  assert.equal(counts.interviews, 1);
  const { rows } = await db.query('select person_key from interview_sessions');
  assert.deepEqual(
    rows.map((r) => r.person_key),
    [key('Nina')]
  );
  const users = await db.query('select 1 from app_users where id = $1', [ivo.id]);
  assert.equal(users.rows.length, 1);
});

// ── The interviewer's plan, the timer, the questions asked ─────────────────

test('a plan for the project: every interview starts from it until changed there', async () => {
  const { bea, ivo, ugo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  // Only for a project given to them.
  await assert.rejects(
    interviews.savePlan(ugo, { project: 'o_evals', plan: [], own: [] }),
    (e) => e.status === 403
  );
  const page = await interviews.planPage(ivo, 'o_evals');
  assert.equal(page.saved, false);
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['q_intro', 'q_project']
  );
  // Required ones left out come back first; own questions and order kept.
  const own = [{ id: 'own_red', text: 'Hai fatto red teaming?' }];
  const saved = await interviews.savePlan(ivo, {
    project: 'o_evals',
    plan: ['own_red', 'q_time'],
    own,
  });
  assert.deepEqual(
    saved.items.map((i) => i.id),
    ['q_intro', 'q_project', 'own_red', 'q_time']
  );
  const order = async (name) =>
    (await interviews.session(ivo, { interviewer: true }, { project: 'o_evals', key: key(name) }))
      .items;
  assert.deepEqual(
    (await order('Lia')).map((i) => i.text),
    [
      interviews.DEFAULT_QUESTIONS[0].text,
      interviews.DEFAULT_QUESTIONS[1].text,
      'Hai fatto red teaming?',
      interviews.DEFAULT_QUESTIONS[2].text,
    ]
  );
  // Scores, notes and ticks do not change the list; reordering it does.
  await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Lia'),
    scores: { motivation: 3 },
    notesByItem: { q_intro: 'Fisica.' },
    asked: { q_intro: true },
  });
  await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Nina'),
    plan: ['own_red', 'q_time'],
    notesByItem: { own_red: 'Sì, due volte.' },
  });
  await interviews.savePlan(ivo, { project: 'o_evals', plan: ['q_questions'], own: [] });
  const lia = await order('Lia');
  assert.deepEqual(
    lia.map((i) => i.id),
    ['q_intro', 'q_project', 'q_questions']
  );
  assert.equal(lia[0].note, 'Fisica.');
  const nina = await order('Nina');
  assert.deepEqual(
    nina.map((i) => i.id),
    ['q_intro', 'q_project', 'own_red', 'q_time']
  );
  assert.equal(nina[2].note, 'Sì, due volte.');
  assert.equal((await interviews.planPage(ivo, 'o_evals')).changed, 1);
});

test('the timer counts while it runs, stops when done; questions marked as asked', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  const target = { project: 'o_evals', key: key('Lia') };
  let r = await interviews.save(ivo, { ...target, timer: 'start' });
  assert.equal(r.timer.running, true);
  // Started 90 seconds ago.
  await db.query(`update interview_sessions set running_since = now() - interval '90 seconds'`);
  r = await interviews.save(ivo, { ...target, timer: 'pause' });
  assert.equal(r.timer.running, false);
  assert.ok(r.timer.seconds >= 90 && r.timer.seconds < 95, String(r.timer.seconds));
  r = await interviews.save(ivo, { ...target, timer: 'start' });
  r = await interviews.save(ivo, { ...target, scores: allScores(4), done: true });
  assert.equal(r.timer.running, false);
  r = await interviews.save(ivo, { ...target, asked: { q_intro: 95, q_project: true } });
  assert.deepEqual(r.asked, { q_intro: 95, q_project: true });
  r = await interviews.save(ivo, { ...target, asked: { q_project: false } });
  assert.deepEqual(r.asked, { q_intro: 95 });
  await assert.rejects(interviews.save(ivo, { ...target, timer: 'fly' }), (e) => e.status === 400);
  await assert.rejects(
    interviews.save(ivo, { ...target, asked: { q_intro: -1 } }),
    (e) => e.status === 400
  );
  const s = await interviews.session(ivo, { interviewer: true }, target);
  assert.ok(s.timer.seconds >= 90);
  assert.deepEqual(s.asked, { q_intro: 95 });
  assert.equal(s.duration, 30);
  await interviews.saveSettings(bea, { duration: 45 });
  assert.equal((await interviews.getSettings()).duration, 45);
  await assert.rejects(interviews.saveSettings(bea, { duration: 1 }), (e) => e.status === 400);
});

test('the planned length: the admins’, an interviewer’s for a project, for one interview', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  const target = { project: 'o_evals', key: key('Lia') };
  const length = async () => {
    const s = await interviews.session(ivo, { interviewer: true }, target);
    return [s.duration, s.durationFrom, s.durationDefault];
  };
  await interviews.saveSettings(bea, { duration: 40 });
  assert.deepEqual(await length(), [40, 'setup', 40]);
  await interviews.savePlan(ivo, { project: 'o_evals', plan: [], own: [], duration: 25 });
  assert.deepEqual(await length(), [25, 'plan', 25]);
  // Saving the list without a length keeps it.
  await interviews.savePlan(ivo, { project: 'o_evals', plan: ['q_time'], own: [] });
  assert.equal((await interviews.planPage(ivo, 'o_evals')).duration, 25);
  await interviews.save(ivo, { ...target, duration: 60 });
  assert.deepEqual(await length(), [60, 'interview', 25]);
  await interviews.save(ivo, { ...target, duration: null });
  assert.deepEqual(await length(), [25, 'plan', 25]);
  await assert.rejects(interviews.save(ivo, { ...target, duration: 2 }), (e) => e.status === 400);
  await assert.rejects(
    interviews.savePlan(ivo, { project: 'o_evals', plan: [], own: [], duration: 999 }),
    (e) => e.status === 400
  );
});

test('a long transcript fits; all-zero weights and days that do not exist are refused', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  const transcript = 'Parola. '.repeat(20000); // 160,000 characters
  const put = (action, body) => {
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
    const raw = JSON.stringify(body);
    return api(
      {
        method: 'PUT',
        url: `/api/app/crm/interviews?action=${action}`,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
          cookie: `${auth.COOKIE}=${auth.makeSession(ivo.id)}`,
        },
        body,
        socket: {},
      },
      res
    ).then(() => res);
  };
  const ok = await put('session', { project: 'o_evals', key: key('Lia'), transcript });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  const s = await interviews.session(
    ivo,
    { interviewer: true },
    { project: 'o_evals', key: key('Lia') }
  );
  assert.equal(s.interview.transcript.length, transcript.length);
  // Other calls keep the usual limit.
  assert.equal(
    (await put('plan', { project: 'o_evals', plan: [], own: [], pad: transcript })).statusCode,
    413
  );

  await assert.rejects(
    interviews.save(ivo, { project: 'o_evals', key: key('Lia'), heldOn: '2026-02-31' }),
    (e) => e.status === 400
  );
  await interviews.save(ivo, { project: 'o_evals', key: key('Lia'), heldOn: '2028-02-29' });

  const zero = interviews.DEFAULT_CRITERIA.map((c) => ({ ...c, weight: 0 }));
  await assert.rejects(interviews.saveSettings(bea, { criteria: zero }), (e) => e.status === 400);
  zero[0].weight = 1;
  await interviews.saveSettings(bea, { criteria: zero });
});

// ── Which projects, emptying an interview, giving it to someone else ───────

test('only the projects chosen have interviews; left out, nothing is lost', async () => {
  const { bea, ivo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  await interviews.assign(bea, { project: 'o_secur', interviewerId: ivo.id, menteeKeys: null });
  await interviews.save(ivo, { project: 'o_secur', key: key('Marco'), notes: 'Bravo.' });
  await interviews.saveSettings(bea, { projects: ['o_evals'] });
  const mine = async () => (await interviews.overview(ivo, { interviewer: true })).assignments;
  assert.deepEqual(
    (await mine()).map((a) => a.project.id),
    ['o_evals']
  );
  await assert.rejects(
    interviews.save(ivo, { project: 'o_secur', key: key('Marco'), notes: 'x' }),
    (e) => e.status === 403
  );
  await assert.rejects(
    interviews.assign(bea, { project: 'o_secur', interviewerId: bea.id, menteeKeys: null }),
    (e) => e.status === 400
  );
  const page = await interviews.adminPage(bea);
  assert.deepEqual(
    page.projects.map((p) => p.id),
    ['o_evals']
  );
  assert.deepEqual(
    page.choices.map((c) => [c.id, c.interviewed, c.interviews]),
    [
      ['o_evals', true, 0],
      ['o_secur', false, 1],
    ]
  );
  // Back on: the assignment and the interview are where they were.
  await interviews.saveSettings(bea, { projects: null });
  assert.equal((await mine()).length, 2);
  const s = await interviews.session(
    ivo,
    { interviewer: true },
    { project: 'o_secur', key: key('Marco') }
  );
  assert.equal(s.interview.notes, 'Bravo.');
  // Unknown ids are dropped.
  await interviews.saveSettings(bea, { projects: ['o_evals', 'o_nope'] });
  assert.deepEqual((await interviews.getSettings()).projects, ['o_evals']);
});

test('emptying an interview: an interviewer their own, an admin anyone’s', async () => {
  const { bea, ivo, ugo } = await cast();
  await interviews.assign(bea, { project: 'o_evals', interviewerId: ivo.id, menteeKeys: null });
  const target = { project: 'o_evals', key: key('Lia') };
  await interviews.save(ivo, { ...target, notes: 'n', scores: allScores(4), timer: 'start' });
  const reset = (user, body) =>
    call({ method: 'POST', url: '/api/app/crm/interviews?action=reset', user, body });
  // Someone else's: not for an interviewer.
  assert.equal((await reset(ugo, { ...target, interviewerId: ivo.id })).statusCode, 403);
  assert.equal((await reset(ugo, target)).statusCode, 403);
  assert.equal((await reset(ivo, target)).statusCode, 200);
  const s = await interviews.session(ivo, { interviewer: true }, target);
  assert.equal(s.interview.notes, '');
  assert.deepEqual(s.interview.scores, {});
  assert.equal(s.timer.seconds, 0);
  assert.equal((await reset(ivo, target)).statusCode, 404);
  // An admin empties anyone's.
  await interviews.save(ivo, { ...target, notes: 'again' });
  assert.equal((await reset(bea, { ...target, interviewerId: ivo.id })).statusCode, 200);
  const { rows } = await db.query('select count(*)::int as n from interview_sessions');
  assert.equal(rows[0].n, 0);
});

test('a shortlist given to someone else, with or without the interviews started', async () => {
  const { bea, ivo, ugo } = await cast();
  const a = await interviews.assign(bea, {
    project: 'o_evals',
    interviewerId: ivo.id,
    menteeKeys: null,
  });
  await interviews.save(ivo, {
    project: 'o_evals',
    key: key('Lia'),
    notes: 'Note di Ivo.',
    notesByItem: { q_intro: 'Fisica.' },
    scores: allScores(5),
  });
  await interviews.save(ivo, { project: 'o_evals', key: key('Nina'), notes: 'Nina, di Ivo.' });
  // Ugo already interviewed Nina for it: that one stays where it is.
  await interviews.assign(bea, {
    project: 'o_evals',
    interviewerId: ugo.id,
    menteeKeys: [key('Nina')],
  });
  await interviews.save(ugo, { project: 'o_evals', key: key('Nina'), notes: 'Nina, di Ugo.' });

  const r = await interviews.reassign(bea, {
    id: a.id,
    interviewerId: ugo.id,
    moveInterviews: true,
  });
  assert.deepEqual([r.moved, r.kept], [1, 1]);
  // One assignment left, Ugo's, for the whole shortlist (Ivo's was whole).
  const { rows } = await db.query('select interviewer_id, mentee_keys from interview_assignments');
  assert.deepEqual(
    rows.map((x) => [x.interviewer_id, x.mentee_keys]),
    [[ugo.id, null]]
  );
  const lia = await interviews.session(
    ugo,
    { interviewer: true },
    {
      project: 'o_evals',
      key: key('Lia'),
    }
  );
  assert.equal(lia.interview.notes, 'Note di Ivo.');
  assert.equal(lia.items[0].note, 'Fisica.');
  assert.equal(lia.interview.mean, 5);
  const nina = await interviews.session(
    ugo,
    { interviewer: true },
    {
      project: 'o_evals',
      key: key('Nina'),
    }
  );
  assert.equal(nina.interview.notes, 'Nina, di Ugo.');
  // Ivo's own Nina stays his, for the admins to read; he no longer sees the project.
  const ivosNina = await interviews.session(
    bea,
    { admin: true },
    {
      project: 'o_evals',
      key: key('Nina'),
      interviewerId: ivo.id,
    }
  );
  assert.equal(ivosNina.interview.notes, 'Nina, di Ivo.');
  assert.equal((await interviews.overview(ivo, { interviewer: true })).assignments.length, 0);

  // Without the interviews: they stay with who wrote them.
  const back = (await interviews.adminPage(bea)).projects[0].assignments[0];
  const r2 = await interviews.reassign(bea, { id: back.id, interviewerId: ivo.id });
  assert.deepEqual([r2.moved, r2.kept], [0, 0]);
  const { rows: still } = await db.query(
    `select count(*)::int as n from interview_sessions where interviewer_id = $1`,
    [ugo.id]
  );
  assert.equal(still[0].n, 2);
  await assert.rejects(
    interviews.reassign(bea, { id: back.id, interviewerId: ivo.id }),
    (e) => e.status === 400
  );
});
