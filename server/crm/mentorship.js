// The mentorship board: mentors and mentees, where each is in the selection,
// the team's notes, and who is paired with whom.
//
// Who people are comes from the board's records (server/crm/records.js):
// copied once from the Google sheets, then from the site's forms and from the
// board itself, encrypted. The lists are joined by the opaque person key, so
// someone who appears in two of them is one card. What the team decides
// (status, track, who follows them, notes, pairs) is stored by key only.
// Every function here assumes access.authorize(user, 'mentorship')
// has already been called by the API.

const fs = require('fs');
const nodeCrypto = require('crypto');
const path = require('path');
const yaml = require('js-yaml');
const db = require('../db');
const { HttpError } = require('../http');
const sources = require('./sources');
const records = require('./records');
const crm = require('./crypto');
const audit = require('./audit');
const access = require('../access');

const STATUSES = {
  mentor: [
    { key: 'to_contact', label: 'To contact' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'replied', label: 'Interested' },
    { key: 'applied', label: 'Applied' },
    { key: 'selected', label: 'Selected' },
    { key: 'matched', label: 'Matched' },
    { key: 'declined', label: 'Declined' },
  ],
  // Shortlisted and Interview are the steps of the mentee selection
  // (server/crm/review.js), which moves people between Applied and those
  // and Rejected; Selected and Matched are decided on the board.
  mentee: [
    { key: 'interested', label: 'Interested' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'applied', label: 'Applied' },
    { key: 'shortlisted', label: 'Shortlisted' },
    { key: 'interview', label: 'Interview' },
    { key: 'selected', label: 'Selected' },
    { key: 'matched', label: 'Matched' },
    { key: 'declined', label: 'Rejected' },
  ],
};
const KINDS = Object.keys(STATUSES);
const TRACKS = [
  { key: 'projects', label: 'AI safety projects' },
  { key: 'orientation', label: 'Career orientation' },
  { key: 'both', label: 'Both' },
];
const TRACK_KEYS = TRACKS.map((t) => t.key);
const KEY = /^[A-Za-z0-9_-]{32}$/;
const MAX_NOTE = 4000;
const MAX_CONSENT_NOTE = 300;

// What a sheet's free-text answers mean.
function yes(value) {
  return /^(s[iì]|yes|y|x|ok|true|1)\b/i.test(sources.norm(value));
}

function trackOf(text) {
  const t = sources.norm(text);
  const projects = /progett|project/.test(t);
  const orientation = /orient/.test(t);
  if (projects && orientation) return 'both';
  return projects ? 'projects' : orientation ? 'orientation' : null;
}

/**
 * An expression of interest says "Mentor", "Mentee" or both. Only the role
 * itself counts, not what explains it: in "Mentee: vorrei essere affiancata
 * da un mentor" the words after the colon (or in brackets) are left out.
 * Several ticked answers come joined by commas.
 */
function kindsOf(applyingAs) {
  const t = String(applyingAs || '')
    .split(/[,;\n]/)
    .map((part) => sources.norm(part.split(':')[0].replace(/\([^)]*\)/g, '')))
    .join(' ');
  const kinds = [];
  if (/mentor/.test(t)) kinds.push('mentor');
  if (/mentee/.test(t) || !kinds.length) kinds.push('mentee');
  return kinds;
}

const first = (...values) => values.find((v) => v && String(v).trim()) || '';

// ── Reading the records into people ──────────────────────────────────────────

/**
 * Everyone in the lists: { people: Map("kind:key" -> person), unlinked: rows
 * without an email, problems: records the current key cannot open }. With
 * `personKey`, only that person's records are read and decrypted.
 */
async function gather(personKey) {
  const people = new Map();
  const unlinked = [];
  const problems = [];

  const add = (kind, sourceId, record) => {
    if (!record.key) {
      unlinked.push({
        kind,
        source: sourceId,
        row: record.row,
        name: record.name || '(no name)',
      });
      return;
    }
    const id = `${kind}:${record.key}`;
    if (!people.has(id)) people.set(id, { key: record.key, kind, records: {} });
    people.get(id).records[sourceId] = record;
  };

  const { bySource, unreadable } = await records.list({ personKey });
  for (const sourceId of Object.keys(sources.SOURCES)) {
    for (const record of bySource[sourceId] || []) {
      if (sourceId === 'mentees_interest') {
        kindsOf(record.applying_as).forEach((kind) => add(kind, sourceId, record));
      } else {
        add(sources.SOURCES[sourceId].kind === 'mentee' ? 'mentee' : 'mentor', sourceId, record);
      }
    }
  }
  if (unreadable) {
    problems.push({
      source: null,
      label: 'Board',
      message: `${unreadable} records cannot be opened with the current key`,
    });
  }
  return { people, unlinked, problems };
}

/** What the records alone say about where someone is. */
function derivedStatus(person) {
  const r = person.records;
  if (person.kind === 'mentor') {
    if (r.mentors_applications) return 'applied';
    if (r.mentors_prospective && yes(r.mentors_prospective.replied)) return 'replied';
    if (r.mentees_interest) return 'replied';
    if (r.mentors_prospective && yes(r.mentors_prospective.contacted)) return 'contacted';
    return 'to_contact';
  }
  if (r.mentees_applications) return 'applied';
  if (r.mentees_interest && yes(r.mentees_interest.contacted)) return 'contacted';
  return 'interested';
}

