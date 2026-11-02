// The mentee selection: reviewers score the mentees' applications on a grid,
// without knowing who they are, and the panel's admins read the summary and
// move each mentee along the selection.
//
// Who does what:
//   admins     hold `review_admin`, given by name by the shared admin
//              (server/permissions.js). They see everything: the summary with
//              names and every score, the grid, the reviewers.
//   reviewers  people the admins add here (review_reviewers). They see the
//              applications under a code, score them, and see their own
//              scores only: never the others', never the summary.
//
// Two parts are scored apart, each on its own grid of criteria (1 to 5):
//   cv         the CV and profile links. A CV says who someone is: that part
//              is not anonymous, only scored under a code.
//   answers    the answers to the application form, with the name, the
//              affiliation, emails, links and phone numbers taken out.
// A mentee's code differs between the two parts (crypto.pseudonym), so a
// reviewer scoring both cannot tell which CV goes with which answers. Nothing
// a reviewer receives carries the person key, which is the same in both.
//
// The status is the board's own (crm_people_state through mentorship.js):
// what the admins decide here shows on the board, and the other way round.

const db = require('../db');
const { HttpError } = require('../http');
const access = require('../access');
const permissions = require('../permissions');
const crm = require('./crypto');
const audit = require('./audit');
const mentorship = require('./mentorship');

const PARTS = [
  { key: 'cv', label: 'CV', prefix: 'CV' },
  { key: 'answers', label: 'Answers', prefix: 'A' },
];
const PART_KEYS = PARTS.map((p) => p.key);
const SCALE = { min: 1, max: 5 };
const MAX_COMMENT = 2000;
const MAX_CRITERIA = 12;
const SETTINGS_KEY = 'review_settings';

// What the grid starts with: the admins change it on the settings page.
const DEFAULT_GRID = {
  cv: [
    {
      key: 'background',
      label: 'Relevant background',
      help: 'Studies and work that prepare them for AI safety research, engineering or policy.',
      weight: 1,
    },
    {
      key: 'experience',
      label: 'Hands-on experience',
      help: 'Research, projects, code, publications or policy work they actually did.',
      weight: 1,
    },
    {
      key: 'trajectory',
      label: 'Trajectory',
      help: 'Initiative and growth shown so far.',
      weight: 1,
    },
  ],
  answers: [
    {
      key: 'motivation',
      label: 'Motivation',
      help: 'Why AI safety and why now: specific and genuine, not generic.',
      weight: 1,
    },
    {
      key: 'understanding',
      label: 'Understanding of the field',
      help: 'A grasp of the problems AI safety works on.',
      weight: 1,
    },
    {
      key: 'goals',
      label: 'Clear goals',
      help: 'They know what they want from the program, and it is realistic.',
      weight: 1,
    },
    {
      key: 'commitment',
      label: 'Commitment',
      help: 'The time and engagement they can give.',
      weight: 1,
    },
  ],
};

// The answers a reviewer reads, in this order: [field, label].
const ANSWER_FIELDS = [
  ['tracks', 'Track'],
  ['areas', 'Areas of interest'],
  ['background', 'Background'],
  ['motivation', 'Why they want to take part'],
  ['goals', 'What they want from the program'],
  ['project_idea', 'Project idea'],
  ['hours', 'Hours per week'],
  ['language', 'Working language'],
];

// ── Who may do what ──────────────────────────────────────────────────────────

async function isReviewer(user) {
  if (!user || user.kind === 'admin') return false;
  const { rows } = await db.query('select 1 from review_reviewers where user_id = $1', [user.id]);
  return rows.length > 0;
}

/**
 * Lets in an admin of the panel or a reviewer: { admin, reviewer }. A recent
 * sign-in is needed as for the rest of the personal data, and the Discord
 * roles are read again when older than five minutes (`fresh`: always), so
 * someone who left the server is out. A refusal is on the audit trail.
 */
async function roleOf(user, { fresh = false } = {}) {
  await access.requireRecentLogin(user);
  if (fresh) await permissions.refreshRoles(user);
  else await permissions.refreshIfStale(user);
  const perms = await permissions.forUser(user);
  const role = { admin: perms.includes('review_admin'), reviewer: await isReviewer(user) };
  if (!role.admin && !role.reviewer) {
    await audit.record(user, 'denied', null, { needs: 'review' });
    throw new HttpError(403, 'Only the reviewers of the mentee selection can open this');
  }
  return role;
}

function requireAdmin(role) {
  if (!role.admin) throw new HttpError(403, 'Only the admins of the mentee selection can do this');
}

