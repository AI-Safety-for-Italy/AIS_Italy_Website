// The interviews of the mentee selection, after the shortlist: for the admins
// of the selection (`review_admin`) and the interviewers they pick, on
// /app/review/interviews/.
//
// Who does what:
//   admins        hold `review_admin`. They pick the interviewers (a list of
//                 their own, apart from the reviewers'), give each a project's
//                 shortlist (all of it, or some of its mentees), set the grid
//                 the interviews are scored on and the questions to ask (each
//                 asked by choice, in every interview, or in some projects'),
//                 and read every interview.
//   interviewers  see the mentees of the shortlists given to them, with their
//                 name and application (an interview is not anonymous), and
//                 for each: notes, the transcript, the grid, a timer, and the
//                 questions they ask, in their order, with notes under each.
//                 They may prepare the questions once for a project (their
//                 plan: order, which, their own), and every interview of it
//                 starts from that; changed in one interview, it keeps its own.
//
// Who is interviewed is the matching's shortlist of the project
// (matching_shortlists, server/crm/matching.js): read here, never written, so
// whoever leaves the shortlist leaves the interviewer's list; what was written
// about them stays, for the admins.
//
// Nothing of the selection is changed: its scores, its setup, the matching
// and the board are only read. The interview's mean is shown next to the
// selection's overall in the summary (a column of its own, and a total with
// the interview weighted in, for the page to show), never folded into it.
//
// The setup lives in app_settings (key interview_settings):
//   { criteria: [{ key, label, help, weight }], weight,
//     questions: [{ id, text, help, required: 'none'|'all'|'projects', projects: [id] }],
//     duration: planned minutes, for the timer }
// Each interviewer's plan for a project in interview_plans.
// The interviews in interview_sessions; free text (notes, transcript, the
// notes under the questions and the interviewer's own questions, the comment)
// is encrypted, bound to the person, the project, the interviewer and the
// field.

const db = require('../db');
const { HttpError } = require('../http');
const access = require('../access');
const permissions = require('../permissions');
const crm = require('./crypto');
const audit = require('./audit');
const mentorship = require('./mentorship');
const matching = require('./matching');
const review = require('./review');
const forms = require('../forms/forms');

