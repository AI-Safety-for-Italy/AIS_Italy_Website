// Gives the site's build the community directory and working groups that were
// last published from the dashboard (server/community.js, "Publish to the
// site"), in place of data/members.yaml and community.yaml's working_groups.
//
// Where they come from, as for the seminars (server/content-build.js):
//   - CONTENT_SOURCE set (the deploy workflow): that site's public
//     /api/content?part=community. An error stops the build, so the live site
//     keeps its directory; an answer without the community (a site deployed
//     before this) means it was never published there: the YAML stays.
//   - otherwise: _community-snapshot.json, which the local server rewrites on
//     publish; without it, the YAML.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_community-snapshot.json');

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function valid(data) {
  return data && data.live === true && Array.isArray(data.groups) && Array.isArray(data.members);
}

async function fromSite(origin) {
  const url = `${origin.replace(/\/+$/, '')}/api/content?part=community`;
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

/** { live, groups, members } for this build. */
async function load() {
  const origin = process.env.CONTENT_SOURCE;
  if (!origin) return fromSnapshot();
  try {
    return await fromSite(origin);
  } catch (err) {
    throw new Error(
      `Could not read the published community (${err.message}). ` +
        'The build stops so the live site keeps its current directory.'
    );
  }
}

/** The day of a publish as the board sees it (Italian time): YYYY-MM-DD. */
function dayOf(iso) {
  const d = new Date(iso || '');
  return isNaN(d) ? '' : d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

/**
 * data/members.yaml's shape, from the published copy (or the YAML as it is).
 * published_at is the publish this build shows: /community/version.json
 * gives it to the board, which says "updated" only once the site has it.
 */
function members(yaml, published) {
  if (!published || !published.live) return yaml;
  return {
    last_updated: dayOf(published.publishedAt) || yaml.last_updated,
    published_at: published.publishedAt || null,
    members: published.members,
  };
}

/** community.yaml with the published working groups (or as it is). */
function community(yaml, published) {
  if (!published || !published.live) return yaml;
  return { ...yaml, working_groups: published.groups };
}

module.exports = { SNAPSHOT, setFetch, load, writeSnapshot, members, community, dayOf };
