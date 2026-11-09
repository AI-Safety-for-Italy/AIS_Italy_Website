// The matching of mentees with mentors, after the selection: for the admins of
// the selection (`review_admin`), on /app/review/matching/.
//
// Projects track. The mentee application form has a ranking question, "which
// projects interest you", with the projects as its options. The options are
// the form's own (an id and a label, "Title (Surname)"): the setup here says
// which mentor(s) run each one and how many places it has, so the form and its
// answers stay as they are. For each project, the mentees who ranked it come
// sorted by
//     adjusted = overall − penalty × (their place for it − 1)
// with `overall` the selection's score (review.summary) and the penalty the
// admins' (0: the score alone). A suggestion pairs everyone at once with a
// stable matching (mentee-proposing deferred acceptance): each mentee asks
// their projects in their order, each project keeps its best by adjusted score
// within its free places. Nothing is written until an admin confirms a pair,
// which is the board's own createMatch.
//
// Career orientation. No preferences, and the score only says who is in: the
// admins pair by fit, reading each mentee's answers next to the mentors'
// profiles. A first round is a shared draft (a proposed mentor and a note for
// each mentee, seen by every admin); once agreed, the proposals are confirmed.
//
// The setup lives in app_settings (key matching_settings):
//   { formId, question, penalty, projects: { optionId: { mentors: [key], places } } }
// The orientation draft too (key matching_drafts), one entry per mentee:
//   { menteeKey: { mentorKey|null, note (encrypted)|null, by, at } }

const db = require('../db');
const { HttpError } = require('../http');
const crm = require('./crypto');
const audit = require('./audit');
const mentorship = require('./mentorship');
const review = require('./review');
const forms = require('../forms/forms');

const SETTINGS_KEY = 'matching_settings';
const DRAFTS_KEY = 'matching_drafts';
const MAX_DRAFT_NOTE = 500;
const DEFAULT_PENALTY = 0.3;
const MAX_PENALTY = 4;
const MAX_PLACES = 50;
const MAX_MENTORS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POOLS = ['selected', 'all'];
// Mentors who can take mentees: the others are not offered.
const MENTOR_READY = ['selected', 'matched'];

// ── The setup ────────────────────────────────────────────────────────────────

async function getSettings() {
  const { rows } = await db.query('select value from app_settings where key = $1', [SETTINGS_KEY]);
  const saved = (rows[0] && rows[0].value) || {};
  const penalty = Number(saved.penalty);
  return {
    formId: saved.formId || null,
    question: saved.question || null,
    penalty: Number.isFinite(penalty) ? penalty : DEFAULT_PENALTY,
    projects: saved.projects && typeof saved.projects === 'object' ? saved.projects : {},
  };
}

/** The ranking questions of a form: [{ id, label }]. */
async function rankingQuestions(formId) {
  const catalog = (await forms.questionsOf(formId)) || [];
  return catalog.filter((q) => q.type === 'ranking').map((q) => ({ id: q.id, label: q.label }));
}

async function readableForm(user, formId) {
  const allowed = await forms.forReview(user);
  if (!allowed.some((f) => f.id === formId))
    throw new HttpError(403, 'You cannot read the answers to this form');
}

/** The ranking questions of a form this admin may read, to pick one. */
async function questions(user, formId) {
  if (!UUID.test(String(formId || ''))) throw new HttpError(404, 'No such form');
  await readableForm(user, formId);
  return rankingQuestions(formId);
}