/** The card: what the board shows for a person, without contact details. */
function card(person, state, extra) {
  const r = person.records;
  const app = r.mentors_applications || {};
  const prospect = r.mentors_prospective || {};
  const interest = r.mentees_interest || {};
  const mentee = r.mentees_applications || {};
  return {
    key: person.key,
    kind: person.kind,
    name: first(app.name, mentee.name, interest.name, prospect.name) || '(no name)',
    org: first(
      app.role,
      prospect.org,
      [mentee.role, mentee.affiliation].filter(Boolean).join(', '),
      [interest.role, interest.affiliation].filter(Boolean).join(', ')
    ),
    track:
      (state && state.track) ||
      trackOf(first(app.tracks, mentee.tracks, prospect.track, interest.tracks)),
    areas: first(app.areas, mentee.areas, interest.areas, prospect.notes),
    project: app.project_title || '',
    capacity: Number(app.mentees) > 0 ? Number(app.mentees) : null,
    referrer: prospect.referrer || '',
    sources: Object.keys(r),
    status: (state && state.status) || derivedStatus(person),
    statusSet: Boolean(state),
    owner: (state && state.owner_name) || null,
    ownerId: (state && state.owner_id) || null,
    notes: extra.notes || 0,
    matches: extra.matches || 0,
  };
}

async function states() {
  const { rows } = await db.query(
    `select s.*, u.name as owner_name from crm_people_state s
     left join app_users u on u.id = s.owner_id`
  );
  return new Map(rows.map((r) => [`${r.kind}:${r.person_key}`, r]));
}

/** One person's row of crm_people_state, or undefined. */
async function stateOf(key, kind) {
  const { rows } = await db.query(
    `select s.*, u.name as owner_name from crm_people_state s
     left join app_users u on u.id = s.owner_id
     where s.person_key = $1 and s.kind = $2`,
    [key, kind]
  );
  return rows[0];
}

async function noteCounts() {
  const { rows } = await db.query(
    'select person_key, count(*)::int as n from crm_notes group by person_key'
  );
  return new Map(rows.map((r) => [r.person_key, r.n]));
}

async function activeMatches() {
  const { rows } = await db.query(
    `select id, mentor_key, mentee_key, track, created_at from crm_matches
     where status = 'active' order by created_at`
  );
  return rows;
}

/** Who the board published or took off: person key -> hidden. */
async function siteRows() {
  const { rows } = await db.query('select person_key, hidden from mentor_site_entries');
  return new Map(rows.map((r) => [r.person_key, r.hidden]));
}

/** The whole board for the page. */
async function board(user) {
  const { people, unlinked, problems } = await gather();
  const [state, notes, matches, site] = await Promise.all([
    states(),
    noteCounts(),
    activeMatches(),
    siteRows(),
  ]);
  const matchCount = new Map();
  matches.forEach((m) => {
    matchCount.set(`mentor:${m.mentor_key}`, (matchCount.get(`mentor:${m.mentor_key}`) || 0) + 1);
    matchCount.set(`mentee:${m.mentee_key}`, 1);
  });
  const cards = [...people.entries()].map(([id, person]) =>
    card(person, state.get(id), { notes: notes.get(person.key), matches: matchCount.get(id) })
  );
  cards
    .filter((c) => c.kind === 'mentor')
    .forEach((c) => {
      c.online = site.has(c.key) ? !site.get(c.key) : Boolean(siteYaml(c.name));
    });
  const byName = (a, b) => a.name.localeCompare(b.name, 'it');
  const names = new Map(cards.map((c) => [`${c.kind}:${c.key}`, c.name]));
  await audit.record(user, 'view-list', null, {
    mentors: cards.filter((c) => c.kind === 'mentor').length,
    mentees: cards.filter((c) => c.kind === 'mentee').length,
  });
  return {
    statuses: STATUSES,
    tracks: TRACKS,
    mentors: cards.filter((c) => c.kind === 'mentor').sort(byName),
    mentees: cards.filter((c) => c.kind === 'mentee').sort(byName),
    matches: matches.map((m) => ({
      id: m.id,
      track: m.track,
      createdAt: m.created_at,
      mentor: {
        key: m.mentor_key,
        name: names.get(`mentor:${m.mentor_key}`) || '(no longer on the board)',
      },
      mentee: {
        key: m.mentee_key,
        name: names.get(`mentee:${m.mentee_key}`) || '(no longer on the board)',
      },
    })),
    unlinked,
    problems,
    me: user.id,
  };
}

/**
 * The mentees who sent an application, for the selection
 * (server/crm/review.js): [{ key, record, card }], `record` their
 * application and `card` as the board shows them, its status included: the
 * selection reads and moves the same status the board does.
 */
async function applicants() {
  const { people } = await gather();
  const state = await states();
  const out = [];
  for (const [id, person] of people) {
    if (person.kind !== 'mentee' || !person.records.mentees_applications) continue;
    out.push({
      key: person.key,
      record: person.records.mentees_applications,
      card: card(person, state.get(id), {}),
    });
  }
  return out;
}

// ── One person ───────────────────────────────────────────────────────────────

function checkKey(key, kind) {
  if (!KEY.test(String(key || ''))) throw new HttpError(400, 'Invalid person');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Invalid kind');
}

async function find(key, kind) {
  checkKey(key, kind);
  const { people } = await gather(key);
  const person = people.get(`${kind}:${key}`);
  if (!person) throw new HttpError(404, 'Not on the board (any more)');
  return person;
}

