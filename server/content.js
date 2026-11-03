// Seminars and events published from the dashboard (/app/content/).
//
// Each item's `entry` has the shape of an entry of data/events.yaml (title,
// title_it, date, date_it, description, format_info, register_link, …), so the
// site's templates read items from here and entries from the YAML the same
// way; content-build.js hands them to the build. The form sends simpler fields
// (day, time, Markdown texts) and toEntry() turns them into that shape.
//
// Who may do what (server/permissions.js): the permission named after the
// item's type to create and edit it, plus `others` to edit, delete or restore
// items somebody else created (and the ones imported from the YAML).

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('./db');
const { HttpError } = require('./http');
const permissions = require('./permissions');
const md = require('../src/assets/js/meet/markdown-lite');

const TYPES = ['seminar', 'event'];
const LIVE_KEY = 'content_live';

// Fields the form owns. Anything else already in an entry (an agenda, a
// stream link written in the YAML before the import) is kept as it is.
const FORM_FIELDS = [
  'anchor',
  'category',
  'day',
  'time',
  'end_time',
  'tbc',
  'speaker',
  'speaker_affiliation',
  'speaker_link',
  'title',
  'title_it',
  'date',
  'date_it',
  'status',
  'status_it',
  'description',
  'description_it',
  'description_md',
  'description_md_it',
  'description_past',
  'description_past_it',
  'description_past_md',
  'description_past_md_it',
  'format_info',
  'register_text',
  'register_text_it',
  'register_link',
  'register_target',
];

const DEFAULTS = {
  tbcTitle: 'Title coming soon',
  tbcTitleIt: 'Titolo in arrivo',
  registerText: 'Register for free on Luma',
  registerTextIt: 'Registrazione gratuita su Luma',
};

const SAFE_LINK = /^(https:\/\/[^\s"<>]+|\/[^\s"<>]*)$/;

function fail(message, field) {
  return new HttpError(400, message, field ? { field } : undefined);
}

function text(value, max, field, label) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length > max) throw fail(`${label} is too long (at most ${max} characters)`, field);
  return s;
}

/** Today's date in Italy, 'YYYY-MM-DD'; the zone every `day` is in. */
function todayInItaly(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
}