function requireReviewer(role) {
  if (!role.reviewer)
    throw new HttpError(403, 'Only the reviewers can score: an admin can add you to them');
}

// ── Settings: the grid, the weight of each part ─────────────────────────────

async function getSettings() {
  const { rows } = await db.query('select value from app_settings where key = $1', [SETTINGS_KEY]);
  const saved = (rows[0] && rows[0].value) || {};
  const grid = {};
  PART_KEYS.forEach((part) => {
    grid[part] =
      saved.grid && Array.isArray(saved.grid[part]) && saved.grid[part].length
        ? saved.grid[part]
        : DEFAULT_GRID[part];
  });
  const weights = {};
  PART_KEYS.forEach((part) => {
    const w = saved.weights && Number(saved.weights[part]);
    weights[part] = Number.isFinite(w) && w >= 0 ? w : 1;
  });
  return { grid, weights };
}

function slug(text) {
  return (
    String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'criterion'
  );
}

/** A part's criteria as the page sends them, checked. Keys stay as they were. */
function cleanCriteria(part, list) {
  if (!Array.isArray(list) || !list.length)
    throw new HttpError(400, `${part}: the grid needs at least one criterion`);
  if (list.length > MAX_CRITERIA)
    throw new HttpError(400, `${part}: at most ${MAX_CRITERIA} criteria`);
  const seen = new Set();
  return list.map((c) => {
    const label = String((c && c.label) || '').trim();
    if (!label || label.length > 80)
      throw new HttpError(400, `${part}: each criterion needs a name (80 characters at most)`);
    const help = String((c && c.help) || '').trim();
    if (help.length > 300) throw new HttpError(400, `${label}: 300 characters at most`);
    const weight = Number(c && c.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10)
      throw new HttpError(400, `${label}: the weight goes from 0 to 10`);
    // A criterion keeps its key when renamed, so its scores stay with it.
    let key =
      c && typeof c.key === 'string' && /^[a-z0-9_]{1,30}$/.test(c.key) ? c.key : slug(label);
    while (seen.has(key)) key = `${key.slice(0, 27)}_${seen.size}`;
    seen.add(key);
    return { key, label, help, weight };
  });
}

async function saveSettings(user, body) {
  const b = body || {};
  const current = await getSettings();
  const next = { grid: { ...current.grid }, weights: { ...current.weights } };
  if (b.grid !== undefined) {
    PART_KEYS.forEach((part) => {
      if (b.grid && b.grid[part] !== undefined) next.grid[part] = cleanCriteria(part, b.grid[part]);
    });
  }
  if (b.weights !== undefined) {
    PART_KEYS.forEach((part) => {
      const w = Number(b.weights && b.weights[part]);
      if (!Number.isFinite(w) || w < 0 || w > 10)
        throw new HttpError(400, 'The weight of each part goes from 0 to 10');
      next.weights[part] = w;
    });
  }
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, next]
  );
  await audit.record(user, 'review-settings', null, {
    grid: b.grid !== undefined,
    weights: b.weights !== undefined,
  });
  return getSettings();
}

// ── Reviewers ────────────────────────────────────────────────────────────────

async function reviewers() {
  const { rows } = await db.query(
    `select r.user_id, u.name, u.avatar_url, r.added_by_name, r.added_at
     from review_reviewers r join app_users u on u.id = r.user_id order by lower(u.name)`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    addedBy: r.added_by_name,
    addedAt: r.added_at,
  }));
}