/** Everything about one person, with fields cut to what `perms` may read. */
async function person(user, perms, key, kind) {
  const found = await find(key, kind);
  const state = await stateOf(key, kind);
  const card_ = card(found, state, {});
  const sheetsView = Object.entries(found.records).map(([sourceId, record]) => {
    // The key and the record's id are dropped on purpose: lookup ids, not
    // fields to show.
    // eslint-disable-next-line no-unused-vars
    const { key: _key, recordId, origin, row, ...fields } = record;
    const shown = access.redact(fields, perms);
    // Only what has an answer.
    Object.keys(shown).forEach((f) => !shown[f] && delete shown[f]);
    return {
      source: sourceId,
      label: sources.SOURCES[sourceId].label,
      row,
      origin,
      // Only those added by hand can be removed from the board.
      recordId: origin === 'board' ? recordId : undefined,
      fields: shown,
    };
  });
  const { rows: noteRows } = await db.query(
    'select id, body_encrypted, author_name, created_at from crm_notes where person_key = $1 order by created_at desc',
    [key]
  );
  const notes = noteRows.map((n) => ({
    id: n.id,
    author: n.author_name,
    createdAt: n.created_at,
    body: crm.decrypt(n.body_encrypted, key) ?? '(this note cannot be opened with the current key)',
  }));
  // Only the pairs of this role: someone can be a mentor and a mentee.
  const side = kind === 'mentor' ? 'mentor_key' : 'mentee_key';
  const { rows: matchRows } = await db.query(
    `select id, mentor_key, mentee_key, track, status, created_at, ended_at from crm_matches
     where ${side} = $1 order by created_at desc`,
    [key]
  );
  const otherKind = kind === 'mentor' ? 'mentee' : 'mentor';
  const otherName = async (otherKey) => {
    const other = (await gather(otherKey)).people.get(`${otherKind}:${otherKey}`);
    return other ? card(other, null, {}).name : null;
  };
  const matches = [];
  for (const m of matchRows) {
    const otherKey = kind === 'mentor' ? m.mentee_key : m.mentor_key;
    matches.push({
      id: m.id,
      track: m.track,
      status: m.status,
      createdAt: m.created_at,
      endedAt: m.ended_at,
      otherKey,
      otherName: await otherName(otherKey),
    });
  }
  await audit.record(user, 'view-person', key, { kind });
  if (notes.length) await audit.record(user, 'view-note', key, { count: notes.length });
  return {
    ...card_,
    email: access.redact(
      { email: first(...Object.values(found.records).map((r) => r.email)) },
      perms
    ).email,
    sheets: sheetsView,
    notes,
    matches,
    // The selection's own lines (who opened or scored them) stay out: the
    // board must not tell who reviewed whom.
    history: (await audit.recent({ subjectKey: key, limit: 60 }))
      .filter((line) => !line.action.startsWith('review-'))
      .slice(0, 40),
    // So a page of its own can show the stage buttons and the track select.
    statuses: STATUSES[kind],
    tracks: TRACKS,
    site: kind === 'mentor' ? await siteOf(key, found, card_.name) : null,
  };
}

// ── The mentor's entry on the public site (mentors only) ─────────────────────
//
// The draft (bio, photo, consent and the entry being written) is encrypted in
// crm_site_profiles. Publishing copies the entry, which is public anyway, into
// mentor_site_entries; the site's build merges those over data/mentors.yaml
// (server/mentors-build.js).

const MAX_BIO = 1200;
const MAX_PHOTO_BYTES = 200_000;
const MENTORS_YAML = path.join(__dirname, '..', '..', 'data', 'mentors.yaml');
const MENTORSHIP_YAML = path.join(__dirname, '..', '..', 'data', 'mentorship.yaml');
const PHOTO_DIR = '/assets/img/mentors/';

// Read once per process: the files only change with a deploy.
let siteData = null;

/** The site's mentors, research areas and tracks: { mentors, areas, tracks }. */
function siteYamls() {
  if (!siteData) {
    try {
      const m = yaml.load(fs.readFileSync(MENTORS_YAML, 'utf8')) || {};
      const p = yaml.load(fs.readFileSync(MENTORSHIP_YAML, 'utf8')) || {};
      siteData = {
        mentors: (m.mentors || []).filter((x) => x && x.id),
        areas: (m.research_areas || []).map((a) => ({ id: a.id, label: a.label })),
        tracks: (p.tracks || []).map((t) => ({ id: t.id, label: t.title })),
      };
    } catch {
      return { mentors: [], areas: [], tracks: [] };
    }
  }
  return siteData;
}

/** Their entry in data/mentors.yaml as written there, matched by name, or null. */
function siteYaml(name) {
  const want = sources.norm(name);
  return siteYamls().mentors.find((m) => sources.norm(m.name) === want) || null;
}

/** Their entry on /mentorship/ (data/mentors.yaml), matched by name, or null. */
function siteEntry(name) {
  const hit = siteYaml(name);
  return hit ? { id: hit.id, url: `/mentorship/#${hit.id}` } : null;
}

// The entry's texts and their longest length. Each has its Italian twin.
const TEXTS = { name: 200, role: 200, affiliation: 200, bio: 1500, orientation: 1000 };
const LANG = { language: 200 };
const PROJECT = { title: 200, summary: 1000, description: 4000, mentee: 1000, deliverable: 1000 };
const LINKS = ['website', 'linkedin', 'scholar', 'github'];
const ID = /^[a-z0-9-]{1,80}$/;
const MAX_PLACES = 50;

