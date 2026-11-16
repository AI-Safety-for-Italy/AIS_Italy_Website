// The mentee selection: reviewers score the mentees' applications on a grid,
// without knowing who they are, and the panel's admins read the summary and
// move each mentee along the selection.
//
// Who does what:
//   admins     hold `review_admin`, given by name by the shared admin
//              (server/permissions.js). They see everything: the summary with
//              names and every score, the setup, the reviewers.
//   reviewers  people the admins add here (review_reviewers). They see the
//              applications under a code, score them, and see their own
//              scores only: never the others', never the summary.
//
// The setup (app_settings, key review_settings) is the admins' to shape:
//   the source    the form whose answers are reviewed, or none: the mentee
//                 applications on the mentorship board (server/crm/records.js);
//   the sections  the tabs the reviewers score apart (say "CV" and
//                 "Answers"), each with the questions it shows, its grid of
//                 criteria (1 to 5), one for the whole section or one per
//                 question, its weight in the overall score, whether its text
//                 is made anonymous, and the reviewers it is given to (none
//                 listed: every reviewer). A question in no section is not
//                 shown to anyone (an email, a phone number, practical info).
//                 Each section may also offer reasons to exclude someone
//                 (say "no ties with Italy"), which a reviewer ticks instead
//                 of, or as well as, scoring; the summary marks the person.
//   the pre-screening  optional, before the sections: a few questions (the
//                 country, the affiliation) and reasons to exclude. Any
//                 reviewer it is given to decides for everyone, pass or
//                 exclude; someone excluded there is shown in no section,
//                 so nobody spends time scoring them, and only those who
//                 passed are. The admins can bring someone back.
// The applications may still be coming in while the reviewers work: each
// list puts what is left to do first, and a reviewer is told how many came
// in since their last visit (review_arrivals, review_visits). The reminders
// before a deadline are server/crm/review-reminders.js's.
// Built to change while people work: the form gaining questions (they come
// in, the sections stay), criteria added (the reviews done before keep
// counting), criteria removed (their scores are kept), two admins saving the
// setup at once (the second is told), reviewers scoring at once (each review
// is its own row).
// A mentee's code differs between sections (crypto.pseudonym), so a reviewer
// scoring two cannot tell which CV goes with which answers. Nothing a
// reviewer receives carries the person key, which is the same in all.
//
// The status is the board's own (crm_people_state through mentorship.js):
// what the admins decide here shows on the board, and the other way round.
// Someone who answered the form but is not on the board has no status.

const db = require('../db');
const { HttpError } = require('../http');
const access = require('../access');
const permissions = require('../permissions');
const crm = require('./crypto');
const audit = require('./audit');
const mentorship = require('./mentorship');
const forms = require('../forms/forms');

const SCALE = { min: 1, max: 5 };
const MAX_COMMENT = 2000;
const MAX_CRITERIA = 12;
const MAX_SECTIONS = 8;
const MAX_NOTE = 400;
const MAX_EXCLUSIONS = 6;
const SETTINGS_KEY = 'review_settings';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_]{1,30}$/;
const QUESTION = /^[a-z][a-z0-9_]{1,39}$/;
// The pre-screening's part, beside the sections' keys (which never take it).
const PRESCREEN = 'prescreen';
// Away this long, a reviewer's next visit counts what is new from the last one.
const VISIT_GAP_MS = 60 * 60 * 1000;

// The grid the two first sections start with: the admins change it.
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

// The questions of the board's mentee applications (sources.js), when no
// form is chosen: [id, label, type], the ids being the template's own.
const BOARD_QUESTIONS = [
  ['name', 'Name', 'short_text'],
  ['email', 'Email', 'email'],
  ['role', 'Role', 'short_text'],
  ['affiliation', 'Affiliation', 'short_text'],
  ['profile', 'Profile', 'url'],
  ['cv', 'CV', 'url'],
  ['country', 'Country', 'short_text'],
  ['tracks', 'Track', 'multi'],
  ['areas', 'Areas of interest', 'multi'],
  ['background', 'Background', 'long_text'],
  ['motivation', 'Why they want to take part', 'long_text'],
  ['goals', 'What they want from the program', 'long_text'],
  ['project_idea', 'Project idea', 'long_text'],
  ['hours', 'Hours per week', 'number'],
  ['language', 'Working language', 'single'],
].map(([id, label, type]) => ({ id, label, type }));

// The setup before the admins change it: the CV and the answers apart.
const DEFAULT_SECTIONS = [
  {
    key: 'cv',
    label: 'CV',
    prefix: 'CV',
    note: 'A CV says who someone is: this section cannot be anonymous. Score each CV on its merits, and step aside if you know the person.',
    anonymous: false,
    weight: 1,
    reviewers: [],
    gridMode: 'section',
    questions: ['cv', 'profile'],
    criteria: DEFAULT_GRID.cv,
    questionGrids: {},
    exclusions: [],
  },
  {
    key: 'answers',
    label: 'Answers',
    prefix: 'A',
    note: 'Names, emails, links and phone numbers are taken out of the answers. If you recognise the person anyway, step aside.',
    anonymous: true,
    weight: 1,
    reviewers: [],
    gridMode: 'section',
    questions: [
      'tracks',
      'areas',
      'background',
      'motivation',
      'goals',
      'project_idea',
      'hours',
      'language',
    ],
    criteria: DEFAULT_GRID.answers,
    questionGrids: {},
    exclusions: [],
  },
];

// The pre-screening before the admins set it: off, on the board's questions
// that say where someone is from and works.
const DEFAULT_PRESCREEN = {
  enabled: false,
  label: 'Pre-screening',
  note: 'Exclude only who clearly falls outside the program (say, no ties with Italy). Anyone else passes: the sections judge the rest.',
  anonymous: false,
  questions: ['country', 'affiliation', 'role', 'background'],
  reasons: [{ key: 'no_italy', label: 'No ties with Italy' }],
  reviewers: [],
};

const copy = (value) => JSON.parse(JSON.stringify(value));

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

// ── The setup ────────────────────────────────────────────────────────────────

/**
 * The setup as saved, or the default one. A setup saved before sections
 * existed ({ grid: { cv, answers }, weights }) becomes the two default
 * sections with its grid and weights, so its scores keep counting.
 */
async function getSettings() {
  const { rows } = await db.query(
    'select value, updated_at::text as version from app_settings where key = $1',
    [SETTINGS_KEY]
  );
  const saved = (rows[0] && rows[0].value) || {};
  // Which save this is: the page sends it back, so two admins editing the
  // setup at once cannot undo each other's changes without knowing.
  const version = (rows[0] && rows[0].version) || null;
  if (Array.isArray(saved.sections) && saved.sections.length) {
    return {
      formId: saved.formId || null,
      nameQuestion: saved.nameQuestion || null,
      sections: saved.sections.map((s) => ({ ...s, exclusions: s.exclusions || [] })),
      prescreen: prescreenOf(saved.prescreen, saved.formId || null),
      version,
    };
  }
  const sections = copy(DEFAULT_SECTIONS);
  sections.forEach((s) => {
    const grid = saved.grid && saved.grid[s.key];
    if (Array.isArray(grid) && grid.length) s.criteria = grid;
    const w = saved.weights && Number(saved.weights[s.key]);
    if (Number.isFinite(w) && w >= 0) s.weight = w;
  });
  return {
    formId: null,
    nameQuestion: 'name',
    sections,
    prescreen: prescreenOf(saved.prescreen, null),
    version,
  };
}