function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** 'CET' or 'CEST' for a day and time in Italy. */
function italianZone(day, time) {
  const instant = new Date(`${day}T${time || '12:00'}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    timeZoneName: 'short',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName').value;
  return name === 'GMT+2' ? 'CEST' : 'CET';
}

/**
 * The card's date line in both languages, as written by hand so far:
 * 'Thursday 29 October 2026, 18:30 (CET)' / 'Giovedì 29 ottobre 2026, ore 18:30 (CET)',
 * or with an end time '…, 18:00–20:30 (CEST)'.
 */
function dateLines(day, time, endTime) {
  const d = new Date(`${day}T12:00:00Z`);
  const part = (locale, options) =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(d);
  const dayNum = d.getUTCDate();
  const year = d.getUTCFullYear();
  const en = `${part('en-GB', { weekday: 'long' })} ${dayNum} ${part('en-GB', {
    month: 'long',
  })} ${year}`;
  const weekdayIt = part('it-IT', { weekday: 'long' });
  const it = `${weekdayIt.charAt(0).toUpperCase()}${weekdayIt.slice(1)} ${dayNum} ${part('it-IT', {
    month: 'long',
  })} ${year}`;
  if (!time) return { date: en, date_it: it };
  const zone = italianZone(day, time);
  const span = endTime ? `${time}–${endTime}` : time;
  return { date: `${en}, ${span} (${zone})`, date_it: `${it}, ore ${span} (${zone})` };
}

function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** A pair of Markdown texts: both written or neither. */
function mdPair(body, key, label) {
  const en = text(body[key], 8000, key, label);
  const it = text(body[`${key}_it`], 8000, `${key}_it`, `${label} (Italian)`);
  if (en && !it) throw fail(`${label}: add the Italian text too`, `${key}_it`);
  if (it && !en) throw fail(`${label}: add the English text too`, key);
  return { en, it };
}

/** The Speaker row of the card's list: the one the Speaker field makes. */
function isSpeakerRow(row) {
  return (
    Boolean(row) &&
    String(row.label || '')
      .trim()
      .toLowerCase() === 'speaker'
  );
}

function details(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 12) throw fail('Invalid details', 'details');
  return list.map((row, i) => {
    const r = row || {};
    const field = `details.${i}`;
    const out = {
      label: text(r.label, 80, field, 'Detail label'),
      label_it: text(r.label_it, 80, field, 'Detail label (Italian)'),
      value: text(r.value, 300, field, 'Detail'),
      value_it: text(r.value_it, 300, field, 'Detail (Italian)'),
    };
    if (!out.label || !out.label_it || !out.value || !out.value_it) {
      throw fail('Each detail needs a label and a value in both languages', field);
    }
    const link = text(r.link, 500, field, 'Detail link');
    if (link) {
      if (!SAFE_LINK.test(link)) throw fail('Links must start with https://', field);
      out.link = link;
    }
    return out;
  });
}

/**
 * Checks the form's fields and builds the entry, keeping whatever `previous`
 * held beyond the form's own fields.
 */
function toEntry(body, previous = {}) {
  const b = body || {};
  const type = b.type;
  if (!TYPES.includes(type)) throw fail('Choose seminar or event', 'type');
  const day = text(b.day, 10, 'day', 'Day');
  if (!validDay(day)) throw fail('Enter a valid day', 'day');
  const time = text(b.time, 5, 'time', 'Time');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail('Enter a time as 18:30', 'time');
  const endTime = text(b.end_time, 5, 'end_time', 'End time');
  if (endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
    throw fail('Enter the end time as 20:30', 'end_time');
  }
  if (endTime && !time) throw fail('Add the start time too', 'time');
  if (endTime && endTime <= time) throw fail('The end time must come after the start', 'end_time');
  const tbc = Boolean(b.tbc);

  let title = text(b.title, 200, 'title', 'Title');
  let titleIt = text(b.title_it, 200, 'title_it', 'Italian title');
  if (tbc && !title && !titleIt) {
    title = DEFAULTS.tbcTitle;
    titleIt = DEFAULTS.tbcTitleIt;
  }
  if (!title) throw fail('Enter the title', 'title');
  if (!titleIt) throw fail('Enter the Italian title', 'title_it');

  const description = mdPair(b, 'description_md', 'Description');
  const past = mdPair(b, 'description_past_md', 'Description after the event');

  const registerLink = text(b.register_link, 500, 'register_link', 'Registration link');
  if (registerLink && !SAFE_LINK.test(registerLink)) {
    throw fail('The registration link must start with https://', 'register_link');
  }

  const kept = {};
  Object.keys(previous).forEach((k) => {
    if (!FORM_FIELDS.includes(k) && k !== 'id') kept[k] = previous[k];
  });

  const entry = {
    ...kept,
    category: type,
    day,
    ...(time ? { time } : {}),
    ...(endTime ? { end_time: endTime } : {}),
    ...(tbc ? { tbc: true } : {}),
    ...dateLines(day, time, endTime),
    title,
    title_it: titleIt,
    status: 'Upcoming',
    status_it: 'In programma',
  };
  const speaker = text(b.speaker, 120, 'speaker', 'Speaker');
  const affiliation = text(b.speaker_affiliation, 200, 'speaker_affiliation', 'Affiliation');
  const speakerLink = text(b.speaker_link, 500, 'speaker_link', 'Speaker link');
  if (speakerLink && !SAFE_LINK.test(speakerLink)) {
    throw fail('The speaker link must start with https://', 'speaker_link');
  }
  if ((affiliation || speakerLink) && !speaker) throw fail('Add the speaker name', 'speaker');
  if (speaker) entry.speaker = speaker;
  if (description.en) {
    entry.description_md = description.en;
    entry.description_md_it = description.it;
    entry.description = md.toHtml(description.en);
    entry.description_it = md.toHtml(description.it);
  }
  if (past.en) {
    entry.description_past_md = past.en;
    entry.description_past_md_it = past.it;
    entry.description_past = md.toHtml(past.en);
    entry.description_past_it = md.toHtml(past.it);
  }
  // The Speaker field makes the card's Speaker row (and the calendar's name),
  // so the list the form sends holds the other rows only.
  const info = details((Array.isArray(b.details) ? b.details : []).filter((r) => !isSpeakerRow(r)));
  if (speaker) {
    const previousRow = (previous.format_info || []).find(isSpeakerRow);
    const value = affiliation ? `${speaker}, ${affiliation}` : speaker;
    info.unshift({
      label: 'Speaker',
      // Kept from the entry being edited: the YAML wrote "Relatrice" for a woman.
      label_it: (previousRow && previousRow.label_it) || 'Relatore',
      value,
      value_it: value,
      ...(speakerLink ? { link: speakerLink } : {}),
    });
  }
  if (info.length) entry.format_info = info;
  if (registerLink) {
    entry.register_link = registerLink;
    entry.register_text =
      text(b.register_text, 80, 'register_text', 'Button text') || DEFAULTS.registerText;
    entry.register_text_it =
      text(b.register_text_it, 80, 'register_text_it', 'Button text (Italian)') ||
      DEFAULTS.registerTextIt;
    entry.register_target = registerLink.startsWith('/') ? '_self' : '_blank';
  }
  return entry;
}

/** The form's fields for an entry: the inverse of toEntry(). */
function toForm(entry) {
  const e = entry || {};
  // Entries imported from the YAML only have the times inside `date`.
  const timeFromDate = (e.date || '').match(/\b([01]\d|2[0-3]):[0-5]\d\b/);
  const endFromDate = (e.date || '').match(/[–-]\s*(([01]\d|2[0-3]):[0-5]\d)\b/);
  // The card's Speaker row is made by the Speaker field, with its affiliation
  // and link: the form shows them there, and the other rows as Details.
  const rows = e.format_info || [];
  const speakerRow = rows.find(isSpeakerRow);
  const rowValue = speakerRow ? String(speakerRow.value || '') : '';
  const speaker = e.speaker || rowValue.split(', ')[0];
  const affiliation = rowValue.startsWith(`${speaker}, `) ? rowValue.slice(speaker.length + 2) : '';
  return {
    type: e.category,
    day: e.day,
    time: e.time || (timeFromDate ? timeFromDate[0] : ''),
    end_time: e.end_time || (endFromDate ? endFromDate[1] : ''),
    tbc: Boolean(e.tbc),
    speaker,
    speaker_affiliation: affiliation,
    speaker_link: speakerRow ? speakerRow.link || '' : '',
    title: e.title || '',
    title_it: e.title_it || '',
    description_md: e.description_md || md.fromHtml(e.description),
    description_md_it: e.description_md_it || md.fromHtml(e.description_it),
    description_past_md: e.description_past_md || md.fromHtml(e.description_past),
    description_past_md_it: e.description_past_md_it || md.fromHtml(e.description_past_it),
    details: rows
      .filter((r) => r !== speakerRow)
      .map((r) => ({
        label: r.label || '',
        label_it: r.label_it || '',
        value: r.value || '',
        value_it: r.value_it || '',
        link: r.link || '',
      })),
    register_text: e.register_text || '',
    register_text_it: e.register_text_it || '',
    register_link: e.register_link || '',
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

function canEdit(item, user, perms) {
  if (!perms.includes(item.type)) return false;
  return perms.includes('others') || (item.created_by && item.created_by === user.id);
}

function summary(row, user, perms) {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
    title: row.entry.title,
    speaker: row.entry.speaker || null,
    tbc: Boolean(row.entry.tbc),
    deleted: row.deleted,
    createdBy: row.created_by_name || null,
    updatedBy: row.updated_by_name || null,
    updatedAt: row.updated_at,
    canEdit: canEdit(row, user, perms),
  };
}

const SELECT = `
  select i.*, c.name as created_by_name, u.name as updated_by_name
  from content_items i
  left join app_users c on c.id = i.created_by
  left join app_users u on u.id = i.updated_by`;

/** Every item, newest day first, with what this user may do with each. */
async function listItems(user) {
  const perms = await permissions.forUser(user);
  const { rows } = await db.query(`${SELECT} order by i.day desc, i.created_at desc`);
  return { items: rows.map((r) => summary(r, user, perms)), permissions: perms };
}

async function loadRow(id, q = db) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new HttpError(404, 'Not found');
  const { rows } = await q.query(`${SELECT} where i.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return rows[0];
}

async function versionsOf(itemId) {
  const { rows } = await db.query(
    `select id, action, user_name, created_at from content_versions
     where item_id = $1 order by created_at desc, id limit 50`,
    [itemId]
  );
  return rows.map((v) => ({
    id: v.id,
    action: v.action,
    userName: v.user_name,
    createdAt: v.created_at,
  }));
}

/** One item for the edit form: its fields, history and permissions. */
async function getItem(id, user) {
  const row = await loadRow(id);
  const perms = await permissions.forUser(user);
  return {
    ...summary(row, user, perms),
    form: toForm(row.entry),
    versions: await versionsOf(row.id),
  };
}

/** The latest saves, deletes and restores across all items. */
async function recentActivity(limit = 15) {
  const { rows } = await db.query(
    `select v.action, v.user_name, v.created_at, i.id as item_id, i.type, v.entry->>'title' as title
     from content_versions v join content_items i on i.id = v.item_id
     order by v.created_at desc limit $1`,
    [limit]
  );
  return rows.map((r) => ({
    action: r.action,
    userName: r.user_name,
    createdAt: r.created_at,
    itemId: r.item_id,
    type: r.type,
    title: r.title,
  }));
}

// ── Writing ──────────────────────────────────────────────────────────────────

async function addVersion(q, itemId, action, entry, user) {
  await q.query(
    `insert into content_versions (item_id, action, entry, user_id, user_name)
     values ($1, $2, $3, $4, $5)`,
    [itemId, action, entry, user.id || null, user.name]
  );
}

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /unique/i.test(err.message || ''));
}

