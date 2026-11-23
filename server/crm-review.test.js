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
    '333 123',
    'lia.example.org',
    LIA_KEY(),
    MARCO_KEY(),
  ]) {
    assert.ok(!text.includes(secret), `leaks ${secret}`);
  }
  // A role or an affiliation stays in the answers, as written.
  assert.ok(text.includes('Dottoranda') && text.includes('Università di Prova'));
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
    'Mi chiamo [name] [name], faccio la Dottoranda alla Università di Prova. Scrivimi a [email] o su [link], tel. [phone].'
  );
  assert.equal(app.items[0].label, 'Track');
  assert.ok(app.items.every((a) => a.url === null));

  const liaCv = await codeOf(ann, 'cv', LIA_KEY());
  const cv = (await call({ url: `/api/app/crm/review?part=cv&code=${liaCv}`, user: ann })).body;
  assert.deepEqual(
    cv.items.map((i) => [i.id, i.url, i.links]),
    [
      [
        'cv',
        'https://drive.example.org/lia-cv.pdf',
        [
          {
            text: 'https://drive.example.org/lia-cv.pdf',
            url: 'https://drive.example.org/lia-cv.pdf',
          },
        ],
      ],
      [
        'profile',
        'https://example.org/lia',
        [{ text: 'https://example.org/lia', url: 'https://example.org/lia' }],
      ],
    ]
  );
  // A link that is not http(s) is never handed to the page as one: its text
  // is, to be read.
  const marcoCv = await codeOf(ann, 'cv', MARCO_KEY());
  const marco = (await call({ url: `/api/app/crm/review?part=cv&code=${marcoCv}`, user: ann }))
    .body;
  assert.deepEqual(
    marco.items.map((i) => [i.url, i.links]),
    [[null, [{ text: 'javascript:alert(1)', url: null }]]]
  );
});