const SETTINGS_KEY = 'interview_settings';
const SCALE = { min: 1, max: 5 };
const MAX_CRITERIA = 12;
const MAX_QUESTIONS = 60;
const MAX_QUESTION = 300;
const MAX_HELP = 300;
const MAX_OWN = 30;
const MAX_PLAN = MAX_QUESTIONS + MAX_OWN;
const MAX_NOTES = 20000;
const MAX_ITEM_NOTE = 4000;
const MAX_TRANSCRIPT = 200000;
const MAX_COMMENT = 2000;
const MAX_WEIGHT = 10;
const DEFAULT_WEIGHT = 1;
// The planned length of an interview, in minutes, for the timer.
const DEFAULT_DURATION = 30;
const MIN_DURATION = 5;
const MAX_DURATION = 240;
// A timer left running is counted for a day at most.
const MAX_ELAPSED = 24 * 60 * 60;
const REQUIRED = ['none', 'all', 'projects'];
const KEY = /^[a-z0-9_]{1,30}$/;
const ITEM = /^(q|own)_[a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON = /^[A-Za-z0-9_-]{1,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_CRITERIA = [
  {
    key: 'motivation',
    label: 'Motivation',
    help: 'Why this programme and this project, and how much they care.',
    weight: 1,
  },
  {
    key: 'skills',
    label: 'Skills for the project',
    help: 'What they know already, and how quickly they would learn the rest.',
    weight: 1,
  },
  {
    key: 'communication',
    label: 'Communication',
    help: 'Clear, honest about what they do not know, asks good questions.',
    weight: 1,
  },
  {
    key: 'commitment',
    label: 'Time and commitment',
    help: 'The hours they can give, and whether the plan is realistic.',
    weight: 1,
  },
];

const DEFAULT_QUESTIONS = [
  {
    id: 'q_intro',
    text: 'Tell us about yourself and what brought you to AI safety.',
    help: '',
    required: 'all',
    projects: [],
  },
  {
    id: 'q_project',
    text: 'Why this project? What would you like to get out of it?',
    help: '',
    required: 'all',
    projects: [],
  },
  {
    id: 'q_time',
    text: 'How many hours a week can you give, and in which months?',
    help: '',
    required: 'none',
    projects: [],
  },
  {
    id: 'q_questions',
    text: 'Do you have questions for us?',
    help: '',
    required: 'none',
    projects: [],
  },
];

const copy = (value) => JSON.parse(JSON.stringify(value));

// ── Who may do what ──────────────────────────────────────────────────────────

async function isInterviewer(user) {
  if (!user || user.kind === 'admin') return false;
  const { rows } = await db.query('select 1 from interview_interviewers where user_id = $1', [
    user.id,
  ]);
  return rows.length > 0;
}

/**
 * Lets in an admin of the selection or an interviewer: { admin, interviewer }.
 * A recent sign-in is needed, as for the rest of the personal data; the
 * Discord roles are read again when older than five minutes (`fresh`:
 * always). A refusal is on the audit trail.
 */
async function roleOf(user, { fresh = false } = {}) {
  await access.requireRecentLogin(user);
  if (fresh) await permissions.refreshRoles(user);
  else await permissions.refreshIfStale(user);
  const perms = await permissions.forUser(user);
  const role = {
    admin: perms.includes('review_admin'),
    interviewer: await isInterviewer(user),
  };
  if (!role.admin && !role.interviewer) {
    await audit.record(user, 'denied', null, { needs: 'interviews' });
    throw new HttpError(403, 'Only the interviewers of the mentee selection can open this');
  }
  return role;
}

function requireAdmin(role) {
  if (!role.admin) throw new HttpError(403, 'Only the admins of the mentee selection can do this');
}

// ── The setup ────────────────────────────────────────────────────────────────

async function getSettings() {
  const { rows } = await db.query(
    'select value, updated_at::text as version from app_settings where key = $1',
    [SETTINGS_KEY]
  );
  const saved = (rows[0] && rows[0].value) || null;
  const version = (rows[0] && rows[0].version) || null;
  if (!saved) {
    return {
      criteria: copy(DEFAULT_CRITERIA),
      questions: copy(DEFAULT_QUESTIONS),
      weight: DEFAULT_WEIGHT,
      duration: DEFAULT_DURATION,
      version,
    };
  }
  const weight = Number(saved.weight);
  const duration = Number(saved.duration);
  return {
    criteria: Array.isArray(saved.criteria) ? saved.criteria : copy(DEFAULT_CRITERIA),
    questions: Array.isArray(saved.questions) ? saved.questions : [],
    weight: Number.isFinite(weight) ? weight : DEFAULT_WEIGHT,
    duration: Number.isInteger(duration) ? duration : DEFAULT_DURATION,
    version,
  };
}

function slug(text, fallback) {
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

/** The grid as the page sends it, checked. A criterion keeps its key when renamed. */
function cleanCriteria(list) {
  if (!Array.isArray(list) || !list.length)
    throw new HttpError(400, 'The grid needs at least one criterion');
  if (list.length > MAX_CRITERIA) throw new HttpError(400, `At most ${MAX_CRITERIA} criteria`);
  const seen = new Set();
  return list.map((c) => {
    const label = String((c && c.label) || '').trim();
    if (!label || label.length > 80)
      throw new HttpError(400, 'Each criterion needs a name (80 characters at most)');
    const help = String((c && c.help) || '').trim();
    if (help.length > MAX_HELP)
      throw new HttpError(400, `${label}: ${MAX_HELP} characters at most`);
    const weight = Number(c && c.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10)
      throw new HttpError(400, `${label}: the weight goes from 0 to 10`);
    let key = c && typeof c.key === 'string' && KEY.test(c.key) ? c.key : slug(label, 'criterion');
    while (seen.has(key)) key = `${key.slice(0, 27)}_${seen.size}`;
    seen.add(key);
    return { key, label, help, weight };
  });
}

/** The questions to ask, checked. A question keeps its id, so its notes stay with it. */
function cleanQuestions(list, projectIds) {
  if (!Array.isArray(list)) throw new HttpError(400, 'The questions are a list');
  if (list.length > MAX_QUESTIONS) throw new HttpError(400, `At most ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  return list.map((q) => {
    const text = String((q && q.text) || '').trim();
    if (!text || text.length > MAX_QUESTION)
      throw new HttpError(400, `Each question needs a text (${MAX_QUESTION} characters at most)`);
    const help = String((q && q.help) || '').trim();
    if (help.length > MAX_HELP)
      throw new HttpError(400, `A question's hint: ${MAX_HELP} characters at most`);
    const required = REQUIRED.includes(q && q.required) ? q.required : 'none';
    const projects =
      required === 'projects'
        ? [...new Set((Array.isArray(q.projects) ? q.projects : []).map(String))].filter((id) =>
            projectIds.has(id)
          )
        : [];
    let id = q && typeof q.id === 'string' && ITEM.test(q.id) && q.id.startsWith('q_') ? q.id : '';
    if (!id) id = `q_${slug(text, 'question').slice(0, 24)}`;
    while (seen.has(id)) id = `${id.slice(0, 36)}_${seen.size}`;
    seen.add(id);
    return {
      id,
      text,
      help,
      // Some projects, but none of them left: asked by choice.
      required: required === 'projects' && !projects.length ? 'none' : required,
      projects,
    };
  });
}

/** Saves the setup: { criteria?, questions?, weight?, duration?, version? }; 409 when stale. */
async function saveSettings(user, body) {
  const b = body || {};
  const current = await getSettings();
  if (b.version !== undefined && (b.version || null) !== current.version)
    throw new HttpError(
      409,
      'Someone else saved the interviews setup in the meantime: reload the page to see their changes, then make yours again'
    );
  const projectIds = new Set((await projectsOf()).map((p) => p.id));
  const criteria = b.criteria === undefined ? current.criteria : cleanCriteria(b.criteria);
  const questions =
    b.questions === undefined ? current.questions : cleanQuestions(b.questions, projectIds);
  const weight = b.weight === undefined ? current.weight : Number(b.weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT)
    throw new HttpError(400, `The interview's weight goes from 0 to ${MAX_WEIGHT}`);
  const duration = b.duration === undefined ? current.duration : Number(b.duration);
  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION)
    throw new HttpError(
      400,
      `The planned length goes from ${MIN_DURATION} to ${MAX_DURATION} minutes`
    );
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, { criteria, questions, weight, duration }]
  );
  await audit.record(user, 'review-interview-settings', null, {
    criteria: criteria.length,
    questions: questions.length,
  });
  return getSettings();
}

/** The questions asked in every interview for this project, in the setup's order. */
function requiredFor(settings, project) {
  return settings.questions.filter(
    (q) => q.required === 'all' || (q.required === 'projects' && q.projects.includes(project))
  );
}