/**
 * Creates (no id) or updates an item from the form's fields. Roles are read
 * from Discord again first. Returns { item, entry }.
 */
async function saveItem(user, body, id) {
  const b = body || {};
  await permissions.refreshRoles(user);
  const perms = await permissions.forUser(user);

  if (!id) {
    if (!perms.includes(b.type))
      throw new HttpError(403, `Your Discord roles do not allow publishing a ${b.type || 'item'}`);
    const entry = toEntry(b);
    if (entry.day < todayInItaly()) throw fail('The day has already passed', 'day');
    const base =
      slugify(`${b.type}-${entry.tbc ? entry.day : entry.title}`) || `${b.type}-${entry.day}`;
    for (let n = 1; n <= 20; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      try {
        const row = await db.transaction(async (tx) => {
          const created = (
            await tx.query(
              `insert into content_items (type, slug, day, entry, created_by, updated_by)
               values ($1, $2, $3, $4, $5, $5) returning id`,
              [b.type, slug, entry.day, { ...entry, anchor: slug }, user.id]
            )
          ).rows[0];
          await addVersion(tx, created.id, 'create', { ...entry, anchor: slug }, user);
          return created;
        });
        return { id: row.id, entry: { ...entry, anchor: slug }, action: 'create' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw fail('Could not find a free address for this item', 'title');
  }

  const row = await loadRow(id);
  if (!canEdit(row, user, perms))
    throw new HttpError(403, 'Your Discord roles do not allow editing this');
  if (b.type !== row.type && !perms.includes(b.type)) {
    throw new HttpError(403, `Your Discord roles do not allow publishing a ${b.type}`);
  }
  const entry = { ...toEntry(b, row.entry), anchor: row.slug };
  await db.transaction(async (tx) => {
    await tx.query(
      `update content_items set type = $2, day = $3, entry = $4, deleted = false,
       updated_by = $5, updated_at = now() where id = $1`,
      [row.id, b.type, entry.day, entry, user.id]
    );
    await addVersion(tx, row.id, 'update', entry, user);
  });
  return { id: row.id, entry, action: 'update' };
}

async function deleteItem(user, id) {
  await permissions.refreshRoles(user);
  const perms = await permissions.forUser(user);
  const row = await loadRow(id);
  if (!canEdit(row, user, perms))
    throw new HttpError(403, 'Your Discord roles do not allow deleting this');
  await db.transaction(async (tx) => {
    await tx.query(
      'update content_items set deleted = true, updated_by = $2, updated_at = now() where id = $1',
      [row.id, user.id]
    );
    await addVersion(tx, row.id, 'delete', row.entry, user);
  });
  return { id: row.id, entry: row.entry, action: 'delete' };
}

/** Puts an item back as it was in one of its versions (and undeletes it). */
async function restoreVersion(user, itemId, versionId) {
  await permissions.refreshRoles(user);
  const perms = await permissions.forUser(user);
  const row = await loadRow(itemId);
  if (!canEdit(row, user, perms))
    throw new HttpError(403, 'Your Discord roles do not allow editing this');
  const { rows } = await db.query(
    'select entry from content_versions where id = $1 and item_id = $2',
    [versionId, row.id]
  );
  if (!rows.length) throw new HttpError(404, 'Version not found');
  const entry = { ...rows[0].entry, anchor: row.slug };
  await db.transaction(async (tx) => {
    await tx.query(
      `update content_items set type = $2, day = $3, entry = $4, deleted = false,
       updated_by = $5, updated_at = now() where id = $1`,
      [row.id, entry.category, entry.day, entry, user.id]
    );
    await addVersion(tx, row.id, 'restore', entry, user);
  });
  return { id: row.id, entry, action: 'restore' };
}

// ── Import and build ─────────────────────────────────────────────────────────

/**
 * Copies seminar and event entries of data/events.yaml into the database
 * (scripts/content-migrate.js). Entries whose anchor is already there are
 * skipped, so running it twice changes nothing. Returns { imported, skipped }.
 */
async function importEntries(entries, userName = 'Import from events.yaml') {
  let imported = 0;
  let skipped = 0;
  for (const raw of entries) {
    if (!raw || !TYPES.includes(raw.category) || !raw.anchor || !validDay(String(raw.day || ''))) {
      skipped++;
      continue;
    }
    // The id is dropped on purpose: an import always creates a new entry.
    // eslint-disable-next-line no-unused-vars
    const { id: _id, ...entry } = raw;
    // Markdown versions of the hand-written HTML, so the form can edit them.
    for (const key of ['description', 'description_past']) {
      for (const suffix of ['', '_it']) {
        if (entry[`${key}${suffix}`] && !entry[`${key}_md${suffix}`]) {
          entry[`${key}_md${suffix}`] = md.fromHtml(entry[`${key}${suffix}`]);
        }
      }
    }
    // Past entries were rewritten by hand; the build now does that from the day.
    entry.status = 'Upcoming';
    entry.status_it = 'In programma';
    const done = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `insert into content_items (type, slug, day, entry) values ($1, $2, $3, $4)
         on conflict (slug) do nothing returning id`,
        [entry.category, entry.anchor, entry.day, entry]
      );
      if (!rows.length) return false;
      await addVersion(tx, rows[0].id, 'import', entry, { name: userName });
      return true;
    });
    if (done) imported++;
    else skipped++;
  }
  return { imported, skipped };
}