test('several links in one answer come apart, each with its text', async () => {
  const { ann } = await panel();
  await records.add(
    'mentees_applications',
    {
      name: 'Nina Link',
      email: 'nina@example.org',
      profile: 'https://linkedin.com/in/nina, www.nina.it; github.com/nina (ex-https:/broken',
      cv: 'Il mio CV: https://example.org/nina.pdf.',
    },
    { origin: 'form' }
  );
  const code = await codeOf(ann, 'cv', crm.personKey('nina@example.org'));
  const app = await review.application(ann, 'cv', code);
  const profile = app.items.find((i) => i.id === 'profile');
  assert.equal(
    profile.text,
    'https://linkedin.com/in/nina, www.nina.it; github.com/nina (ex-https:/broken'
  );
  assert.deepEqual(profile.links, [
    { text: 'https://linkedin.com/in/nina', url: 'https://linkedin.com/in/nina' },
    { text: 'www.nina.it', url: 'https://www.nina.it/' },
    { text: 'github.com/nina', url: 'https://github.com/nina' },
    { text: 'ex-https:/broken', url: null },
  ]);
  // A sentence with a link in it: the text as written, and its link.
  const cv = app.items.find((i) => i.id === 'cv');
  assert.equal(cv.text, 'Il mio CV: https://example.org/nina.pdf.');
  assert.deepEqual(cv.links, [
    { text: 'https://example.org/nina.pdf', url: 'https://example.org/nina.pdf' },
  ]);
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
  // A criterion not in the grid: the page is behind the setup (409, it reloads).
  assert.equal((await post(ann, { part: 'answers', code, scores: { nope: 3 } })).statusCode, 409);
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

test('a section for the projects track only: career orientation alone skips it, in the mean too', async () => {
  const { boss, ann } = await panel();
  const score = (part, key, value) =>
    review.score(ann, { part, code: review.codeOf(key, part), scores: scoreAll(part, value) });
  // Marco is on career orientation alone, Lia on the projects.
  await score('cv', MARCO_KEY(), 3);
  await score('answers', MARCO_KEY(), 5);
  await score('answers', LIA_KEY(), 4);
  const overall = async (name) => (await review.summary(boss)).people.find((p) => p.name === name);
  assert.equal((await overall('Marco Secondo')).overall, 4);

  const { sections } = await review.getSettings();
  sections.find((s) => s.key === 'answers').projectsOnly = true;
  await review.saveSettings(boss, { sections });

  // The reviewers no longer see him there; Lia stays.
  const list = (await call({ url: '/api/app/crm/review?part=answers', user: ann })).body;
  assert.deepEqual(
    list.items.map((i) => i.code),
    [review.codeOf(LIA_KEY(), 'answers')]
  );
  await assert.rejects(
    review.application(ann, 'answers', review.codeOf(MARCO_KEY(), 'answers')),
    (e) => e.status === 404
  );
  // His review there is kept but counts for nothing: the CV alone, not partial.
  const marco = await overall('Marco Secondo');
  assert.equal(marco.parts.answers.mean, null);
  assert.equal(marco.parts.answers.reviews.length, 1);
  assert.equal(marco.overall, 3);
  assert.equal(marco.partial, false);
  assert.equal((await overall('Lia Candidata')).parts.answers.mean, 4);
});

test('on both tracks: the overall (the projects score) and the advising one without the projects sections', async () => {
  const { boss, ann } = await panel();
  const score = (part, key, value) =>
    review.score(ann, { part, code: review.codeOf(key, part), scores: scoreAll(part, value) });
  const person = async (name) => (await review.summary(boss)).people.find((p) => p.name === name);

  // No section for the projects only: nothing to split.
  await score('cv', LIA_KEY(), 3);
  await score('answers', LIA_KEY(), 5);
  let lia = await person('Lia Candidata');
  assert.equal(lia.overall, 4);
  assert.equal(lia.advising, null);
  assert.equal('projects' in lia, false);

  const { sections } = await review.getSettings();
  sections.find((s) => s.key === 'answers').projectsOnly = true;
  await review.saveSettings(boss, { sections });
  await mentorship.update(boss, LIA_KEY(), 'mentee', { track: 'both' });
  lia = await person('Lia Candidata');
  assert.equal(lia.track, 'both');
  assert.equal(lia.overall, 4);
  assert.equal(lia.advising, 3);
  assert.equal(lia.advisingPartial, false);

  // Career orientation alone: the advising score is the overall.
  await score('cv', MARCO_KEY(), 2);
  const marco = await person('Marco Secondo');
  assert.equal(marco.overall, 2);
  assert.equal(marco.advising, 2);

  // In the CSV too.
  const csv = (await review.exportFile(boss, 'csv')).body.replace(/^\uFEFF/, '');
  assert.match(csv, /^Applicant,Organisation,Track,Status,Overall,Advising,/);
  assert.match(csv, /\r\nLia Candidata,[^\r\n]*,both,[^,]*,4,3,/);
});

test('the export: the summary as CSV or JSON, for the admins only', async () => {
  const { boss, ann, ben } = await panel();
  await review.score(ann, {
    part: 'answers',
    code: review.codeOf(LIA_KEY(), 'answers'),
    scores: scoreAll('answers', 4),
    comment: '=Bene, motivata',
  });
  await review.score(ben, {
    part: 'answers',
    code: review.codeOf(MARCO_KEY(), 'answers'),
    scores: {},
    conflict: true,
  });

  const csv = await review.exportFile(boss, 'csv');
  assert.match(csv.filename, /^mentee-selection-\d{4}-\d{2}-\d{2}\.csv$/);
  // A byte order mark first, for Excel to read the accents.
  assert.equal(csv.body.charCodeAt(0), 0xfeff);
  const lines = csv.body.slice(1).trim().split('\r\n');
  assert.match(
    lines[0],
    /^Applicant,Organisation,Track,Status,Overall,Advising,Pre-screening,Threshold,Section,Code/
  );
  const lia = lines.filter((l) => l.startsWith('Lia Candidata,'));
  // One line per section: a review in the answers, none yet in the CV.
  assert.equal(lia.length, 2);
  assert.match(
    lia.find((l) => l.includes(',Ann,')),
    /,no,yes,/
  );
  // A comment that looks like a formula stays text.
  assert.match(csv.body, /'=Bene, motivata/);
  assert.match(
    lines.find((l) => l.startsWith('Marco Secondo,') && l.includes(',Ben,')),
    /,yes,no,/
  );

  const json = JSON.parse((await review.exportFile(boss, 'json')).body);
  assert.equal(json.people.length, 2);
  assert.ok(json.exportedAt);
  await assert.rejects(review.exportFile(boss, 'xlsx'), { status: 400 });

  // A reviewer may not download it.
  assert.equal(
    (await call({ url: '/api/app/crm/review?action=export&format=csv', user: ann })).statusCode,
    403
  );
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
    (e) => e.status === 409
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
  assert.equal(app.items[0].text, 'Sono [name], studio al Politecnico di Prova.');

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

// ── Robust while people work: the setup, the grids and the form change ──────

test('two admins saving the setup at once: the second is told, not overwriting', async () => {
  const { boss } = await panel();
  const page = await review.settingsPage(boss);
  const mine = JSON.parse(JSON.stringify(page.sections));
  const theirs = JSON.parse(JSON.stringify(page.sections));
  mine[0].note = 'Prima nota';
  theirs[0].note = 'Seconda nota';
  await review.saveSettings(boss, { sections: mine, version: page.version });
  await assert.rejects(
    review.saveSettings(boss, { sections: theirs, version: page.version }),
    (e) => e.status === 409
  );
  const now = await review.getSettings();
  assert.equal(now.sections[0].note, 'Prima nota');
  // With the version just saved, the next change goes through.
  theirs[0].note = 'Terza nota';
  await review.saveSettings(boss, { sections: theirs, version: now.version });
  assert.equal((await review.getSettings()).sections[0].note, 'Terza nota');
});

test('a criterion added halfway: reviews already done keep counting', async () => {
  const { boss, ann, ben } = await panel();
  const code = review.codeOf(LIA_KEY(), 'answers');
  await review.score(ann, { part: 'answers', code, scores: scoreAll('answers', 4) });
  await new Promise((r) => setTimeout(r, 20));

  const sections = (await review.getSettings()).sections;
  sections[1].criteria.push({ label: 'Chiarezza', help: '', weight: 1 });
  await review.saveSettings(boss, { sections });

  // Ann's review counts (on the criteria it has); she is told to add the new one.
  let lia = (await review.summary(boss)).people.find((p) => p.name === 'Lia Candidata');
  assert.equal(lia.parts.answers.count, 1);
  assert.equal(lia.parts.answers.mean, 4);
  assert.equal(lia.parts.answers.reviews[0].missing, 1);
  const list = (await call({ url: '/api/app/crm/review?part=answers', user: ann })).body;
  assert.equal(list.items.find((i) => i.code === code).state, 'update');

  // A review begun after the criterion was added is not complete without it.
  await review.score(ben, { part: 'answers', code, scores: scoreAll('answers', 2) });
  lia = (await review.summary(boss)).people.find((p) => p.name === 'Lia Candidata');
  assert.equal(lia.parts.answers.count, 1);

  await review.score(ann, {
    part: 'answers',
    code,
    scores: { ...scoreAll('answers', 4), chiarezza: 1 },
  });
  lia = (await review.summary(boss)).people.find((p) => p.name === 'Lia Candidata');
  // (4 × 4 + 1) / 5
  assert.equal(lia.parts.answers.mean, 3.4);
});

test('a criterion taken out keeps its scores, and finds them when put back', async () => {
  const { boss, ann } = await panel();
  const code = review.codeOf(LIA_KEY(), 'answers');
  await review.score(ann, { part: 'answers', code, scores: scoreAll('answers', 5) });
  const sections = (await review.getSettings()).sections;
  const goals = sections[1].criteria.find((c) => c.key === 'goals');
  sections[1].criteria = sections[1].criteria.filter((c) => c.key !== 'goals');
  await review.saveSettings(boss, { sections });
  // Ann changes her review while "goals" is out of the grid.
  const fewer = scoreAll('answers', 3);
  delete fewer.goals;
  assert.deepEqual(await review.score(ann, { part: 'answers', code, scores: fewer }), {
    state: 'done',
  });
  sections[1].criteria.push(goals);
  await review.saveSettings(boss, { sections });
  const mine = (await review.application(ann, 'answers', code)).mine;
  assert.equal(mine.scores.goals, 5);
  assert.equal(mine.scores.motivation, 3);
});

test('reasons to exclude: set per section, flagged by reviewers, shown to the admins', async () => {
  const { boss, ann, ben } = await panel();
  const sections = (await review.getSettings()).sections;
  sections.forEach((s) => {
    s.exclusions = [
      { label: 'Escluso per non avere rapporti con l’Italia' },
      { label: 'Escluso per uso di LLM nelle risposte' },
    ];
  });
  await review.saveSettings(boss, { sections });
  const saved = (await review.getSettings()).sections[0].exclusions;
  assert.equal(saved.length, 2);
  const [italy, llm] = saved.map((r) => r.key);

  const code = review.codeOf(LIA_KEY(), 'cv');
  const app = await review.application(ann, 'cv', code);
  assert.deepEqual(
    app.section.exclusions.map((r) => r.key),
    [italy, llm]
  );
  await assert.rejects(
    review.score(ann, { part: 'cv', code, scores: {}, flags: ['nope'] }),
    (e) => e.status === 409
  );
  // A flag without scores is a finished review.
  assert.deepEqual(await review.score(ann, { part: 'cv', code, scores: {}, flags: [italy] }), {
    state: 'excluded',
  });
  const over = (await call({ user: ann })).body;
  assert.equal(over.sections.find((s) => s.key === 'cv').done, 1);
  assert.deepEqual((await review.application(ann, 'cv', code)).mine.flags, [italy]);

  // Marco has the better score but Lia is flagged: she goes after him.
  await review.score(ben, {
    part: 'answers',
    code: review.codeOf(LIA_KEY(), 'answers'),
    scores: scoreAll('answers', 5),
  });
  await review.score(ben, {
    part: 'answers',
    code: review.codeOf(MARCO_KEY(), 'answers'),
    scores: scoreAll('answers', 3),
  });
  const sum = await review.summary(boss);
  assert.deepEqual(
    sum.people.map((p) => p.name),
    ['Marco Secondo', 'Lia Candidata']
  );
  const lia = sum.people[1];
  assert.deepEqual(lia.exclusions, [
    {
      part: 'cv',
      section: 'CV',
      reason: 'Escluso per non avere rapporti con l’Italia',
      reviewer: 'Ann',
    },
  ]);
  // A reason taken out of the setup no longer counts.
  const again = (await review.getSettings()).sections;
  again[0].exclusions = again[0].exclusions.filter((r) => r.key !== italy);
  await review.saveSettings(boss, { sections: again });
  assert.equal(
    (await review.summary(boss)).people.find((p) => p.name === 'Lia Candidata').exclusions.length,
    0
  );
});

test('many reviewers at once: every score is kept, the same one twice is harmless', async () => {
  const { ann, ben } = await panel();
  const lia = review.codeOf(LIA_KEY(), 'answers');
  const marco = review.codeOf(MARCO_KEY(), 'answers');
  await Promise.all([
    review.score(ann, { part: 'answers', code: lia, scores: scoreAll('answers', 4) }),
    review.score(ben, { part: 'answers', code: lia, scores: scoreAll('answers', 2) }),
    review.score(ann, { part: 'answers', code: marco, scores: scoreAll('answers', 3) }),
    review.score(ben, { part: 'answers', code: marco, scores: { motivation: 5 } }),
    review.score(ben, { part: 'answers', code: marco, scores: { motivation: 5 } }),
  ]);
  const { rows } = await db.query('select count(*)::int as n from review_scores');
  assert.equal(rows[0].n, 4);
});

test('the codes are never the same for two people, and stay put', async () => {
  const keys = Array.from({ length: 300 }, (_, i) => `person-${i}`);
  const codes = review.codesOf(keys, 'answers');
  assert.equal(new Set(codes.values()).size, keys.length);
  // Someone joining or leaving changes no one else's code.
  const fewer = review.codesOf(keys.slice(0, 100), 'answers');
  keys.slice(0, 100).forEach((k) => assert.equal(fewer.get(k), codes.get(k)));
  // Two people whose five letters clash get ten letters each, still unique.
  const real = crm.pseudonym;
  crm.pseudonym = (text, length = 5) => (length === 5 ? 'AAAAA' : real(text, length));
  try {
    const clash = review.codesOf(['a', 'b', 'c'], 'answers');
    assert.equal(new Set(clash.values()).size, 3);
    clash.forEach((c) => assert.match(c, /^A-[A-Z0-9]{10}$/));
  } finally {
    crm.pseudonym = real;
  }
});

test('the form gets new questions: the setup and the scores stay, the questions add up', async () => {
  const forms = require('./forms/forms');
  const guard = require('./forms/guard');
  let clock = Date.now();
  guard.setClock(() => clock);
  const { ann } = await panel();
  const root = await admin();
  const items = [
    { id: 'nome', type: 'short_text', label: { it: 'Nome' }, required: true },
    { id: 'email', type: 'email', label: { it: 'Email' }, required: true },
    { id: 'perche', type: 'long_text', label: { it: 'Perché?' } },
    { id: 'progetti', type: 'long_text', label: { it: 'Quali progetti?' } },
  ];
  const schema = { languages: ['it'], title: { it: 'Candidature' }, items };
  const { id, slug } = await forms.create(root, { title: 'Candidature', schema });
  await forms.updateSettings(root, id, { status: 'open' });
  const send = async (answers) => {
    const view = await forms.publicView(slug);
    clock += 5000;
    return forms.submit(slug, { version: view.version, token: view.token, answers }, '203.0.113.9');
  };
  await send({ nome: 'Lia Candidata', email: 'lia@example.org', perche: 'Per capire.' });
  await send({
    nome: 'Marco Secondo',
    email: 'marco@example.org',
    perche: 'Per lavorarci.',
    progetti: 'Interpretability.',
  });
  const q = await review.questions(root, id);
  const sections = [
    { ...q.sections[0], key: 'answers', label: 'Generale', questions: ['perche'] },
    { ...q.sections[0], key: 'progetti', label: 'Progetti', prefix: 'P', questions: ['progetti'] },
  ];
  await review.saveSettings(root, { formId: id, nameQuestion: 'nome', sections });

  // Only those who answered about the projects are scored there.
  const projects = (await call({ url: '/api/app/crm/review?part=progetti', user: ann })).body;
  assert.equal(projects.items.length, 1);
  const lia = review.codeOf(LIA_KEY(), (await review.getSettings()).sections[0]);
  await review.score(ann, { part: 'answers', code: lia, scores: scoreAll('answers', 4) });

  // The form changes: a new question, one taken out. A new version of it.
  await forms.saveSchema(root, id, {
    ...schema,
    items: [
      items[0],
      items[1],
      items[2],
      { id: 'paese', type: 'short_text', label: { it: 'Paese' } },
    ],
  });
  await send({
    nome: 'Nuova Persona',
    email: 'nuova@example.org',
    perche: 'Curiosità.',
    paese: 'IT',
  });

  // The setup is as it was; every question, old and new, can be placed.
  const page = await review.settingsPage(root);
  assert.deepEqual(
    page.sections.map((s) => [s.key, s.questions]),
    [
      ['answers', ['perche']],
      ['progetti', ['progetti']],
    ]
  );
  assert.deepEqual(page.catalog.map((x) => x.id).sort(), [
    'email',
    'nome',
    'paese',
    'perche',
    'progetti',
  ]);
  // The new question goes in a section: saved without touching the rest.
  page.sections[0].questions.push('paese');
  await review.saveSettings(root, { sections: page.sections, version: page.version });
  const list = (await call({ url: '/api/app/crm/review?part=answers', user: ann })).body;
  assert.equal(list.items.length, 3);
  assert.equal(list.items.find((i) => i.code === lia).state, 'done');
  const mine = (await review.application(ann, 'answers', lia)).mine;
  assert.deepEqual(mine.scores, scoreAll('answers', 4));
});

// ── The pre-screening, applications still coming in, the reminders ─────────

/** Switches the pre-screening on, on the board's questions. */
async function prescreenOn(boss, extra = {}) {
  await review.saveSettings(boss, {
    prescreen: {
      enabled: true,
      questions: ['country', 'affiliation'],
      reasons: [{ label: 'No ties with Italy' }],
      ...extra,
    },
  });
  return (await review.getSettings()).prescreen;
}

test('the pre-screening: any reviewer decides, and who is excluded is in no section', async () => {
  const { boss, ann, ben } = await panel();
  // Off by default: the sections show everyone.
  assert.equal((await review.getSettings()).prescreen.enabled, false);
  await assert.rejects(review.list(ann, 'prescreen'), (e) => e.status === 400);
  // Switched on, it needs a question and a reason.
  await assert.rejects(
    review.saveSettings(boss, { prescreen: { enabled: true, questions: [], reasons: [] } }),
    (e) => e.status === 400
  );
  const p = await prescreenOn(boss);
  const reason = p.reasons[0].key;

  const over = (await call({ user: ann })).body;
  assert.equal(over.sections[0].key, 'prescreen');
  assert.equal(over.sections[0].total, 2);
  // Nobody has passed yet: the sections are empty, both waiting.
  const cv = over.sections.find((s) => s.key === 'cv');
  assert.deepEqual([cv.total, cv.waiting], [0, 2]);

  const list = (await call({ url: '/api/app/crm/review?part=prescreen', user: ann })).body;
  assert.ok(list.items.every((i) => /^P-/.test(i.code) && i.state === 'todo'));
  const liaCode = review.codeOf(LIA_KEY(), { key: 'prescreen', prefix: 'P' });
  const marcoCode = review.codeOf(MARCO_KEY(), { key: 'prescreen', prefix: 'P' });
  const app = (await call({ url: `/api/app/crm/review?part=prescreen&code=${liaCode}`, user: ann }))
    .body;
  assert.deepEqual(
    app.items.map((i) => i.id),
    ['affiliation']
  );
  assert.equal(app.decision, null);

  // Excluding needs a reason among those offered.
  const decide = (user, body) =>
    call({ method: 'POST', url: '/api/app/crm/review?action=prescreen', user, body });
  assert.equal((await decide(ann, { code: liaCode, decision: 'exclude' })).statusCode, 400);
  assert.equal(
    (await decide(ann, { code: liaCode, decision: 'exclude', reasons: ['nope'] })).statusCode,
    409
  );
  const out = await decide(ann, { code: liaCode, decision: 'exclude', reasons: [reason] });
  assert.equal(out.body.state, 'excluded');
  assert.equal(out.body.decision.by, 'Ann');
  // Ben passes Marco: one decision for everyone.
  assert.equal((await decide(ben, { code: marcoCode, decision: 'pass' })).body.state, 'passed');
  const benList = await review.list(ben, 'prescreen');
  assert.deepEqual(benList.items.map((i) => i.state).sort(), ['excluded', 'passed']);

  // Only Marco is in the sections; Lia cannot be scored there.
  const cvList = await review.list(ann, 'cv');
  assert.deepEqual(
    cvList.items.map((i) => i.code),
    [review.codeOf(MARCO_KEY(), 'cv')]
  );
  await assert.rejects(
    review.score(ann, { part: 'cv', code: review.codeOf(LIA_KEY(), 'cv'), scores: {} }),
    (e) => e.status === 404
  );

  // The admins see why, Lia last; only they can bring her back.
  const sum = await review.summary(boss);
  const lia = sum.people[sum.people.length - 1];
  assert.equal(lia.name, 'Lia Candidata');
  assert.deepEqual(lia.prescreen.reasonLabels, ['No ties with Italy']);
  const readmit = (user) =>
    call({
      method: 'POST',
      url: '/api/app/crm/review?action=readmit',
      user,
      body: { key: LIA_KEY(), decision: 'pass' },
    });
  assert.equal((await readmit(ann)).statusCode, 403);
  assert.equal((await readmit(boss)).statusCode, 200);
  assert.equal((await review.list(ann, 'cv')).items.length, 2);

  // Given to some reviewers only, the others do not see it.
  await prescreenOn(boss, { reviewers: [ben.id] });
  await assert.rejects(review.list(ann, 'prescreen'), (e) => e.status === 403);
  assert.ok(
    (await review.overview(ann, { reviewer: true })).sections.every((s) => s.key !== 'prescreen')
  );
  // Switched off, everyone is back in the sections.
  await review.saveSettings(boss, { prescreen: { ...p, enabled: false } });
  assert.equal((await review.list(ann, 'cv')).items.length, 2);
});

test('a reviewer never receives a person key in the pre-screening', async () => {
  const { boss, ann } = await panel();
  await prescreenOn(boss);
  const list = await call({ url: '/api/app/crm/review?part=prescreen', user: ann });
  const code = list.body.items[0].code;
  const one = await call({ url: `/api/app/crm/review?part=prescreen&code=${code}`, user: ann });
  const text = JSON.stringify([list.body, one.body]);
  assert.ok(!text.includes(LIA_KEY()) && !text.includes(MARCO_KEY()));
});

test('the lists put what is left to do first', async () => {
  const { ann } = await panel();
  const before = (await review.list(ann, 'cv')).items.map((i) => i.code);
  await review.score(ann, { part: 'cv', code: before[0], scores: scoreAll('cv', 4) });
  const after = (await review.list(ann, 'cv')).items;
  assert.deepEqual(
    after.map((i) => [i.code, i.state]),
    [
      [before[1], 'todo'],
      [before[0], 'done'],
    ]
  );
});

test('what came in since the last visit is counted and marked', async () => {
  const { ann } = await panel();
  // The first visit: nothing is new.
  let over = await review.overview(ann, { reviewer: true });
  assert.equal(over.news.count, 0);
  // A new application while the reviewer is away for a while.
  await db.query(`update review_visits set last_at = now() - interval '2 hours'`);
  await db.query(`update review_arrivals set arrived_at = now() - interval '3 hours'`);
  await records.add(
    'mentees_applications',
    { name: 'Nina Nuova', email: 'nina@example.org', motivation: 'Ci provo.' },
    { origin: 'form' }
  );
  over = await review.overview(ann, { reviewer: true });
  assert.equal(over.news.count, 1);
  assert.equal(over.sections.find((s) => s.key === 'answers').fresh, 1);
  const items = (await review.list(ann, 'answers')).items;
  assert.deepEqual(
    items.filter((i) => i.fresh).map((i) => i.code),
    [review.codeOf(crm.personKey('nina@example.org'), 'answers')]
  );
  // Still new on the next page load, while the reviewer keeps working.
  assert.equal((await review.overview(ann, { reviewer: true })).news.count, 1);
});

test('reminders: now, and before the deadline, to whoever has reviews left', async () => {
  process.env.MEET_FAKE_MAIL = '1';
  const reminders = require('./crm/review-reminders');
  const { boss, ann, ben } = await panel();
  await db.query(`update app_users set email = lower(name) || '@example.org' where id = any($1)`, [
    [ann.id, ben.id],
  ]);
  // Ben has finished: only Ann is reminded.
  await review.saveSettings(boss, {
    sections: (
      await review.getSettings()
    ).sections.map((s) => ({
      ...s,
      reviewers: s.key === 'cv' ? [ann.id] : [ben.id],
    })),
  });
  for (const key of [LIA_KEY(), MARCO_KEY()]) {
    await review.score(ben, {
      part: 'answers',
      code: review.codeOf(key, 'answers'),
      scores: scoreAll('answers', 3),
    });
  }
  const page = (await call({ url: '/api/app/crm/review?action=reminders', user: boss })).body;
  assert.deepEqual(
    page.team.map((r) => [r.name, r.left]),
    [
      ['Ann', 2],
      ['Ben', 0],
    ]
  );
  const now = await call({
    method: 'POST',
    url: '/api/app/crm/review?action=remind',
    user: boss,
    body: { note: 'Grazie!' },
  });
  assert.deepEqual(now.body, { sent: 1, reviewers: 1 });
  // Not twice in a few minutes, and never by a reviewer.
  assert.equal(
    (await call({ method: 'POST', url: '/api/app/crm/review?action=remind', user: boss, body: {} }))
      .statusCode,
    429
  );
  assert.equal(
    (await call({ method: 'POST', url: '/api/app/crm/review?action=remind', user: ann, body: {} }))
      .statusCode,
    403
  );

  // Automatic: three days and twelve hours before.
  const deadline = new Date(Date.now() + 5 * 24 * 3600e3);
  const put = (body) =>
    call({ method: 'PUT', url: '/api/app/crm/review?action=reminders', user: boss, body });
  assert.equal((await put({ auto: true, leads: [4320] })).statusCode, 400);
  assert.equal((await put({ auto: true, deadline, leads: [999] })).statusCode, 400);
  assert.equal((await put({ auto: true, deadline, leads: [4320, 720] })).statusCode, 200);
  const at = (minutesBefore) => new Date(deadline.getTime() - minutesBefore * 60000);
  assert.deepEqual(await reminders.run({ now: at(4400) }), { sent: 0 });
  assert.deepEqual(await reminders.run({ now: at(4310) }), { sent: 1 });
  assert.deepEqual(await reminders.run({ now: at(4300) }), { sent: 0 });
  assert.deepEqual(await reminders.run({ now: at(700) }), { sent: 1 });
  // Long after its time, a reminder is not sent any more.
  await db.query('delete from review_reminders_sent');
  assert.deepEqual(await reminders.run({ now: at(500) }), { sent: 0 });

  const msg = reminders.message(
    { total: 20, parts: [{ label: 'CV', left: 20 }] },
    { deadline: deadline.toISOString(), minutesLeft: 10080, note: null, origin: 'https://x' }
  );
  assert.equal(msg.subject, 'Mentee selection: 1 week left, 20 applications to review');
  delete process.env.MEET_FAKE_MAIL;
});

// ── The threshold ────────────────────────────────────────────────────────────

/** Three more applicants, with a CV and an answer each: [key of each]. */
async function threeMore() {
  const keys = [];
  for (const n of ['uno', 'due', 'tre']) {
    const email = `${n}@example.org`;
    await records.add(
      'mentees_applications',
      {
        name: `Persona ${n}`,
        email,
        cv: `https://drive.example.org/${n}.pdf`,
        tracks: 'Progetti di AI safety',
        motivation: `Motivazione ${n}.`,
      },
      { origin: 'form' }
    );
    keys.push(crm.personKey(email));
  }
  return keys;
}

const scoreCv = (user, key, value) =>
  review.score(user, { part: 'cv', code: review.codeOf(key, 'cv'), scores: scoreAll('cv', value) });
const answersOf = async (user) => (await review.list(user, 'answers')).items.map((i) => i.code);
const gateCall = (user, body) =>
  call({ method: 'PUT', url: '/api/app/crm/review?action=gate', user, body });

test('the threshold: the worst share of the CV reaches no later section, and comes back', async () => {
  const { boss, ann, ben } = await panel();
  const [uno, due, tre] = await threeMore();
  const marcoAnswers = review.codeOf(MARCO_KEY(), 'answers');
  // Off by default: the answers show everyone.
  assert.equal((await review.getGate()).from, null);
  assert.equal((await answersOf(ann)).length, 5);
  // Ann scores Marco's answers before the threshold is on.
  await review.score(ann, {
    part: 'answers',
    code: marcoAnswers,
    scores: scoreAll('answers', 4),
    comment: 'Buone risposte',
  });

  // Only the admins move it, and only after a section with another after it.
  assert.equal((await gateCall(ann, { from: 'cv', percent: 20 })).statusCode, 403);
  assert.equal((await gateCall(boss, { from: 'answers', percent: 20 })).statusCode, 400);
  assert.equal((await gateCall(boss, { from: 'nope', percent: 20 })).statusCode, 400);
  assert.equal((await gateCall(boss, { from: 'cv', percent: 95 })).statusCode, 400);
  assert.equal((await gateCall(boss, { from: 'cv', percent: 2.5 })).statusCode, 400);
  const on = await gateCall(boss, { from: 'cv', percent: 20 });
  assert.equal(on.statusCode, 200);
  assert.deepEqual([on.body.gate.from, on.body.gate.percent], ['cv', 20]);
  // Moved by someone else since: refused, not overwritten.
  assert.equal((await gateCall(boss, { percent: 30, version: 'old' })).statusCode, 409);

  // Nobody's CV is done: everyone waits, the answers are empty, the CV is not.
  assert.equal((await answersOf(ann)).length, 0);
  assert.equal((await review.list(ann, 'cv')).items.length, 5);
  await assert.rejects(
    review.score(ann, { part: 'answers', code: marcoAnswers, scores: {} }),
    (e) => e.status === 404
  );

  // Ann scores every CV; Ben not yet: still waiting for Ben.
  const values = [
    [LIA_KEY(), 5],
    [MARCO_KEY(), 1],
    [uno, 4],
    [due, 3],
    [tre, 2],
  ];
  for (const [key, v] of values) await scoreCv(ann, key, v);
  assert.equal((await answersOf(ann)).length, 0);
  // Ben scores all but Tre, whom he knows: stepping aside finishes it.
  for (const [key, v] of values.slice(0, 4)) await scoreCv(ben, key, v);
  await review.score(ben, {
    part: 'cv',
    code: review.codeOf(tre, 'cv'),
    scores: {},
    conflict: true,
  });

  // Five ranked, 20%: one left out, Marco (mean 1).
  const answers = await answersOf(ann);
  assert.equal(answers.length, 4);
  assert.ok(!answers.includes(marcoAnswers));
  await assert.rejects(review.application(ann, 'answers', marcoAnswers), (e) => e.status === 404);
  const over = (await call({ user: ann })).body;
  assert.equal(over.sections.find((s) => s.key === 'answers').total, 4);

  // The admins see it all, and Marco's review of his answers is still there.
  let sum = await review.summary(boss);
  assert.equal(sum.gate.cutoff, 2);
  assert.deepEqual(sum.gate.means, [1, 2, 3, 4, 5]);
  assert.deepEqual(sum.gate.counts, { pass: 4, below: 1, waiting: 0 });
  assert.deepEqual(sum.gate.filters, ['answers']);
  const marco = sum.people.find((p) => p.key === MARCO_KEY());
  assert.equal(marco.gate, 'below');
  assert.equal(marco.parts.answers.count, 1);
  // Held back, the answers are not a section missing.
  assert.equal(marco.partial, false);
  assert.equal(sum.people[sum.people.length - 1].key, MARCO_KEY());
  const csv = (await review.exportFile(boss, 'csv')).body;
  assert.ok(csv.split('\r\n').some((l) => l.startsWith('Marco Secondo,') && l.includes(',below,')));

  // 40%: two out. 0%: everyone back, Marco's review as Ann left it.
  await review.saveGate(boss, { percent: 40 });
  assert.equal((await answersOf(ann)).length, 3);
  // Rejecting the two below does not cut the next one: they stay ranked.
  const head = await admin();
  for (const k of [MARCO_KEY(), tre])
    await mentorship.update(head, k, 'mentee', { status: 'declined' });
  sum = await review.summary(boss);
  assert.deepEqual(sum.gate.counts, { pass: 3, below: 2, waiting: 0 });
  assert.equal(sum.people.find((p) => p.key === due).gate, 'pass');
  for (const k of [MARCO_KEY(), tre])
    await mentorship.update(head, k, 'mentee', { status: 'applied' });
  await review.saveGate(boss, { percent: 0 });
  assert.equal((await answersOf(ann)).length, 5);
  const back = await review.application(ann, 'answers', marcoAnswers);
  assert.equal(back.mine.scores.motivation, 4);
  assert.equal(back.mine.comment, 'Buone risposte');

  // A tie with the last one in passes: Tre as low as Marco, nobody out at 20%.
  await review.saveGate(boss, { percent: 20 });
  await scoreCv(ann, tre, 1);
  sum = await review.summary(boss);
  assert.equal(sum.gate.counts.below, 0);
  assert.equal((await answersOf(ann)).length, 5);

  // Off: as before it was set.
  await review.saveGate(boss, { from: null });
  assert.equal(
    (await review.summary(boss)).people.every((p) => p.gate === null),
    true
  );
  const { rows } = await db.query(
    `select detail from crm_audit where action = 'review-gate' order by at desc limit 1`
  );
  assert.deepEqual(rows[0].detail, { from: null, percent: 20 });
});

test('the threshold waits for the reviewers the section is given to, and nobody else', async () => {
  const { boss, ann, ben } = await panel();
  const sections = (await review.getSettings()).sections;
  sections.find((s) => s.key === 'cv').reviewers = [ann.id];
  await review.saveSettings(boss, { sections });
  await review.saveGate(boss, { from: 'cv', percent: 50 });
  await scoreCv(ann, LIA_KEY(), 5);
  // Lia is done by everyone the CV is given to; Marco waits.
  const sum = await review.summary(boss);
  assert.equal(sum.people.find((p) => p.key === LIA_KEY()).gate, 'pass');
  assert.equal(sum.people.find((p) => p.key === MARCO_KEY()).gate, 'waiting');
  assert.deepEqual(await answersOf(ben), [review.codeOf(LIA_KEY(), 'answers')]);
  // The CV section gone, the threshold stops filtering.
  await review.saveSettings(boss, { sections: sections.filter((s) => s.key !== 'cv') });
  assert.equal((await answersOf(ben)).length, 2);
});