/** Adds (`add`) or removes (`remove`) a reviewer by user id. Their scores stay. */
async function setReviewer(user, { add, remove } = {}) {
  const id = String(add || remove || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid person');
  if (add) {
    // Only those who signed in with Discord: the audit trail must name a person.
    const known = (await permissions.discordPeople()).some((p) => p.userId === id);
    if (!known) throw new HttpError(400, 'Only people who signed in with Discord can review');
    await db.query(
      `insert into review_reviewers (user_id, added_by_name) values ($1, $2)
       on conflict (user_id) do nothing`,
      [id, user.name]
    );
  } else {
    await db.query('delete from review_reviewers where user_id = $1', [id]);
  }
  await audit.record(user, 'review-reviewers', null, { action: add ? 'add' : 'remove' });
  return reviewers();
}

// ── The applications under a code ────────────────────────────────────────────

function codeOf(key, part) {
  const p = PARTS.find((x) => x.key === part);
  return `${p.prefix}-${crm.pseudonym(`review:${part}:${key}`)}`;
}

function checkPart(part) {
  if (!PART_KEYS.includes(part)) throw new HttpError(400, 'Unknown part');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text without what would say who wrote it: emails, links, handles, phone
 * numbers, and the person's own name, role and affiliation as the form has
 * them. It cannot catch everything (a thesis title, a small town): it takes
 * out what is mechanical, and the reviewers are asked to step aside when
 * they recognise someone anyway.
 */
function scrub(text, record) {
  let out = String(text || '');
  out = out.replace(/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g, '[email]');
  // A link ends before the punctuation that follows it.
  out = out.replace(/\b(?:https?:\/\/|www\.)\S+?(?=[.,;:!?)]*(?:\s|$))/gi, '[link]');
  out = out.replace(
    /\b[\w-]+\.(?:com|it|org|net|io|eu|edu|dev|ai)\b(?:\/\S*?(?=[.,;:!?)]*(?:\s|$)))?/gi,
    '[link]'
  );
  out = out.replace(/(^|\s)@[\w.]{2,}/g, '$1[handle]');
  // A phone number has at least 9 digits: "2019-2023" stays.
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) =>
    m.replace(/\D/g, '').length >= 9 ? '[phone]' : m
  );
  [
    [record.affiliation, '[affiliation]'],
    [record.role, '[role]'],
  ]
    .map(([phrase, mark]) => [String(phrase || '').trim(), mark])
    .filter(([phrase]) => phrase.length >= 4)
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([phrase, mark]) => {
      out = out.replace(new RegExp(escapeRe(phrase), 'gi'), mark);
    });
  String(record.name || '')
    .split(/[\s,.'’-]+/)
    .filter((w) => w.length >= 3)
    .forEach((w) => {
      out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRe(w)}(?![\\p{L}])`, 'giu'), '[name]');
    });
  return out;
}

/** A link a reviewer may open: http(s) only, else null. */
function safeLink(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** What a reviewer reads of one application in one part. */
function shown(applicant, part) {
  const r = applicant.record;
  if (part === 'cv') {
    return {
      links: [
        { label: 'CV', url: safeLink(r.cv) },
        { label: 'Profile', url: safeLink(r.profile) },
      ].filter((l) => l.url),
    };
  }
  return {
    answers: ANSWER_FIELDS.map(([field, label]) => ({ label, text: scrub(r[field], r) })).filter(
      (a) => a.text.trim()
    ),
  };
}

/**
 * The applications reviewers score: those not declined on the board, each
 * with its code in `part`, ordered by code (which is as good as shuffled, and
 * the same for everyone).
 */
async function pool(part) {
  const all = await mentorship.applicants();
  return all
    .filter((a) => a.card.status !== 'declined')
    .map((a) => ({ ...a, code: codeOf(a.key, part) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

async function findByCode(part, code) {
  checkPart(part);
  const found = (await pool(part)).find((a) => a.code === String(code || ''));
  if (!found) throw new HttpError(404, 'No such application (any more)');
  return found;
}

function commentContext(key, part, reviewerId) {
  return `review:${key}:${part}:${reviewerId}`;
}

function ownReview(row, key, part) {
  if (!row) return null;
  return {
    scores: row.scores || {},
    conflict: row.conflict,
    comment: row.comment_encrypted
      ? crm.decrypt(row.comment_encrypted, commentContext(key, part, row.reviewer_id)) ?? ''
      : '',
    updatedAt: row.updated_at,
  };
}

/** True when every criterion of the grid has a score. */
function complete(scores, criteria) {
  return criteria.every((c) => Number.isInteger(scores && scores[c.key]));
}

/** The grid's weighted mean of these scores (1 to 5), or null. */
function weighted(scores, criteria) {
  let sum = 0;
  let weights = 0;
  criteria.forEach((c) => {
    const v = scores && scores[c.key];
    if (!Number.isInteger(v) || !c.weight) return;
    sum += v * c.weight;
    weights += c.weight;
  });
  return weights ? sum / weights : null;
}

// ── What a reviewer sees ──────────────────────────────────────────────────────

/** The landing page: who I am here and how far I am in each part. */
async function overview(user, role) {
  const settings = await getSettings();
  const parts = [];
  for (const p of PARTS) {
    const list = role.reviewer ? await pool(p.key) : [];
    const { rows } = role.reviewer
      ? await db.query(
          'select person_key, scores, conflict from review_scores where reviewer_id = $1 and part = $2',
          [user.id, p.key]
        )
      : { rows: [] };
    const mine = new Map(rows.map((r) => [r.person_key, r]));
    const done = list.filter((a) => {
      const r = mine.get(a.key);
      return r && (r.conflict || complete(r.scores, settings.grid[p.key]));
    }).length;
    parts.push({ key: p.key, label: p.label, total: list.length, done });
  }
  return { admin: role.admin, reviewer: role.reviewer, parts, scale: SCALE };
}

/** One part's list for a reviewer: [{ code, state: 'todo'|'partial'|'done'|'conflict' }]. */
async function list(user, part) {
  checkPart(part);
  const settings = await getSettings();
  const apps = await pool(part);
  const { rows } = await db.query(
    'select person_key, scores, conflict from review_scores where reviewer_id = $1 and part = $2',
    [user.id, part]
  );
  const mine = new Map(rows.map((r) => [r.person_key, r]));
  await audit.record(user, 'review-list', null, { part, count: apps.length });
  return {
    part,
    grid: settings.grid[part],
    scale: SCALE,
    items: apps.map((a) => {
      const r = mine.get(a.key);
      let state = 'todo';
      if (r && r.conflict) state = 'conflict';
      else if (r && complete(r.scores, settings.grid[part])) state = 'done';
      else if (r) state = 'partial';
      return { code: a.code, state };
    }),
  };
}

/** One application in one part, anonymous, with my own review of it. */
async function application(user, part, code) {
  const found = await findByCode(part, code);
  const settings = await getSettings();
  const { rows } = await db.query(
    'select * from review_scores where person_key = $1 and part = $2 and reviewer_id = $3',
    [found.key, part, user.id]
  );
  await audit.record(user, 'review-list', found.key, { part, open: true });
  return {
    part,
    code: found.code,
    grid: settings.grid[part],
    scale: SCALE,
    ...shown(found, part),
    mine: ownReview(rows[0], found.key, part),
  };
}

/**
 * Saves my review of one application: { part, code, scores: { criterion: 1..5 },
 * conflict?, comment? }. A review may be saved half done; it counts in the
 * summary once every criterion has a score. Stepping aside (`conflict`)
 * drops the scores.
 */
async function score(user, body) {
  const b = body || {};
  const found = await findByCode(b.part, b.code);
  const settings = await getSettings();
  const criteria = settings.grid[b.part];
  const conflict = b.conflict === true;
  const scores = {};
  if (!conflict) {
    const given = b.scores && typeof b.scores === 'object' ? b.scores : {};
    for (const [k, v] of Object.entries(given)) {
      if (v === null || v === undefined || v === '') continue;
      if (!criteria.some((c) => c.key === k)) throw new HttpError(400, 'Unknown criterion');
      const n = Number(v);
      if (!Number.isInteger(n) || n < SCALE.min || n > SCALE.max)
        throw new HttpError(400, `Scores go from ${SCALE.min} to ${SCALE.max}`);
      scores[k] = n;
    }
  }
  const comment = String(b.comment || '').trim();
  if (comment.length > MAX_COMMENT)
    throw new HttpError(400, `A comment can be at most ${MAX_COMMENT} characters`);
  await db.query(
    `insert into review_scores (person_key, part, reviewer_id, reviewer_name, scores, conflict, comment_encrypted, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (person_key, part, reviewer_id) do update set reviewer_name = excluded.reviewer_name,
       scores = excluded.scores, conflict = excluded.conflict,
       comment_encrypted = excluded.comment_encrypted, updated_at = now()`,
    [
      found.key,
      b.part,
      user.id,
      user.name,
      scores,
      conflict,
      comment ? crm.encrypt(comment, commentContext(found.key, b.part, user.id)) : null,
    ]
  );
  await audit.record(user, 'review-score', found.key, {
    part: b.part,
    complete: !conflict && complete(scores, criteria),
    conflict,
  });
  return { state: conflict ? 'conflict' : complete(scores, criteria) ? 'done' : 'partial' };
}

// ── What the admins see ──────────────────────────────────────────────────────

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * Everyone who applied, declined ones too, with every review: the names, the
 * board's status, each part's mean and spread over the complete reviews, and
 * the overall score (the parts' means, weighted). Sorted best first.
 */
async function summary(user) {
  const settings = await getSettings();
  const all = await mentorship.applicants();
  const { rows } = await db.query('select * from review_scores');
  const byPerson = new Map();
  rows.forEach((r) => {
    if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, []);
    byPerson.get(r.person_key).push(r);
  });
  const current = new Set((await reviewers()).map((r) => r.userId));

  const people = all.map((a) => {
    const parts = {};
    PART_KEYS.forEach((part) => {
      const criteria = settings.grid[part];
      const reviews = (byPerson.get(a.key) || [])
        .filter((r) => r.part === part)
        .map((r) => {
          const done = !r.conflict && complete(r.scores, criteria);
          return {
            reviewer: r.reviewer_name,
            reviewerId: r.reviewer_id,
            stillReviewer: current.has(r.reviewer_id),
            scores: r.scores,
            total: r.conflict ? null : round(weighted(r.scores, criteria)),
            complete: done,
            conflict: r.conflict,
            comment: ownReview(r, a.key, part).comment,
            updatedAt: r.updated_at,
          };
        })
        .sort((x, y) => x.reviewer.localeCompare(y.reviewer, 'it'));
      const totals = reviews.filter((r) => r.complete).map((r) => weighted(r.scores, criteria));
      // The mean of each criterion over the complete reviews, for the table.
      const byCriterion = {};
      criteria.forEach((c) => {
        const vs = reviews.filter((r) => r.complete).map((r) => r.scores[c.key]);
        byCriterion[c.key] = vs.length ? round(vs.reduce((s, v) => s + v, 0) / vs.length) : null;
      });
      parts[part] = {
        code: codeOf(a.key, part),
        mean: totals.length ? round(totals.reduce((s, v) => s + v, 0) / totals.length) : null,
        spread: totals.length > 1 ? round(Math.max(...totals) - Math.min(...totals)) : null,
        count: totals.length,
        conflicts: reviews.filter((r) => r.conflict).length,
        byCriterion,
        reviews,
      };
    });
    let sum = 0;
    let weights = 0;
    PART_KEYS.forEach((part) => {
      if (parts[part].mean === null || !settings.weights[part]) return;
      sum += parts[part].mean * settings.weights[part];
      weights += settings.weights[part];
    });
    const scored = PART_KEYS.filter((part) => parts[part].mean !== null);
    return {
      key: a.key,
      name: a.card.name,
      org: a.card.org,
      track: a.card.track,
      status: a.card.status,
      overall: weights ? round(sum / weights) : null,
      // The overall stands on one part only while the other has no score.
      partial: scored.length > 0 && scored.length < PART_KEYS.length,
      parts,
    };
  });
  people.sort((x, y) => {
    if (x.overall === null && y.overall === null) return x.name.localeCompare(y.name, 'it');
    if (x.overall === null) return 1;
    if (y.overall === null) return -1;
    return y.overall - x.overall;
  });
  await audit.record(user, 'review-summary', null, { people: people.length });
  return {
    parts: PARTS.map((p) => ({ key: p.key, label: p.label })),
    grid: settings.grid,
    weights: settings.weights,
    scale: SCALE,
    // Every status, for the labels; `editable` the ones the selection sets.
    statuses: mentorship.STATUSES.mentee,
    editable: SELECTION_STATUSES,
    reviewers: await reviewers(),
    people,
  };
}

// The statuses the selection moves people between. The others (Selected,
// Matched…) are the board's: someone there is shown, not moved, here.
const SELECTION_STATUSES = ['applied', 'shortlisted', 'interview', 'declined'];

/**
 * Moves a mentee along the selection from the summary: the board's own status
 * (mentorship.update), so both show the same. Only between Applied,
 * Shortlisted, Interview and Rejected, and only for someone still in those.
 */
async function setStatus(user, key, status) {
  const found = (await mentorship.applicants()).find((a) => a.key === key);
  if (!found) throw new HttpError(404, 'No such application (any more)');
  if (!SELECTION_STATUSES.includes(status))
    throw new HttpError(
      400,
      'The selection moves people between Applied, Shortlisted, Interview and Rejected'
    );
  if (!SELECTION_STATUSES.includes(found.card.status))
    throw new HttpError(409, `${found.card.name} is past the selection: change it on the board`);
  return mentorship.update(user, key, 'mentee', { status });
}

/** The settings page: the grid, the weights, the reviewers and who could be one. */
async function settingsPage() {
  const [settings, list, people] = await Promise.all([
    getSettings(),
    reviewers(),
    permissions.discordPeople(),
  ]);
  const taken = new Set(list.map((r) => r.userId));
  return {
    parts: PARTS.map((p) => ({ key: p.key, label: p.label })),
    ...settings,
    scale: SCALE,
    reviewers: list,
    candidates: people.filter((p) => !taken.has(p.userId)),
  };
}

module.exports = {
  PARTS,
  DEFAULT_GRID,
  SCALE,
  isReviewer,
  roleOf,
  requireAdmin,
  requireReviewer,
  getSettings,
  saveSettings,
  settingsPage,
  reviewers,
  setReviewer,
  codeOf,
  scrub,
  overview,
  list,
  application,
  score,
  summary,
  setStatus,
};