const str = (v) => (v == null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** Any entry-like object in the full shape the board edits, every field present. */
function shape(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.project && typeof r.project === 'object' ? r.project : {};
  const l = r.links && typeof r.links === 'object' ? r.links : {};
  const out = {};
  out.name = str(r.name);
  out.role = str(r.role);
  out.role_it = str(r.role_it);
  out.affiliation = str(r.affiliation);
  out.links = Object.fromEntries(LINKS.map((k) => [k, str(l[k])]));
  out.tracks = list(r.tracks);
  out.areas = list(r.areas);
  for (const f of ['bio', 'orientation', 'language']) {
    out[f] = str(r[f]);
    out[`${f}_it`] = str(r[`${f}_it`]);
  }
  out.places = Number.isInteger(Number(r.places)) && Number(r.places) > 0 ? Number(r.places) : null;
  out.co_mentors = list(r.co_mentors);
  out.project = {};
  for (const f of Object.keys(PROJECT)) {
    out.project[f] = str(p[f]);
    out.project[`${f}_it`] = str(p[`${f}_it`]);
  }
  return out;
}

/** An entry sent by the page: types and lengths checked, in the full shape. */
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'Invalid entry');
  const texts = (obj, limits, prefix) => {
    for (const [f, max] of Object.entries(limits)) {
      for (const k of f === 'name' || f === 'affiliation' ? [f] : [f, `${f}_it`]) {
        const v = obj[k];
        if (v != null && typeof v !== 'string')
          throw new HttpError(400, `${prefix}${k}: text only`);
        if (str(v).length > max)
          throw new HttpError(400, `${prefix}${k}: at most ${max} characters`);
      }
    }
  };
  texts(raw, { ...TEXTS, ...LANG }, '');
  if (raw.project != null) {
    if (typeof raw.project !== 'object') throw new HttpError(400, 'Invalid project');
    texts(raw.project, PROJECT, 'project.');
  }
  if (raw.links != null) {
    if (typeof raw.links !== 'object') throw new HttpError(400, 'Invalid links');
    for (const k of LINKS) {
      const v = str(raw.links[k]);
      if (v && !(/^https:\/\/[^\s<>"]+$/.test(v) && v.length <= 300))
        throw new HttpError(400, `links.${k}: a https:// address`);
    }
  }
  const { tracks, areas } = siteYamls();
  const known = (field, ids) => {
    const v = raw[field];
    if (v == null) return;
    if (!Array.isArray(v) || v.some((x) => !ids.includes(x)))
      throw new HttpError(400, `${field}: unknown`);
  };
  known(
    'tracks',
    tracks.map((t) => t.id)
  );
  known(
    'areas',
    areas.map((a) => a.id)
  );
  if (raw.co_mentors != null) {
    if (!Array.isArray(raw.co_mentors) || raw.co_mentors.some((x) => !ID.test(String(x))))
      throw new HttpError(400, 'co_mentors: ids of other mentors');
  }
  if (raw.places != null && raw.places !== '') {
    const n = Number(raw.places);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PLACES)
      throw new HttpError(400, `places: a number from 1 to ${MAX_PLACES}`);
  }
  return shape(raw);
}

/** The fields that keep an entry off the site, as paths ('bio', 'project.summary_it'). */
function missingOf(e) {
  const out = [];
  const need = (obj, f, prefix = '') => !obj[f] && out.push(prefix + f);
  ['name', 'affiliation'].forEach((f) => need(e, f));
  if (!e.tracks.length) out.push('tracks');
  if (!e.areas.length) out.push('areas');
  ['bio', 'bio_it', 'language', 'language_it'].forEach((f) => need(e, f));
  if (e.tracks.includes('orientation'))
    ['orientation', 'orientation_it'].forEach((f) => need(e, f));
  // Optional texts: written in one language, they are needed in the other too.
  const pair = (obj, f, prefix = '') => {
    if (obj[f] || obj[`${f}_it`]) [f, `${f}_it`].forEach((k) => need(obj, k, prefix));
  };
  pair(e, 'role');
  // Co-mentors show the project written on one of them.
  const project = e.tracks.includes('projects') && !e.co_mentors.length;
  for (const f of Object.keys(PROJECT)) {
    if (project) [f, `${f}_it`].forEach((k) => need(e.project, k, 'project.'));
    else pair(e.project, f, 'project.');
  }
  return out;
}

/** Without the empty fields, as data/mentors.yaml writes a mentor. */
function prune(value) {
  if (Array.isArray(value)) return value.length ? value : undefined;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const kept = prune(v);
      if (kept !== undefined) out[k] = kept;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === '' || value === null ? undefined : value;
}

// jsonb keeps keys in its own order: compare with sorted keys.
function canonical(value) {
  return JSON.stringify(value, (k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]])
        )
      : v
  );
}

/** What the application form says, as an entry. */
function fromApplication(app, name, bio) {
  const e = shape({ name, bio_it: bio });
  e.affiliation = str(app.role);
  const profile = str(app.profile);
  if (/^https:\/\//.test(profile)) {
    e.links[/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(profile) ? 'linkedin' : 'website'] =
      profile;
  }
  const track = trackOf(app.tracks);
  e.tracks = track === 'both' ? ['projects', 'orientation'] : track ? [track] : [];
  e.project.title_it = str(app.project_title);
  e.project.description_it = str(app.project_abstract);
  e.language_it = str(app.language);
  return e;
}

