// The mentorship board: mentors and mentees, where each is in the selection,
// the team's notes, and who is paired with whom.
//
// Who people are comes from the sheets (server/crm/sources.js), read each time
// and never stored; the three lists are joined by the opaque person key, so
// someone who appears in two of them is one card. What the team decides
// (status, track, who follows them, notes, pairs) is stored by key only.
// Every function here assumes access.authorize(user, 'mentorship')
// has already been called by the API.

const db = require('../db');
const { HttpError } = require('../http');
const sources = require('./sources');
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
  mentee: [
    { key: 'interested', label: 'Interested' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'applied', label: 'Applied' },
    { key: 'selected', label: 'Selected' },
    { key: 'matched', label: 'Matched' },
    { key: 'declined', label: 'Declined' },
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

/** An expression of interest says "Mentor", "Mentee" or both. */
function kindsOf(applyingAs) {
  const t = sources.norm(applyingAs);
  const kinds = [];
  if (/mentor/.test(t)) kinds.push('mentor');
  if (/mentee/.test(t) || !kinds.length) kinds.push('mentee');
  return kinds;
}

const first = (...values) => values.find((v) => v && String(v).trim()) || '';

// ── Reading the sheets into people ───────────────────────────────────────────

/**
 * Everyone in the three lists: { people: Map("kind:key" -> person),
 * unlinked: rows without an email, problems: sources that could not be read
 * or lost a column }.
 */
async function gather() {
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

  for (const sourceId of Object.keys(sources.SOURCES)) {
    let loaded;
    try {
      loaded = await sources.load(sourceId);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push({
        source: sourceId,
        label: sources.SOURCES[sourceId].label,
        message: err.message,
      });
      continue;
    }
    if (loaded.missing.length) {
      problems.push({
        source: sourceId,
        label: sources.SOURCES[sourceId].label,
        message: `Columns not found: ${loaded.missing.join(', ')}`,
      });
    }
    for (const record of loaded.records) {
      if (sourceId === 'mentees_interest') {
        kindsOf(record.applying_as).forEach((kind) => add(kind, sourceId, record));
      } else {
        add('mentor', sourceId, record);
      }
    }
  }
  return { people, unlinked, problems };
}

/** What the sheets alone say about where someone is. */
function derivedStatus(person) {
  const r = person.records;
  if (person.kind === 'mentor') {
    if (r.mentors_applications) return 'applied';
    if (r.mentors_prospective && yes(r.mentors_prospective.replied)) return 'replied';
    if (r.mentees_interest) return 'replied';
    if (r.mentors_prospective && yes(r.mentors_prospective.contacted)) return 'contacted';
    return 'to_contact';
  }
  if (r.mentees_interest && yes(r.mentees_interest.contacted)) return 'contacted';
  return 'interested';
}

/** The card: what the board shows for a person, without contact details. */
function card(person, state, extra) {
  const r = person.records;
  const app = r.mentors_applications || {};
  const prospect = r.mentors_prospective || {};
  const interest = r.mentees_interest || {};
  return {
    key: person.key,
    kind: person.kind,
    name: first(app.name, interest.name, prospect.name) || '(no name)',
    org: first(
      app.role,
      prospect.org,
      [interest.role, interest.affiliation].filter(Boolean).join(', ')
    ),
    track: (state && state.track) || trackOf(first(app.tracks, prospect.track, interest.tracks)),
    areas: first(app.areas, interest.areas, prospect.notes),
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

/** The whole board for the page. */
async function board(user) {
  const { people, unlinked, problems } = await gather();
  const [state, notes, matches] = await Promise.all([states(), noteCounts(), activeMatches()]);
  const matchCount = new Map();
  matches.forEach((m) => {
    matchCount.set(`mentor:${m.mentor_key}`, (matchCount.get(`mentor:${m.mentor_key}`) || 0) + 1);
    matchCount.set(`mentee:${m.mentee_key}`, 1);
  });
  const cards = [...people.entries()].map(([id, person]) =>
    card(person, state.get(id), { notes: notes.get(person.key), matches: matchCount.get(id) })
  );
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
        name: names.get(`mentor:${m.mentor_key}`) || '(no longer in the sheets)',
      },
      mentee: {
        key: m.mentee_key,
        name: names.get(`mentee:${m.mentee_key}`) || '(no longer in the sheets)',
      },
    })),
    unlinked,
    problems,
    me: user.id,
  };
}

// ── One person ───────────────────────────────────────────────────────────────

function checkKey(key, kind) {
  if (!KEY.test(String(key || ''))) throw new HttpError(400, 'Invalid person');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Invalid kind');
}

async function find(key, kind) {
  checkKey(key, kind);
  const { people } = await gather();
  const person = people.get(`${kind}:${key}`);
  if (!person) throw new HttpError(404, 'Not in the sheets (any more)');
  return person;
}

/** Everything about one person, with fields cut to what `perms` may read. */
async function person(user, perms, key, kind) {
  const found = await find(key, kind);
  const state = (await states()).get(`${kind}:${key}`);
  const card_ = card(found, state, {});
  const sheetsView = Object.entries(found.records).map(([sourceId, record]) => {
    // The key is dropped on purpose: it is the lookup id, not a field to show.
    // eslint-disable-next-line no-unused-vars
    const { key: _key, row, ...fields } = record;
    const shown = access.redact(fields, perms);
    // Only what has an answer.
    Object.keys(shown).forEach((f) => !shown[f] && delete shown[f]);
    return { source: sourceId, label: sources.SOURCES[sourceId].label, row, fields: shown };
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
  const { rows: matchRows } = await db.query(
    `select id, mentor_key, mentee_key, track, status, created_at, ended_at from crm_matches
     where mentor_key = $1 or mentee_key = $1 order by created_at desc`,
    [key]
  );
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
    matches: matchRows.map((m) => ({
      id: m.id,
      track: m.track,
      status: m.status,
      createdAt: m.created_at,
      endedAt: m.ended_at,
      otherKey: m.mentor_key === key ? m.mentee_key : m.mentor_key,
    })),
    history: await audit.recent({ subjectKey: key, limit: 40 }),
  };
}

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * Moves someone along the selection, sets their track, or takes or drops them:
 * `changes` is { status?, track?, owner?: 'me' | 'none' }.
 */
async function update(user, key, kind, changes) {
  const found = await find(key, kind);
  const c = changes || {};
  const all = await states();
  const current = all.get(`${kind}:${key}`);
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
  return { status, track };
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
  if (!mentor || !mentee) throw new HttpError(404, 'Not in the sheets (any more)');
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

module.exports = {
  STATUSES,
  TRACKS,
  trackOf,
  kindsOf,
  yes,
  board,
  person,
  update,
  addNote,
  createMatch,
  endMatch,
};
