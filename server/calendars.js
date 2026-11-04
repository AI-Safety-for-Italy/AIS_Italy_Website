// The calendar (/app/calendar/): sub-calendars, their events, who comes, and
// each member's choice of what to follow. What the API in
// server/routes/app/calendar.js and the public api/calendar.js call into.
//
// Who may do what, per calendar (levelOf):
//   view    sees its events (and answers going / maybe / no);
//   edit    also creates, changes and deletes every event in it;
//   manage  also changes the calendar itself: name, colour, who has access,
//           its Discord announcements; archives it.
// Each level is given to every member, to Discord roles and to people by
// name; a higher one includes the lower ones. A public calendar is also seen
// by anyone, signed in or not. Whoever created a calendar manages it; the
// `calendar_admin` key manages them all, and `calendar_create` may create
// new ones (server/permissions.js).
//
// The seminars and events of the site (server/content.js) and the chosen time
// of a meeting poll (server/polls.js) each land in a calendar if asked to: the
// calendar keeps a copy, changed from there only (source, source_id).

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const permissions = require('./permissions');
const recurrence = require('./recurrence');
const timeOf = require('./calendar-expand');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_ID = /^[\w-]{1,40}$/;
const CHANNEL_ID = /^(\d{5,25}|dev-[\w-]{1,30})$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const LEVELS = ['view', 'edit', 'manage'];
const RANK = { public: 0, view: 1, edit: 2, manage: 3 };
const MAX_SHARED = 50;
const MAX_CALENDARS = 100;
// The lead times offered for reminders and announcements, in minutes.
const LEAD_TIMES = [0, 5, 10, 15, 30, 60, 120, 180, 1440, 2880, 10080];
const MAX_RANGE_DAYS = 400;
const MAX_EVENT_DAYS = 62;

// The palette offered for a calendar's colour (the page shows these).
const COLORS = [
  '#00703a',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#0d9488',
  '#0891b2',
  '#4b5563',
];

const newToken = () => crypto.randomBytes(24).toString('base64url');

// ── Validation ──────────────────────────────────────────────────────────────

function fail(message, field) {
  return new HttpError(400, message, field ? { field } : undefined);
}

function text(value, field, label, { max, required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw fail(`${label} is required`, field);
  if (s.length > max) throw fail(`${label} is too long (at most ${max} characters)`, field);
  return s;
}

function uuid(value, what = 'id') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(404, `Unknown ${what}`);
  return value;
}

function timezone(value) {
  const tz = typeof value === 'string' && value ? value.slice(0, 64) : 'Europe/Rome';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw fail('Unknown time zone', 'timezone');
  }
  return tz;
}

function instant(value, field, label) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) {
    throw fail(`${label} is not a valid date`, field);
  }
  return d;
}

function dateOnly(value, field, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fail(`${label} is not a valid day`, field);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw fail(`${label} is not a valid day`, field);
  }
  return d;
}

function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** One level's access from a request: { all, roles: [{ id, name }], people: [{ discordId, name }] }. */
function cleanLevel(value, level) {
  const v = value || {};
  const list = (items, key, field) => {
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items)) throw fail('Expected a list', field);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const id = String((item && item[key]) || '');
      if (!SHARE_ID.test(id)) throw fail('Unknown entry', field);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        [key]: id,
        name: String((item && item.name) || id)
          .trim()
          .slice(0, 100),
      });
    }
    if (out.length > MAX_SHARED) throw fail(`At most ${MAX_SHARED}`, field);
    return out;
  };
  return {
    all: Boolean(v.all),
    roles: list(v.roles, 'id', `${level}.roles`),
    people: list(v.people, 'discordId', `${level}.people`),
  };
}

/** Announcements in Discord channels: [{ channelId, name, minutes: [] }] (null: none given). */
function cleanAnnounce(value, field = 'announce') {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw fail('Expected a list of channels', field);
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const channelId = String((item && item.channelId) || '');
    if (!CHANNEL_ID.test(channelId)) throw fail('Unknown Discord channel', field);
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    const minutes = leadTimes(item.minutes, field);
    if (!minutes.length) throw fail('Choose when each channel hears of the event', field);
    out.push({
      channelId,
      name: String(item.name || channelId)
        .replace(/^#/, '')
        .trim()
        .slice(0, 100),
      minutes,
    });
  }
  if (out.length > 5) throw fail('At most 5 channels', field);
  return out;
}

function leadTimes(value, field) {
  const list = Array.isArray(value) ? value.map(Number) : [];
  if (list.some((m) => !LEAD_TIMES.includes(m))) throw fail('Unknown reminder time', field);
  return [...new Set(list)].sort((a, b) => b - a).slice(0, 4);
}

/** Reminders to the followers: [{ minutes, channels: ['discord', 'email'] }]. */
function cleanReminders(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail('Expected a list of reminders', 'reminders');
  const out = [];
  const seen = new Set();
  for (const r of value) {
    const minutes = Number(r && r.minutes);
    if (!LEAD_TIMES.includes(minutes)) throw fail('Unknown reminder time', 'reminders');
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    const channels = ['discord', 'email'].filter(
      (c) => Array.isArray(r.channels) && r.channels.includes(c)
    );
    if (!channels.length) throw fail('A reminder goes on Discord, by email or both', 'reminders');
    out.push({ minutes, channels });
  }
  if (out.length > 4) throw fail('At most 4 reminders', 'reminders');
  return out.sort((a, b) => b.minutes - a.minutes);
}

