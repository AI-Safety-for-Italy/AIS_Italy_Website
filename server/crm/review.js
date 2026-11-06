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
const SETTINGS_KEY = 'review_settings';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_]{1,30}$/;
const QUESTION = /^[a-z][a-z0-9_]{1,39}$/;

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
  },
  {
    key: 'answers',
    label: 'Answers',
    prefix: 'A',
    note: 'Names, affiliations, emails, links and phone numbers are taken out of the answers. If you recognise the person anyway, step aside.',
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
  },
];

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
  const { rows } = await db.query('select value from app_settings where key = $1', [SETTINGS_KEY]);
  const saved = (rows[0] && rows[0].value) || {};
  if (Array.isArray(saved.sections) && saved.sections.length) {
    return {
      formId: saved.formId || null,
      nameQuestion: saved.nameQuestion || null,
      sections: saved.sections,
    };
  }
  const sections = copy(DEFAULT_SECTIONS);
  sections.forEach((s) => {
    const grid = saved.grid && saved.grid[s.key];
    if (Array.isArray(grid) && grid.length) s.criteria = grid;
    const w = saved.weights && Number(saved.weights[s.key]);
    if (Number.isFinite(w) && w >= 0) s.weight = w;
  });
  return { formId: null, nameQuestion: 'name', sections };
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

/** A list of criteria as the page sends them, checked. Keys stay as they were. */
function cleanCriteria(where, list, { allowEmpty = false } = {}) {
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
    return { key, label, help, weight };
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
function cleanSections(list, catalog, reviewerIds) {
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
    while (keys.has(key)) key = `${key.slice(0, 27)}_${keys.size}`;
    keys.add(key);
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
      criteria = cleanCriteria(label, s.criteria);
    } else {
      const given = s.questionGrids && typeof s.questionGrids === 'object' ? s.questionGrids : {};
      questions.forEach((id) => {
        const grid = cleanCriteria(`${label}, ${id}`, given[id] || [], { allowEmpty: true });
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
    };
  });
}

/**
 * Saves the setup: { formId?, nameQuestion?, sections }. A form may be
 * chosen only if this admin may read its answers, or if it feeds the mentee
 * applications on the board.
 */