/**
 * The pre-screening as saved, every field there: the default one (off)
 * when never set. With a form, the default starts with no question.
 */
function prescreenOf(saved, formId) {
  const base = copy(DEFAULT_PRESCREEN);
  if (formId) base.questions = [];
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    enabled: saved.enabled === true,
    questions: Array.isArray(saved.questions) ? saved.questions : base.questions,
    reasons: Array.isArray(saved.reasons) ? saved.reasons : base.reasons,
    reviewers: Array.isArray(saved.reviewers) ? saved.reviewers : [],
  };
}

function slug(text, fallback = 'criterion') {
  return (
    String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || fallback
  );
}

/**
 * A list of criteria as the page sends them, checked. Keys stay as they were.
 * `before` holds the criteria saved until now (by key): one already there
 * keeps when it was added, a new one is added now. A review finished before a
 * criterion was added still counts in the summary (server: counted()).
 */
function cleanCriteria(where, list, { allowEmpty = false, before = new Map() } = {}) {
  if (!Array.isArray(list) || (!list.length && !allowEmpty))
    throw new HttpError(400, `${where}: the grid needs at least one criterion`);
  if (list.length > MAX_CRITERIA)
    throw new HttpError(400, `${where}: at most ${MAX_CRITERIA} criteria`);
  const seen = new Set();
  return list.map((c) => {
    const label = String((c && c.label) || '').trim();
    if (!label || label.length > 80)
      throw new HttpError(400, `${where}: each criterion needs a name (80 characters at most)`);
    const help = String((c && c.help) || '').trim();
    if (help.length > 300) throw new HttpError(400, `${label}: 300 characters at most`);
    const weight = Number(c && c.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10)
      throw new HttpError(400, `${label}: the weight goes from 0 to 10`);
    // A criterion keeps its key when renamed, so its scores stay with it.
    let key = c && typeof c.key === 'string' && KEY.test(c.key) ? c.key : slug(label);
    while (seen.has(key)) key = `${key.slice(0, 27)}_${seen.size}`;
    seen.add(key);
    const old = before.get(key);
    const addedAt = old ? old.addedAt || null : new Date().toISOString();
    return addedAt ? { key, label, help, weight, addedAt } : { key, label, help, weight };
  });
}

/**
 * The reasons to exclude someone a section offers (say "No ties with Italy"):
 * [{ key, label }]. Keys stay as they were, so a reason renamed keeps its
 * flags.
 */
function cleanExclusions(where, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, `${where}: the reasons to exclude are a list`);
  if (list.length > MAX_EXCLUSIONS)
    throw new HttpError(400, `${where}: at most ${MAX_EXCLUSIONS} reasons to exclude`);
  const seen = new Set();
  return list.map((r) => {
    const label = String((r && r.label) || '').trim();
    if (!label || label.length > 80)
      throw new HttpError(
        400,
        `${where}: each reason to exclude needs a text (80 characters at most)`
      );
    let key = r && typeof r.key === 'string' && KEY.test(r.key) ? r.key : slug(label, 'reason');
    while (seen.has(key)) key = `${key.slice(0, 27)}_${seen.size}`;
    seen.add(key);
    return { key, label };
  });
}

