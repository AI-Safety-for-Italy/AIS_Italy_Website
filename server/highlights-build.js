// Gives the site's build the banners and the home page boxes saved in the
// content tool (server/highlights.js): global.announcements and `highlights`.
//
// Where they come from, as for the seminars (content-build.js):
//   - CONTENT_SOURCE set (the deploy workflow): that site's
//     /api/content?part=highlights. An error stops the build, so the live site
//     keeps its banners; a 404 or an older site without the part means the
//     YAML stays the site.
//   - otherwise: _highlights-snapshot.json, which the local server rewrites
//     on every save; without it, the YAML.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_highlights-snapshot.json');
const NOT_LIVE = { live: false, banners: [], spotlights: [] };

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

async function fromSite(origin) {
  const url = `${origin.replace(/\/+$/, '')}/api/content?part=highlights`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${url} did not answer (${err.message})`);
  }
  if (res.status === 404) return NOT_LIVE;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const data = await res.json();
  // A site from before this part answers with the seminars instead.
  if (!data || !Array.isArray(data.banners) || !Array.isArray(data.spotlights)) return NOT_LIVE;
  return data;
}

function fromSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return NOT_LIVE;
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

function writeSnapshot(data) {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2)
  );
}

async function load() {
  const origin = process.env.CONTENT_SOURCE;
  return origin ? fromSite(origin) : fromSnapshot();
}

/**
 * data/global.yaml with the banners switched on in the tool. `banners_managed`
 * tells the header that no banner is a choice: no falling back to the
 * featured event.
 */
function global(yaml, data) {
  if (!data || !data.live) return yaml;
  return { ...yaml, announcements: data.banners, banners_managed: true };
}

/** The home page's boxes: { live, spotlights }; not live, the YAML's featured entry. */
function spotlights(data) {
  return data && data.live
    ? { live: true, spotlights: data.spotlights }
    : { live: false, spotlights: [] };
}

module.exports = { SNAPSHOT, setFetch, load, writeSnapshot, global, spotlights };