async function saveSettings(user, body) {
  const b = body || {};
  const current = await getSettings();
  const formId = b.formId === undefined ? current.formId : b.formId || null;
  if (formId !== null && !UUID.test(String(formId))) throw new HttpError(400, 'Unknown form');
  if (formId && formId !== current.formId) await readableForm(user, formId);
  // Another form: its questions and options are others.
  const sameForm = formId === current.formId;
  let question = b.question === undefined ? (sameForm ? current.question : null) : b.question;
  question = question || null;
  let options = [];
  if (question) {
    options = formId ? await forms.rankingOptions(formId, question) : null;
    if (!options) throw new HttpError(400, 'That is not a ranking question of the form');
  }

  let penalty = b.penalty === undefined ? current.penalty : Number(b.penalty);
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > MAX_PENALTY)
    throw new HttpError(400, `The penalty goes from 0 to ${MAX_PENALTY}`);
  penalty = Math.round(penalty * 100) / 100;

  let projects = sameForm && question === current.question ? current.projects : {};
  if (b.projects !== undefined) {
    if (!b.projects || typeof b.projects !== 'object' || Array.isArray(b.projects))
      throw new HttpError(400, 'Projects: a list by option');
    const known = new Set(options.map((o) => o.id));
    const mentors = new Set((await mentorship.roster()).mentors.map((m) => m.key));
    projects = {};
    Object.entries(b.projects).forEach(([id, raw]) => {
      if (!known.has(id)) throw new HttpError(400, 'One of the projects is not an option');
      const r = raw || {};
      const keys = [...new Set(Array.isArray(r.mentors) ? r.mentors.map(String) : [])];
      if (keys.length > MAX_MENTORS)
        throw new HttpError(400, `At most ${MAX_MENTORS} mentors on a project`);
      if (keys.some((k) => !mentors.has(k)))
        throw new HttpError(400, 'One of the mentors is not on the board');
      let places =
        r.places === null || r.places === undefined || r.places === '' ? null : Number(r.places);
      if (places !== null && (!Number.isInteger(places) || places < 0 || places > MAX_PLACES))
        throw new HttpError(400, `Places: a whole number from 0 to ${MAX_PLACES}`);
      if (keys.length || places !== null) projects[id] = { mentors: keys, places };
    });
  }

  const next = { formId, question, penalty, projects };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, next]
  );
  await audit.record(user, 'review-matching-settings', null, {
    form: Boolean(formId),
    projects: Object.keys(projects).length,
  });
  return getSettings();
}

// ── Who runs which project ───────────────────────────────────────────────────

function plain(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * A first guess at the mentors of each option, from the surnames in its
 * label's last brackets: "Title (Rossi)", "Title (Rossi, Bianchi)", "(Rossi &
 * Bianchi)". A surname that fits no mentor, or more than one, is left to the
 * admins. { optionId: [mentorKey] }, options with no guess left out.
 */
