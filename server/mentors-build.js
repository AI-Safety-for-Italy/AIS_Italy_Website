// Gives the site's build the mentors published from the mentorship board
// (server/crm/mentorship.js, "Publish"), on top of data/mentors.yaml.
//
// Where they come from, as for the community (server/community-build.js):
//   - CONTENT_SOURCE set (the deploy workflow): that site's public
//     /api/content?part=mentors, and each photo from part=mentor-photo. An
//     error stops the build, so the live site keeps its mentors and never
//     ships a broken image; an answer without the mentors (a site deployed
//     before this) means none were published there: the YAML stays.
//   - otherwise: _mentors-snapshot.json, which the local server rewrites on
//     publish, photos included; without it, the YAML.

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '_mentors-snapshot.json');
const PHOTO_DIR = path.join(__dirname, '..', 'src', 'assets', 'img', 'mentors');
// The only photo path the build writes: a name from the network never picks the file.
const PHOTO = /^\/assets\/img\/mentors\/([a-z0-9-]+-[0-9a-f]{8}\.jpg)$/;
// A photo from data/mentors.yaml: already in the repository, nothing to fetch.
const REPO_PHOTO = /^\/assets\/img\/mentors\/([a-z0-9-]+\.jpg)$/;

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function valid(data) {
  return data && data.live === true && Array.isArray(data.mentors) && Array.isArray(data.hidden);
}

function isJpeg(base64) {
  return typeof base64 === 'string' && base64.startsWith('/9j/'); // FF D8 FF
}

function inRepo(photo) {
  const match = REPO_PHOTO.exec(photo);
  return Boolean(match) && fs.existsSync(path.join(PHOTO_DIR, match[1]));
}

// A photo stays only with a safe name and JPEG bytes, or as a file of the
// repository; otherwise the card shows initials.
function clean(data) {
  const photos = data.photos || {};
  const mentors = data.mentors.map((m) => {
    if (!m.photo || (PHOTO.test(m.photo) ? isJpeg(photos[m.id]) : inRepo(m.photo))) return m;
    const rest = { ...m };
    delete rest.photo;
    return rest;
  });
  return { live: true, mentors, hidden: data.hidden, photos };
}

async function get(url, accept) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: accept } });
  } catch (err) {
    throw new Error(`${url} did not answer (${err.message})`);
  }
  return res;
}

async function fromSite(origin) {
  const base = `${origin.replace(/\/+$/, '')}/api/content?part=`;
  const url = `${base}mentors`;
  const res = await get(url, 'application/json');
  if (res.status === 404) return { live: false };
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const data = await res.json();
  if (!valid(data)) return { live: false };

  const photos = {};
  for (const m of data.mentors) {
    if (!m.photo || !PHOTO.test(m.photo)) continue;
    const photoUrl = `${base}mentor-photo&id=${encodeURIComponent(m.id)}`;
    const photo = await get(photoUrl, 'image/jpeg');
    if (!photo.ok) throw new Error(`${photoUrl} answered ${photo.status}`);
    photos[m.id] = Buffer.from(await photo.arrayBuffer()).toString('base64');
    if (!isJpeg(photos[m.id])) throw new Error(`${photoUrl} is not a JPEG`);
  }
  return clean({ ...data, photos });
}

function fromSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return { live: false };
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  return valid(data) ? clean(data) : { live: false };
}

function writeSnapshot(data) {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2)
  );
}

/** { live, mentors, hidden, photos: { [id]: base64 } } for this build. */
async function load() {
  const origin = process.env.CONTENT_SOURCE;
  if (!origin) return fromSnapshot();
  try {
    return await fromSite(origin);
  } catch (err) {
    throw new Error(
      `Could not read the published mentors (${err.message}). ` +
        'The build stops so the live site keeps its current mentors.'
    );
  }
}

/** Writes the published photos where the passthrough copy of src/assets/img picks them up. */
function writePhotos(published, dir = PHOTO_DIR) {
  if (!published || !published.live) return;
  for (const m of published.mentors) {
    const match = m.photo && PHOTO.exec(m.photo);
    if (!match || !isJpeg(published.photos[m.id])) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, match[1]), Buffer.from(published.photos[m.id], 'base64'));
  }
}

/** data/mentors.yaml with the published entries: same id replaced in place, new ones last, hidden ones out. */
function merge(yaml, published) {
  if (!published || !published.live) return yaml;
  const hidden = new Set(published.hidden);
  const byId = new Map(published.mentors.map((m) => [m.id, m]));
  const yamlMentors = yaml.mentors || [];
  const known = new Set(yamlMentors.map((m) => m.id));
  const mentors = yamlMentors
    .filter((m) => !hidden.has(m.id))
    .map((m) => byId.get(m.id) || m)
    .concat(published.mentors.filter((m) => !known.has(m.id) && !hidden.has(m.id)));
  return { ...yaml, mentors };
}

module.exports = { SNAPSHOT, PHOTO_DIR, setFetch, load, writeSnapshot, writePhotos, merge };
