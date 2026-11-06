// Tests for the mentee selection (server/crm/review.js and its API): who may
// see what, the anonymous codes, the scores and the summary, and the status
// shared with the mentorship board. Run with `npm run test:meet`.
//
// The applicants: Lia and Marco applied through the form; Gino (from the
// invented sheets) only expressed interest, so he is not scored.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
const testDb = require('./test-db');
const auth = require('./auth');
const permissions = require('./permissions');
const sheets = require('./sheets');
const crm = require('./crm/crypto');
const mentorship = require('./crm/mentorship');
const review = require('./crm/review');
const records = require('./crm/records');
const retention = require('./retention');
const api = require('./routes/app/crm/review');
const authApi = require('../api/auth');

const LIA = {
  name: 'Lia Candidata',
  email: 'lia@example.org',
  role: 'Dottoranda',
  affiliation: 'Università di Prova',
  profile: 'https://example.org/lia',
  cv: 'https://drive.example.org/lia-cv.pdf',
  tracks: 'Progetti di AI safety',
  background:
    'Mi chiamo Lia Candidata, faccio la Dottoranda alla Università di Prova. Scrivimi a lia@example.org o su https://lia.example.org, tel. +39 333 123 4567.',
  motivation: 'Voglio lavorare su interpretability.',
  goals: 'Un primo progetto.',
  hours: '6',
};
const MARCO = {
  name: 'Marco Secondo',
  email: 'marco@example.org',
  cv: 'javascript:alert(1)',
  tracks: 'Orientamento professionale',
  motivation: 'Capire se la AI safety fa per me.',
};

beforeEach(async () => {
  await testDb.fresh();
  process.env.CRM_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.CRM_KEY_SECRET = 'a-crm-secret-of-at-least-thirty-two-characters';
  process.env.CRM_SHEETS_FAKE = '1';
  delete process.env.VERCEL;
  delete process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  delete process.env.DISCORD_GUILD_ID;
  sheets.setForTests();
  permissions.setFetch(() => {
    throw new Error('no network in tests');
  });
  const me = await admin();
  await records.importSource(me, 'mentees_interest');
  await records.add('mentees_applications', LIA, { origin: 'form' });
  await records.add('mentees_applications', MARCO, { origin: 'form' });
});

const LIA_KEY = () => crm.personKey('lia@example.org');
const MARCO_KEY = () => crm.personKey('marco@example.org');

async function admin() {
  await db.query('select 1');
  const { rows } = await db.query(
    `update app_users set last_login_at = now() where kind = 'admin' returning *`
  );
  return { id: rows[0].id, kind: 'admin', name: rows[0].name };
}

async function member(name, roles = []) {
  return auth.upsertDiscordUser({ discordId: `test-${name}`, name, roles });
}

/** A panel admin (review_admin by name) and two reviewers. */
async function panel() {
  const boss = await member('Bea');
  const ann = await member('Ann');
  const ben = await member('Ben');
  await permissions.savePermissions(
    { roles: [], people: [{ userId: boss.id, permissions: ['review_admin'] }] },
    await admin()
  );
  await review.setReviewer(boss, { add: ann.id });
  await review.setReviewer(boss, { add: ben.id });
  return { boss, ann, ben };
}