function suggestMapping(options, mentors) {
  const words = mentors.map((m) => ({ key: m.key, words: plain(m.name).split(/[^a-z']+/) }));
  const out = {};
  options.forEach((o) => {
    const brackets = String(o.label || '').match(/\(([^()]*)\)/g);
    if (!brackets) return;
    const inside = plain(brackets[brackets.length - 1].slice(1, -1));
    const found = [];
    inside
      .split(/\s*(?:,|;|\/|&|\+|\be\b|\band\b)\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((name) => {
        const parts = name.split(/[^a-z']+/).filter(Boolean);
        if (!parts.length) return;
        const fits = words.filter((m) => parts.every((p) => m.words.includes(p)));
        if (fits.length === 1 && !found.includes(fits[0].key)) found.push(fits[0].key);
      });
    if (found.length) out[o.id] = found;
  });
  return out;
}

// ── The stable matching ──────────────────────────────────────────────────────

/** Better first: higher score (none last), then a higher place, then the key. */
function better(a, b) {
  if (a.score === null && b.score !== null) return 1;
  if (b.score === null && a.score !== null) return -1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.position !== b.position) return a.position - b.position;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Mentee-proposing deferred acceptance with places.
 *   projects  [{ id, free }]  free: places left (Infinity: no limit)
 *   mentees   [{ key, prefs: [{ project, score, position }] }]  prefs in their order
 * Returns { menteeKey: projectId } for those who got one. Stable: no mentee
 * and project would both rather have each other than what they got.
 */
function stableMatch(projects, mentees) {
  const free = new Map(projects.map((p) => [p.id, p.free]));
  const held = new Map(projects.map((p) => [p.id, []]));
  const next = new Map(mentees.map((m) => [m.key, 0]));
  const queue = mentees.slice();
  while (queue.length) {
    const m = queue.shift();
    const i = next.get(m.key);
    if (i >= m.prefs.length) continue;
    next.set(m.key, i + 1);
    const pref = m.prefs[i];
    const list = held.get(pref.project);
    if (!list || !(free.get(pref.project) > 0)) {
      queue.push(m);
      continue;
    }
    list.push({ key: m.key, score: pref.score, position: pref.position, mentee: m });
    list.sort(better);
    if (list.length > free.get(pref.project)) queue.push(list.pop().mentee);
  }
  const out = {};
  held.forEach((list, project) => {
    list.forEach((x) => {
      out[x.key] = project;
    });
  });
  return out;
}

// ── The orientation draft ────────────────────────────────────────────────────

const draftContext = (menteeKey) => `matching-draft:${menteeKey}`;

// How well a mentee fits each mentor, as the admins judge it reading both.
const AFFINITY = { strong: 2, ok: 1, no: -1 };
const AFFINITY_VALUES = new Set(Object.values(AFFINITY));

/** The draft: menteeKey -> { mentorKey, note, affinity, by, at }, notes opened. */
async function getDrafts() {
  const { rows } = await db.query('select value from app_settings where key = $1', [DRAFTS_KEY]);
  const saved = (rows[0] && rows[0].value) || {};
  const out = {};
  Object.entries(saved).forEach(([key, d]) => {
    out[key] = {
      mentorKey: d.mentorKey || null,
      note: d.note ? crm.decrypt(d.note, draftContext(key)) ?? '' : '',
      affinity: d.affinity && typeof d.affinity === 'object' ? d.affinity : {},
      by: d.by || '',
      at: d.at || null,
    };
  });
  return out;
}

async function dropDraft(menteeKey) {
  await db.query(`update app_settings set value = value - $2, updated_at = now() where key = $1`, [
    DRAFTS_KEY,
    menteeKey,
  ]);
}

async function writeDraft(user, menteeKey, { mentorKey, note, affinity }) {
  if (!mentorKey && !note && !Object.keys(affinity).length) return dropDraft(menteeKey);
  const entry = {
    mentorKey: mentorKey || null,
    note: note ? crm.encrypt(note, draftContext(menteeKey)) : null,
    affinity,
    by: user.name || '',
    at: new Date().toISOString(),
  };
  // One mentee's entry at a time, so two admins on two mentees do not clash.
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, jsonb_build_object($2::text, $3::jsonb), now())
     on conflict (key) do update
       set value = app_settings.value || jsonb_build_object($2::text, $3::jsonb), updated_at = now()`,
    [DRAFTS_KEY, menteeKey, JSON.stringify(entry)]
  );
}

const orientationMentor = (c) =>
  Boolean(c) && MENTOR_READY.includes(c.status) && c.track !== 'projects';

/**
 * The draft for a mentee on career orientation: the proposed mentor, a note,
 * and how well they fit each mentor (affinity: { mentorKey: 2 | 1 | -1 }, a
 * mentor left out not judged yet). What is not sent stays as it was. Nothing
 * on the board changes.
 */
async function saveDraft(user, { menteeKey, mentorKey, note, affinity } = {}) {
  const roster = await mentorship.roster();
  const mentee = roster.mentees.find((c) => c.key === menteeKey);
  if (!mentee || !(mentee.track === 'orientation' || mentee.track === 'both'))
    throw new HttpError(400, 'Not a mentee on career orientation');
  const mentors = new Map(roster.mentors.map((c) => [c.key, c]));
  const current = (await getDrafts())[menteeKey] || { mentorKey: null, note: '', affinity: {} };

  const nextMentor = mentorKey === undefined ? current.mentorKey : mentorKey || null;
  if (nextMentor && nextMentor !== current.mentorKey && !orientationMentor(mentors.get(nextMentor)))
    throw new HttpError(400, 'Not a selected mentor on career orientation');
  const text = note === undefined ? current.note : String(note == null ? '' : note).trim();
  if (text.length > MAX_DRAFT_NOTE)
    throw new HttpError(400, `A note can be at most ${MAX_DRAFT_NOTE} characters`);
  let marks = current.affinity;
  if (affinity !== undefined) {
    if (!affinity || typeof affinity !== 'object' || Array.isArray(affinity))
      throw new HttpError(400, 'Affinity: a value by mentor');
    marks = {};
    Object.entries(affinity).forEach(([k, v]) => {
      if (v === null || v === undefined) return;
      if (!AFFINITY_VALUES.has(v)) throw new HttpError(400, 'Affinity: strong, ok or no');
      if (!mentors.has(k)) throw new HttpError(400, 'One of the mentors is not on the board');
      marks[k] = v;
    });
  }
  await writeDraft(user, menteeKey, { mentorKey: nextMentor, note: text, affinity: marks });
  await audit.record(user, 'review-matching-draft', menteeKey, {
    mentor: Boolean(nextMentor),
    affinity: Object.keys(marks).length,
  });
  return (await getDrafts())[menteeKey] || null;
}

/**
 * The gaps of the orientation draft filled: each selected mentee with neither
 * a pair nor a proposal gets the mentor the stable matching gives them, by
 * affinity first and score second, within the places left. The admins then
 * read and change it. Returns how many were filled.
 */
async function fillDrafts(user) {
  const page = await view(user, { pool: 'selected' });
  const drafts = await getDrafts();
  for (const s of page.orientation.suggestion) {
    const d = drafts[s.menteeKey] || { note: '', affinity: {} };
    await writeDraft(user, s.menteeKey, {
      mentorKey: s.mentorKey,
      note: d.note,
      affinity: d.affinity,
    });
  }
  await audit.record(user, 'review-matching-draft', null, {
    filled: page.orientation.suggestion.length,
  });
  return { filled: page.orientation.suggestion.length };
}

/**
 * The orientation suggestion: mentee-proposing deferred acceptance, each
 * mentee asking the mentors they fit (strong before ok, never "no") and each
 * mentor keeping, within the places left, the best fit and then the best score.
 * Mentees already paired or proposed are left as they are.
 */
function orientationSuggestion(mentees, mentors) {
  const free = mentors.map((m) => ({
    id: m.key,
    free: m.capacity ? Math.max(0, m.capacity - m.taken - m.proposed) : Infinity,
  }));
  const proposers = [];
  mentees.forEach((p) => {
    if (p.matchedTo || p.status !== 'selected' || (p.draft && p.draft.mentorKey)) return;
    const marks = (p.draft && p.draft.affinity) || {};
    const prefs = mentors
      .filter((m) => marks[m.key] >= 1)
      .sort((a, b) => marks[b.key] - marks[a.key])
      .map((m, i) => ({
        project: m.key,
        position: i + 1,
        // A mentor prefers who fits them best, then the higher score.
        score: marks[m.key] * 10 + (p.overall || 0),
      }));
    if (prefs.length) proposers.push({ key: p.key, prefs });
  });
  const got = stableMatch(free, proposers);
  return Object.entries(got).map(([menteeKey, mentorKey]) => ({ menteeKey, mentorKey }));
}

// ── The page ─────────────────────────────────────────────────────────────────

function round(n) {
  return Math.round(n * 100) / 100;
}

function adjust(overall, position, penalty) {
  return overall === null || overall === undefined
    ? null
    : round(overall - penalty * (position - 1));
}

/**
 * Everything the matching page shows. `pool`: who the suggestion is made for,
 * the mentees selected on the board ('selected') or everyone not rejected
 * ('all'), to see it take shape before the selection ends.
 */
async function view(user, { pool = 'selected' } = {}) {
  if (!POOLS.includes(pool)) throw new HttpError(400, 'Unknown pool');
  const settings = await getSettings();
  const [scores, roster, choices] = await Promise.all([
    review.summary(user, { record: false }),
    mentorship.roster(),
    forms.forReview(user),
  ]);
  const ranking =
    settings.formId && settings.question
      ? await forms.rankingAnswers(settings.formId, settings.question)
      : null;
  const questions = settings.formId ? await rankingQuestions(settings.formId) : [];
  const drafts = await getDrafts();

  const scored = new Map(scores.people.map((p) => [p.key, p]));
  const mentees = new Map(roster.mentees.map((c) => [c.key, c]));
  const mentors = new Map(roster.mentors.map((c) => [c.key, c]));
  const pairOf = new Map(roster.matches.map((m) => [m.menteeKey, m]));
  const taken = new Map();
  roster.matches.forEach((m) =>
    [m.mentorKey, ...m.coMentors].forEach((k) => taken.set(k, (taken.get(k) || 0) + 1))
  );
  const mentorBrief = (key) => {
    const c = mentors.get(key);
    return c
      ? {
          key,
          name: c.name,
          status: c.status,
          track: c.track,
          capacity: c.capacity,
          // 'site' (their entry's places) or 'application' (their answer, in capacityText).
          capacityFrom: c.capacityFrom,
          capacityText: c.capacityText,
          taken: taken.get(key) || 0,
          ready: MENTOR_READY.includes(c.status),
        }
      : { key, name: '(no longer on the board)', missing: true, taken: 0, ready: false };
  };
  const person = (key) => {
    const s = scored.get(key);
    const c = mentees.get(key);
    const pair = pairOf.get(key);
    return {
      key,
      name: (c && c.name) || (s && s.name) || '(no name)',
      org: (c && c.org) || (s && s.org) || '',
      onBoard: Boolean(c),
      status: c ? c.status : null,
      track: c ? c.track : null,
      overall: s ? s.overall : null,
      partial: Boolean(s && s.partial),
      matchedTo: pair
        ? [pair.mentorKey, ...pair.coMentors].map((k) => mentorBrief(k).name).join(' & ')
        : null,
      matchedTrack: pair ? pair.track : null,
    };
  };

  // ── Projects ──
  let projects = [];
  let suggestion = [];
  let noKey = 0;
  if (ranking) {
    const mapped = settings.projects;
    const guesses = suggestMapping(
      ranking.options,
      roster.mentors.filter((m) => MENTOR_READY.includes(m.status) || m.status === 'applied')
    );
    const answers = ranking.answers.filter((a) => {
      if (!a.respondentKey) noKey += 1;
      return a.respondentKey;
    });
    projects = ranking.options.map((o) => {
      const setup = mapped[o.id] || null;
      const keys = setup ? setup.mentors : [];
      const team = keys.map(mentorBrief);
      // Co-mentors share the project and its mentees: its places are not the
      // sum of theirs. Without a number set here, the most any of them said.
      const said = team.filter((m) => m.capacity);
      const top = said.length ? said.reduce((a, b) => (b.capacity > a.capacity ? b : a)) : null;
      const placesSet = Boolean(setup && setup.places !== null);
      const places = placesSet ? setup.places : top ? top.capacity : null;
      const pairs = roster.matches.filter(
        (m) => m.track === 'projects' && [m.mentorKey, ...m.coMentors].some((k) => keys.includes(k))
      );
      const candidates = [];
      answers.forEach((a) => {
        const at = a.ids.indexOf(o.id);
        if (at === -1) return;
        const p = person(a.respondentKey);
        if (p.status === 'declined' || p.track === 'orientation') return;
        candidates.push({
          ...p,
          position: at + 1,
          of: a.ids.length,
          adjusted: adjust(p.overall, at + 1, settings.penalty),
          here: pairs.some((m) => m.menteeKey === a.respondentKey),
        });
      });
      candidates.sort((x, y) => better({ ...x, score: x.adjusted }, { ...y, score: y.adjusted }));
      return {
        id: o.id,
        label: o.label,
        mapped: Boolean(setup && keys.length),
        guess: setup ? null : guesses[o.id] || null,
        mentors: team,
        // Every mentor of the project selected: the pair can be made.
        ready: team.length > 0 && team.every((m) => m.ready),
        places,
        placesSet,
        // Where the number comes from: 'setup' (set here), 'site', 'application', or null.
        placesFrom: placesSet ? 'setup' : top ? top.capacityFrom : null,
        boardPlaces: top ? top.capacity : null,
        taken: pairs.length,
        candidates,
      };
    });

    // The suggestion: mapped projects, their free places, the pool not yet paired.
    const open = projects.filter((p) => p.mapped);
    const free = open.map((p) => ({
      id: p.id,
      free: p.places === null ? Infinity : Math.max(0, p.places - p.taken),
    }));
    const openIds = new Set(open.map((p) => p.id));
    const inPool = (p) =>
      p.onBoard &&
      !p.matchedTo &&
      p.overall !== null &&
      (pool === 'all' ? p.status !== 'declined' : p.status === 'selected');
    const proposers = [];
    answers.forEach((a) => {
      const p = person(a.respondentKey);
      if (!inPool(p) || p.track === 'orientation') return;
      const prefs = a.ids
        .map((id, i) => ({ project: id, position: i + 1 }))
        .filter((x) => openIds.has(x.project))
        .map((x) => ({ ...x, score: adjust(p.overall, x.position, settings.penalty) }));
      if (prefs.length) proposers.push({ key: a.respondentKey, prefs });
    });
    const got = stableMatch(free, proposers);
    const byId = new Map(open.map((p) => [p.id, p]));
    suggestion = Object.entries(got).map(([key, projectId]) => {
      const project = byId.get(projectId);
      const c = project.candidates.find((x) => x.key === key);
      return {
        menteeKey: key,
        name: c.name,
        project: projectId,
        position: c.position,
        adjusted: c.adjusted,
        status: c.status,
        ready: project.ready,
      };
    });
    suggestion.sort((a, b) => a.position - b.position || (b.adjusted || 0) - (a.adjusted || 0));
    const placed = new Set(suggestion.map((s) => s.menteeKey));
    projects.forEach((p) => {
      p.candidates.forEach((c) => {
        c.suggested = placed.has(c.key) && got[c.key] === p.id;
      });
    });
  }

  // ── Career orientation ──
  const orientationMentees = roster.mentees
    .filter((c) => (c.track === 'orientation' || c.track === 'both') && c.status !== 'declined')
    .map((c) => person(c.key))
    .filter((p) => p.overall !== null || ['selected', 'matched'].includes(p.status))
    .map((p) => ({
      ...p,
      profile: roster.profiles.get(`mentee:${p.key}`) || {},
      // Once paired, the proposal is history.
      draft: p.matchedTo ? null : drafts[p.key] || null,
    }))
    .sort((a, b) =>
      better({ ...a, score: a.overall, position: 0 }, { ...b, score: b.overall, position: 0 })
    );
  const proposed = new Map();
  orientationMentees.forEach((p) => {
    if (p.draft && p.draft.mentorKey)
      proposed.set(p.draft.mentorKey, (proposed.get(p.draft.mentorKey) || 0) + 1);
  });
  const orientationMentors = roster.mentors
    .filter(orientationMentor)
    .map((c) => ({
      ...mentorBrief(c.key),
      org: c.org,
      profile: roster.profiles.get(`mentor:${c.key}`) || {},
      proposed: proposed.get(c.key) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const mentorOf = new Map(orientationMentors.map((m) => [m.key, m]));
  const toPair = orientationMentees.filter((p) => !p.matchedTo && p.status === 'selected');
  const orientation = {
    mentees: orientationMentees,
    mentors: orientationMentors,
    // What is still open: does everyone selected have a mentor that fits?
    check: {
      selected: toPair.length,
      unassigned: toPair.filter((p) => !(p.draft && p.draft.mentorKey)).map((p) => p.name),
      // Proposed to a mentor the admins said does not fit.
      misfit: toPair
        .filter((p) => p.draft && p.draft.mentorKey && p.draft.affinity[p.draft.mentorKey] === -1)
        .map((p) => p.name),
      // Proposals that would take a mentor over their places.
      overfull: orientationMentors
        .filter((m) => m.capacity && m.taken + m.proposed > m.capacity)
        .map((m) => `${m.name} (${m.taken + m.proposed}/${m.capacity})`),
      placesLeft: orientationMentors.every((m) => m.capacity)
        ? orientationMentors.reduce((n, m) => n + Math.max(0, m.capacity - m.taken - m.proposed), 0)
        : null,
    },
    suggestion: orientationSuggestion(orientationMentees, orientationMentors).map((s) => ({
      ...s,
      mentorName: mentorOf.get(s.mentorKey).name,
    })),
  };

  // ── How many to select: the places against who is selected ──
  const isIn = (c) => ['selected', 'matched'].includes(c.status);
  const onTrack = (c, t) => c.track === t || c.track === 'both';
  const sum = (list) => ({
    places: list.reduce((n, x) => n + (x.places || 0), 0),
    unknown: list.filter((x) => !x.places).length,
  });
  const projectRows = projects
    .filter((p) => p.mapped)
    .map((p) => ({
      id: p.id,
      label: p.label,
      places: p.places,
      placesFrom: p.placesFrom,
      first: p.candidates.filter((c) => c.position === 1).length,
      ranked: p.candidates.length,
      // Selected (or paired) mentees who put it first.
      selectedFirst: p.candidates.filter((c) => c.position === 1 && isIn(c)).length,
      paired: p.taken,
    }));
  const places = {
    projects: {
      ...sum(projectRows),
      projects: projectRows,
      unmapped: projects.length - projectRows.length,
      selected: roster.mentees.filter((c) => onTrack(c, 'projects') && isIn(c)).length,
      paired: roster.matches.filter((m) => m.track === 'projects').length,
    },
    orientation: {
      ...sum(orientation.mentors.map((m) => ({ places: m.capacity }))),
      mentors: orientation.mentors.length,
      selected: roster.mentees.filter((c) => onTrack(c, 'orientation') && isIn(c)).length,
      paired: roster.matches.filter((m) => m.track === 'orientation').length,
    },
  };

  await audit.record(user, 'review-matching', null, {
    projects: projects.length,
    suggested: suggestion.length,
  });
  return {
    settings,
    forms: choices,
    questions,
    pool,
    statuses: mentorship.STATUSES.mentee,
    // Every mentor who could run a project, for the setup.
    mentors: roster.mentors
      .filter((c) => MENTOR_READY.includes(c.status) || c.status === 'applied')
      .map((c) => mentorBrief(c.key))
      .sort((a, b) => a.name.localeCompare(b.name, 'it')),
    projects,
    suggestion,
    orientation,
    places,
    // Answers with no email: nobody to pair them with.
    noKey,
    limits: {
      penalty: MAX_PENALTY,
      places: MAX_PLACES,
      mentors: MAX_MENTORS,
      note: MAX_DRAFT_NOTE,
    },
  };
}

/**
 * Confirms a pair: the board's own match, so its rules and its record hold.
 * Projects: the mentee with the project, so with all its mentors at once (the
 * first as the pair's mentor, the others as co-mentors). Orientation: with
 * the mentor chosen.
 */
async function confirm(user, { project, mentorKey, menteeKey, track } = {}) {
  if (track === 'orientation') {
    const made = await mentorship.createMatch(user, mentorKey, menteeKey, 'orientation');
    await dropDraft(menteeKey);
    return made;
  }
  const settings = await getSettings();
  const setup = project ? settings.projects[project] : null;
  if (!setup || !setup.mentors.length)
    throw new HttpError(400, 'This project has no mentor in the setup');
  const [lead, ...co] = setup.mentors;
  return mentorship.createMatch(user, lead, menteeKey, 'projects', co);
}

module.exports = {
  DEFAULT_PENALTY,
  getSettings,
  saveSettings,
  AFFINITY,
  getDrafts,
  saveDraft,
  fillDrafts,
  rankingQuestions,
  questions,
  suggestMapping,
  stableMatch,
  view,
  confirm,
};
