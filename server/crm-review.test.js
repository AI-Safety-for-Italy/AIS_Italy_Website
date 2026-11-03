// Tests for the mentee selection (server/crm/review.js and its API): who may
// see what, the anonymous codes, the scores and the summary, and the status
// shared with the mentorship board. Run with `npm run test:meet`.
//
// The applicants: Lia and Marco applied through the form; Gino (from the
// invented sheets) only expressed interest, so he is not scored.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'x'.repeat(40);

const db = require('./db');
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
  db.setDb(new PGlite());
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
    mine.parts.map((p) => [p.key, p.total, p.done]),
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
  const background = app.answers.find((a) => a.label === 'Background').text;
  assert.equal(
    background,
    'Mi chiamo [name] [name], faccio la [role] alla [affiliation]. Scrivimi a [email] o su [link], tel. [phone].'
  );
  assert.equal(app.answers[0].label, 'Track');

  const liaCv = await codeOf(ann, 'cv', LIA_KEY());
  const cv = (await call({ url: `/api/app/crm/review?part=cv&code=${liaCv}`, user: ann })).body;
  assert.deepEqual(cv.links, [
    { label: 'CV', url: 'https://drive.example.org/lia-cv.pdf' },
    { label: 'Profile', url: 'https://example.org/lia' },
  ]);
  assert.equal(cv.answers, undefined);
  // A link that is not http(s) is never handed to the page.
  const marcoCv = await codeOf(ann, 'cv', MARCO_KEY());
  const marco = (await call({ url: `/api/app/crm/review?part=cv&code=${marcoCv}`, user: ann }))
    .body;
  assert.deepEqual(marco.links, []);
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

  await review.saveSettings(boss, { weights: { cv: 1, answers: 3 } });
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
  await review.saveSettings(boss, {
    grid: {
      answers: [
        { key: 'motivation', label: 'Motivazione', help: '', weight: 3 },
        { label: 'Chiarezza', help: 'Scrive in modo chiaro', weight: 1 },
      ],
    },
  });
  const settings = await review.getSettings();
  assert.deepEqual(
    settings.grid.answers.map((c) => c.key),
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

  await assert.rejects(review.saveSettings(boss, { grid: { cv: [] } }), (e) => e.status === 400);
  await assert.rejects(
    review.saveSettings(boss, { weights: { cv: -1, answers: 1 } }),
    (e) => e.status === 400
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