/** A code's prefix from a section's name: its initials, in capitals. */
function prefixOf(label) {
  const letters = String(label || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  return letters || 'S';
}

/**
 * The sections as the page sends them, checked against the questions of the
 * source (`catalog`) and the reviewers. A section keeps its key when renamed,
 * so its scores and codes stay with it.
 */
function cleanSections(list, catalog, reviewerIds, previous = []) {
  if (!Array.isArray(list) || !list.length)
    throw new HttpError(400, 'The selection needs at least one section');
  if (list.length > MAX_SECTIONS) throw new HttpError(400, `At most ${MAX_SECTIONS} sections`);
  const known = new Set(catalog.map((q) => q.id));
  const keys = new Set();
  return list.map((raw) => {
    const s = raw || {};
    const label = String(s.label || '').trim();
    if (!label || label.length > 40)
      throw new HttpError(400, 'Each section needs a name (40 characters at most)');
    let key = typeof s.key === 'string' && KEY.test(s.key) ? s.key : slug(label, 'section');
    if (key === PRESCREEN) key = `${PRESCREEN}_1`;
    while (keys.has(key)) key = `${key.slice(0, 27)}_${keys.size}`;
    keys.add(key);
    const was = previous.find((p) => p.key === key) || {};
    const byKey = (grid) => new Map((Array.isArray(grid) ? grid : []).map((c) => [c.key, c]));
    const prefix = /^[A-Z]{1,4}$/.test(String(s.prefix || '').toUpperCase())
      ? String(s.prefix).toUpperCase()
      : prefixOf(label);
    const note = String(s.note || '').trim();
    if (note.length > MAX_NOTE)
      throw new HttpError(
        400,
        `${label}: the note for the reviewers is ${MAX_NOTE} characters at most`
      );
    const weight = Number(s.weight === undefined ? 1 : s.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10)
      throw new HttpError(400, `${label}: the weight of a section goes from 0 to 10`);
    const questions = [];
    (Array.isArray(s.questions) ? s.questions : []).forEach((id) => {
      if (!QUESTION.test(String(id)) || !known.has(id))
        throw new HttpError(400, `${label}: a question is no longer in the form`);
      if (!questions.includes(id)) questions.push(id);
    });
    if (!questions.length) throw new HttpError(400, `${label}: pick at least one question`);
    const gridMode = s.gridMode === 'question' ? 'question' : 'section';
    let criteria = [];
    const questionGrids = {};
    if (gridMode === 'section') {
      criteria = cleanCriteria(label, s.criteria, { before: byKey(was.criteria) });
    } else {
      const given = s.questionGrids && typeof s.questionGrids === 'object' ? s.questionGrids : {};
      const wasGrids = was.questionGrids || {};
      questions.forEach((id) => {
        const grid = cleanCriteria(`${label}, ${id}`, given[id] || [], {
          allowEmpty: true,
          before: byKey(wasGrids[id]),
        });
        if (grid.length) questionGrids[id] = grid;
      });
      if (!Object.keys(questionGrids).length)
        throw new HttpError(400, `${label}: give at least one question a criterion to score`);
    }
    const reviewers = [
      ...new Set((Array.isArray(s.reviewers) ? s.reviewers : []).map(String)),
    ].filter((id) => reviewerIds.has(id));
    return {
      key,
      label,
      prefix,
      note,
      anonymous: s.anonymous === true,
      weight,
      reviewers,
      gridMode,
      questions,
      criteria,
      questionGrids,
      exclusions: cleanExclusions(label, s.exclusions),
    };
  });
}

/**
 * The pre-screening as the page sends it, checked: { enabled, note,
 * anonymous, questions, reasons, reviewers }. Switched on, it needs a
 * question to show and a reason to exclude. A question gone from the form
 * (`lenient`, when the form changed and the page sent no pre-screening) is
 * left out rather than refused.
 */
function cleanPrescreen(raw, catalog, reviewerIds, { lenient = false } = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const known = new Set(catalog.map((q) => q.id));
  const note = String(p.note || '').trim();
  if (note.length > MAX_NOTE)
    throw new HttpError(400, `Pre-screening: the note is ${MAX_NOTE} characters at most`);
  const questions = [];
  (Array.isArray(p.questions) ? p.questions : []).forEach((id) => {
    if (!QUESTION.test(String(id)) || !known.has(id)) {
      if (lenient) return;
      throw new HttpError(400, 'Pre-screening: a question is no longer in the form');
    }
    if (!questions.includes(id)) questions.push(id);
  });
  const reasons = cleanExclusions('Pre-screening', p.reasons);
  const enabled = p.enabled === true && !(lenient && !questions.length);
  if (enabled && !questions.length)
    throw new HttpError(400, 'Pre-screening: pick at least one question to show');
  if (enabled && !reasons.length)
    throw new HttpError(400, 'Pre-screening: give at least one reason to exclude');
  return {
    enabled,
    label: DEFAULT_PRESCREEN.label,
    note,
    anonymous: p.anonymous === true,
    questions,
    reasons,
    reviewers: [...new Set((Array.isArray(p.reviewers) ? p.reviewers : []).map(String))].filter(
      (id) => reviewerIds.has(id)
    ),
  };
}

/**
 * Saves the setup: { formId?, nameQuestion?, sections, prescreen? }. A form may be
 * chosen only if this admin may read its answers, or if it feeds the mentee
 * applications on the board.
 */
async function saveSettings(user, body) {
  const b = body || {};
  const current = await getSettings();
  // Saved by someone else since this page loaded: refuse, rather than
  // silently putting back what they changed.
  if (b.version !== undefined && (b.version || null) !== current.version)
    throw new HttpError(
      409,
      'Someone else saved the setup in the meantime: reload the page to see their changes, then make yours again'
    );
  let formId = b.formId === undefined ? current.formId : b.formId || null;
  if (formId !== null && !UUID.test(String(formId))) throw new HttpError(400, 'Unknown form');
  if (formId && formId !== current.formId) {
    const allowed = await forms.forReview(user);
    if (!allowed.some((f) => f.id === formId))
      throw new HttpError(403, 'You cannot read the answers to this form');
  }
  const catalog = await catalogOf(formId);
  if (!catalog) throw new HttpError(400, 'Unknown form');
  const reviewerIds = new Set((await reviewers()).map((r) => r.userId));
  const sections =
    b.sections === undefined && formId === current.formId
      ? current.sections
      : cleanSections(b.sections, catalog, reviewerIds, current.sections);
  let nameQuestion = b.nameQuestion === undefined ? current.nameQuestion : b.nameQuestion || null;
  if (nameQuestion && !catalog.some((q) => q.id === nameQuestion))
    throw new HttpError(400, 'The question with the name is not in the form');
  const prescreen =
    b.prescreen === undefined
      ? cleanPrescreen(current.prescreen, catalog, reviewerIds, { lenient: true })
      : cleanPrescreen(b.prescreen, catalog, reviewerIds);
  const next = { formId, nameQuestion, sections, prescreen };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, next]
  );
  await audit.record(user, 'review-settings', null, {
    form: Boolean(formId),
    sections: sections.length,
    prescreen: prescreen.enabled,
  });
  return getSettings();
}

/** The section with this key, or a 400. */
function sectionOf(settings, key) {
  const s = settings.sections.find((x) => x.key === key);
  if (!s) throw new HttpError(400, 'Unknown section');
  return s;
}

/** Whether a reviewer is given this section: none listed means everyone. */
function assigned(section, userId) {
  return !section.reviewers.length || section.reviewers.includes(userId);
}

function requireAssigned(section, user) {
  if (!assigned(section, user.id))
    throw new HttpError(403, 'This section is given to other reviewers');
}

/**
 * What a reviewer scores in a section, flat: [{ key, label, help, weight,
 * question? }]. With one grid per question, each criterion's key is
 * "question.criterion", so the scores of two questions never mix.
 */