// ── The projects and their shortlists (the matching's, read only) ──────────

/**
 * The projects of the matching's setup that have mentors: [{ id, label,
 * mentors: [{ key, name }] }], labels from the form's ranking question.
 */
async function projectsOf(roster = null) {
  const setup = await matching.getSettings();
  if (!setup.formId || !setup.question) return [];
  const options = (await forms.rankingOptions(setup.formId, setup.question)) || [];
  const r = roster || (await mentorship.roster());
  const mentorName = new Map(r.mentors.map((m) => [m.key, m.name]));
  return options
    .filter((o) => setup.projects[o.id] && (setup.projects[o.id].mentors || []).length)
    .map((o) => ({
      id: o.id,
      label: o.label,
      mentors: setup.projects[o.id].mentors.map((k) => ({
        key: k,
        name: mentorName.get(k) || '(no longer on the board)',
      })),
    }));
}

/** A project's shortlist as people: [{ key, name, org, status, track, stage, outcome }]. */
function shortlistOf(shortlists, project, mentees) {
  const list = shortlists[project] || {};
  return Object.entries(list)
    .map(([key, entry]) => {
      const c = mentees.get(key);
      return {
        key,
        name: c ? c.name : '(no longer on the board)',
        org: c ? c.org || '' : '',
        status: c ? c.status : null,
        track: c ? c.track : null,
        stage: (entry && entry.stage) || null,
        outcome: (entry && entry.outcome) || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

/** Who of the shortlist an assignment gives: all, or those listed. */
function givenOf(assignment, shortlist) {
  const keys = Array.isArray(assignment.mentee_keys) ? new Set(assignment.mentee_keys) : null;
  return keys ? shortlist.filter((p) => keys.has(p.key)) : shortlist;
}

// ── Interviewers and assignments ─────────────────────────────────────────────

async function interviewers() {
  const { rows } = await db.query(
    `select i.user_id, u.name, u.avatar_url, i.added_by_name, i.added_at
     from interview_interviewers i join app_users u on u.id = i.user_id order by lower(u.name)`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    addedBy: r.added_by_name,
    addedAt: r.added_at,
  }));
}

/** Adds (`add`) or removes (`remove`) an interviewer. Their interviews stay. */
async function setInterviewer(user, { add, remove } = {}) {
  const id = String(add || remove || '');
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid person');
  if (add) {
    const known = (await permissions.discordPeople()).some((p) => p.userId === id);
    if (!known) throw new HttpError(400, 'Only people who signed in with Discord can interview');
    await db.query(
      `insert into interview_interviewers (user_id, added_by_name) values ($1, $2)
       on conflict (user_id) do nothing`,
      [id, user.name]
    );
  } else {
    // Their shortlists are given back: nobody is left half-assigned.
    await db.query('delete from interview_assignments where interviewer_id = $1', [id]);
    await db.query('delete from interview_interviewers where user_id = $1', [id]);
  }
  await audit.record(user, 'review-interviewers', null, { action: add ? 'add' : 'remove' });
  return interviewers();
}

/**
 * Gives a project's shortlist to an interviewer: { project, interviewerId,
 * menteeKeys: null (all of it) | [key] }. Again for the same pair: changes
 * who of it. Returns the assignment.
 */
async function assign(user, { project, interviewerId, menteeKeys } = {}) {
  const id = String(project || '');
  if (!(await projectsOf()).some((p) => p.id === id))
    throw new HttpError(400, 'Not a project of the matching setup (with its mentors)');
  const who = String(interviewerId || '');
  if (!UUID.test(who) || !(await interviewers()).some((i) => i.userId === who))
    throw new HttpError(400, 'Add them to the interviewers first');
  let keys = null;
  if (menteeKeys !== null && menteeKeys !== undefined) {
    if (!Array.isArray(menteeKeys)) throw new HttpError(400, 'menteeKeys: a list, or null');
    const listed = (await matching.getShortlists())[id] || {};
    keys = [...new Set(menteeKeys.map(String))];
    if (keys.some((k) => !listed[k]))
      throw new HttpError(400, 'One of them is not on the project’s shortlist');
    if (!keys.length) throw new HttpError(400, 'Pick at least one mentee, or give all of them');
  }
  const { rows } = await db.query(
    `insert into interview_assignments (project, interviewer_id, mentee_keys, created_by_name)
     values ($1, $2, $3, $4)
     on conflict (project, interviewer_id) do update set mentee_keys = excluded.mentee_keys
     returning id`,
    [id, who, keys === null ? null : JSON.stringify(keys), user.name]
  );
  await audit.record(user, 'review-interview-assign', null, {
    project: id,
    action: 'assign',
    mentees: keys === null ? 'all' : keys.length,
  });
  return { id: rows[0].id, project: id, interviewerId: who, menteeKeys: keys };
}

/** Takes an assignment back. The interviews written under it stay. */
async function unassign(user, { id } = {}) {
  if (!UUID.test(String(id || ''))) throw new HttpError(400, 'Unknown assignment');
  const { rows } = await db.query(
    'delete from interview_assignments where id = $1 returning project',
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Unknown assignment');
  await audit.record(user, 'review-interview-assign', null, {
    project: rows[0].project,
    action: 'unassign',
  });
  return { ok: true };
}

// ── The interviews ───────────────────────────────────────────────────────────

const contextOf = (key, project, interviewerId, field) =>
  `interview:${key}:${project}:${interviewerId}:${field}`;

function open(row, field) {
  const blob = row && row[`${field}_encrypted`];
  if (!blob) return field === 'answers' ? null : '';
  const text = crm.decrypt(blob, contextOf(row.person_key, row.project, row.interviewer_id, field));
  if (field !== 'answers') return text;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** The grid's weighted mean of complete scores, or null. */
function meanOf(scores, criteria) {
  let sum = 0;
  let weights = 0;
  for (const c of criteria) {
    const v = scores && scores[c.key];
    if (!Number.isInteger(v)) return null;
    sum += v * c.weight;
    weights += c.weight;
  }
  return weights ? Math.round((sum / weights) * 100) / 100 : null;
}

/** 'todo' (nothing yet) | 'started' | 'done' | 'conflict'. */
function stateOf(row) {
  if (!row) return 'todo';
  if (row.conflict) return 'conflict';
  return row.done ? 'done' : 'started';
}

/**
 * The assignments of an interviewer (or all, for `userId` null), each with
 * the project and who of the shortlist it gives.
 */
async function assignmentsWithPeople(userId) {
  const [roster, shortlists] = await Promise.all([mentorship.roster(), matching.getShortlists()]);
  const projects = await projectsOf(roster);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const mentees = new Map(roster.mentees.map((c) => [c.key, c]));
  const { rows } = await db.query(
    `select a.*, u.name as interviewer_name from interview_assignments a
     join app_users u on u.id = a.interviewer_id
     where ($1::uuid is null or a.interviewer_id = $1) order by a.created_at`,
    [userId]
  );
  return {
    projects,
    shortlists,
    mentees,
    list: rows
      .filter((a) => byId.has(a.project))
      .map((a) => ({
        id: a.id,
        project: byId.get(a.project),
        interviewerId: a.interviewer_id,
        interviewerName: a.interviewer_name,
        menteeKeys: Array.isArray(a.mentee_keys) ? a.mentee_keys : null,
        people: givenOf(a, shortlistOf(shortlists, a.project, mentees)),
      })),
  };
}

async function sessionsOf(where, params) {
  const { rows } = await db.query(
    `select person_key, project, interviewer_id, interviewer_name, scores, conflict, done,
            held_on::text as held_on, updated_at, elapsed_seconds, running_since,
            notes_encrypted is not null as has_notes,
            transcript_encrypted is not null as has_transcript
     from interview_sessions ${where}`,
    params
  );
  return rows;
}

/** An interviewer's page: their shortlists, each mentee with how far along. */
async function overview(user, role) {
  const settings = await getSettings();
  const { list } = await assignmentsWithPeople(user.id);
  const rows = await sessionsOf('where interviewer_id = $1', [user.id]);
  const mine = new Map(rows.map((r) => [`${r.project}:${r.person_key}`, r]));
  const { rows: plans } = await db.query(
    'select project, duration from interview_plans where interviewer_id = $1',
    [user.id]
  );
  const prepared = new Set(plans.map((r) => r.project));
  const lengths = new Map(plans.map((r) => [r.project, r.duration]));
  await audit.record(user, 'review-interview-list', null, { assignments: list.length });
  return {
    admin: role.admin,
    interviewer: role.interviewer,
    duration: settings.duration,
    assignments: list.map((a) => ({
      id: a.id,
      project: a.project,
      // Whether they set their own order of the questions for it.
      prepared: prepared.has(a.project.id),
      duration: lengths.get(a.project.id) || settings.duration,
      people: a.people.map((p) => {
        const row = mine.get(`${a.project.id}:${p.key}`);
        return {
          ...p,
          state: stateOf(row),
          mean: row && !row.conflict ? meanOf(row.scores, settings.criteria) : null,
          heldOn: row ? row.held_on : null,
          seconds: row ? elapsedOf(row) : 0,
          updatedAt: row ? row.updated_at : null,
        };
      }),
    })),
  };
}

/** The timer's seconds: what was counted, and while it runs, since it started. */
function elapsedOf(row, now = Date.now()) {
  let n = Number(row.elapsed_seconds) || 0;
  if (row.running_since) n += Math.floor((now - new Date(row.running_since).getTime()) / 1000);
  return Math.max(0, Math.min(n, MAX_ELAPSED));
}

function timerOf(row) {
  return {
    seconds: row ? elapsedOf(row) : 0,
    running: Boolean(row && row.running_since),
  };
}

// ── The interviewer's plan for a project ────────────────────────────────────

/** Their order of the questions and their own questions for a project, or null. */
async function getPlan(userId, project) {
  const { rows } = await db.query(
    `select plan, own, duration, updated_at from interview_plans
     where interviewer_id = $1 and project = $2`,
    [userId, project]
  );
  return rows[0]
    ? {
        plan: rows[0].plan || [],
        own: rows[0].own || [],
        duration: rows[0].duration || null,
        updatedAt: rows[0].updated_at,
      }
    : null;
}

/** A planned length as sent: minutes, or null (the default). */
function cleanDuration(value) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DURATION || n > MAX_DURATION)
    throw new HttpError(
      400,
      `The planned length goes from ${MIN_DURATION} to ${MAX_DURATION} minutes`
    );
  return n;
}

/** An interviewer's own questions as the page sends them, checked. */
function cleanOwn(list) {
  if (!Array.isArray(list) || list.length > MAX_OWN)
    throw new HttpError(400, `At most ${MAX_OWN} questions of your own`);
  const seen = new Set();
  return list.map((q) => {
    const id = String((q && q.id) || '');
    if (!ITEM.test(id) || !id.startsWith('own_') || seen.has(id))
      throw new HttpError(400, 'Invalid question');
    seen.add(id);
    const t = String((q && q.text) || '').trim();
    if (!t || t.length > MAX_QUESTION)
      throw new HttpError(400, `Each question needs a text (${MAX_QUESTION} characters at most)`);
    return { id, text: t };
  });
}

/**
 * An order of the questions, checked: questions of the setup or their own
 * (or, `before`, ones already there and since taken out of the setup), with
 * those every interview of the project asks put in first when left out.
 */
function cleanPlan(settings, project, list, own, before = []) {
  if (!Array.isArray(list) || list.length > MAX_PLAN)
    throw new HttpError(400, 'The questions: a list');
  const bank = new Set(settings.questions.map((q) => q.id));
  const mine = new Set(own.map((q) => q.id));
  const was = new Set(Array.isArray(before) ? before : []);
  const ids = [...new Set(list.map(String))];
  if (ids.some((id) => !ITEM.test(id))) throw new HttpError(400, 'Invalid question');
  if (ids.some((id) => !(bank.has(id) || mine.has(id) || was.has(id))))
    throw new HttpError(400, 'Unknown question');
  const required = requiredFor(settings, project).map((q) => q.id);
  return [...required.filter((id) => !ids.includes(id)), ...ids];
}

async function requireProject(userId, project) {
  const { list } = await assignmentsWithPeople(userId);
  if (!list.some((a) => a.project.id === project))
    throw new HttpError(403, 'This project’s shortlist is not given to you');
}

/** The page to prepare the questions of a project: the setup's, theirs, in their order. */
async function planPage(user, project) {
  if (!project || String(project).length > 80) throw new HttpError(400, 'Unknown project');
  await requireProject(user.id, project);
  const settings = await getSettings();
  const saved = await getPlan(user.id, project);
  const p = (await projectsOf()).find((x) => x.id === project);
  const { rows } = await db.query(
    `select count(*)::int as n from interview_sessions
     where interviewer_id = $1 and project = $2 and plan is not null`,
    [user.id, project]
  );
  return {
    project: p,
    bank: settings.questions.map((q) => ({ id: q.id, text: q.text, help: q.help })),
    items: itemsOf(settings, project, saved ? saved.plan : [], { own: saved ? saved.own : [] }),
    own: saved ? saved.own : [],
    saved: Boolean(saved),
    // Their planned length for the project (null: the admins'), and the admins'.
    duration: saved ? saved.duration : null,
    defaultDuration: settings.duration,
    // Interviews whose questions they changed already: those keep their own.
    changed: rows[0].n,
    limits: {
      question: MAX_QUESTION,
      own: MAX_OWN,
      duration: [MIN_DURATION, MAX_DURATION],
    },
  };
}

/** Saves their plan for a project: { project, plan, own, duration? } (duration left out: kept). */
async function savePlan(user, body) {
  const b = body || {};
  const project = String(b.project || '');
  if (!project || project.length > 80) throw new HttpError(400, 'Unknown project');
  await requireProject(user.id, project);
  const settings = await getSettings();
  const own = cleanOwn(b.own === undefined ? [] : b.own);
  const plan = cleanPlan(settings, project, b.plan === undefined ? [] : b.plan, own);
  const before = await getPlan(user.id, project);
  const duration =
    b.duration === undefined ? (before ? before.duration : null) : cleanDuration(b.duration);
  await db.query(
    `insert into interview_plans (interviewer_id, project, plan, own, duration, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (interviewer_id, project) do update set
       plan = excluded.plan, own = excluded.own, duration = excluded.duration,
       updated_at = now()`,
    [user.id, project, JSON.stringify(plan), JSON.stringify(own), duration]
  );
  await audit.record(user, 'review-interview-plan', null, {
    project,
    questions: plan.length,
    own: own.length,
  });
  return { items: itemsOf(settings, project, plan, { own }), own, duration };
}

/** Whether this interviewer was given this mentee for this project. */
async function given(userId, project, key) {
  const { list } = await assignmentsWithPeople(userId);
  return list.some((a) => a.project.id === project && a.people.some((p) => p.key === key));
}

/**
 * The questions of an interview, in its order: the interviewer's plan, with
 * the questions every interview of the project asks put in when missing (at
 * the start, in the setup's order). Each: { id, text, help, required, own,
 * removed, note }.
 */
function itemsOf(settings, project, plan, answers) {
  const bank = new Map(settings.questions.map((q) => [q.id, q]));
  const own = new Map(((answers && answers.own) || []).map((q) => [q.id, q]));
  const notes = (answers && answers.notes) || {};
  const required = requiredFor(settings, project).map((q) => q.id);
  const order = Array.isArray(plan) ? plan.filter((id) => ITEM.test(String(id))) : [];
  const missing = required.filter((id) => !order.includes(id));
  return [...missing, ...order]
    .map((id) => {
      if (id.startsWith('own_')) {
        const q = own.get(id);
        if (!q) return null;
        return { id, text: q.text, help: '', required: false, own: true, note: notes[id] || '' };
      }
      const q = bank.get(id);
      // A question taken out of the setup: kept while it has a note.
      if (!q)
        return notes[id]
          ? {
              id,
              text: '(a question no longer in the setup)',
              help: '',
              required: false,
              own: false,
              removed: true,
              note: notes[id],
            }
          : null;
      return {
        id,
        text: q.text,
        help: q.help,
        required: required.includes(id),
        own: false,
        note: notes[id] || '',
      };
    })
    .filter(Boolean);
}

function checkTarget(project, key) {
  if (!project || String(project).length > 80) throw new HttpError(400, 'Unknown project');
  if (!PERSON.test(String(key || ''))) throw new HttpError(400, 'Invalid person');
}

/**
 * One interview, for its interviewer (`interviewerId` omitted) or, read only,
 * for an admin (any interviewer's). Returns the mentee's application, the
 * grid, the questions of the setup and the interview as written.
 */
async function session(user, role, { project, key, interviewerId } = {}) {
  checkTarget(project, key);
  let who = user.id;
  let readOnly = false;
  if (interviewerId && interviewerId !== user.id) {
    requireAdmin(role);
    if (!UUID.test(String(interviewerId))) throw new HttpError(400, 'Invalid person');
    who = interviewerId;
    readOnly = true;
  } else if (!(await given(user.id, project, key))) {
    // An admin may read the interviews already written, not open new ones.
    throw new HttpError(403, 'This mentee is not on a shortlist given to you');
  }
  const settings = await getSettings();
  const { rows } = await db.query(
    `select *, held_on::text as held_text from interview_sessions
     where person_key = $1 and project = $2 and interviewer_id = $3`,
    [key, project, who]
  );
  const row = rows[0] || null;
  if (readOnly && !row) throw new HttpError(404, 'No interview by them yet');
  const projects = await projectsOf();
  const p = projects.find((x) => x.id === project) || { id: project, label: project, mentors: [] };
  const roster = await mentorship.roster();
  const card = roster.mentees.find((c) => c.key === key) || null;
  const application = await review.applicationOf(key);
  const answers = row ? open(row, 'answers') : null;
  // Questions not changed in this interview yet: the interviewer's plan for the project.
  const ownOrder = Boolean(row && row.plan !== null);
  const prepared = await getPlan(who, project);
  const planDuration = prepared ? prepared.duration : null;
  const plan = ownOrder ? row.plan : prepared ? prepared.plan : [];
  const own = ownOrder ? (answers && answers.own) || [] : prepared ? prepared.own : [];
  // The planned length: this interview's, else their plan's, else the admins'.
  const sessionDuration = row && row.duration ? row.duration : null;
  await audit.record(user, 'review-interview-open', key, { project, readOnly });
  return {
    readOnly,
    project: p,
    person: {
      key,
      name: (card && card.name) || (application && application.name) || '(no name)',
      org: (card && card.org) || '',
      status: card ? card.status : null,
      track: card ? card.track : null,
    },
    application: application ? application.sections : [],
    criteria: settings.criteria,
    scale: SCALE,
    bank: settings.questions.map((q) => ({ id: q.id, text: q.text, help: q.help })),
    items: itemsOf(settings, project, plan, { own, notes: (answers && answers.notes) || {} }),
    own,
    // Which questions were asked: { id: seconds into the interview | true }.
    asked: (answers && answers.asked) || {},
    // 'interview': changed in this interview; 'plan': their plan for the
    // project; 'setup': neither, the required questions only.
    order: ownOrder ? 'interview' : prepared ? 'plan' : 'setup',
    duration: sessionDuration || planDuration || settings.duration,
    // Where it comes from, and what it falls back to without this interview's.
    durationFrom: sessionDuration ? 'interview' : planDuration ? 'plan' : 'setup',
    durationDefault: planDuration || settings.duration,
    timer: timerOf(row),
    interview: {
      interviewer: row ? row.interviewer_name : user.name,
      scores: row ? row.scores : {},
      conflict: row ? row.conflict : false,
      done: row ? row.done : false,
      heldOn: row ? row.held_text : null,
      notes: row ? open(row, 'notes') : '',
      transcript: row ? open(row, 'transcript') : '',
      comment: row ? open(row, 'comment') : '',
      mean: row ? meanOf(row.scores, settings.criteria) : null,
      updatedAt: row ? row.updated_at : null,
    },
    limits: {
      notes: MAX_NOTES,
      itemNote: MAX_ITEM_NOTE,
      transcript: MAX_TRANSCRIPT,
      comment: MAX_COMMENT,
      question: MAX_QUESTION,
      own: MAX_OWN,
      duration: [MIN_DURATION, MAX_DURATION],
    },
  };
}

function text(value, max, label) {
  const t = String(value == null ? '' : value);
  if (t.length > max) throw new HttpError(400, `${label}: ${max} characters at most`);
  return t;
}

/**
 * Saves an interview, all or part: { project, key, scores?, conflict?, done?,
 * heldOn?, notes?, transcript?, comment?, plan?, notesByItem?, own? }. What is
 * not sent stays as it was. Only the interviewer it was given to.
 */
async function save(user, body) {
  const b = body || {};
  const project = String(b.project || '');
  const key = String(b.key || '');
  checkTarget(project, key);
  if (!(await given(user.id, project, key)))
    throw new HttpError(403, 'This mentee is not on a shortlist given to you');
  const settings = await getSettings();
  const { rows } = await db.query(
    `select *, held_on::text as held_text from interview_sessions
     where person_key = $1 and project = $2 and interviewer_id = $3`,
    [key, project, user.id]
  );
  const row = rows[0] || null;
  const ctx = (field) => contextOf(key, project, user.id, field);
  const seal = (field, value) => (value ? crm.encrypt(value, ctx(field)) : null);

  let scores = row ? row.scores : {};
  if (b.scores !== undefined) {
    if (!b.scores || typeof b.scores !== 'object') throw new HttpError(400, 'Scores: an object');
    const known = new Set(settings.criteria.map((c) => c.key));
    // Scores of criteria taken out of the grid are kept, as in the selection.
    scores = { ...scores };
    Object.entries(b.scores).forEach(([k, v]) => {
      if (!known.has(k)) throw new HttpError(400, 'Unknown criterion');
      if (v === null) delete scores[k];
      else if (!Number.isInteger(v) || v < SCALE.min || v > SCALE.max)
        throw new HttpError(400, `Each score goes from ${SCALE.min} to ${SCALE.max}`);
      else scores[k] = v;
    });
  }
  const conflict = b.conflict === undefined ? Boolean(row && row.conflict) : b.conflict === true;
  const done = b.done === undefined ? Boolean(row && row.done) : b.done === true;
  if (done && !conflict && meanOf(scores, settings.criteria) === null)
    throw new HttpError(400, 'Score every criterion of the grid before marking it done');
  let heldOn = row ? row.held_text : null;
  if (b.heldOn !== undefined) {
    if (b.heldOn !== null && b.heldOn !== '' && !DATE.test(String(b.heldOn)))
      throw new HttpError(400, 'The date: YYYY-MM-DD');
    heldOn = b.heldOn || null;
  }

  const notes =
    b.notes === undefined
      ? row && row.notes_encrypted
      : seal('notes', text(b.notes, MAX_NOTES, 'Notes'));
  const transcript =
    b.transcript === undefined
      ? row && row.transcript_encrypted
      : seal('transcript', text(b.transcript, MAX_TRANSCRIPT, 'The transcript'));
  const comment =
    b.comment === undefined
      ? row && row.comment_encrypted
      : seal('comment', text(b.comment, MAX_COMMENT, 'The comment'));

  // The questions: their order, the interviewer's own, the notes under each,
  // which were asked. The first change to them starts from the interviewer's
  // plan for the project; until then the interview follows that plan.
  let plan = row ? row.plan : null;
  let answers = (row && open(row, 'answers')) || { own: [], notes: {}, asked: {} };
  let answersChanged = false;
  const touchesQuestions = ['plan', 'own', 'notesByItem', 'asked'].some((k) => b[k] !== undefined);
  if (plan === null && touchesQuestions) {
    const prepared = await getPlan(user.id, project);
    plan = prepared ? prepared.plan : [];
    if (prepared && prepared.own.length && !(answers.own || []).length) {
      answers = { ...answers, own: prepared.own };
      answersChanged = true;
    }
  }
  if (b.own !== undefined) {
    answers = { ...answers, own: cleanOwn(b.own) };
    answersChanged = true;
  }
  if (b.plan !== undefined) plan = cleanPlan(settings, project, b.plan, answers.own || [], plan);
  if (b.notesByItem !== undefined) {
    if (!b.notesByItem || typeof b.notesByItem !== 'object')
      throw new HttpError(400, 'The notes under the questions: an object');
    const next = { ...(answers.notes || {}) };
    Object.entries(b.notesByItem).forEach(([id, v]) => {
      if (!ITEM.test(id)) throw new HttpError(400, 'Invalid question');
      const t = text(v, MAX_ITEM_NOTE, 'A note');
      if (t.trim()) next[id] = t;
      else delete next[id];
    });
    if (Object.keys(next).length > MAX_PLAN) throw new HttpError(400, 'Too many notes');
    answers = { ...answers, notes: next };
    answersChanged = true;
  }
  if (b.asked !== undefined) {
    if (!b.asked || typeof b.asked !== 'object')
      throw new HttpError(400, 'The questions asked: an object');
    const next = { ...(answers.asked || {}) };
    Object.entries(b.asked).forEach(([id, v]) => {
      if (!ITEM.test(id)) throw new HttpError(400, 'Invalid question');
      if (v === false || v === null) delete next[id];
      else if (v === true || (Number.isInteger(v) && v >= 0 && v <= MAX_ELAPSED)) next[id] = v;
      else throw new HttpError(400, 'When a question was asked: seconds, or true');
    });
    if (Object.keys(next).length > MAX_PLAN) throw new HttpError(400, 'Too many questions');
    answers = { ...answers, asked: next };
    answersChanged = true;
  }

  // The timer: start, pause, reset; marking it done stops it.
  const now = Date.now();
  let elapsed = row ? Number(row.elapsed_seconds) || 0 : 0;
  let runningSince = row && row.running_since ? new Date(row.running_since) : null;
  const pause = () => {
    if (!runningSince) return;
    elapsed = Math.min(elapsed + Math.floor((now - runningSince.getTime()) / 1000), MAX_ELAPSED);
    runningSince = null;
  };
  if (b.timer !== undefined) {
    if (b.timer === 'start') runningSince = runningSince || new Date(now);
    else if (b.timer === 'pause') pause();
    else if (b.timer === 'reset') {
      elapsed = 0;
      runningSince = null;
    } else throw new HttpError(400, 'The timer: start, pause or reset');
  }
  if (done && !(row && row.done)) pause();
  const duration =
    b.duration === undefined ? (row && row.duration) || null : cleanDuration(b.duration);

  const answersBlob = answersChanged
    ? seal('answers', JSON.stringify(answers))
    : row && row.answers_encrypted;

  await db.query(
    `insert into interview_sessions
       (person_key, project, interviewer_id, interviewer_name, scores, plan, conflict, done,
        notes_encrypted, transcript_encrypted, answers_encrypted, comment_encrypted, held_on,
        elapsed_seconds, running_since, duration, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
     on conflict (person_key, project, interviewer_id) do update set
       interviewer_name = excluded.interviewer_name, scores = excluded.scores,
       plan = excluded.plan, conflict = excluded.conflict, done = excluded.done,
       notes_encrypted = excluded.notes_encrypted,
       transcript_encrypted = excluded.transcript_encrypted,
       answers_encrypted = excluded.answers_encrypted,
       comment_encrypted = excluded.comment_encrypted, held_on = excluded.held_on,
       elapsed_seconds = excluded.elapsed_seconds, running_since = excluded.running_since,
       duration = excluded.duration, updated_at = now()`,
    [
      key,
      project,
      user.id,
      user.name || '',
      JSON.stringify(scores),
      plan === null ? null : JSON.stringify(plan),
      conflict,
      done,
      notes || null,
      transcript || null,
      answersBlob || null,
      comment || null,
      heldOn,
      elapsed,
      runningSince ? runningSince.toISOString() : null,
      duration,
    ]
  );
  await audit.record(user, 'review-interview-save', key, {
    project,
    fields: Object.keys(b).filter((k) => !['project', 'key'].includes(k)),
  });
  return {
    state: stateOf({ conflict, done }),
    mean: conflict ? null : meanOf(scores, settings.criteria),
    timer: timerOf({ elapsed_seconds: elapsed, running_since: runningSince }),
    asked: answers.asked || {},
  };
}

// ── For the admins ───────────────────────────────────────────────────────────

/**
 * The admins' page: the setup, the interviewers, the projects with their
 * shortlist and who interviews whom, and how far each interview is.
 */
async function adminPage(user) {
  const [settings, team, people] = await Promise.all([
    getSettings(),
    interviewers(),
    permissions.discordPeople(),
  ]);
  const { projects, shortlists, mentees, list } = await assignmentsWithPeople(null);
  const rows = await sessionsOf('', []);
  const byTarget = new Map();
  rows.forEach((r) => {
    const k = `${r.project}:${r.person_key}`;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(r);
  });
  const taken = new Set(team.map((i) => i.userId));
  await audit.record(user, 'review-interview-list', null, {
    admin: true,
    projects: projects.length,
  });
  return {
    settings,
    defaults: { criteria: DEFAULT_CRITERIA, questions: DEFAULT_QUESTIONS },
    scale: SCALE,
    limits: {
      criteria: MAX_CRITERIA,
      questions: MAX_QUESTIONS,
      question: MAX_QUESTION,
      help: MAX_HELP,
      weight: MAX_WEIGHT,
      duration: [MIN_DURATION, MAX_DURATION],
    },
    interviewers: team,
    candidates: people.filter((p) => !taken.has(p.userId)),
    projects: projects.map((p) => {
      const shortlist = shortlistOf(shortlists, p.id, mentees);
      const assignments = list.filter((a) => a.project.id === p.id);
      return {
        ...p,
        assignments: assignments.map((a) => ({
          id: a.id,
          interviewerId: a.interviewerId,
          interviewerName: a.interviewerName,
          menteeKeys: a.menteeKeys,
        })),
        shortlist: shortlist.map((m) => ({
          ...m,
          interviewers: assignments
            .filter((a) => a.people.some((x) => x.key === m.key))
            .map((a) => ({ id: a.interviewerId, name: a.interviewerName })),
          interviews: (byTarget.get(`${p.id}:${m.key}`) || []).map((r) => ({
            interviewerId: r.interviewer_id,
            interviewer: r.interviewer_name,
            state: stateOf(r),
            mean: r.conflict ? null : meanOf(r.scores, settings.criteria),
            heldOn: r.held_on,
            seconds: elapsedOf(r),
            hasNotes: r.has_notes,
            hasTranscript: r.has_transcript,
            updatedAt: r.updated_at,
          })),
        })),
      };
    }),
  };
}

/**
 * The interviews' scores by mentee, for the summary: { weight, criteria,
 * people: { key: { mean, count, interviews: [{ project, interviewer, mean }] } } }.
 * `mean` over the interviews done (not stepped aside), null when none.
 */
async function scores(user) {
  const settings = await getSettings();
  const rows = await sessionsOf('where done and not conflict', []);
  const projects = new Map((await projectsOf()).map((p) => [p.id, p.label]));
  const people = {};
  rows.forEach((r) => {
    const mean = meanOf(r.scores, settings.criteria);
    if (mean === null) return;
    const entry = people[r.person_key] || { interviews: [] };
    entry.interviews.push({
      project: r.project,
      projectLabel: projects.get(r.project) || r.project,
      interviewer: r.interviewer_name,
      mean,
      scores: r.scores,
    });
    people[r.person_key] = entry;
  });
  Object.values(people).forEach((p) => {
    p.count = p.interviews.length;
    p.mean = Math.round((p.interviews.reduce((s, x) => s + x.mean, 0) / p.count) * 100) / 100;
  });
  await audit.record(user, 'review-interview-scores', null, { people: Object.keys(people).length });
  return { weight: settings.weight, criteria: settings.criteria, people };
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_CRITERIA,
  DEFAULT_QUESTIONS,
  isInterviewer,
  roleOf,
  requireAdmin,
  getSettings,
  saveSettings,
  requiredFor,
  projectsOf,
  interviewers,
  setInterviewer,
  assign,
  unassign,
  overview,
  planPage,
  savePlan,
  session,
  save,
  adminPage,
  scores,
  meanOf,
};