async function saveSettings(user, body) {
  const b = body || {};
  const current = await getSettings();
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
      : cleanSections(b.sections, catalog, reviewerIds);
  let nameQuestion = b.nameQuestion === undefined ? current.nameQuestion : b.nameQuestion || null;
  if (nameQuestion && !catalog.some((q) => q.id === nameQuestion))
    throw new HttpError(400, 'The question with the name is not in the form');
  const next = { formId, nameQuestion, sections };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, next]
  );
  await audit.record(user, 'review-settings', null, {
    form: Boolean(formId),
    sections: sections.length,
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
    out.push({ key, answers: r.texts, card: cards.get(key) || null });
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

function codeOf(key, section) {
  const s = typeof section === 'string' ? DEFAULT_SECTIONS.find((x) => x.key === section) : section;
  const prefix = s ? s.prefix : 'S';
  const sectionKey = s ? s.key : section;
  return `${prefix}-${crm.pseudonym(`review:${sectionKey}:${key}`)}`;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text without what would say who wrote it: emails, links, handles, phone
 * numbers, the person's own name, and the short answers they gave elsewhere
 * in the form (their role, their affiliation…), each marked by its question:
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

// What may say who someone is when it turns up in their other answers.
const IDENTIFYING = ['short_text', 'email', 'url'];

/**
 * What a reviewer reads of one application in one section: [{ id, label,
 * text, url }]. In an anonymous section, the text is scrubbed and links are
 * not offered; elsewhere a link answer is offered as a link, if http(s).
 */
function shown(applicant, section, catalog, settings) {
  const byId = new Map(catalog.map((q) => [q.id, q]));
  const a = applicant.answers;
  const inSection = new Set(section.questions);
  const nameQ = settings.nameQuestion;
  const who = {
    name: nameQ && !inSection.has(nameQ) ? a[nameQ] || (applicant.card && applicant.card.name) : '',
    phrases: catalog
      .filter((q) => IDENTIFYING.includes(q.type) && q.id !== nameQ && !inSection.has(q.id))
      .map((q) => [a[q.id], `[${q.id}]`]),
  };
  const scored = new Set(slots(section).map((s) => s.question));
  return section.questions
    .map((id) => {
      const q = byId.get(id) || { id, label: id, type: 'short_text' };
      const raw = String(a[id] == null ? '' : a[id]);
      const linkish = q.type === 'url' || /^https?:\/\/\S+$/i.test(raw.trim());
      if (linkish && !section.anonymous) {
        return { id, label: q.label, text: '', url: safeLink(raw) };
      }
      return { id, label: q.label, text: section.anonymous ? scrub(raw, who) : raw, url: null };
    })
    .filter((item) => item.url || item.text.trim() || scored.has(item.id));
}

/**
 * The applications reviewers score: those not declined on the board, each
 * with its code in the section, ordered by code (which is as good as
 * shuffled, and the same for everyone).
 */
async function pool(settings, section) {
  const all = await applicants(settings);
  return all
    .filter((a) => !a.card || a.card.status !== 'declined')
    .map((a) => ({ ...a, code: codeOf(a.key, section) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

async function findByCode(settings, section, code) {
  const found = (await pool(settings, section)).find((a) => a.code === String(code || ''));
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

/** What a reviewer is told about a section. */
function sectionHead(s) {
  return { key: s.key, label: s.label, note: s.note || '', anonymous: s.anonymous };
}

// ── What a reviewer sees ──────────────────────────────────────────────────────

/** The landing page: who I am here and how far I am in each of my sections. */
async function overview(user, role) {
  const settings = await getSettings();
  const sections = [];
  const mine = role.reviewer ? settings.sections.filter((s) => assigned(s, user.id)) : [];
  const all = mine.length ? await applicants(settings) : [];
  for (const s of mine) {
    const list = all.filter((a) => !a.card || a.card.status !== 'declined');
    const { rows } = await db.query(
      'select person_key, scores, conflict from review_scores where reviewer_id = $1 and part = $2',
      [user.id, s.key]
    );
    const given = new Map(rows.map((r) => [r.person_key, r]));
    const done = list.filter((a) => {
      const r = given.get(a.key);
      return r && (r.conflict || complete(r.scores, slots(s)));
    }).length;
    sections.push({ ...sectionHead(s), total: list.length, done });
  }
  return { admin: role.admin, reviewer: role.reviewer, sections, scale: SCALE };
}

/** One section's list for a reviewer: [{ code, state: 'todo'|'partial'|'done'|'conflict' }]. */
async function list(user, part) {
  const settings = await getSettings();
  const section = sectionOf(settings, part);
  requireAssigned(section, user);
  const apps = await pool(settings, section);
  const { rows } = await db.query(
    'select person_key, scores, conflict from review_scores where reviewer_id = $1 and part = $2',
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
    items: apps.map((a) => {
      const r = mine.get(a.key);
      let state = 'todo';
      if (r && r.conflict) state = 'conflict';
      else if (r && complete(r.scores, grid)) state = 'done';
      else if (r) state = 'partial';
      return { code: a.code, state };
    }),
  };
}

/** One application in one section, anonymous if the section is, with my own review of it. */
async function application(user, part, code) {
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
  const settings = await getSettings();
  const section = sectionOf(settings, b.part);
  requireAssigned(section, user);
  const found = await findByCode(settings, section, b.code);
  const criteria = slots(section);
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
 * board's status, each section's mean and spread over the complete reviews,
 * and the overall score (the sections' means, weighted). Sorted best first.
 */
async function summary(user) {
  const settings = await getSettings();
  const catalog = (await catalogOf(settings.formId)) || [];
  const labels = new Map(catalog.map((q) => [q.id, q.label]));
  const all = await applicants(settings);
  const { rows } = await db.query('select * from review_scores');
  const byPerson = new Map();
  rows.forEach((r) => {
    if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, []);
    byPerson.get(r.person_key).push(r);
  });
  const team = await reviewers();
  const current = new Set(team.map((r) => r.userId));

  const people = all.map((a) => {
    const parts = {};
    settings.sections.forEach((section) => {
      const part = section.key;
      const criteria = slots(section);
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
        code: codeOf(a.key, section),
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
  const names = new Map(team.map((r) => [r.userId, r.name]));
  return {
    sections: settings.sections.map((s) => ({
      key: s.key,
      label: s.label,
      weight: s.weight,
      anonymous: s.anonymous,
      reviewers: s.reviewers.map((id) => names.get(id)).filter(Boolean),
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
    limits: { sections: MAX_SECTIONS, criteria: MAX_CRITERIA, note: MAX_NOTE },
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
  scrub,
  slots,
  overview,
  list,
  application,
  score,
  summary,
  setStatus,
};