async function call({ method = 'GET', url = '/api/app/crm/review', user, body, handler = api }) {
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

function scoreAll(part, value) {
  const out = {};
  review.DEFAULT_GRID[part].forEach((c) => {
    out[c.key] = value;
  });
  return out;
}

/** Sets the weight of each section of the setup. */
async function reweigh(boss, weights) {
  const sections = (await review.getSettings()).sections;
  sections.forEach((s) => {
    s.weight = weights[s.key];
  });
  await review.saveSettings(boss, { sections });
}

async function codeOf(user, part, key) {
  const list = (await call({ url: `/api/app/crm/review?part=${part}`, user })).body;
  const want = review.codeOf(key, part);
  assert.ok(list.items.some((i) => i.code === want));
  return want;
}

// ── Who may do what ──────────────────────────────────────────────────────────

test('the admin key goes to people only, and only the shared admin gives it', async () => {
  const root = await admin();
  await assert.rejects(
    permissions.savePermissions(
      { roles: [{ roleId: 'r1', roleName: 'Direttivo', permissions: ['review_admin'] }] },
      root
    ),
    (err) => err.status === 400 && /people only/.test(err.message)
  );
  // Even written straight into the roles' table, a role does not grant it.
  await db.query(
    `insert into content_role_permissions (role_id, role_name, permissions) values ('r1', 'X', $1)`,
    [['review_admin', 'forms']]
  );
  const someone = await member('Ugo', ['r1']);
  assert.deepEqual(await permissions.forUser(someone), ['forms']);

  // Who holds manage_all hands out the CRM, not the selection's admin.
  const boss = await member('Ada');
  const bea = await member('Bea');
  await permissions.savePermissions(
    { roles: [], people: [{ userId: boss.id, permissions: ['manage_all'] }] },
    root
  );
  assert.ok(!permissions.grantable(boss, await permissions.forUser(boss)).includes('review_admin'));
  await assert.rejects(
    permissions.savePermissions(
      {
        roles: [],
        people: [
          { userId: boss.id, permissions: ['manage_all'] },
          { userId: bea.id, permissions: ['review_admin'] },
        ],
      },
      boss
    ),
    (err) => err.status === 403 && /Mentee selection/.test(err.message)
  );
  await permissions.savePermissions(
    {
      roles: [],
      people: [
        { userId: boss.id, permissions: ['manage_all'] },
        { userId: bea.id, permissions: ['review_admin'] },
      ],
    },
    root
  );
  assert.deepEqual(await permissions.forUser(bea), ['review_admin']);
});

test('only the panel admins and the reviewers get in, each to their own part', async () => {
  const { boss, ann } = await panel();
  const stranger = await member('Zoe', []);
  assert.equal((await call({ user: stranger })).statusCode, 403);
  const { rows } = await db.query(
    `select detail from crm_audit where action = 'denied' and user_name = 'Zoe'`
  );
  assert.deepEqual(rows[0].detail, { needs: 'review' });

  // A reviewer scores, and sees neither the summary nor the settings.
  const mine = (await call({ user: ann })).body;
  assert.equal(mine.reviewer, true);
  assert.equal(mine.admin, false);
  assert.deepEqual(
    mine.sections.map((p) => [p.key, p.total, p.done]),
    [
      ['cv', 2, 0],
      ['answers', 2, 0],
    ]
  );
  assert.equal(
    (await call({ url: '/api/app/crm/review?action=summary', user: ann })).statusCode,
    403
  );
  assert.equal(
    (await call({ url: '/api/app/crm/review?action=settings', user: ann })).statusCode,
    403
  );
  // An admin who is not a reviewer reads the summary, and does not score.
  assert.equal(
    (await call({ url: '/api/app/crm/review?action=summary', user: boss })).statusCode,
    200
  );
  assert.equal((await call({ url: '/api/app/crm/review?part=cv', user: boss })).statusCode, 403);

  // The tool shows in the sidebar to both.
  for (const user of [boss, ann]) {
    const info = (await call({ url: '/api/auth', user, handler: authApi })).body;
    assert.equal(info.areas.review, true);
  }
  const info = (await call({ url: '/api/auth', user: stranger, handler: authApi })).body;
  assert.equal(info.areas.review, false);
});

test('removed from the reviewers, the door closes; only Discord accounts can review', async () => {
  const { boss, ann } = await panel();
  await review.setReviewer(boss, { remove: ann.id });
  assert.equal((await call({ user: ann })).statusCode, 403);
  const root = await admin();
  await assert.rejects(review.setReviewer(boss, { add: root.id }), (err) => err.status === 400);
});

// ── What a reviewer receives ──────────────────────────────────────────────────

test('a reviewer never receives a name, an email or a person key', async () => {
  const { ann } = await panel();
  const seen = [];
  for (const part of ['cv', 'answers']) {
    const list = (await call({ url: `/api/app/crm/review?part=${part}`, user: ann })).body;
    seen.push(list);
    for (const item of list.items) {
      seen.push(
        (await call({ url: `/api/app/crm/review?part=${part}&code=${item.code}`, user: ann })).body
      );
    }
  }
  const text = JSON.stringify(seen);
  for (const secret of [
    'Lia',
    'Candidata',
    'Marco',
    'Secondo',
    'lia@example.org',
    'Università di Prova',
    'Dottoranda',
    '333 123',
    'lia.example.org',
    LIA_KEY(),
    MARCO_KEY(),
  ]) {
    assert.ok(!text.includes(secret), `leaks ${secret}`);
  }
  // Gino only expressed interest: nothing to score.
  assert.equal(seen[0].items.length, 2);
});

test('the codes differ between the CV and the answers, and are stable', async () => {
  const cv = review.codeOf(LIA_KEY(), 'cv');
  const answers = review.codeOf(LIA_KEY(), 'answers');
  assert.match(cv, /^CV-[A-Z2-9]{5}$/);
  assert.match(answers, /^A-[A-Z2-9]{5}$/);
  assert.notEqual(cv.slice(3), answers.slice(2));
  assert.equal(review.codeOf(LIA_KEY(), 'cv'), cv);
});

test('the answers come without who wrote them; the CV part only with safe links', async () => {
  const { ann } = await panel();
  const code = await codeOf(ann, 'answers', LIA_KEY());
  const app = (await call({ url: `/api/app/crm/review?part=answers&code=${code}`, user: ann }))
    .body;
  const background = app.items.find((a) => a.label === 'Background').text;
  assert.equal(
    background,
    'Mi chiamo [name] [name], faccio la [role] alla [affiliation]. Scrivimi a [email] o su [link], tel. [phone].'
  );
  assert.equal(app.items[0].label, 'Track');
  assert.ok(app.items.every((a) => a.url === null));

  const liaCv = await codeOf(ann, 'cv', LIA_KEY());
  const cv = (await call({ url: `/api/app/crm/review?part=cv&code=${liaCv}`, user: ann })).body;
  assert.deepEqual(cv.items, [
    { id: 'cv', label: 'CV', text: '', url: 'https://drive.example.org/lia-cv.pdf' },
    { id: 'profile', label: 'Profile', text: '', url: 'https://example.org/lia' },
  ]);
  // A link that is not http(s) is never handed to the page.
  const marcoCv = await codeOf(ann, 'cv', MARCO_KEY());
  const marco = (await call({ url: `/api/app/crm/review?part=cv&code=${marcoCv}`, user: ann }))
    .body;
  assert.deepEqual(marco.items, []);
});

// ── Scores ───────────────────────────────────────────────────────────────────

test('scores are checked, saved half done, and each reviewer sees only their own', async () => {
  const { ann, ben } = await panel();
  const code = await codeOf(ann, 'answers', LIA_KEY());
  const post = (user, body) =>
    call({ method: 'POST', url: '/api/app/crm/review?action=score', user, body });

  assert.equal(
    (await post(ann, { part: 'answers', code, scores: { motivation: 6 } })).statusCode,
    400
  );
  assert.equal((await post(ann, { part: 'answers', code, scores: { nope: 3 } })).statusCode, 400);
  assert.equal((await post(ann, { part: 'answers', code: 'A-XXXXX', scores: {} })).statusCode, 404);

  const half = await post(ann, { part: 'answers', code, scores: { motivation: 4 } });
  assert.deepEqual(half.body, { state: 'partial' });
  const full = await post(ann, {
    part: 'answers',
    code,
    scores: scoreAll('answers', 4),
    comment: 'Chiara e motivata',
  });
  assert.deepEqual(full.body, { state: 'done' });

  const mine = (await call({ url: `/api/app/crm/review?part=answers&code=${code}`, user: ann }))
    .body.mine;
  assert.deepEqual(mine.scores, scoreAll('answers', 4));
  assert.equal(mine.comment, 'Chiara e motivata');
  // Ben has not scored: he sees nothing of Ann's.
  const his = (await call({ url: `/api/app/crm/review?part=answers&code=${code}`, user: ben }))
    .body;
  assert.equal(his.mine, null);
  const list = (await call({ url: '/api/app/crm/review?part=answers', user: ben })).body;
  assert.ok(list.items.every((i) => i.state === 'todo'));
  // The comment is stored encrypted.
  const { rows } = await db.query('select comment_encrypted from review_scores');
  assert.ok(!rows[0].comment_encrypted.includes('motivata'));
});

test('the summary: means of the complete reviews, the spread, the parts weighted', async () => {
  const { boss, ann, ben } = await panel();
  const score = (user, part, key, scores, extra = {}) =>
    review.score(user, { part, code: review.codeOf(key, part), scores, ...extra });

  // Lia: answers 5 and 2 (far apart), CV 4 from Ann only.
  await score(ann, 'answers', LIA_KEY(), scoreAll('answers', 5));
  await score(ben, 'answers', LIA_KEY(), scoreAll('answers', 2));
  await score(ann, 'cv', LIA_KEY(), scoreAll('cv', 4));
  // Marco: Ann knows him and steps aside; Ben leaves his review half done.
  await score(ann, 'answers', MARCO_KEY(), {}, { conflict: true });
  await score(ben, 'answers', MARCO_KEY(), { motivation: 5 });

  await reweigh(boss, { cv: 1, answers: 3 });
  const sum = (await call({ url: '/api/app/crm/review?action=summary', user: boss })).body;
  const lia = sum.people.find((p) => p.name === 'Lia Candidata');
  assert.equal(lia.parts.answers.mean, 3.5);
  assert.equal(lia.parts.answers.spread, 3);
  assert.equal(lia.parts.answers.count, 2);
  assert.equal(lia.parts.cv.mean, 4);
  assert.equal(lia.parts.cv.spread, null);
  // (4 × 1 + 3.5 × 3) / 4 = 3.625, to two decimals.
  assert.equal(lia.overall, 3.63);
  assert.equal(lia.partial, false);
  assert.equal(lia.status, 'applied');
  assert.equal(lia.parts.answers.reviews.length, 2);

  const marco = sum.people.find((p) => p.name === 'Marco Secondo');
  assert.equal(marco.overall, null);
  assert.equal(marco.parts.answers.count, 0);
  assert.equal(marco.parts.answers.conflicts, 1);
  assert.equal(marco.parts.answers.reviews.find((r) => r.reviewer === 'Ben').complete, false);
  // Best first, those without a score last.
  assert.deepEqual(
    sum.people.map((p) => p.name),
    ['Lia Candidata', 'Marco Secondo']
  );
  // Only applicants: Gino expressed interest only.
  assert.equal(sum.people.length, 2);
});

test('the criteria weigh as set, and a renamed criterion keeps its scores', async () => {
  const { boss, ann } = await panel();
  const sections = (await review.getSettings()).sections;
  sections[1].criteria = [
    { key: 'motivation', label: 'Motivazione', help: '', weight: 3 },
    { label: 'Chiarezza', help: 'Scrive in modo chiaro', weight: 1 },
  ];
  await review.saveSettings(boss, { sections });
  const settings = await review.getSettings();
  assert.deepEqual(
    settings.sections[1].criteria.map((c) => c.key),
    ['motivation', 'chiarezza']
  );
  await review.score(ann, {
    part: 'answers',
    code: review.codeOf(LIA_KEY(), 'answers'),
    scores: { motivation: 5, chiarezza: 1 },
  });
  const lia = (await review.summary(boss)).people.find((p) => p.name === 'Lia Candidata');
  assert.equal(lia.parts.answers.mean, 4);
  assert.equal(lia.partial, true);

  const broken = (change) => {
    const copy = JSON.parse(JSON.stringify(settings.sections));
    change(copy);
    return review.saveSettings(boss, { sections: copy });
  };
  await assert.rejects(
    broken((s) => (s[0].criteria = [])),
    (e) => e.status === 400
  );
  await assert.rejects(
    broken((s) => (s[0].weight = -1)),
    (e) => e.status === 400
  );
  await assert.rejects(
    broken((s) => (s[0].questions = [])),
    (e) => e.status === 400
  );
  await assert.rejects(
    broken((s) => s[0].questions.push('nope')),
    (e) => e.status === 400
  );
});

// ── The setup: sections, grids, reviewers per section, the form ──────────────

test('a setup saved before sections keeps its grid and weights', async () => {
  await db.query(`insert into app_settings (key, value) values ('review_settings', $1)`, [
    {
      grid: { cv: [{ key: 'only', label: 'Only', help: '', weight: 1 }] },
      weights: { answers: 2 },
    },
  ]);
  const { sections } = await review.getSettings();
  assert.deepEqual(
    sections.map((s) => [s.key, s.weight, s.criteria.length]),
    [
      ['cv', 1, 1],
      ['answers', 2, 4],
    ]
  );
});

test('sections of their own: chosen questions, a grid per question, given to some reviewers', async () => {
  const { boss, ann, ben } = await panel();
  await review.saveSettings(boss, {
    sections: [
      {
        label: 'Motivazione',
        anonymous: true,
        weight: 2,
        reviewers: [ann.id],
        gridMode: 'question',
        questions: ['tracks', 'motivation', 'goals'],
        questionGrids: {
          motivation: [{ label: 'Sincera', weight: 1 }],
          goals: [
            { label: 'Realistici', weight: 1 },
            { label: 'Chiari', weight: 1 },
          ],
        },
      },
      {
        key: 'cv',
        label: 'Curriculum',
        prefix: 'cv',
        questions: ['cv'],
        criteria: [{ label: 'Esperienza', weight: 1 }],
      },
    ],
  });
  const { sections } = await review.getSettings();
  assert.deepEqual(
    sections.map((s) => [s.key, s.prefix, s.gridMode]),
    [
      ['motivazione', 'M', 'question'],
      ['cv', 'CV', 'section'],
    ]
  );
  // Ann has both sections, Ben only the one given to everyone.
  const annSees = (await call({ user: ann })).body.sections.map((s) => s.key);
  const benSees = (await call({ user: ben })).body.sections.map((s) => s.key);
  assert.deepEqual(annSees, ['motivazione', 'cv']);
  assert.deepEqual(benSees, ['cv']);
  assert.equal(
    (await call({ url: '/api/app/crm/review?part=motivazione', user: ben })).statusCode,
    403
  );

  // The questions of the section only, each grid keyed by its question.
  const code = review.codeOf(LIA_KEY(), sections[0]);
  assert.match(code, /^M-/);
  const app = (await call({ url: `/api/app/crm/review?part=motivazione&code=${code}`, user: ann }))
    .body;
  assert.deepEqual(
    app.items.map((i) => i.id),
    ['tracks', 'motivation', 'goals']
  );
  assert.deepEqual(
    app.grid.map((c) => c.key),
    ['motivation.sincera', 'goals.realistici', 'goals.chiari']
  );
  assert.ok(!JSON.stringify(app).includes('Dottoranda'));
  // A score of a question outside the grid is refused.
  assert.equal(
    (
      await call({
        method: 'POST',
        url: '/api/app/crm/review?action=score',
        user: ben,
        body: { part: 'motivazione', code, scores: {} },
      })
    ).statusCode,
    403
  );
  await assert.rejects(
    review.score(ann, { part: 'motivazione', code, scores: { sincera: 4 } }),
    (e) => e.status === 400
  );
  const r = await review.score(ann, {
    part: 'motivazione',
    code,
    scores: { 'motivation.sincera': 5, 'goals.realistici': 3, 'goals.chiari': 4 },
  });
  assert.equal(r.state, 'done');
  // A CV section scored by Ben, under its old key, weighs half.
  await review.score(ben, {
    part: 'cv',
    code: review.codeOf(LIA_KEY(), sections[1]),
    scores: { esperienza: 1 },
  });

  const sum = await review.summary(boss);
  assert.deepEqual(
    sum.sections.map((s) => [s.key, s.weight, s.reviewers]),
    [
      ['motivazione', 2, ['Ann']],
      ['cv', 1, []],
    ]
  );
  assert.equal(sum.sections[0].grid[0].questionLabel, 'Why they want to take part');
  const lia = sum.people.find((p) => p.name === 'Lia Candidata');
  assert.equal(lia.parts.motivazione.mean, 4);
  // (4 × 2 + 1 × 1) / 3
  assert.equal(lia.overall, 3);

  // A question grid with no criterion at all is not a grid.
  await assert.rejects(
    review.saveSettings(boss, {
      sections: [{ label: 'X', gridMode: 'question', questions: ['goals'], questionGrids: {} }],
    }),
    (e) => e.status === 400
  );
});

test('the applications can come from a form chosen by the admins', async () => {
  const forms = require('./forms/forms');
  const guard = require('./forms/guard');
  let clock = Date.now();
  guard.setClock(() => clock);
  const { boss, ann } = await panel();
  const root = await admin();
  const schema = {
    languages: ['it'],
    title: { it: 'Selezione' },
    items: [
      { id: 'nome', type: 'short_text', label: { it: 'Il tuo nome' }, required: true },
      { id: 'email', type: 'email', label: { it: 'Email' }, required: true },
      { id: 'uni', type: 'short_text', label: { it: 'Università' } },
      { id: 'cv_link', type: 'url', label: { it: 'CV' } },
      { id: 'perche', type: 'long_text', label: { it: 'Perché?' } },
      { id: 'citta', type: 'short_text', label: { it: 'Città' } },
    ],
  };
  const { id, slug } = await forms.create(root, { title: 'Selezione', schema });
  await forms.updateSettings(root, id, { status: 'open' });
  const send = async (answers) => {
    const view = await forms.publicView(slug);
    clock += 5000;
    return forms.submit(slug, { version: view.version, token: view.token, answers }, '203.0.113.9');
  };
  await send({
    nome: 'Lia Candidata',
    email: 'lia@example.org',
    uni: 'Politecnico di Prova',
    cv_link: 'https://example.org/cv.pdf',
    perche: 'Sono Lia, studio al Politecnico di Prova.',
    citta: 'Torino',
  });
  await send({ nome: 'Nuovo Nome', email: 'nuovo@example.org', perche: 'Perché sì.' });

  // Boss cannot read this form's answers: not theirs to pick.
  await assert.rejects(review.questions(boss, id), (e) => e.status === 404);
  await assert.rejects(review.saveSettings(boss, { formId: id }), (e) => e.status === 403);
  // The shared admin can: the questions come with a first split.
  const q = await review.questions(root, id);
  assert.deepEqual(
    q.catalog.map((x) => x.id),
    ['nome', 'email', 'uni', 'cv_link', 'perche', 'citta']
  );
  assert.equal(q.nameQuestion, 'nome');
  assert.deepEqual(
    q.sections.map((s) => [s.key, s.questions]),
    [
      ['cv', ['cv_link']],
      ['answers', ['perche']],
    ]
  );
  await review.saveSettings(root, { formId: id, nameQuestion: 'nome', sections: q.sections });

  // The reviewers read the form's answers, scrubbed in the anonymous section.
  const list = (await call({ url: '/api/app/crm/review?part=answers', user: ann })).body;
  assert.equal(list.items.length, 2);
  const liaCode = review.codeOf(LIA_KEY(), q.sections[1]);
  const app = await review.application(ann, 'answers', liaCode);
  assert.equal(app.items[0].text, 'Sono [name], studio al [uni].');

  // In the summary: Lia is on the board (her status shows), the other is not.
  await records.add('mentees_applications', LIA, { origin: 'form' });
  const sum = await review.summary(boss);
  assert.equal(sum.source, 'form');
  assert.deepEqual(sum.people.map((p) => [p.name, p.status]).sort(), [
    ['Lia Candidata', 'applied'],
    ['Nuovo Nome', null],
  ]);
  const nuovo = sum.people.find((p) => p.name === 'Nuovo Nome');
  assert.equal(
    (
      await call({
        method: 'POST',
        url: '/api/app/crm/review?action=status',
        user: boss,
        body: { key: nuovo.key, status: 'shortlisted' },
      })
    ).statusCode,
    404
  );
  // The settings page lists the form in use for Boss too.
  const page = (await call({ url: '/api/app/crm/review?action=settings', user: boss })).body;
  assert.equal(page.formId, id);
  assert.ok(page.forms.some((f) => f.id === id));
  assert.deepEqual(
    page.catalog.map((x) => x.id),
    ['nome', 'email', 'uni', 'cv_link', 'perche', 'citta']
  );
});

// ── The status is the board's ────────────────────────────────────────────────

test('the status set in the selection is the board’s, both ways', async () => {
  const { boss, ann } = await panel();
  const me = await admin();
  const move = (user, key, status) =>
    call({ method: 'POST', url: '/api/app/crm/review?action=status', user, body: { key, status } });
  const onBoard = async (name) =>
    (await mentorship.board(me)).mentees.find((m) => m.name === name).status;

  // Applied → Shortlisted → Interview: the board shows each step.
  for (const status of ['shortlisted', 'interview']) {
    const res = await move(boss, LIA_KEY(), status);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, status);
    assert.equal(await onBoard('Lia Candidata'), status);
  }

  // Selected and Matched are the board's, not the selection's.
  assert.equal((await move(boss, LIA_KEY(), 'selected')).statusCode, 400);
  await mentorship.update(me, LIA_KEY(), 'mentee', { status: 'selected' });
  const past = await move(boss, LIA_KEY(), 'declined');
  assert.equal(past.statusCode, 409);
  assert.equal(await onBoard('Lia Candidata'), 'selected');
  const sum0 = await review.summary(boss);
  assert.deepEqual(sum0.editable, ['applied', 'shortlisted', 'interview', 'declined']);
  assert.equal(sum0.statuses.find((s) => s.key === 'declined').label, 'Rejected');

  // Rejected on the board: off the reviewers' lists, still in the summary.
  await mentorship.update(me, MARCO_KEY(), 'mentee', { status: 'declined' });
  const list = (await call({ url: '/api/app/crm/review?part=cv', user: ann })).body;
  assert.deepEqual(
    list.items.map((i) => i.code),
    [review.codeOf(LIA_KEY(), 'cv')]
  );
  const sum = await review.summary(boss);
  assert.equal(sum.people.find((p) => p.name === 'Marco Secondo').status, 'declined');
  // And back from Rejected to Applied, from the selection.
  assert.equal((await move(boss, MARCO_KEY(), 'applied')).statusCode, 200);

  // A reviewer cannot move anyone.
  assert.equal((await move(ann, MARCO_KEY(), 'declined')).statusCode, 403);
});

