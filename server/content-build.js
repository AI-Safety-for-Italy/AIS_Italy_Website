// Gives the site's build the seminars and events published from the dashboard
// (server/content.js), merged into the `events` data of data/events.yaml.
//
// Where they come from:
//   - CONTENT_SOURCE set (the deploy workflow sets it: www.ais4i.it for main,
//     ais4i-dev.vercel.app for dev): that site's public /api/content, which
//     reads the same database. No database address is needed at build time.
//     If it answers with an error the build fails on purpose, so the live
//     site stays as it was instead of losing its seminars; a 404 means the
//     tool is not deployed there yet, so the YAML stays the site.
//   - otherwise: _content-snapshot.json, which the local server
//     (scripts/meet-dev.js) rewrites on every publish; and without it, the
//     YAML alone. The CI checks build this way.
//
// Until the content is switched on (the "Switch on" button on /app/content/,
// or scripts/content-migrate.js), the YAML is the site.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_content-snapshot.json');
const MANAGED = ['seminar', 'event'];

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function todayInItaly(now = new Date()) {
  if (process.env.EVENTS_TODAY) return process.env.EVENTS_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
}

async function fromSite(origin) {
  const url = `${origin.replace(/\/+$/, '')}/api/content`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${url} did not answer (${err.message})`);
  }
  if (res.status === 404) return { live: false, entries: [] };
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.live !== 'boolean' || !Array.isArray(data.entries)) {
    throw new Error(`${url} answered something unexpected`);
  }
  return data;
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
  const origin = process.env.CONTENT_SOURCE;
  if (!origin) return fromSnapshot();
  try {
    return await fromSite(origin);
  } catch (err) {
    throw new Error(
      `Could not read the published seminars and events (${err.message}). ` +
        'The build stops so the live site keeps its current content.'
    );
  }
}

/** An entry whose day is over, as the Past section shows it. */
function asPast(entry) {
  // The register_* keys are dropped on purpose: a Past entry shows no register fields.
  /* eslint-disable no-unused-vars */
  const {
    register_text,
    register_text_it,
    register_link,
    register_target,
    description_past,
    description_past_it,
    ...rest
  } = entry;
  /* eslint-enable no-unused-vars */
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

module.exports = {
  SNAPSHOT,
  setFetch,
  load,
  merge,
  writeSnapshot,
  todayInItaly,
  asPast,
  stayInYaml,
};
