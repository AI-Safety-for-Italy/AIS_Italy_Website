// Gives the site's build the local groups last published from the dashboard
// (server/local-groups.js, Site content → Local groups), in place of
// community.yaml's local_groups.cities.
//
// Where they come from, as for the community (server/community-build.js):
//   - CONTENT_SOURCE set (the deploy workflow): that site's public
//     /api/content?part=local-groups. An error stops the build, so the live
//     site keeps its map; an answer without the cities (a site deployed
//     before this) means they were never published there: the YAML stays.
//   - otherwise: _local-groups-snapshot.json, which the local server rewrites
//     on publish; without it, the YAML.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_local-groups-snapshot.json');

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function valid(data) {
  return data && data.live === true && Array.isArray(data.cities);
}

async function fromSite(origin) {
  const url = `${origin.replace(/\/+$/, '')}/api/content?part=local-groups`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${url} did not answer (${err.message})`);
  }
  if (res.status === 404) return { live: false };
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const data = await res.json();
  return valid(data) ? data : { live: false };
}

function fromSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return { live: false };
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  return valid(data) ? data : { live: false };
}

function writeSnapshot(data) {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2)
  );
}

/** { live, cities } for this build. */
async function load() {
  const origin = process.env.CONTENT_SOURCE;
  if (!origin) return fromSnapshot();
  try {
    return await fromSite(origin);
  } catch (err) {
    throw new Error(
      `Could not read the published local groups (${err.message}). ` +
        'The build stops so the live site keeps its current map.'
    );
  }
}

/** A city the templates can draw: a name, a pin on the map, maybe an https link. */
function cleanCity(c) {
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return null;
  const x = Number(c.x);
  const y = Number(c.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const out = { name: c.name.trim(), x, y };
  if (typeof c.link === 'string' && /^https?:\/\//.test(c.link)) out.link = c.link;
  return out;
}

/** community.yaml with the published cities (or as it is). */
function community(yaml, published) {
  if (!published || !published.live) return yaml;
  const cities = published.cities.map(cleanCity).filter(Boolean);
  return { ...yaml, local_groups: { ...(yaml.local_groups || {}), cities } };
}

module.exports = { SNAPSHOT, setFetch, load, writeSnapshot, community };