function slots(section) {
  if (section.gridMode !== 'question') return section.criteria;
  const out = [];
  section.questions.forEach((q) => {
    (section.questionGrids[q] || []).forEach((c) => {
      out.push({ ...c, key: `${q}.${c.key}`, question: q });
    });
  });
  return out;
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

// ── The source: the questions and the applications ──────────────────────────

/** The questions of the source: [{ id, label, type }], or null for a form gone. */
async function catalogOf(formId) {
  if (!formId) return BOARD_QUESTIONS;
  return forms.questionsOf(formId);
}

/**
 * Everyone who applied: [{ key, answers: { question: text }, card }], `card`
 * as the board shows them (its status included) or null when they are not
 * on the board. From a form, the newest answer of each person counts; an
 * answer without an email is a person of its own.
 */
async function applicants(settings) {
  const board = await mentorship.applicants();
  if (!settings.formId) {
    return board.map((a) => ({ key: a.key, answers: a.record, card: a.card }));
  }
  const cards = new Map(board.map((a) => [a.key, a.card]));
  const seen = new Set();
  const out = [];
  (await forms.answerTexts(settings.formId)).forEach((r) => {
    const key = r.respondentKey || `response-${r.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, answers: r.texts, card: cards.get(key) || null, sentAt: r.submittedAt });
  });
  return out;
}

function nameOf(applicant, settings) {
  return (
    (applicant.card && applicant.card.name) ||
    String((settings.nameQuestion && applicant.answers[settings.nameQuestion]) || '').trim() ||
    '(no name)'
  );
}

// ── The applications under a code ────────────────────────────────────────────

function codeOf(key, section, length = 5) {
  const s = typeof section === 'string' ? DEFAULT_SECTIONS.find((x) => x.key === section) : section;
  const prefix = s ? s.prefix : 'S';
  const sectionKey = s ? s.key : section;
  return `${prefix}-${crm.pseudonym(`review:${sectionKey}:${key}`, length)}`;
}

/**
 * Each person's code in a section, never the same for two: the five letters
 * of codeOf(), or ten for the rare people whose five letters would clash
 * (31^5 codes: a clash is unlikely, not impossible). A code depends on the
 * person and the section only, so it stays the same as people come and go;
 * the scores are kept under the person, never under the code.
 */
function codesOf(keys, section) {
  const short = new Map(keys.map((k) => [k, codeOf(k, section)]));
  const count = new Map();
  short.forEach((c) => count.set(c, (count.get(c) || 0) + 1));
  const out = new Map();
  short.forEach((c, k) => out.set(k, count.get(c) > 1 ? codeOf(k, section, 10) : c));
  return out;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text without what would say who wrote it: emails, links, handles, phone
 * numbers, the person's own name, and the email or link they gave elsewhere
 * in the form (identifying()), marked by its question; where they study or
 * work, their role, their country stay as written:
 * `who` is { name, phrases: [[text, mark]] }. It cannot catch everything (a
 * thesis title, a small town): it takes out what is mechanical, and the
 * reviewers are asked to step aside when they recognise someone anyway.
 */
function scrub(text, who = {}) {
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
  (who.phrases || [])
    .map(([phrase, mark]) => [String(phrase || '').trim(), mark])
    .filter(([phrase]) => phrase.length >= 4)
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([phrase, mark]) => {
      out = out.replace(new RegExp(escapeRe(phrase), 'gi'), mark);
    });
  String(who.name || '')
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

/**
 * The links in an answer: [{ text, url }], one per piece, `url` null when a
 * piece is no http(s) link (a typo, "javascript:…"): its text stays for the
 * reviewer to copy. Several links in one answer ("my site, my LinkedIn") are
 * split on commas, semicolons and spaces; "www.x.it" or "x.com/me" without
 * https:// are taken as https. `only`: the answer is nothing but links.
 */
function trimPiece(piece) {
  let t = piece.replace(/^[(<[]+/, '');
  // Punctuation after a link is the sentence's; a ")" is the link's when it
  // closes a "(" of its own.
  for (;;) {
    const last = t.slice(-1);
    const unbalanced = (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length;
    if ('.:>]'.includes(last) || (last === ')' && unbalanced)) t = t.slice(0, -1);
    else return t;
    if (!t) return t;
  }
}

function linksIn(raw) {
  const pieces = String(raw || '')
    .split(/[\s,;]+/)
    .map(trimPiece)
    .filter(Boolean);
  const looks = (t) =>
    /^[a-z][a-z0-9+.-]*:/i.test(t) ||
    /^www\./i.test(t) ||
    /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(t);
  const links = pieces.map((text) => ({
    text,
    url: looks(text)
      ? safeLink(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
      : null,
  }));
  return { links, only: links.length > 0 && links.every((l) => looks(l.text)) };
}

/** A question whose answer, found in other answers, is taken out of them. */
function identifying(q) {
  return q.type === 'email' || q.type === 'url';
}

/**
 * What a reviewer reads of one application in one section: [{ id, label,
 * text, url, links }]. In an anonymous section, the text is scrubbed and
 * links are not offered. Elsewhere the answer comes as written, with its
 * links (linksIn): an answer of links only (`onlyLinks`) is shown link by
 * link, each with its text; `url` is its first http(s) link.
 */
function shown(applicant, section, catalog, settings) {
  const byId = new Map(catalog.map((q) => [q.id, q]));
  const a = applicant.answers;
  const inSection = new Set(section.questions);
  const nameQ = settings.nameQuestion;
  const who = {
    name: nameQ && !inSection.has(nameQ) ? a[nameQ] || (applicant.card && applicant.card.name) : '',
    phrases: catalog
      .filter((q) => identifying(q) && q.id !== nameQ && !inSection.has(q.id))
      .map((q) => [a[q.id], `[${q.id}]`]),
  };
  const scored = new Set(slots(section).map((s) => s.question));
  return section.questions
    .map((id) => {
      const q = byId.get(id) || { id, label: id, type: 'short_text' };
      const raw = String(a[id] == null ? '' : a[id]);
      if (section.anonymous) {
        return { id, label: q.label, text: scrub(raw, who), url: null, links: [] };
      }
      const found = linksIn(raw);
      const onlyLinks = found.only;
      const links = onlyLinks ? found.links : found.links.filter((l) => l.url);
      const first = links.find((l) => l.url);
      return {
        id,
        label: q.label,
        text: raw,
        url: first ? first.url : null,
        links,
        onlyLinks,
      };
    })
    .filter((item) => item.text.trim() || scored.has(item.id));
}

/** Whether someone answered at least one of the section's questions. */
function answeredIn(applicant, section) {
  return section.questions.some((id) => {
    const v = applicant.answers[id];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}

const notDeclined = (a) => !a.card || a.card.status !== 'declined';

/** Each applicant under a code of this section, ordered by code. */
function coded(list, section) {
  const codes = codesOf(
    list.map((a) => a.key),
    section
  );
  return list
    .map((a) => ({ ...a, code: codes.get(a.key) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The applications reviewers score in a section: those not declined on the
 * board who answered something there (someone who did not apply to the
 * projects has nothing to score under them) and, with a pre-screening
 * (`screen`: person key -> its decision), passed it. Each with its code,
 * ordered by code (which is as good as shuffled, and the same for everyone).
 */
function poolOf(all, section, screen = null) {
  return coded(
    all.filter(
      (a) =>
        notDeclined(a) &&
        answeredIn(a, section) &&
        (!screen || (screen.get(a.key) && screen.get(a.key).decision === 'pass'))
    ),
    section
  );
}

/** The pre-screening's decisions: person key -> { decision, reasons, reviewer_name… }. */
async function decisions() {
  const { rows } = await db.query('select * from review_prescreen');
  return new Map(rows.map((r) => [r.person_key, r]));
}

/** The decisions that filter the sections, or null when there is no pre-screening. */
async function screenOf(settings) {
  return settings.prescreen && settings.prescreen.enabled ? decisions() : null;
}

async function pool(settings, section) {
  return poolOf(await applicants(settings), section, await screenOf(settings));
}

async function findByCode(settings, section, code) {
  const found = (await pool(settings, section)).find((a) => a.code === String(code || ''));
  if (!found) throw new HttpError(404, 'No such application (any more)');
  return found;
}

// ── The pre-screening ────────────────────────────────────────────────────────

/** The pre-screening as a section: what shown() and the codes need. */
function prescreenSection(p) {
  return {
    key: PRESCREEN,
    label: p.label,
    prefix: 'P',
    note: p.note,
    anonymous: p.anonymous,
    gridMode: 'section',
    questions: p.questions,
    criteria: [],
    questionGrids: {},
  };
}

/** Everyone to pre-screen: whoever is not declined on the board, under a P- code. */
function prescreenPoolOf(all, settings) {
  return coded(all.filter(notDeclined), prescreenSection(settings.prescreen));
}

function requirePrescreen(settings, user) {
  if (!settings.prescreen.enabled) throw new HttpError(400, 'There is no pre-screening');
  if (!assigned(settings.prescreen, user.id))
    throw new HttpError(403, 'The pre-screening is given to other reviewers');
}

/** Where an application is in the pre-screening: todo, passed, excluded. */
function screenState(row) {
  if (!row) return 'todo';
  return row.decision === 'pass' ? 'passed' : 'excluded';
}

function prescreenHead(p) {
  return {
    key: PRESCREEN,
    kind: PRESCREEN,
    label: p.label,
    note: p.note || '',
    anonymous: p.anonymous,
    exclusions: p.reasons,
  };
}

/** What a reviewer is told of a decision: who took it, when, for what. */
function decisionOf(row, p) {
  if (!row) return null;
  const labels = new Map(p.reasons.map((r) => [r.key, r.label]));
  return {
    decision: row.decision,
    reasons: (row.reasons || []).filter((k) => labels.has(k)),
    reasonLabels: (row.reasons || []).map((k) => labels.get(k) || k),
    by: row.reviewer_name,
    at: row.decided_at,
  };
}

/** The pre-screening's list: [{ code, state, by }], what is left to decide first. */
async function prescreenList(user) {
  const settings = await getSettings();
  requirePrescreen(settings, user);
  const all = await applicants(settings);
  const decided = await decisions();
  const apps = prescreenPoolOf(all, settings);
  const fresh = await freshness(user, all);
  await audit.record(user, 'review-list', null, { part: PRESCREEN, count: apps.length });
  return {
    part: PRESCREEN,
    section: prescreenHead(settings.prescreen),
    grid: [],
    scale: SCALE,
    items: firstToDo(
      apps.map((a) => {
        const row = decided.get(a.key);
        return {
          code: a.code,
          state: screenState(row),
          by: row ? row.reviewer_name : null,
          fresh: fresh(a.key),
        };
      })
    ),
  };
}

/** One application in the pre-screening, and its decision if taken. */
async function prescreenApplication(user, code) {
  const settings = await getSettings();
  requirePrescreen(settings, user);
  const found = prescreenPoolOf(await applicants(settings), settings).find(
    (a) => a.code === String(code || '')
  );
  if (!found) throw new HttpError(404, 'No such application (any more)');
  const catalog = (await catalogOf(settings.formId)) || [];
  const { rows } = await db.query('select * from review_prescreen where person_key = $1', [
    found.key,
  ]);
  await audit.record(user, 'review-list', found.key, { part: PRESCREEN, open: true });
  return {
    part: PRESCREEN,
    section: prescreenHead(settings.prescreen),
    code: found.code,
    grid: [],
    scale: SCALE,
    items: shown(found, prescreenSection(settings.prescreen), catalog, settings),
    decision: decisionOf(rows[0], settings.prescreen),
    state: screenState(rows[0]),
  };
}

/**
 * Decides on one application, for every reviewer: { code, decision: 'pass' |
 * 'exclude' | null, reasons? }. Excluding needs a reason among those offered;
 * null takes the decision back. The last decision stands, whoever took it.
 */
async function prescreen(user, body) {
  const b = body || {};
  const settings = await getSettings();
  requirePrescreen(settings, user);
  const found = prescreenPoolOf(await applicants(settings), settings).find(
    (a) => a.code === String(b.code || '')
  );
  if (!found) throw new HttpError(404, 'No such application (any more)');
  const decision = b.decision === undefined ? null : b.decision;
  if (decision !== null && !['pass', 'exclude'].includes(decision))
    throw new HttpError(400, 'A decision is pass or exclude');
  let reasons = [];
  if (decision === 'exclude') {
    const offered = settings.prescreen.reasons.map((r) => r.key);
    (Array.isArray(b.reasons) ? b.reasons : []).forEach((k) => {
      if (!offered.includes(k))
        throw new HttpError(
          409,
          'The reasons to exclude have changed since the page was opened: it shows the new ones now'
        );
      if (!reasons.includes(k)) reasons.push(k);
    });
    if (!reasons.length) throw new HttpError(400, 'Say why: tick a reason to exclude');
  }
  if (decision === null) {
    await db.query('delete from review_prescreen where person_key = $1', [found.key]);
  } else {
    await db.query(
      `insert into review_prescreen (person_key, decision, reasons, reviewer_id, reviewer_name, decided_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (person_key) do update set decision = excluded.decision, reasons = excluded.reasons,
         reviewer_id = excluded.reviewer_id, reviewer_name = excluded.reviewer_name, decided_at = now()`,
      [found.key, decision, JSON.stringify(reasons), user.id, user.name]
    );
  }
  await audit.record(user, 'review-prescreen', found.key, {
    decision: decision || 'undo',
    reasons: reasons.length,
  });
  const { rows } = await db.query('select * from review_prescreen where person_key = $1', [
    found.key,
  ]);
  return {
    state: screenState(rows[0]),
    decision: decisionOf(rows[0], settings.prescreen),
  };
}

/**
 * The admins' word on the pre-screening, from the summary: { key, decision:
 * 'pass' | null }. 'pass' brings someone excluded back into the sections;
 * null leaves them to be pre-screened again.
 */
async function readmit(user, key, decision) {
  const k = String(key || '');
  const all = await applicants(await getSettings());
  if (!all.some((a) => a.key === k)) throw new HttpError(404, 'No such applicant');
  if (decision === 'pass') {
    await db.query(
      `insert into review_prescreen (person_key, decision, reasons, reviewer_id, reviewer_name, decided_at)
       values ($1, 'pass', '[]', $2, $3, now())
       on conflict (person_key) do update set decision = 'pass', reasons = '[]',
         reviewer_id = excluded.reviewer_id, reviewer_name = excluded.reviewer_name, decided_at = now()`,
      [k, user.id, user.name]
    );
  } else if (decision === null || decision === undefined) {
    await db.query('delete from review_prescreen where person_key = $1', [k]);
  } else {
    throw new HttpError(400, 'An admin brings someone back (pass) or undoes the decision');
  }
  await audit.record(user, 'review-prescreen', k, { decision: decision || 'undo', admin: true });
  return { ok: true };
}

// ── What came in since the last visit ────────────────────────────────────────

/**
 * When each applicant came in: person key -> time. The first time the
 * selection sees someone is written down (a form's answer: when it was sent).
 */
async function arrivals(all) {
  if (!all.length) return new Map();
  const keys = all.map((a) => a.key);
  await db.query(
    `insert into review_arrivals (person_key, arrived_at)
     select k, coalesce(t, now()) from unnest($1::text[], $2::timestamptz[]) as x(k, t)
     on conflict (person_key) do nothing`,
    [keys, all.map((a) => a.sentAt || null)]
  );
  const { rows } = await db.query(
    'select person_key, arrived_at from review_arrivals where person_key = any($1::text[])',
    [keys]
  );
  return new Map(rows.map((r) => [r.person_key, new Date(r.arrived_at).getTime()]));
}

/**
 * A reviewer's visit (the landing page): returns since when "new" counts.
 * The first visit counts nothing as new; one after VISIT_GAP_MS away counts
 * from the visit before, and stays so while they keep working.
 */
async function visit(user) {
  const { rows } = await db.query(
    `insert into review_visits (reviewer_id) values ($1)
     on conflict (reviewer_id) do update set
       since = case when review_visits.last_at < now() - make_interval(secs => $2)
                    then review_visits.last_at else review_visits.since end,
       last_at = now()
     returning since`,
    [user.id, VISIT_GAP_MS / 1000]
  );
  return new Date(rows[0].since).getTime();
}

/** A test of whether a person key came in since my last visit (read only). */
async function freshness(user, all) {
  const { rows } = await db.query('select since from review_visits where reviewer_id = $1', [
    user.id,
  ]);
  if (!rows[0]) return () => false;
  const since = new Date(rows[0].since).getTime();
  const at = await arrivals(all);
  return (key) => (at.get(key) || 0) > since;
}

const TO_DO = ['todo', 'partial', 'update'];

/** A list with what is left to do first, then what is done; by code within each. */
function firstToDo(items) {
  const rank = (it) => (TO_DO.includes(it.state) ? 0 : 1);
  return items
    .map((it, i) => [it, i])
    .sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1])
    .map(([it]) => it);
}

function commentContext(key, part, reviewerId) {
  return `review:${key}:${part}:${reviewerId}`;
}

function ownReview(row, key, part) {
  if (!row) return null;
  return {
    scores: row.scores || {},
    conflict: row.conflict,
    flags: Array.isArray(row.flags) ? row.flags : [],
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

/**
 * Whether a review counts in the summary: not stepped aside, and every
 * criterion scored, or missing only criteria added after it was last saved
 * (a criterion added halfway leaves the reviews already done counting, on
 * the criteria they have, until their reviewer adds the new one).
 */
function counted(row, criteria) {
  if (!row || row.conflict) return false;
  const saved = new Date(row.updated_at).getTime();
  const scored = criteria.filter((c) => Number.isInteger(row.scores && row.scores[c.key]));
  if (!scored.length) return false;
  return criteria.every(
    (c) =>
      Number.isInteger(row.scores && row.scores[c.key]) ||
      (c.addedAt && new Date(c.addedAt).getTime() > saved)
  );
}

/** The flags of a row that the section still offers. */
function flagsOf(row, section) {
  const offered = new Set((section.exclusions || []).map((r) => r.key));
  return (Array.isArray(row && row.flags) ? row.flags : []).filter((k) => offered.has(k));
}

/**
 * Where a reviewer is with one application: todo, partial, done, conflict
 * (stepped aside), excluded (flagged with a reason to exclude), or update (it
 * was done, and a criterion has been added since).
 */
function stateOf(row, section) {
  if (!row) return 'todo';
  if (row.conflict) return 'conflict';
  if (flagsOf(row, section).length) return 'excluded';
  const grid = slots(section);
  if (complete(row.scores, grid)) return 'done';
  if (counted(row, grid)) return 'update';
  return 'partial';
}

const FINISHED = ['done', 'conflict', 'excluded'];

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

/** What a reviewer is told about a section. */
function sectionHead(s) {
  return {
    key: s.key,
    label: s.label,
    note: s.note || '',
    anonymous: s.anonymous,
    exclusions: s.exclusions || [],
  };
}

// ── What a reviewer sees ──────────────────────────────────────────────────────

/** What is read once to tell several reviewers how far they are. */
async function context() {
  const settings = await getSettings();
  const all = await applicants(settings);
  const decided = await decisions();
  const screen = settings.prescreen.enabled ? decided : null;
  return { settings, all, decided, screen };
}

/**
 * How far a reviewer is in the pre-screening (if given to them) and each of
 * their sections: [{ ...head, kind, total, done, waiting, keys }], `keys`
 * the people of each list (for what is new), `waiting` those of a section
 * still to be pre-screened.
 */
async function progress(userId, ctx) {
  const { settings, all, decided, screen } = ctx;
  const out = [];
  if (settings.prescreen.enabled && assigned(settings.prescreen, userId)) {
    const list = prescreenPoolOf(all, settings);
    out.push({
      ...prescreenHead(settings.prescreen),
      total: list.length,
      done: list.filter((a) => decided.has(a.key)).length,
      waiting: 0,
      keys: list.map((a) => a.key),
    });
  }
  const mine = settings.sections.filter((s) => assigned(s, userId));
  if (!mine.length) return out;
  const { rows } = await db.query(
    'select person_key, part, scores, conflict, flags, updated_at from review_scores where reviewer_id = $1',
    [userId]
  );
  mine.forEach((s) => {
    const given = new Map(rows.filter((r) => r.part === s.key).map((r) => [r.person_key, r]));
    const list = poolOf(all, s, screen);
    out.push({
      ...sectionHead(s),
      kind: 'section',
      total: list.length,
      done: list.filter((a) => FINISHED.includes(stateOf(given.get(a.key), s))).length,
      waiting: screen
        ? all.filter((a) => notDeclined(a) && answeredIn(a, s) && !screen.has(a.key)).length
        : 0,
      keys: list.map((a) => a.key),
    });
  });
  return out;
}

/**
 * The landing page: who I am here, how far I am in the pre-screening and
 * each of my sections, and what came in since my last visit: { news: {
 * count, since } }, `fresh` on each list.
 */
async function overview(user, role) {
  if (!role.reviewer)
    return { admin: role.admin, reviewer: false, sections: [], scale: SCALE, news: null };
  const ctx = await context();
  const lists = await progress(user.id, ctx);
  // Who is here now is written down before the visit: never new to it.
  const at = await arrivals(ctx.all);
  const since = await visit(user);
  const isNew = (key) => (at.get(key) || 0) > since;
  const news = new Set();
  const sections = lists.map(({ keys, ...s }) => {
    const fresh = keys.filter(isNew);
    fresh.forEach((k) => news.add(k));
    return { ...s, fresh: fresh.length };
  });
  return {
    admin: role.admin,
    reviewer: role.reviewer,
    sections,
    scale: SCALE,
    news: { count: news.size, since: new Date(since).toISOString() },
  };
}

/**
 * One section's list for a reviewer: [{ code, state: 'todo'|'partial'|…,
 * fresh }], what is left to do first. The pre-screening's is prescreenList().
 */
async function list(user, part) {
  if (part === PRESCREEN) return prescreenList(user);
  const settings = await getSettings();
  const section = sectionOf(settings, part);
  requireAssigned(section, user);
  const all = await applicants(settings);
  const apps = poolOf(all, section, await screenOf(settings));
  const fresh = await freshness(user, all);
  const { rows } = await db.query(
    'select person_key, scores, conflict, flags, updated_at from review_scores where reviewer_id = $1 and part = $2',
    [user.id, part]
  );
  const mine = new Map(rows.map((r) => [r.person_key, r]));
  const grid = slots(section);
  await audit.record(user, 'review-list', null, { part, count: apps.length });
  return {
    part,
    section: sectionHead(section),
    grid,
    scale: SCALE,
    items: firstToDo(
      apps.map((a) => ({
        code: a.code,
        state: stateOf(mine.get(a.key), section),
        fresh: fresh(a.key),
      }))
    ),
  };
}

/** One application in one section, anonymous if the section is, with my own review of it. */
async function application(user, part, code) {
  if (part === PRESCREEN) return prescreenApplication(user, code);
  const settings = await getSettings();
  const section = sectionOf(settings, part);
  requireAssigned(section, user);
  const found = await findByCode(settings, section, code);
  const catalog = (await catalogOf(settings.formId)) || [];
  const { rows } = await db.query(
    'select * from review_scores where person_key = $1 and part = $2 and reviewer_id = $3',
    [found.key, part, user.id]
  );
  await audit.record(user, 'review-list', found.key, { part, open: true });
  return {
    part,
    section: sectionHead(section),
    code: found.code,
    grid: slots(section),
    scale: SCALE,
    items: shown(found, section, catalog, settings),
    mine: ownReview(rows[0], found.key, part),
    state: stateOf(rows[0], section),
  };
}

/**
 * Saves my review of one application: { part, code, scores: { criterion: 1..5 },
 * conflict?, comment?, flags? }. A review may be saved half done; it counts
 * in the summary once every criterion has a score. Stepping aside
 * (`conflict`) drops the scores. `flags`: the section's reasons to exclude
 * the person that apply. Scores of criteria taken out of the grid since are
 * kept as they were, so a criterion put back finds them again. Saving the
 * same review twice (two tabs, a retry) is harmless: the last one stands.
 */
async function score(user, body) {
  const b = body || {};
  const settings = await getSettings();
  const section = sectionOf(settings, b.part);
  requireAssigned(section, user);
  const found = await findByCode(settings, section, b.code);
  const criteria = slots(section);
  const conflict = b.conflict === true;
  const scores = {};
  const { rows: before } = await db.query(
    'select scores from review_scores where person_key = $1 and part = $2 and reviewer_id = $3',
    [found.key, b.part, user.id]
  );
  if (!conflict && before[0]) {
    // What was scored on criteria no longer in the grid stays.
    Object.entries(before[0].scores || {}).forEach(([k, v]) => {
      if (!criteria.some((c) => c.key === k)) scores[k] = v;
    });
  }
  if (!conflict) {
    const given = b.scores && typeof b.scores === 'object' ? b.scores : {};
    for (const [k, v] of Object.entries(given)) {
      if (v === null || v === undefined || v === '') continue;
      if (!criteria.some((c) => c.key === k))
        throw new HttpError(
          409,
          'The grid of this section has changed since the page was opened: it shows the new one now'
        );
      const n = Number(v);
      if (!Number.isInteger(n) || n < SCALE.min || n > SCALE.max)
        throw new HttpError(400, `Scores go from ${SCALE.min} to ${SCALE.max}`);
      scores[k] = n;
    }
  }
  const comment = String(b.comment || '').trim();
  if (comment.length > MAX_COMMENT)
    throw new HttpError(400, `A comment can be at most ${MAX_COMMENT} characters`);
  const offered = (section.exclusions || []).map((r) => r.key);
  const flags = [];
  (Array.isArray(b.flags) ? b.flags : []).forEach((k) => {
    if (!offered.includes(k))
      throw new HttpError(
        409,
        'The reasons to exclude of this section have changed since the page was opened: it shows the new ones now'
      );
    if (!flags.includes(k)) flags.push(k);
  });
  await db.query(
    `insert into review_scores (person_key, part, reviewer_id, reviewer_name, scores, conflict, comment_encrypted, flags, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (person_key, part, reviewer_id) do update set reviewer_name = excluded.reviewer_name,
       scores = excluded.scores, conflict = excluded.conflict,
       comment_encrypted = excluded.comment_encrypted, flags = excluded.flags, updated_at = now()`,
    [
      found.key,
      b.part,
      user.id,
      user.name,
      scores,
      conflict,
      comment ? crm.encrypt(comment, commentContext(found.key, b.part, user.id)) : null,
      JSON.stringify(flags),
    ]
  );
  const row = { scores, conflict, flags, updated_at: new Date() };
  const state = stateOf(row, section);
  await audit.record(user, 'review-score', found.key, {
    part: b.part,
    complete: state === 'done',
    conflict,
    flags: flags.length,
  });
  return { state };
}

// ── What the admins see ──────────────────────────────────────────────────────

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * Everyone who applied, declined ones too, with every review: the names, the
 * board's status, each section's mean and spread over the complete reviews,
 * and the overall score (the sections' means, weighted). Sorted best first.
 */
async function summary(user, { record = true } = {}) {
  const settings = await getSettings();
  const catalog = (await catalogOf(settings.formId)) || [];
  const labels = new Map(catalog.map((q) => [q.id, q.label]));
  const all = await applicants(settings);
  const screen = await screenOf(settings);
  const { rows } = await db.query('select * from review_scores');
  const byPerson = new Map();
  rows.forEach((r) => {
    if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, []);
    byPerson.get(r.person_key).push(r);
  });
  const team = await reviewers();
  const current = new Set(team.map((r) => r.userId));
  // The codes as the reviewers see them, clashes resolved (codesOf).
  const codes = new Map(
    settings.sections.map((section) => [
      section.key,
      codesOf(
        all.map((a) => a.key),
        section
      ),
    ])
  );

  const people = all.map((a) => {
    const parts = {};
    const exclusions = [];
    settings.sections.forEach((section) => {
      const part = section.key;
      const criteria = slots(section);
      const reasons = new Map((section.exclusions || []).map((r) => [r.key, r.label]));
      const reviews = (byPerson.get(a.key) || [])
        .filter((r) => r.part === part)
        .map((r) => {
          const flags = flagsOf(r, section).map((k) => ({ key: k, label: reasons.get(k) }));
          flags.forEach((f) =>
            exclusions.push({
              part,
              section: section.label,
              reason: f.label,
              reviewer: r.reviewer_name,
            })
          );
          return {
            reviewer: r.reviewer_name,
            reviewerId: r.reviewer_id,
            stillReviewer: current.has(r.reviewer_id),
            scores: r.scores,
            total: r.conflict ? null : round(weighted(r.scores, criteria)),
            // Counts in the mean: complete, or done before a criterion was added.
            complete: counted(r, criteria),
            missing: r.conflict
              ? 0
              : criteria.filter((c) => !Number.isInteger(r.scores[c.key])).length,
            conflict: r.conflict,
            flags,
            comment: ownReview(r, a.key, part).comment,
            updatedAt: r.updated_at,
          };
        })
        .sort((x, y) => x.reviewer.localeCompare(y.reviewer, 'it'));
      const totals = reviews.filter((r) => r.complete).map((r) => weighted(r.scores, criteria));
      // The mean of each criterion over the complete reviews, for the table.
      const byCriterion = {};
      criteria.forEach((c) => {
        const vs = reviews
          .filter((r) => r.complete && Number.isInteger(r.scores[c.key]))
          .map((r) => r.scores[c.key]);
        byCriterion[c.key] = vs.length ? round(vs.reduce((s, v) => s + v, 0) / vs.length) : null;
      });
      parts[part] = {
        code: codes.get(part).get(a.key),
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
    settings.sections.forEach((s) => {
      if (parts[s.key].mean === null || !s.weight) return;
      sum += parts[s.key].mean * s.weight;
      weights += s.weight;
    });
    const scored = settings.sections.filter((s) => parts[s.key].mean !== null);
    const card = a.card || {};
    return {
      key: a.key,
      name: nameOf(a, settings),
      org: card.org || '',
      track: card.track || null,
      // null: not on the mentorship board, so no status to move.
      status: a.card ? card.status : null,
      overall: weights ? round(sum / weights) : null,
      // The overall stands on some sections only while the others have no score.
      partial: scored.length > 0 && scored.length < settings.sections.length,
      // Reasons to exclude given by some reviewer: [{ part, section, reason, reviewer }].
      exclusions,
      // The pre-screening's decision, when there is one: { decision, reasonLabels, by, at }.
      prescreen: screen ? decisionOf(screen.get(a.key), settings.prescreen) : null,
      parts,
    };
  });
  people.sort((x, y) => {
    // Those excluded at the pre-screening last of all: nobody scored them.
    const out = (p) => Number(Boolean(p.prescreen && p.prescreen.decision === 'exclude'));
    const pre = out(x) - out(y);
    if (pre) return pre;
    // Those flagged for exclusion after the others, to be looked at apart.
    const ex = Number(x.exclusions.length > 0) - Number(y.exclusions.length > 0);
    if (ex) return ex;
    if (x.overall === null && y.overall === null) return x.name.localeCompare(y.name, 'it');
    if (x.overall === null) return 1;
    if (y.overall === null) return -1;
    return y.overall - x.overall;
  });
  if (record) await audit.record(user, 'review-summary', null, { people: people.length });
  const names = new Map(team.map((r) => [r.userId, r.name]));
  return {
    sections: settings.sections.map((s) => ({
      key: s.key,
      label: s.label,
      weight: s.weight,
      anonymous: s.anonymous,
      reviewers: s.reviewers.map((id) => names.get(id)).filter(Boolean),
      exclusions: s.exclusions || [],
      grid: slots(s).map((c) => ({
        key: c.key,
        label: c.label,
        weight: c.weight,
        question: c.question || null,
        questionLabel: c.question ? labels.get(c.question) || c.question : null,
      })),
    })),
    scale: SCALE,
    source: settings.formId ? 'form' : 'board',
    prescreen: { enabled: settings.prescreen.enabled, reasons: settings.prescreen.reasons },
    // Every status, for the labels; `editable` the ones the selection sets.
    statuses: mentorship.STATUSES.mentee,
    editable: SELECTION_STATUSES,
    reviewers: team,
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
  if (!found) throw new HttpError(404, 'Not on the mentorship board: there is no status to change');
  if (!SELECTION_STATUSES.includes(status))
    throw new HttpError(
      400,
      'The selection moves people between Applied, Shortlisted, Interview and Rejected'
    );
  if (!SELECTION_STATUSES.includes(found.card.status))
    throw new HttpError(409, `${found.card.name} is past the selection: change it on the board`);
  return mentorship.update(user, key, 'mentee', { status });
}

/**
 * A first split of a source's questions into sections, for a form just
 * chosen: the links (a CV, a profile) in one, the long answers in another,
 * the rest (the name, the email, practical details) in none.
 */
function suggest(catalog, formId) {
  if (!formId) return copy(DEFAULT_SECTIONS);
  const links = catalog.filter((q) => q.type === 'url').map((q) => q.id);
  const texts = catalog
    .filter((q) => ['long_text', 'multi', 'single', 'ranking'].includes(q.type))
    .map((q) => q.id);
  const out = [];
  if (links.length) out.push({ ...copy(DEFAULT_SECTIONS[0]), questions: links });
  if (texts.length) out.push({ ...copy(DEFAULT_SECTIONS[1]), questions: texts });
  if (!out.length) {
    out.push({
      ...copy(DEFAULT_SECTIONS[1]),
      questions: catalog.filter((q) => q.type !== 'email').map((q) => q.id),
    });
  }
  return out;
}

/** The question most likely to hold the name: an id or label that says so. */
function guessName(catalog) {
  const q =
    catalog.find((x) => x.id === 'name') ||
    catalog.find((x) => x.type === 'short_text' && /\b(nome|name)\b/i.test(x.label));
  return q ? q.id : null;
}

/** The questions of a form, and a first split of them: for "Import the questions". */
async function questions(user, formId) {
  const id = formId || null;
  if (id) {
    const allowed = await forms.forReview(user);
    if (!allowed.some((f) => f.id === id)) throw new HttpError(404, 'No such form');
  }
  const catalog = await catalogOf(id);
  if (!catalog) throw new HttpError(404, 'No such form');
  return { formId: id, catalog, sections: suggest(catalog, id), nameQuestion: guessName(catalog) };
}

/** The setup page: the setup, the source's questions, the forms, the reviewers. */
async function settingsPage(user) {
  const [settings, list, people, choices] = await Promise.all([
    getSettings(),
    reviewers(),
    permissions.discordPeople(),
    forms.forReview(user),
  ]);
  const catalog = await catalogOf(settings.formId);
  const taken = new Set(list.map((r) => r.userId));
  // The form in use stays in the list even when this admin cannot pick it.
  if (settings.formId && !choices.some((f) => f.id === settings.formId)) {
    choices.unshift({
      id: settings.formId,
      title: '(the form in use)',
      status: '',
      responses: null,
    });
  }
  return {
    ...settings,
    catalog: catalog || [],
    formMissing: Boolean(settings.formId) && !catalog,
    forms: choices,
    defaults: { criteria: DEFAULT_GRID },
    scale: SCALE,
    limits: {
      sections: MAX_SECTIONS,
      criteria: MAX_CRITERIA,
      note: MAX_NOTE,
      exclusions: MAX_EXCLUSIONS,
    },
    defaultPrescreen: prescreenOf(null, settings.formId),
    reviewers: list,
    candidates: people.filter((p) => !taken.has(p.userId)),
  };
}

module.exports = {
  DEFAULT_GRID,
  DEFAULT_SECTIONS,
  SCALE,
  isReviewer,
  roleOf,
  requireAdmin,
  requireReviewer,
  getSettings,
  saveSettings,
  settingsPage,
  questions,
  reviewers,
  setReviewer,
  codeOf,
  codesOf,
  scrub,
  slots,
  overview,
  list,
  application,
  score,
  prescreen,
  readmit,
  summary,
  setStatus,
  context,
  progress,
  PRESCREEN,
};