function slug(name) {
  return (
    sources
      .norm(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'mentor'
  );
}

/** The encrypted draft: { draft, row } (draft {} when there is none). */
async function readDraft(key) {
  const { rows } = await db.query(
    'select data_encrypted, updated_by_name, updated_at from crm_site_profiles where person_key = $1',
    [key]
  );
  let draft = {};
  if (rows[0]) {
    try {
      draft = JSON.parse(crm.decrypt(rows[0].data_encrypted, `crm-site:${key}`)) || {};
    } catch {
      draft = {};
    }
  }
  return { draft, row: rows[0] };
}

async function writeDraft(user, key, draft) {
  await db.query(
    `insert into crm_site_profiles (person_key, data_encrypted, updated_by, updated_by_name, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (person_key) do update set data_encrypted = excluded.data_encrypted,
       updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = now()`,
    [
      key,
      crm.encrypt(JSON.stringify(draft), `crm-site:${key}`),
      user.kind === 'admin' ? null : user.id,
      user.name,
    ]
  );
}

/** Their row of mentor_site_entries, hidden or not, or undefined. */
async function publishedRow(key) {
  const { rows } = await db.query('select * from mentor_site_entries where person_key = $1', [key]);
  return rows[0];
}

/**
 * What publishing would store: { entry, photo, hash }, `entry` as the site
 * gets it (with id and photo path), `photo` the JPEG in base64 or null.
 */
function toPublish(id, entry, consent, draftPhoto, yamlHit) {
  const out = prune({ ...entry, id }) || {};
  const bytes = draftPhoto ? draftPhoto.split(',')[1] : null;
  if (consent === 'yes' && bytes) {
    const hash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.from(bytes, 'base64'))
      .digest('hex')
      .slice(0, 8);
    out.photo = `${PHOTO_DIR}${id}-${hash}.jpg`;
    return { entry: out, photo: bytes, hash };
  }
  // A photo already in data/mentors.yaml stays, unless they said no.
  if (consent !== 'no' && yamlHit && yamlHit.photo) out.photo = yamlHit.photo;
  return { entry: out, photo: null, hash: null };
}

async function siteOf(key, found, name) {
  const { draft, row } = await readDraft(key);
  const answer = found.records.mentors_applications && found.records.mentors_applications.publish;
  const fromForm = answer ? (yes(answer) ? 'yes' : 'no') : null;
  // A consent recorded by hand (given by email, say) wins over the form's answer.
  const manual = draft.consent || null;
  const consent = manual ? manual.value : fromForm;

  const pub = await publishedRow(key);
  const live = pub && !pub.hidden ? pub : null;
  const yamlHit = siteYaml(name);
  const id = pub ? pub.id : yamlHit ? yamlHit.id : slug(name);
  let entry;
  let entryFrom;
  if (draft.entry) [entry, entryFrom] = [shape(draft.entry), 'draft'];
  else if (live) [entry, entryFrom] = [shape(live.entry), 'published'];
  else if (yamlHit) [entry, entryFrom] = [shape(yamlHit), 'yaml'];
  else {
    entry = fromApplication(found.records.mentors_applications || {}, name, draft.bio);
    entryFrom = 'application';
  }
  const unpublishedChanges = live
    ? canonical(toPublish(id, entry, consent, draft.photo, yamlHit).entry) !== canonical(live.entry)
    : false;
  const { tracks, areas } = siteYamls();
  return {
    bio: draft.bio || '',
    photo: draft.photo || null,
    // The photo data/mentors.yaml puts on the site: toPublish() keeps it unless they said no.
    yamlPhoto: (consent !== 'no' && yamlHit && yamlHit.photo) || null,
    online: pub ? !pub.hidden : Boolean(yamlHit),
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by_name : null,
    consent,
    consentFrom: manual ? { by: manual.by, at: manual.at, note: manual.note } : null,
    consentInForm: fromForm,
    id,
    entry,
    entryFrom,
    published: live ? { at: live.published_at, by: live.published_by_name, id: live.id } : null,
    unpublishedChanges,
    missing: missingOf(entry),
    vocab: { tracks, areas },
  };
}

/** A photo as the page sends it: a JPEG data URL, small, really a JPEG. */
function cleanPhoto(photo) {
  if (photo === null) return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(photo || ''));
  if (!m) throw new HttpError(400, 'The photo must be a JPEG');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'The photo is too large');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new HttpError(400, 'The photo must be a JPEG');
  return photo;
}

/**
 * A consent to publish recorded by hand: { value: 'yes' | 'no', note } with a
 * note saying how it was given (required for a yes), or null to go back to
 * the form's answer.
 */
function cleanConsent(consent, user) {
  if (consent === null) return undefined;
  const value = consent && consent.value;
  if (value !== 'yes' && value !== 'no') throw new HttpError(400, 'Consent is yes or no');
  const note = String(consent.note || '').trim();
  if (note.length > MAX_CONSENT_NOTE)
    throw new HttpError(400, `The note is longer than ${MAX_CONSENT_NOTE} characters`);
  if (value === 'yes' && !note) throw new HttpError(400, 'Say how they gave their consent');
  return { value, note, by: user.name, at: new Date().toISOString() };
}