/** The video call: { kind: 'link', url } or { kind: 'discord', channelId, name }, or null. */
function cleanVideo(value) {
  if (!value || !value.kind) return { kind: null, url: '', channelId: null, channelName: null };
  if (value.kind === 'link') {
    const url = text(value.url, 'video', 'The video call link', { max: 1000 });
    if (!url) return { kind: null, url: '', channelId: null, channelName: null };
    if (!/^https:\/\/[^\s"<>]+$/i.test(url))
      throw fail('The video call link must start with https://', 'video');
    return { kind: 'link', url, channelId: null, channelName: null };
  }
  if (value.kind === 'discord') {
    const channelId = String(value.channelId || '');
    if (!CHANNEL_ID.test(channelId)) throw fail('Choose a voice channel', 'video');
    return {
      kind: 'discord',
      url: '',
      channelId,
      channelName: String(value.name || channelId).slice(0, 100),
    };
  }
  throw fail('Unknown kind of video call', 'video');
}

/** The times of an event from a request: { startsAt, endsAt, allDay, timezone }. */
function cleanTimes(b) {
  const allDay = Boolean(b.allDay);
  const tz = timezone(b.timezone);
  let startsAt;
  let endsAt;
  if (allDay) {
    startsAt = dateOnly(b.startDate, 'startDate', 'The first day');
    const last = dateOnly(b.endDate || b.startDate, 'endDate', 'The last day');
    endsAt = new Date(last.getTime() + 86400000);
  } else {
    startsAt = instant(b.start, 'start', 'The start');
    endsAt = instant(b.end, 'end', 'The end');
  }
  if (endsAt <= startsAt) throw fail('The end must come after the start', 'end');
  if (endsAt - startsAt > MAX_EVENT_DAYS * 86400000)
    throw fail(`An event lasts at most ${MAX_EVENT_DAYS} days`, 'end');
  return { startsAt, endsAt, allDay, timezone: tz };
}

/** An event's fields from a request (the calendar apart). */
function cleanEvent(body) {
  const b = body || {};
  const video = cleanVideo(b.video);
  return {
    title: text(b.title, 'title', 'Title', { max: 200, required: true }),
    description: text(b.description, 'description', 'Description', { max: 8000 }),
    location: text(b.location, 'location', 'Place', { max: 500 }),
    video,
    ...cleanTimes(b),
    recurrence: recurrence.validate(b.recurrence, { daily: true }),
    reminders: cleanReminders(b.reminders),
    announce: cleanAnnounce(b.announce === undefined ? null : b.announce),
  };
}

// ── Who may do what ─────────────────────────────────────────────────────────

/** Who is asking: { user, roles, discordId, perms }, read once per request. */
async function whoIs(user) {
  if (!user) return { user: null, roles: [], discordId: null, perms: [] };
  const perms = await permissions.forUser(user);
  if (user.kind !== 'discord') return { user, roles: [], discordId: null, perms };
  const row = await permissions.rowOf(user);
  return {
    user,
    roles: (row && row.roles) || [],
    discordId: (row && row.discord_id) || null,
    perms,
  };
}

function holds(cal, level, who) {
  if (!who.user) return false;
  if (cal[`${level}_all`]) return true;
  if ((cal[`${level}_roles`] || []).some((r) => who.roles.includes(r.id))) return true;
  return (
    Boolean(who.discordId) &&
    (cal[`${level}_people`] || []).some((p) => p.discordId === who.discordId)
  );
}

/** 'manage' | 'edit' | 'view' | 'public' | null: what `who` may do with `cal`. */
function levelOf(cal, who) {
  if (who.user) {
    if (who.perms.includes('calendar_admin')) return 'manage';
    if (cal.owner_id && cal.owner_id === who.user.id) return 'manage';
    for (const level of ['manage', 'edit', 'view']) if (holds(cal, level, who)) return level;
  }
  return cal.is_public ? 'public' : null;
}

function atLeast(level, wanted) {
  return level !== null && RANK[level] >= RANK[wanted];
}

function canCreate(who) {
  return who.perms.includes('calendar_create') || who.perms.includes('calendar_admin');
}

async function loadCalendar(id, q = db) {
  const { rows } = await q.query('select * from calendars where id = $1', [uuid(id, 'calendar')]);
  if (!rows.length) throw new HttpError(404, 'Calendar not found');
  return rows[0];
}

/**
 * A calendar `who` may use at `wanted` or more. One they cannot even see is
 * reported as missing, so ids reveal nothing.
 */
async function calendarFor(id, who, wanted) {
  const cal = await loadCalendar(id);
  const level = levelOf(cal, who);
  if (level === null || (cal.archived_at && !atLeast(level, 'manage')))
    throw new HttpError(404, 'Calendar not found');
  if (!atLeast(level, wanted)) {
    throw new HttpError(
      403,
      wanted === 'manage'
        ? 'Only who manages this calendar can change it'
        : 'You can see this calendar but not add to it'
    );
  }
  return { cal, level };
}

// ── Calendars ───────────────────────────────────────────────────────────────

function accessOut(cal) {
  const out = {};
  LEVELS.forEach((level) => {
    out[level] = {
      all: cal[`${level}_all`],
      roles: cal[`${level}_roles`] || [],
      people: cal[`${level}_people`] || [],
    };
  });
  return out;
}

function calendarOut(cal, level, owners = {}) {
  const manage = atLeast(level, 'manage');
  return {
    id: cal.id,
    slug: cal.slug,
    name: cal.name,
    description: cal.description,
    color: cal.color,
    timezone: cal.timezone,
    isPublic: cal.is_public,
    system: cal.system_key || null,
    archived: Boolean(cal.archived_at),
    level,
    canEdit: atLeast(level, 'edit'),
    canManage: manage,
    owner: cal.owner_id && owners[cal.owner_id] ? owners[cal.owner_id] : null,
    // Who has access, and the announcements: for those who change them.
    access: manage ? accessOut(cal) : undefined,
    announce: atLeast(level, 'edit') ? cal.announce || [] : undefined,
  };
}

async function ownerNames(cals) {
  const ids = [...new Set(cals.map((c) => c.owner_id).filter(Boolean))];
  if (!ids.length) return {};
  const { rows } = await db.query(
    'select id, name, avatar_url from app_users where id = any($1::uuid[])',
    [ids]
  );
  return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, avatarUrl: r.avatar_url }]));
}

/** Every calendar `who` sees, with their level: [{ cal, level }]. */
async function visible(who, { archived = false } = {}) {
  const { rows } = await db.query(
    `select * from calendars order by case system_key when 'seminars' then 0 when 'events' then 1 else 2 end, lower(name)`
  );
  return rows
    .map((cal) => ({ cal, level: levelOf(cal, who) }))
    .filter(
      ({ cal, level }) =>
        level !== null && (!cal.archived_at || (archived && atLeast(level, 'manage')))
    );
}

/** The calendars of the Calendars page and the sidebar: { calendars, canCreate, colors }. */
async function listCalendars(user) {
  await ensureContentBackfill();
  const who = await whoIs(user);
  const list = await visible(who, { archived: true });
  const owners = await ownerNames(list.map((x) => x.cal));
  return {
    calendars: list.map(({ cal, level }) => calendarOut(cal, level, owners)),
    canCreate: canCreate(who),
    isAdmin: who.perms.includes('calendar_admin'),
    colors: COLORS,
    leadTimes: LEAD_TIMES,
  };
}