test('the board’s history of a person does not tell who reviewed them', async () => {
  const { ann } = await panel();
  await review.score(ann, {
    part: 'cv',
    code: review.codeOf(LIA_KEY(), 'cv'),
    scores: scoreAll('cv', 3),
  });
  const me = await admin();
  const lia = await mentorship.person(me, ['mentorship'], LIA_KEY(), 'mentee');
  assert.ok(lia.history.every((line) => !line.action.startsWith('review-')));
});

test('the scores go with the application they score', async () => {
  const { ann } = await panel();
  await review.score(ann, {
    part: 'cv',
    code: review.codeOf(MARCO_KEY(), 'cv'),
    scores: scoreAll('cv', 3),
  });
  await db.query(
    `delete from crm_records where source = 'mentees_applications' and person_key = $1`,
    [MARCO_KEY()]
  );
  assert.equal((await retention.cleanup()).reviewScores, 1);
  const { rows } = await db.query('select count(*)::int as n from review_scores');
  assert.equal(rows[0].n, 0);
});

test('the faces of a tool: who opens it, only for who can open it', async () => {
  const { boss, ann } = await panel();
  await permissions.saveRolePermissions([
    { roleId: 'r-m', roleName: 'Mentorship team', permissions: ['mentorship', 'crm_admin'] },
  ]);
  const accessApi = require('./routes/app/access');
  const get = (user, tool) =>
    call({ url: `/api/app/access?tool=${tool}`, user, handler: accessApi });

  const review = (await get(ann, 'review')).body.access;
  assert.deepEqual(
    review.map((a) => [a.kind, a.name, a.what]),
    [
      ['person', 'Bea', 'Admin'],
      ['person', 'Ann', 'Reviewer'],
      ['person', 'Ben', 'Reviewer'],
    ]
  );
  // A reviewer cannot open the board: no faces of it either.
  assert.equal((await get(ann, 'crm')).statusCode, 403);
  const team = await member('Teo', ['r-m']);
  assert.deepEqual((await get(team, 'crm')).body.access, [
    { kind: 'role', name: 'Mentorship team', what: 'Role: Mentorship, Settings' },
  ]);
  // The forms and polls show theirs on each card.
  assert.equal((await get(boss, 'forms')).statusCode, 404);
});