/** The mentor, their name, and their draft: for the changes below. */
async function mentorDraft(key, kind) {
  if (kind !== 'mentor') throw new HttpError(400, 'Only mentors are on the site');
  const found = await find(key, kind);
  const name = card(found, await stateOf(key, kind), {}).name;
  const { draft } = await readDraft(key);
  return { found, name, draft };
}

const contentPublish = () => require('../content-publish');

/**
 * Saves a mentor's bio, photo and/or consent for the site (`photo: null` removes it).
 * Returns the draft as person() shows it. A consent withdrawn takes the photo
 * off the site at once.
 */
async function saveSite(user, key, kind, body) {
  const { found, name, draft } = await mentorDraft(key, kind);
  if (body.bio !== undefined) {
    const bio = String(body.bio || '').trim();
    if (bio.length > MAX_BIO)
      throw new HttpError(400, `The bio is longer than ${MAX_BIO} characters`);
    draft.bio = bio;
  }
  if (body.photo !== undefined) draft.photo = cleanPhoto(body.photo);
  if (body.consent !== undefined) draft.consent = cleanConsent(body.consent, user);
  await writeDraft(user, key, draft);
  await audit.record(user, 'site-draft', key, {
    bio: body.bio !== undefined,
    photo: body.photo === undefined ? undefined : body.photo === null ? 'removed' : 'set',
    consent:
      body.consent === undefined ? undefined : (draft.consent && draft.consent.value) || 'form',
  });
  const site = await siteOf(key, found, name);
  const pub = await publishedRow(key);
  if (site.consent === 'no' && pub && !pub.hidden && (pub.photo || pub.entry.photo)) {
    // eslint-disable-next-line no-unused-vars
    const { photo, ...rest } = pub.entry;
    await db.query(
      `update mentor_site_entries set photo = null, photo_hash = null, entry = $2::jsonb
       where id = $1`,
      [pub.id, JSON.stringify(rest)]
    );
    await contentPublish().triggerBuild();
    return siteOf(key, found, name);
  }
  return site;
}

/** Saves the entry being written for the site, without publishing it. */
async function saveEntry(user, key, kind, entry) {
  const { found, name, draft } = await mentorDraft(key, kind);
  draft.entry = cleanEntry(entry);
  await writeDraft(user, key, draft);
  await audit.record(user, 'site-draft', key, { entry: true });
  return siteOf(key, found, name);
}

/**
 * Puts a selected mentor's entry on /mentorship/ (in about 3 minutes, with
 * the next build). Returns { site, build }.
 */
async function publish(user, key, kind, { siteOrigin = '' } = {}) {
  const { found, name, draft } = await mentorDraft(key, kind);
  const state = await stateOf(key, kind);
  if (!['selected', 'matched'].includes(card(found, state, {}).status))
    throw new HttpError(400, 'Only selected mentors go on the site');
  const site = await siteOf(key, found, name);
  if (site.missing.length)
    throw new HttpError(400, `Missing: ${site.missing.join(', ')}`, { missing: site.missing });
  const taken = (
    await db.query('select person_key from mentor_site_entries where id = $1', [site.id])
  ).rows[0];
  if (taken && taken.person_key && taken.person_key !== key)
    throw new HttpError(409, `Another mentor is on the site as ${site.id}`);
  const out = toPublish(site.id, site.entry, site.consent, draft.photo, siteYaml(name));
  await db.query(
    `insert into mentor_site_entries
       (id, person_key, entry, photo, photo_hash, hidden, published_by, published_by_name, published_at)
     values ($1, $2, $3::jsonb, $4, $5, false, $6, $7, now())
     on conflict (id) do update set person_key = excluded.person_key, entry = excluded.entry,
       photo = excluded.photo, photo_hash = excluded.photo_hash, hidden = false,
       published_by = excluded.published_by, published_by_name = excluded.published_by_name,
       published_at = now()`,
    [
      site.id,
      key,
      JSON.stringify(out.entry),
      out.photo,
      out.hash,
      user.kind === 'admin' ? null : user.id,
      user.name,
    ]
  );
  await audit.record(user, 'publish', key, { id: site.id });
  const build = await contentPublish().triggerBuild();
  await contentPublish().announceMentor({ user, name: out.entry.name, id: site.id, siteOrigin });
  return { site: await siteOf(key, found, name), build };
}

/**
 * Takes the board's entry off the site. A mentor also in data/mentors.yaml
 * stays hidden there, or the YAML entry would come back. Returns { site, build }.
 */
async function unpublish(user, key, kind) {
  const { found, name } = await mentorDraft(key, kind);
  const site = await siteOf(key, found, name);
  if (siteYamls().mentors.some((m) => m.id === site.id)) {
    await db.query(
      `insert into mentor_site_entries
         (id, person_key, entry, photo, photo_hash, hidden, published_by, published_by_name, published_at)
       values ($1, $2, '{}'::jsonb, null, null, true, $3, $4, now())
       on conflict (id) do update set person_key = excluded.person_key, entry = '{}'::jsonb,
         photo = null, photo_hash = null, hidden = true, published_by = excluded.published_by,
         published_by_name = excluded.published_by_name, published_at = now()`,
      [site.id, key, user.kind === 'admin' ? null : user.id, user.name]
    );
  } else {
    await db.query('delete from mentor_site_entries where id = $1 and person_key = $2', [
      site.id,
      key,
    ]);
  }
  await audit.record(user, 'unpublish', key, { id: site.id });
  const build = await contentPublish().triggerBuild();
  return { site: await siteOf(key, found, name), build };
}