async function freeSlug(name, q = db) {
  const base = slugify(name) || 'calendar';
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { rows } = await q.query('select 1 from calendars where slug = $1', [slug]);
    if (!rows.length) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function cleanCalendar(body, previous) {
  const b = body || {};
  const p = previous || {};
  const color = b.color === undefined ? p.color || COLORS[0] : String(b.color);
  if (!COLOR.test(color)) throw fail('Choose a colour', 'color');
  return {
    name: b.name === undefined ? p.name : text(b.name, 'name', 'Name', { max: 80, required: true }),
    description:
      b.description === undefined
        ? p.description || ''
        : text(b.description, 'description', 'Description', { max: 1000 }),
    color: color.toLowerCase(),
    timezone: b.timezone === undefined ? p.timezone || 'Europe/Rome' : timezone(b.timezone),
    isPublic: b.isPublic === undefined ? Boolean(p.is_public) : Boolean(b.isPublic),
  };
}

function levelsFrom(body, previous) {
  const access = (body && body.access) || {};
  const out = {};
  LEVELS.forEach((level) => {
    out[level] =
      access[level] === undefined && previous
        ? {
            all: previous[`${level}_all`],
            roles: previous[`${level}_roles`],
            people: previous[`${level}_people`],
          }
        : cleanLevel(access[level], level);
  });
  return out;
}

/** A new calendar, managed by its creator (calendar_create). */
async function createCalendar(user, body) {
  await permissions.refreshRoles(user);
  const who = await whoIs(user);
  if (!canCreate(who))
    throw new HttpError(403, 'Your Discord roles do not allow creating calendars');
  const { rows: count } = await db.query('select count(*)::int as n from calendars');
  if (count[0].n >= MAX_CALENDARS) throw fail(`At most ${MAX_CALENDARS} calendars`);
  const fields = cleanCalendar(body);
  if (!fields.name) throw fail('Name is required', 'name');
  const access = levelsFrom(body && body.access ? body : { access: { view: { all: true } } }, null);
  const announce = cleanAnnounce((body && body.announce) || []);
  const slug = await freeSlug(fields.name);
  const { rows } = await db.query(
    `insert into calendars (slug, name, description, color, timezone, is_public,
       view_all, view_roles, view_people, edit_all, edit_roles, edit_people,
       manage_all, manage_roles, manage_people, announce, owner_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning *`,
    [
      slug,
      fields.name,
      fields.description,
      fields.color,
      fields.timezone,
      fields.isPublic,
      access.view.all,
      JSON.stringify(access.view.roles),
      JSON.stringify(access.view.people),
      access.edit.all,
      JSON.stringify(access.edit.roles),
      JSON.stringify(access.edit.people),
      access.manage.all,
      JSON.stringify(access.manage.roles),
      JSON.stringify(access.manage.people),
      JSON.stringify(announce),
      user.kind === 'discord' ? user.id : null,
    ]
  );
  return calendarOut(rows[0], 'manage', await ownerNames(rows));
}

/** Changes a calendar: its details, who has access, its announcements (manage). */
async function updateCalendar(user, id, body) {
  await permissions.refreshRoles(user);
  const who = await whoIs(user);
  const { cal } = await calendarFor(id, who, 'manage');
  const fields = cleanCalendar(body, cal);
  const access = levelsFrom(body, cal);
  const announce = cleanAnnounce(body && body.announce);
  const { rows } = await db.query(
    `update calendars set name = $2, description = $3, color = $4, timezone = $5,
       is_public = $6, view_all = $7, view_roles = $8, view_people = $9,
       edit_all = $10, edit_roles = $11, edit_people = $12,
       manage_all = $13, manage_roles = $14, manage_people = $15,
       announce = $16, updated_at = now()
     where id = $1 returning *`,
    [
      cal.id,
      fields.name,
      fields.description,
      fields.color,
      fields.timezone,
      fields.isPublic,
      access.view.all,
      JSON.stringify(access.view.roles),
      JSON.stringify(access.view.people),
      access.edit.all,
      JSON.stringify(access.edit.roles),
      JSON.stringify(access.edit.people),
      access.manage.all,
      JSON.stringify(access.manage.roles),
      JSON.stringify(access.manage.people),
      JSON.stringify(announce === undefined || announce === null ? cal.announce : announce),
    ]
  );
  const after = rows[0];
  // Changing access may take it away from oneself: answered with what is left.
  const level = levelOf(after, await whoIs(user));
  return calendarOut(after, level || 'public', await ownerNames(rows));
}

/** Archives (hides) a calendar or brings it back (manage). The site's own stay. */
async function archiveCalendar(user, id, archived) {
  await permissions.refreshRoles(user);
  const who = await whoIs(user);
  const { cal } = await calendarFor(id, who, 'manage');
  if (cal.system_key) throw fail('The Seminars and Events calendars cannot be archived');
  const { rows } = await db.query(
    `update calendars set archived_at = $2, updated_at = now() where id = $1 returning *`,
    [cal.id, archived ? new Date() : null]
  );
  return calendarOut(rows[0], 'manage', await ownerNames(rows));
}

/** Deletes an archived calendar and its events for good (manage). */
async function deleteCalendar(user, id) {
  await permissions.refreshRoles(user);
  const who = await whoIs(user);
  const { cal } = await calendarFor(id, who, 'manage');
  if (cal.system_key) throw fail('The Seminars and Events calendars cannot be deleted');
  if (!cal.archived_at) throw fail('Archive the calendar first');
  await db.query('delete from calendars where id = $1', [cal.id]);
  return { id: cal.id, deleted: true };
}

// ── Events ──────────────────────────────────────────────────────────────────

/** Where an event copied from elsewhere is changed. */
function sourceOf(event) {
  if (event.source === 'content')
    return {
      kind: 'content',
      id: event.source_id,
      label: 'Edit in Site content',
      url: `/app/content/edit/?id=${encodeURIComponent(event.source_id)}`,
    };
  if (event.source === 'poll')
    return {
      kind: 'poll',
      id: event.source_id,
      label: 'Open the poll',
      url: `/app/polls/poll/?id=${encodeURIComponent(event.source_id)}`,
    };
  return null;
}

function videoOut(event) {
  if (event.video_kind === 'link') return { kind: 'link', url: event.video_url };
  if (event.video_kind === 'discord')
    return {
      kind: 'discord',
      channelId: event.discord_channel_id,
      name: event.discord_channel_name,
      url: require('./calendar-discord').channelLink(event.discord_channel_id),
    };
  return null;
}

/** One occurrence for the page. */
function occurrenceOut(occ, cal, level) {
  const e = occ.event;
  const seriesId = e.series_id || (e.recurrence ? e.id : null);
  return {
    id: e.id,
    seriesId,
    occurrence: occ.occurrenceStart.toISOString(),
    start: occ.start.toISOString(),
    end: occ.end.toISOString(),
    allDay: e.all_day,
    timezone: e.timezone,
    title: e.title,
    description: e.description,
    location: e.location,
    video: videoOut(e),
    calendarId: cal.id,
    color: cal.color,
    recurring: Boolean(seriesId),
    changedAlone: Boolean(e.series_id),
    recurrence: e.recurrence || null,
    source: sourceOf(e),
    canEdit: atLeast(level, 'edit') && !e.source,
    canAnswer: level !== null && level !== 'public',
  };
}

async function eventRows(calendarIds, from, to) {
  if (!calendarIds.length) return { rows: [], overrides: [] };
  const { rows } = await db.query(
    `select * from calendar_events where calendar_id = any($1::uuid[])
       and starts_at < $3 and (recurrence is not null or ends_at > $2)`,
    [calendarIds, from, to]
  );
  const series = rows.filter((r) => r.recurrence).map((r) => r.id);
  const overrides = series.length
    ? (
        await db.query(
          'select series_id, recurrence_id from calendar_events where series_id = any($1::uuid[])',
          [series]
        )
      ).rows
    : [];
  return { rows, overrides };
}

function range(query) {
  const from = instant(query.from, 'from', 'The start of the range');
  const to = instant(query.to, 'to', 'The end of the range');
  if (to <= from) throw fail('The range ends before it starts');
  if (to - from > MAX_RANGE_DAYS * 86400000) throw fail('Ask for a shorter range');
  return { from, to };
}

/**
 * The occurrences between `from` and `to` of the calendars `who` sees, those
 * of `calendarIds` only when given: [occurrence] (occurrenceOut).
 */
async function occurrencesFor(who, from, to, calendarIds) {
  const list = (await visible(who)).filter(
    ({ cal }) => !calendarIds || calendarIds.includes(cal.id)
  );
  const byId = new Map(list.map((x) => [x.cal.id, x]));
  const { rows, overrides } = await eventRows([...byId.keys()], from, to);
  return timeOf.expand(rows, from, to, overrides).map((occ) => {
    const x = byId.get(occ.event.calendar_id);
    return occurrenceOut(occ, x.cal, x.level);
  });
}

/** The dashboard's view: the occurrences of the calendars this member shows. */
async function listEvents(user, query) {
  await ensureContentBackfill();
  const who = await whoIs(user);
  const { from, to } = range(query);
  const prefs = await prefsOf(user);
  const list = await visible(who);
  const shown = list.filter(({ cal, level }) => choiceFor(prefs, cal, level).dashboard);
  const ids =
    query.calendars !== undefined
      ? String(query.calendars)
          .split(',')
          .filter((id) => list.some((x) => x.cal.id === id))
      : shown.map((x) => x.cal.id);
  return { events: await occurrencesFor(who, from, to, ids) };
}

async function loadEvent(id, q = db) {
  const { rows } = await q.query('select * from calendar_events where id = $1', [
    uuid(id, 'event'),
  ]);
  if (!rows.length) throw new HttpError(404, 'Event not found');
  return rows[0];
}

/** An event `who` may use at `wanted` or more, with its calendar and their level. */
async function eventFor(id, who, wanted) {
  const event = await loadEvent(id);
  const { cal, level } = await calendarFor(event.calendar_id, who, 'public').catch(() => {
    throw new HttpError(404, 'Event not found');
  });
  if (cal.archived_at && !atLeast(level, 'manage')) throw new HttpError(404, 'Event not found');
  // A copy is changed where it comes from, whoever asks.
  if (wanted === 'edit' && event.source)
    throw new HttpError(409, 'This event is changed where it comes from');
  if (!atLeast(level, wanted)) {
    throw new HttpError(403, 'You can see this event but not change it');
  }
  return { event, cal, level };
}

/** The occurrence of `event` starting at `occurrence` (ISO), checked against its series. */
function pickOccurrence(event, occurrence) {
  if (!event.recurrence || event.series_id) {
    return {
      event,
      start: new Date(event.starts_at),
      end: new Date(event.ends_at),
      occurrenceStart: new Date(event.series_id ? event.recurrence_id : event.starts_at),
    };
  }
  const at = occurrence ? instant(occurrence, 'occurrence', 'The occurrence') : event.starts_at;
  const ms = new Date(at).getTime();
  const found = timeOf.seriesStarts(event, ms, ms + 1).find((x) => x.at === ms);
  if (!found) throw new HttpError(404, 'This event does not happen then');
  const length = new Date(event.ends_at) - new Date(event.starts_at);
  return { event, start: new Date(ms), end: new Date(ms + length), occurrenceStart: new Date(ms) };
}

async function rsvpsOf(eventId, occurrenceStart) {
  const { rows } = await db.query(
    `select r.answer, r.user_id, u.name, u.avatar_url from calendar_rsvps r
     join app_users u on u.id = r.user_id
     where r.event_id = $1 and r.occurrence_start = $2 order by r.updated_at`,
    [eventId, occurrenceStart]
  );
  return rows;
}

/** One occurrence with who comes, its reminders and announcements: for its card. */
async function getEvent(user, id, occurrence) {
  const who = await whoIs(user);
  const { event, cal, level } = await eventFor(id, who, 'public');
  const occ = pickOccurrence(event, occurrence);
  const out = occurrenceOut(occ, cal, level);
  const answers = await rsvpsOf(event.id, occ.occurrenceStart);
  const mine = answers.find((a) => a.user_id === user.id);
  const { rows: by } = await db.query('select name from app_users where id = $1', [
    event.created_by,
  ]);
  // An occurrence changed on its own still shows its series' rhythm.
  const series = event.series_id ? await loadEvent(event.series_id).catch(() => null) : null;
  return {
    ...out,
    recurrence: series ? series.recurrence : out.recurrence,
    calendar: { id: cal.id, name: cal.name, color: cal.color },
    createdBy: by[0] ? by[0].name : null,
    rsvp: {
      mine: mine ? mine.answer : null,
      counts: {
        yes: answers.filter((a) => a.answer === 'yes').length,
        maybe: answers.filter((a) => a.answer === 'maybe').length,
        no: answers.filter((a) => a.answer === 'no').length,
      },
      people: answers.map((a) => ({ name: a.name, avatarUrl: a.avatar_url, answer: a.answer })),
    },
    reminders: event.reminders || [],
    announce: atLeast(level, 'edit') ? event.announce : undefined,
    calendarAnnounce: atLeast(level, 'edit') ? cal.announce || [] : undefined,
  };
}

function eventValues(f) {
  return [
    f.title,
    f.description,
    f.location,
    f.video.kind,
    f.video.url,
    f.video.channelId,
    f.video.channelName,
    f.startsAt,
    f.endsAt,
    f.allDay,
    f.timezone,
    f.recurrence ? JSON.stringify(f.recurrence) : null,
    JSON.stringify(f.reminders),
    f.announce === null || f.announce === undefined ? null : JSON.stringify(f.announce),
  ];
}

const EVENT_COLUMNS = `title, description, location, video_kind, video_url, discord_channel_id,
  discord_channel_name, starts_at, ends_at, all_day, timezone, recurrence, reminders, announce`;

/** A new event in a calendar this member edits. */
async function createEvent(user, body) {
  await permissions.refreshIfStale(user);
  const who = await whoIs(user);
  const { cal } = await calendarFor((body || {}).calendarId, who, 'edit');
  const f = cleanEvent(body);
  const { rows } = await db.query(
    `insert into calendar_events (calendar_id, ${EVENT_COLUMNS}, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     returning *`,
    [cal.id, ...eventValues(f), user.kind === 'discord' ? user.id : null]
  );
  return { id: rows[0].id, occurrence: rows[0].starts_at };
}

/**
 * The series an event belongs to, and which of its starts is meant: for an
 * occurrence changed on its own, its series and the start it replaces.
 */
async function seriesOf(event, occurrence) {
  if (event.series_id) {
    return { master: await loadEvent(event.series_id), at: new Date(event.recurrence_id) };
  }
  return {
    master: event,
    at: event.recurrence ? pickOccurrence(event, occurrence).occurrenceStart : null,
  };
}

/** The recurrence of a series cut to end the day before `at`. */
function endBefore(master, at) {
  const tz = timeOf.zoneOf(master);
  const until = timeOf.dayBefore(timeOf.localDate(at, tz));
  return { ...master.recurrence, until, count: null };
}

/**
 * Changes an event. For a repeating one, `scope` says which: 'this'
 * occurrence (then changed on its own), 'following' (the series is cut there
 * and a new one starts) or 'all' (the series, moved by as much as this
 * occurrence was).
 */
async function updateEvent(user, id, body, { scope = 'all', occurrence } = {}) {
  await permissions.refreshIfStale(user);
  const who = await whoIs(user);
  const { event } = await eventFor(id, who, 'edit');
  const b = body || {};
  // Moving it to another calendar takes edit there too.
  let calendarId = event.calendar_id;
  if (b.calendarId && b.calendarId !== event.calendar_id) {
    calendarId = (await calendarFor(b.calendarId, who, 'edit')).cal.id;
  }
  const f = cleanEvent(b);
  const by = user.kind === 'discord' ? user.id : null;
  const isSeries = Boolean(event.recurrence || event.series_id);

  if (!isSeries || (event.series_id && scope === 'this')) {
    // A single event, or an occurrence already changed on its own.
    if (event.series_id) f.recurrence = null;
    await db.query(
      `update calendar_events set calendar_id = $1, (${EVENT_COLUMNS}) =
         ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15),
         sequence = sequence + 1, updated_by = $16, updated_at = now()
       where id = $17`,
      [calendarId, ...eventValues(f), by, event.id]
    );
    return { id: event.id };
  }

  const { master, at } = await seriesOf(event, occurrence);
  if (scope === 'this') {
    f.recurrence = null;
    const { rows } = await db.query(
      `insert into calendar_events (calendar_id, ${EVENT_COLUMNS}, series_id, recurrence_id,
         created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
       returning id`,
      [master.calendar_id, ...eventValues(f), master.id, at, by]
    );
    await db.query(
      'update calendar_events set sequence = sequence + 1, updated_at = now() where id = $1',
      [master.id]
    );
    return { id: rows[0].id };
  }

  if (scope === 'following' && at.getTime() > new Date(master.starts_at).getTime()) {
    // The old series ends the day before; the new one starts with this occurrence.
    return db.transaction(async (tx) => {
      await tx.query(
        `update calendar_events set recurrence = $2, sequence = sequence + 1,
           updated_by = $3, updated_at = now() where id = $1`,
        [master.id, JSON.stringify(endBefore(master, at)), by]
      );
      await tx.query('delete from calendar_events where series_id = $1 and recurrence_id >= $2', [
        master.id,
        at,
      ]);
      const { rows } = await tx.query(
        `insert into calendar_events (calendar_id, ${EVENT_COLUMNS}, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
         returning id`,
        [calendarId, ...eventValues(f), by]
      );
      return { id: rows[0].id };
    });
  }

  // The whole series: moved by as much as this occurrence was.
  const shift = f.startsAt.getTime() - at.getTime();
  const length = f.endsAt.getTime() - f.startsAt.getTime();
  f.startsAt = new Date(new Date(master.starts_at).getTime() + shift);
  f.endsAt = new Date(f.startsAt.getTime() + length);
  await db.transaction(async (tx) => {
    await tx.query(
      `update calendar_events set calendar_id = $1, (${EVENT_COLUMNS}) =
         ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15),
         exdates = case when $18 then '[]'::jsonb else exdates end,
         sequence = sequence + 1, updated_by = $16, updated_at = now()
       where id = $17`,
      [calendarId, ...eventValues(f), by, master.id, shift !== 0]
    );
    await tx.query('update calendar_events set calendar_id = $2 where series_id = $1', [
      master.id,
      calendarId,
    ]);
    // Moved in time, the occurrences changed on their own no longer match it.
    if (shift !== 0)
      await tx.query('delete from calendar_events where series_id = $1', [master.id]);
  });
  return { id: master.id };
}

/** Deletes an event; for a repeating one, `scope` as in updateEvent. */
async function deleteEvent(user, id, { scope = 'all', occurrence } = {}) {
  await permissions.refreshIfStale(user);
  const who = await whoIs(user);
  const { event } = await eventFor(id, who, 'edit');
  if (!event.recurrence && !event.series_id) {
    await db.query('delete from calendar_events where id = $1', [event.id]);
    return { deleted: true };
  }
  const { master, at } = await seriesOf(event, occurrence);
  if (scope === 'this') {
    const skipped = [...new Set([...(master.exdates || []), at.toISOString()])];
    await db.transaction(async (tx) => {
      await tx.query(
        `update calendar_events set exdates = $2, sequence = sequence + 1, updated_at = now()
         where id = $1`,
        [master.id, JSON.stringify(skipped)]
      );
      await tx.query('delete from calendar_events where series_id = $1 and recurrence_id = $2', [
        master.id,
        at,
      ]);
    });
    return { deleted: true };
  }
  if (scope === 'following' && at.getTime() > new Date(master.starts_at).getTime()) {
    await db.transaction(async (tx) => {
      await tx.query(
        `update calendar_events set recurrence = $2, sequence = sequence + 1, updated_at = now()
         where id = $1`,
        [master.id, JSON.stringify(endBefore(master, at))]
      );
      await tx.query('delete from calendar_events where series_id = $1 and recurrence_id >= $2', [
        master.id,
        at,
      ]);
    });
    return { deleted: true };
  }
  await db.query('delete from calendar_events where id = $1', [master.id]);
  return { deleted: true };
}

/** This member comes to an occurrence, maybe, or not (null takes the answer back). */
async function rsvp(user, id, occurrence, answer) {
  const who = await whoIs(user);
  const { event } = await eventFor(id, who, 'view');
  if (user.kind !== 'discord') throw fail('Sign in with Discord to answer');
  const occ = pickOccurrence(event, occurrence);
  if (answer === null || answer === undefined || answer === '') {
    await db.query(
      'delete from calendar_rsvps where event_id = $1 and occurrence_start = $2 and user_id = $3',
      [event.id, occ.occurrenceStart, user.id]
    );
  } else {
    if (!['yes', 'maybe', 'no'].includes(answer)) throw fail('Answer yes, maybe or no');
    await db.query(
      `insert into calendar_rsvps (event_id, occurrence_start, user_id, answer)
       values ($1, $2, $3, $4)
       on conflict (event_id, occurrence_start, user_id)
       do update set answer = excluded.answer, updated_at = now()`,
      [event.id, occ.occurrenceStart, user.id, answer]
    );
  }
  return getEvent(user, event.id, occ.occurrenceStart.toISOString());
}

// ── What each member follows ────────────────────────────────────────────────

async function prefsOf(user, q = db) {
  if (!user || user.kind !== 'discord') return { advanced: false, notify: false, selection: {} };
  const { rows } = await q.query('select * from calendar_prefs where user_id = $1', [user.id]);
  return rows[0] || { advanced: false, notify: false, selection: {}, feed_token: null };
}

/**
 * A calendar nobody chose about yet: on, for every calendar one sees. New
 * calendars come in by themselves; each is switched off on the Subscribe page.
 */
function defaultChoice() {
  return true;
}

/** What a member's choices mean for one calendar: { dashboard, ics, notify }. */
function choiceFor(prefs, cal) {
  const stored = (prefs.selection || {})[cal.id];
  const def = defaultChoice(cal);
  if (prefs.advanced) {
    const pick = (k, fallback) => (stored && typeof stored[k] === 'boolean' ? stored[k] : fallback);
    return {
      dashboard: pick('dashboard', def),
      ics: pick('ics', def),
      notify: pick('notify', def && Boolean(prefs.notify)),
    };
  }
  const on = stored && typeof stored.dashboard === 'boolean' ? stored.dashboard : def;
  return { dashboard: on, ics: on, notify: on && Boolean(prefs.notify) };
}

/** The member's own row, made with a fresh link the first time. */
async function ensurePrefs(user) {
  if (user.kind !== 'discord')
    throw fail('The shared admin account has no calendar of its own: sign in with Discord');
  await db.query(
    `insert into calendar_prefs (user_id, feed_token) values ($1, $2)
     on conflict (user_id) do nothing`,
    [user.id, newToken()]
  );
  return prefsOf(user);
}

/** The Subscribe page: the link, the mode and the choice per calendar. */
async function getPrefs(user) {
  const who = await whoIs(user);
  const prefs = user.kind === 'discord' ? await ensurePrefs(user) : await prefsOf(user);
  const list = await visible(who);
  return {
    feedToken: prefs.feed_token || null,
    advanced: Boolean(prefs.advanced),
    notify: Boolean(prefs.notify),
    calendars: list.map(({ cal, level }) => ({
      id: cal.id,
      slug: cal.slug,
      name: cal.name,
      color: cal.color,
      level,
      isPublic: cal.is_public,
      system: cal.system_key || null,
      choice: choiceFor(prefs, cal),
    })),
  };
}

/** Saves the Subscribe page: { advanced, notify, selection: { id: { dashboard, ics, notify } } }. */
async function savePrefs(user, body) {
  const b = body || {};
  await ensurePrefs(user);
  const who = await whoIs(user);
  const seen = new Set((await visible(who)).map((x) => x.cal.id));
  const selection = {};
  const given = b.selection && typeof b.selection === 'object' ? b.selection : {};
  Object.keys(given).forEach((id) => {
    if (!seen.has(id)) return;
    const c = given[id] || {};
    selection[id] = {};
    ['dashboard', 'ics', 'notify'].forEach((k) => {
      if (typeof c[k] === 'boolean') selection[id][k] = c[k];
    });
  });
  await db.query(
    `update calendar_prefs set advanced = $2, notify = $3, selection = $4, updated_at = now()
     where user_id = $1`,
    [user.id, Boolean(b.advanced), Boolean(b.notify), JSON.stringify(selection)]
  );
  return getPrefs(user);
}

/** Only the dashboard's switches, from the sidebar of the calendar page. */
async function setShown(user, calendarId, on) {
  const prefs = await ensurePrefs(user);
  const who = await whoIs(user);
  await calendarFor(calendarId, who, 'public');
  const selection = { ...(prefs.selection || {}) };
  const current = selection[calendarId] || {};
  selection[calendarId] = prefs.advanced
    ? { ...current, dashboard: Boolean(on) }
    : { ...current, dashboard: Boolean(on), ics: Boolean(on) };
  await db.query(
    'update calendar_prefs set selection = $2, updated_at = now() where user_id = $1',
    [user.id, JSON.stringify(selection)]
  );
  return { id: calendarId, shown: Boolean(on) };
}

/** A new personal link: the old one stops working at once. */
async function regenerateFeed(user) {
  await ensurePrefs(user);
  await db.query(
    'update calendar_prefs set feed_token = $2, updated_at = now() where user_id = $1',
    [user.id, newToken()]
  );
  return getPrefs(user);
}

// ── What the .ics links and the public page read ────────────────────────────

const FEED_PAST_DAYS = 120;
const FEED_FUTURE_DAYS = 400;

/** The rows a feed carries for these calendars: series whole, single events near now. */
async function feedRows(calendarIds) {
  if (!calendarIds.length) return [];
  const { rows } = await db.query(
    `select * from calendar_events where calendar_id = any($1::uuid[])
       and (recurrence is not null or series_id is not null
            or (ends_at > now() - make_interval(days => $2) and starts_at < now() + make_interval(days => $3)))
     order by starts_at limit 3000`,
    [calendarIds, FEED_PAST_DAYS, FEED_FUTURE_DAYS]
  );
  return rows;
}

/**
 * A member's personal feed, by its secret token: the calendars they chose for
 * it, among those they may still see (their roles are read again when
 * stale). Null for a token that does not exist.
 */
async function personalFeed(token) {
  await ensureContentBackfill();
  if (typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return null;
  const { rows } = await db.query(
    `select p.*, u.id as uid, u.kind, u.name from calendar_prefs p
     join app_users u on u.id = p.user_id where p.feed_token = $1`,
    [token]
  );
  if (!rows.length) return null;
  const prefs = rows[0];
  const user = { id: prefs.uid, kind: prefs.kind, name: prefs.name };
  await permissions.refreshIfStale(user, { maxAgeMs: 6 * 60 * 60 * 1000 });
  const who = await whoIs(user);
  const cals = (await visible(who)).filter(({ cal }) => choiceFor(prefs, cal).ics);
  return {
    name: 'AI Safety for Italy',
    calendars: cals.map((x) => x.cal),
    events: await feedRows(cals.map((x) => x.cal.id)),
  };
}

/** The public calendars, for /calendar/ on the site. */
async function publicCalendars() {
  await ensureContentBackfill();
  const { rows } = await db.query(
    `select * from calendars where is_public and archived_at is null
     order by case system_key when 'seminars' then 0 when 'events' then 1 else 2 end, lower(name)`
  );
  return rows.map((cal) => ({
    slug: cal.slug,
    name: cal.name,
    description: cal.description,
    color: cal.color,
  }));
}

/** One public calendar by its slug, with its events for the feed: null if none. */
async function publicFeed(slug) {
  await ensureContentBackfill();
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const { rows } = await db.query(
    'select * from calendars where slug = $1 and is_public and archived_at is null',
    [slug]
  );
  if (!rows.length) return null;
  return { name: rows[0].name, calendars: rows, events: await feedRows([rows[0].id]) };
}

/** The public calendars' occurrences in a range, for the site's page. */
async function publicEvents(query) {
  await ensureContentBackfill();
  const { from, to } = range(query);
  const { rows: cals } = await db.query(
    'select * from calendars where is_public and archived_at is null'
  );
  const wanted = query.calendar ? cals.filter((c) => c.slug === query.calendar) : cals;
  const bySlug = new Map(wanted.map((c) => [c.id, c]));
  const { rows, overrides } = await eventRows([...bySlug.keys()], from, to);
  return {
    events: timeOf.expand(rows, from, to, overrides).map((occ) => {
      const cal = bySlug.get(occ.event.calendar_id);
      const out = occurrenceOut(occ, cal, 'public');
      return {
        start: out.start,
        end: out.end,
        allDay: out.allDay,
        title: out.title,
        description: out.description,
        location: out.location,
        video: out.video && out.video.kind === 'link' ? out.video : null,
        calendar: cal.slug,
      };
    }),
  };
}

// ── Copies of the site's seminars and events, and of polls ──────────────────

/** The calendar of the site's `system_key` ('seminars' | 'events'). */
async function systemCalendar(key, q = db) {
  const { rows } = await q.query('select * from calendars where system_key = $1', [key]);
  return rows[0] || null;
}

/** Puts in (or takes out of) a calendar the copy of something from elsewhere. */
async function upsertCopy(source, sourceId, calendarId, f) {
  const { rows } = await db.query(
    'select id from calendar_events where source = $1 and source_id = $2',
    [source, sourceId]
  );
  if (!calendarId) {
    if (rows.length) await db.query('delete from calendar_events where id = $1', [rows[0].id]);
    return null;
  }
  const values = [
    f.title.slice(0, 200),
    (f.description || '').slice(0, 8000),
    (f.location || '').slice(0, 500),
    f.videoUrl ? 'link' : null,
    f.videoUrl || '',
    null,
    null,
    f.startsAt,
    f.endsAt,
    Boolean(f.allDay),
    f.timezone || 'Europe/Rome',
    f.recurrence ? JSON.stringify(f.recurrence) : null,
    '[]',
    null,
  ];
  if (rows.length) {
    await db.query(
      `update calendar_events set calendar_id = $1, (${EVENT_COLUMNS}) =
         ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15),
         sequence = sequence + 1, updated_at = now()
       where id = $16`,
      [calendarId, ...values, rows[0].id]
    );
    return rows[0].id;
  }
  const { rows: made } = await db.query(
    `insert into calendar_events (calendar_id, ${EVENT_COLUMNS}, source, source_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning id`,
    [calendarId, ...values, source, sourceId]
  );
  return made[0].id;
}

/** Which calendar a site item goes in: its choice, else its type's own. */
async function contentCalendar(item) {
  const choice = item.calendar_choice;
  if (choice === 'none') return null;
  if (choice && UUID.test(choice)) {
    const { rows } = await db.query(
      'select id from calendars where id = $1 and archived_at is null',
      [choice]
    );
    if (rows.length) return rows[0].id;
  }
  const cal = await systemCalendar(item.type === 'seminar' ? 'seminars' : 'events');
  return cal ? cal.id : null;
}

/** The calendar's copy of a seminar or event of the site, after any change to it. */
async function syncFromContent(itemId) {
  const { rows } = await db.query('select * from content_items where id = $1', [itemId]);
  const item = rows[0];
  if (!item) {
    await upsertCopy('content', String(itemId), null);
    return null;
  }
  const calendarId = item.deleted ? null : await contentCalendar(item);
  const e = item.entry || {};
  const day = item.day instanceof Date ? item.day.toISOString().slice(0, 10) : String(item.day);
  const [y, m, d] = day.split('-').map(Number);
  let times;
  if (e.time) {
    const [h, min] = e.time.split(':').map(Number);
    const startsAt = new Date(timeOf.zonedToUtc(y, m, d, h, min, 'Europe/Rome'));
    let endsAt = new Date(startsAt.getTime() + 90 * 60000);
    if (e.end_time) {
      const [eh, emin] = e.end_time.split(':').map(Number);
      endsAt = new Date(timeOf.zonedToUtc(y, m, d, eh, emin, 'Europe/Rome'));
    }
    times = { startsAt, endsAt, allDay: false };
  } else {
    const startsAt = new Date(Date.UTC(y, m - 1, d));
    times = { startsAt, endsAt: new Date(startsAt.getTime() + 86400000), allDay: true };
  }
  const site = String(process.env.SITE_URL || 'https://www.ais4i.it').replace(/\/+$/, '');
  const page = `${site}/${item.type === 'seminar' ? 'seminars' : 'events'}/#${item.slug}`;
  const description = [
    e.speaker ? `Speaker: ${e.speaker}` : null,
    e.description_md || null,
    e.register_link ? `${e.register_text || 'Register'}: ${e.register_link}` : null,
    page,
  ]
    .filter(Boolean)
    .join('\n\n');
  return upsertCopy('content', item.id, calendarId, {
    title: e.title || 'Seminar',
    description,
    ...times,
    timezone: 'Europe/Rome',
  });
}

/**
 * Once per database: the site's items from before the calendar get their
 * copies. Asked by every read of the calendar, the public ones too, so the
 * feeds are full before anyone opens the dashboard.
 */
let backfilled = false;
async function ensureContentBackfill() {
  if (backfilled) return;
  const { rows } = await db.query(
    "select 1 from app_settings where key = 'migration_calendar_content'"
  );
  if (!rows.length) {
    const { rows: items } = await db.query('select id from content_items where not deleted');
    for (const item of items) await syncFromContent(item.id);
    await db.query(
      `insert into app_settings (key, value) values ('migration_calendar_content', 'true')
       on conflict (key) do nothing`
    );
  }
  backfilled = true;
}

/** For the tests: the next call checks the backfill again. */
function resetBackfill() {
  backfilled = false;
}

/**
 * What a site item's form chose for its calendar, checked: '' (its type's
 * own) gives null, 'none' stays, a calendar's id needs edit there.
 */
async function contentChoice(choice, user) {
  if (!choice) return null;
  if (choice === 'none') return 'none';
  const who = await whoIs(user);
  return (await calendarFor(choice, who, 'edit')).cal.id;
}

/** The calendars a site item may go in, for its form: those this member edits. */
async function contentChoices(user) {
  const who = await whoIs(user);
  return (await visible(who))
    .filter(({ cal, level }) => atLeast(level, 'edit') || cal.system_key)
    .map(({ cal }) => ({ id: cal.id, name: cal.name, color: cal.color, system: cal.system_key }));
}

/** The calendar's copy of a poll's chosen time, after any change to the poll. */
async function syncFromPoll(pollId) {
  const { rows } = await db.query('select * from polls where id = $1', [pollId]);
  const poll = rows[0];
  if (!poll || poll.status !== 'scheduled' || !poll.calendar_id || !poll.final_slot_id) {
    await upsertCopy('poll', String(pollId), null);
    return null;
  }
  const { rows: slot } = await db.query('select starts_at from poll_slots where id = $1', [
    poll.final_slot_id,
  ]);
  if (!slot.length) return upsertCopy('poll', poll.id, null);
  const startsAt = new Date(slot[0].starts_at);
  const location = poll.location || '';
  return upsertCopy('poll', poll.id, poll.calendar_id, {
    title: poll.title,
    description: poll.description,
    location: /^https:\/\//i.test(location) ? '' : location,
    videoUrl: /^https:\/\/[^\s"<>]+$/i.test(location) ? location : '',
    startsAt,
    endsAt: new Date(startsAt.getTime() + poll.duration_minutes * 60000),
    timezone: poll.timezone,
    recurrence: poll.recurrence,
  });
}

/** Which calendar a poll's time goes in (its owner, who edits that calendar); null for none. */
async function setPollCalendar(user, pollId, calendarId) {
  let value = null;
  if (calendarId) {
    const who = await whoIs(user);
    value = (await calendarFor(calendarId, who, 'edit')).cal.id;
  }
  await db.query('update polls set calendar_id = $2 where id = $1', [pollId, value]);
  await syncFromPoll(pollId);
  return value;
}

/**
 * Whether this member gives access to calendars (manages one, or may create
 * them): only they may search the server's members and roles here.
 */
async function sharesCalendars(user) {
  const who = await whoIs(user);
  if (canCreate(who)) return true;
  return (await visible(who)).some(({ level }) => atLeast(level, 'manage'));
}

/** The calendars this member may put things in. */
async function writable(user) {
  const who = await whoIs(user);
  return (await visible(who))
    .filter(({ level }) => atLeast(level, 'edit'))
    .map(({ cal }) => ({ id: cal.id, name: cal.name, color: cal.color }));
}

module.exports = {
  COLORS,
  LEAD_TIMES,
  LEVELS,
  levelOf,
  whoIs,
  visible,
  choiceFor,
  prefsOf,
  listCalendars,
  createCalendar,
  updateCalendar,
  archiveCalendar,
  deleteCalendar,
  listEvents,
  occurrencesFor,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  rsvp,
  getPrefs,
  savePrefs,
  setShown,
  regenerateFeed,
  personalFeed,
  publicCalendars,
  publicFeed,
  publicEvents,
  syncFromContent,
  syncFromPoll,
  contentChoice,
  contentChoices,
  setPollCalendar,
  writable,
  sharesCalendars,
  ensureContentBackfill,
  resetBackfill,
  systemCalendar,
};