const EVENTS_YAML = path.join(__dirname, '..', 'data', 'events.yaml');

/** The seminars and events of data/events.yaml (vercel.json ships the file
 * with the functions in api/app/). */
function yamlEntries(file = EVENTS_YAML) {
  const events = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  return [...(events.upcoming_events || []), ...(events.past_events || [])].filter(
    (e) => e && TYPES.includes(e.category)
  );
}

/**
 * The "Switch on" button and scripts/content-migrate.js: imports the YAML's
 * seminars and events, then lets the site take them from here. Returns
 * { imported, skipped, undated } where undated are the titles left in the
 * YAML for lack of a `day`.
 */
async function switchOn(userName, file) {
  const entries = yamlEntries(file);
  const result = await importEntries(entries, userName);
  await setLive(true);
  return { ...result, undated: entries.filter((e) => !e.day).map((e) => e.title) };
}

/** Whether the site takes its seminars and events from here (after the import). */
async function isLive() {
  const { rows } = await db.query('select value from app_settings where key = $1', [LIVE_KEY]);
  return Boolean(rows.length && rows[0].value && rows[0].value.live);
}

async function setLive(live) {
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [LIVE_KEY, { live: Boolean(live), since: new Date().toISOString() }]
  );
}

/** What the build needs: { live, entries } with the items not deleted. */
async function exportForBuild() {
  const live = await isLive();
  const { rows } = await db.query(
    'select entry from content_items where not deleted order by day, created_at'
  );
  return { live, entries: rows.map((r) => r.entry) };
}

module.exports = {
  TYPES,
  todayInItaly,
  dateLines,
  slugify,
  toEntry,
  toForm,
  listItems,
  getItem,
  recentActivity,
  saveItem,
  deleteItem,
  restoreVersion,
  importEntries,
  yamlEntries,
  switchOn,
  isLive,
  setLive,
  exportForBuild,
};