/**
 * What the site's build reads (GET /api/content?part=mentors): the entries
 * published from the board, oldest first, and the ids of data/mentors.yaml
 * taken off. Photos are only paths: their bytes come from photoOf().
 */
async function publicExport() {
  const { rows } = await db.query(
    'select id, entry, hidden from mentor_site_entries order by published_at, id'
  );
  return {
    live: true,
    mentors: rows.filter((r) => !r.hidden).map((r) => ({ ...r.entry, id: r.id })),
    hidden: rows.filter((r) => r.hidden).map((r) => r.id),
  };
}

/** A published mentor's photo, as JPEG bytes, or null. */
async function photoOf(id) {
  if (!ID.test(String(id || ''))) return null;
  const { rows } = await db.query(
    'select photo from mentor_site_entries where id = $1 and not hidden and photo is not null',
    [id]
  );
  return rows[0] ? Buffer.from(rows[0].photo, 'base64') : null;
}

/** publicExport() with the photos' bytes, for a local build: photos { id: base64 }. */
async function snapshotData() {
  const { rows } = await db.query(
    'select id, photo from mentor_site_entries where not hidden and photo is not null'
  );
  return {
    ...(await publicExport()),
    photos: Object.fromEntries(rows.map((r) => [r.id, r.photo])),
  };
}

// ── Emails ───────────────────────────────────────────────────────────────────

const MAX_EMAILS = 1000;

/**
 * The names and emails of these people, for the team to write to them:
 * { people: [{ name, email }] } in the given order, without those who have
 * none. One line on the audit trail with how many, never who.
 */
async function emails(user, kind, keys) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Invalid kind');
  if (!Array.isArray(keys) || keys.length > MAX_EMAILS) throw new HttpError(400, 'Invalid list');
  keys.forEach((k) => checkKey(k, kind));
  const { people } = await gather();
  const out = [];
  for (const key of new Set(keys)) {
    const person = people.get(`${kind}:${key}`);
    if (!person) continue;
    const email = first(...Object.values(person.records).map((r) => r.email));
    if (email) out.push({ name: card(person, null, {}).name, email });
  }
  await audit.record(user, 'export', null, { kind, asked: keys.length, copied: out.length });
  return { people: out };
}

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * Moves someone along the selection, sets their track, or takes or drops them:
 * `changes` is { status?, track?, owner?: 'me' | 'none' }.
 */
async function update(user, key, kind, changes) {
  const found = await find(key, kind);
  const c = changes || {};
  const current = await stateOf(key, kind);
  const before = card(found, current, {});

  let status = before.status;
  if (c.status !== undefined) {
    if (!STATUSES[kind].some((s) => s.key === c.status)) throw new HttpError(400, 'Unknown status');
    if (c.status === 'matched')
      throw new HttpError(400, 'Matched is set by pairing a mentor and a mentee');
    if (before.status === 'matched' && c.status !== 'matched') {
      const { rows } = await db.query(
        `select 1 from crm_matches where status = 'active' and (mentor_key = $1 or mentee_key = $1)`,
        [key]
      );
      if (rows.length) throw new HttpError(409, 'End the pairing first');
    }
    status = c.status;
  }
  let track = current ? current.track : null;
  if (c.track !== undefined) {
    if (c.track !== null && !TRACK_KEYS.includes(c.track))
      throw new HttpError(400, 'Unknown track');
    track = c.track;
  }
  let ownerId = current ? current.owner_id : null;
  if (c.owner === 'me') ownerId = user.kind === 'admin' ? null : user.id;
  else if (c.owner === 'none') ownerId = null;
  else if (c.owner !== undefined) throw new HttpError(400, 'Invalid owner');

  await db.query(
    `insert into crm_people_state (person_key, kind, status, track, owner_id, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (person_key, kind) do update set status = excluded.status, track = excluded.track,
       owner_id = excluded.owner_id, updated_by = excluded.updated_by, updated_at = now()`,
    [key, kind, status, track, ownerId, user.kind === 'admin' ? null : user.id]
  );
  const detail = { kind };
  if (status !== before.status) Object.assign(detail, { from: before.status, to: status });
  if (c.track !== undefined) detail.track = track;
  if (c.owner !== undefined) detail.owner = c.owner;
  await audit.record(user, 'set-status', key, detail);
  // What the board's card needs, so the page updates it without reloading.
  const after = card(found, await stateOf(key, kind), {});
  return { status: after.status, track: after.track, owner: after.owner, ownerId: after.ownerId };
}

async function addNote(user, key, kind, body) {
  await find(key, kind);
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, 'Write the note first');
  if (text.length > MAX_NOTE)
    throw new HttpError(400, `A note can be at most ${MAX_NOTE} characters`);
  await db.query(
    'insert into crm_notes (person_key, body_encrypted, author_id, author_name) values ($1, $2, $3, $4)',
    [key, crm.encrypt(text, key), user.kind === 'admin' ? null : user.id, user.name]
  );
  await audit.record(user, 'add-note', key, { kind });
}

