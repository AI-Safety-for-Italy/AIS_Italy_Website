// Gives the site's build the seminars and events published from the dashboard
// (server/content.js), merged into the `events` data of data/events.yaml.
//
// Where they come from:
//   - CONTENT_BUILD_DATABASE=1 (set it once the content is migrated): the
//     database, at CONTENT_DATABASE_URL or else MEET_DATABASE_URL /
//     DATABASE_URL. If it cannot be read the build fails on purpose, so the
//     live site stays as it was instead of losing its seminars.
//     Opt-in because the deploy's build environment (`vercel pull`) may hold a
//     database address only the running functions can reach.
//   - otherwise: _content-snapshot.json, which the local server
//     (scripts/meet-dev.js) rewrites on every publish; and without it, the
//     YAML alone. The CI checks build this way.
//
// Until scripts/content-migrate.js has imported the YAML entries and switched
// the content "live", the database is ignored and the YAML is the site.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_content-snapshot.json');
const MANAGED = ['seminar', 'event'];

function todayInItaly(now = new Date()) {
  if (process.env.EVENTS_TODAY) return process.env.EVENTS_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
}

async function fromDatabase(url) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const exists = (await client.query(`select to_regclass('content_items') as t`)).rows[0].t;
    if (!exists) return { live: false, entries: [] };
    const setting = await client.query(`select value from app_settings where key = 'content_live'`);
    const live = Boolean(
      setting.rows.length && setting.rows[0].value && setting.rows[0].value.live
    );
    const { rows } = await client.query(
      'select entry from content_items where not deleted order by day, created_at'
    );
    return { live, entries: rows.map((r) => r.entry) };
  } finally {
    await client.end();
  }
}

function fromSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return { live: false, entries: [] };
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

function writeSnapshot(data) {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2)
  );
}

/** { live, entries } for this build. */
async function load() {
  if (process.env.CONTENT_BUILD_DATABASE !== '1') return fromSnapshot();
  const url =
    process.env.CONTENT_DATABASE_URL || process.env.MEET_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('CONTENT_BUILD_DATABASE=1 but no database address is set for the build.');
  }
  try {
    return await fromDatabase(url);
  } catch (err) {
    throw new Error(
      `Could not read the published seminars and events from the database (${err.message}). ` +
        'The build stops so the live site keeps its current content.'
    );
  }
}

/** An entry whose day is over, as the Past section shows it. */
function asPast(entry) {
  const {
    register_text,
    register_text_it,
    register_link,
    register_target,
    description_past,
    description_past_it,
    ...rest
  } = entry;
  return {
    ...rest,
    status: 'Past',
    status_it: 'Concluso',
    description: description_past || rest.description,
    description_it: description_past_it || rest.description_it,
  };
}

/**
 * Entries the database cannot hold, so the YAML keeps them even once live:
 * other categories (the mentorship call), and seminars or events without a
 * `day`, which the import skips (scripts/content-migrate.js lists them).
 */
function stayInYaml(entry) {
  return Boolean(entry) && (!MANAGED.includes(entry.category) || !entry.day);
}

/**
 * The `events` data with the published entries in place of the YAML's seminars
 * and events. An entry stays upcoming on its own day and is past from the next.
 */
function merge(events, content, today = todayInItaly()) {
  if (!content || !content.live) return events;
  const others = (list) => (list || []).filter(stayInYaml);
  const entries = (content.entries || []).filter((e) => e && MANAGED.includes(e.category));
  const upcoming = entries
    .filter((e) => e.day >= today)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((e) => ({ ...e, status: 'Upcoming', status_it: 'In programma' }));
  const past = entries
    .filter((e) => e.day < today)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map(asPast);
  return {
    ...events,
    upcoming_events: others(events.upcoming_events).concat(upcoming),
    past_events: past.concat(others(events.past_events)),
  };
}

module.exports = { SNAPSHOT, load, merge, writeSnapshot, todayInItaly, asPast, stayInYaml };