/** Pairs a selected mentor with a selected mentee on a track. */
async function createMatch(user, mentorKey, menteeKey, trackKey) {
  if (!['projects', 'orientation'].includes(trackKey)) throw new HttpError(400, 'Choose the track');
  checkKey(mentorKey, 'mentor');
  checkKey(menteeKey, 'mentee');
  const { people } = await gather();
  const all = await states();
  const mentor = people.get(`mentor:${mentorKey}`);
  const mentee = people.get(`mentee:${menteeKey}`);
  if (!mentor || !mentee) throw new HttpError(404, 'Not on the board (any more)');
  const m = card(mentor, all.get(`mentor:${mentorKey}`), {});
  const e = card(mentee, all.get(`mentee:${menteeKey}`), {});
  if (!['selected', 'matched'].includes(m.status))
    throw new HttpError(409, `${m.name} is not selected as a mentor yet`);
  if (e.status !== 'selected')
    throw new HttpError(409, `${e.name} is not selected as a mentee yet`);
  const fits = (t) => !t || t === 'both' || t === trackKey;
  if (!fits(m.track)) throw new HttpError(409, `${m.name} is not on this track`);
  if (!fits(e.track)) throw new HttpError(409, `${e.name} is not on this track`);

  const { rows: active } = await db.query(
    `select count(*)::int as n from crm_matches where status = 'active' and mentor_key = $1`,
    [mentorKey]
  );
  let id;
  try {
    id = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `insert into crm_matches (mentor_key, mentee_key, track, created_by)
         values ($1, $2, $3, $4) returning id`,
        [mentorKey, menteeKey, trackKey, user.kind === 'admin' ? null : user.id]
      );
      for (const [key, kind, track] of [
        [mentorKey, 'mentor', m.track],
        [menteeKey, 'mentee', e.track],
      ]) {
        await tx.query(
          `insert into crm_people_state (person_key, kind, status, track, updated_at)
           values ($1, $2, 'matched', $3, now())
           on conflict (person_key, kind) do update set status = 'matched', updated_at = now()`,
          [key, kind, track]
        );
      }
      return rows[0].id;
    });
  } catch (err) {
    if (err && (err.code === '23505' || /unique/i.test(err.message || ''))) {
      throw new HttpError(409, `${e.name} already has a mentor`);
    }
    throw err;
  }
  await audit.record(user, 'set-match', mentorKey, {
    action: 'create',
    role: 'mentor',
    track: trackKey,
  });
  await audit.record(user, 'set-match', menteeKey, {
    action: 'create',
    role: 'mentee',
    track: trackKey,
  });
  return { id, overCapacity: Boolean(m.capacity) && active[0].n + 1 > m.capacity };
}

/** Ends a pairing: both go back to Selected (the mentor only if no other pair). */
async function endMatch(user, matchId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(matchId || ''))) throw new HttpError(400, 'Invalid pairing');
  const { rows } = await db.query(`select * from crm_matches where id = $1 and status = 'active'`, [
    matchId,
  ]);
  if (!rows.length) throw new HttpError(404, 'No such active pairing');
  const match = rows[0];
  await db.transaction(async (tx) => {
    await tx.query(`update crm_matches set status = 'ended', ended_at = now() where id = $1`, [
      matchId,
    ]);
    await tx.query(
      `update crm_people_state set status = 'selected', updated_at = now() where person_key = $1 and kind = 'mentee'`,
      [match.mentee_key]
    );
    const { rows: left } = await tx.query(
      `select 1 from crm_matches where status = 'active' and mentor_key = $1`,
      [match.mentor_key]
    );
    if (!left.length) {
      await tx.query(
        `update crm_people_state set status = 'selected', updated_at = now() where person_key = $1 and kind = 'mentor'`,
        [match.mentor_key]
      );
    }
  });
  await audit.record(user, 'set-match', match.mentor_key, {
    action: 'end',
    role: 'mentor',
    track: match.track,
  });
  await audit.record(user, 'set-match', match.mentee_key, {
    action: 'end',
    role: 'mentee',
    track: match.track,
  });
}

// The fields of a mentor to contact the board's "Add" takes (sources.js).
const PROSPECT_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'social',
  'org',
  'career',
  'track',
  'referrer',
  'notes',
];

/** Adds a mentor to contact, by hand. Returns { key, kind }. */
async function addProspect(user, body) {
  const b = body || {};
  const fields = {};
  for (const f of PROSPECT_FIELDS) {
    const value = String(b[f] == null ? '' : b[f]).trim();
    if (value.length > 500) throw new HttpError(400, `${f}: at most 500 characters`);
    fields[f] = value;
  }
  if (!fields.first_name && !fields.last_name) throw new HttpError(400, 'Write the name');
  const record = sources.toRecord('mentors_prospective', fields);
  if (!record.key) throw new HttpError(400, 'Enter a valid email: the board finds people by it');
  await records.add('mentors_prospective', fields, { origin: 'board', user });
  await audit.record(user, 'crm-add', record.key, { source: 'mentors_prospective' });
  return { key: record.key, kind: 'mentor' };
}

module.exports = {
  STATUSES,
  PROSPECT_FIELDS,
  addProspect,
  TRACKS,
  trackOf,
  kindsOf,
  yes,
  board,
  applicants,
  person,
  update,
  addNote,
  createMatch,
  endMatch,
  saveSite,
  saveEntry,
  publish,
  unpublish,
  publicExport,
  photoOf,
  snapshotData,
  siteEntry,
  siteYaml,
  emails,
};
