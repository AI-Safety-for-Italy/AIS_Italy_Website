// The home page's highlights, from the content tool (/app/content/homepage/):
//   banners     the bar above every page's header: up to three messages that
//               scroll across it one after the other
//   spotlights  the boxes beside the home page's hero (the mentorship call, an
//               event, a seminar…): the ones switched on take turns there
// Each one has its own switch (`on`): what is off stays saved here, off the
// site. Saved as one copy in app_settings; saving rebuilds the site
// (content-publish.js), which reads the copy through /api/content?part=highlights
// (highlights-build.js).
//
// The first time anyone asks, the copy starts from what the YAML shows today
// (data/global.yaml's announcements, the featured entry of data/events.yaml),
// switched on: the site looks the same, and from then on it is edited here.
//
// Who: the `homepage` permission (server/permissions.js).

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('./db');
const { HttpError } = require('./http');
const access = require('./access');

const KEY = 'site_highlights';
const MAX_BANNERS = 3;
const MAX_SPOTLIGHTS = 6;
const MAX_LINES = 4;
const KINDS = ['mentorship', 'event', 'seminar', 'other'];
const SAFE_LINK = /^(https:\/\/[^\s"<>]+|\/[^\s"<>]*)$/;

const BANNER_FIELDS = ['text', 'text_it', 'link', 'link_text', 'link_text_it'];
const SPOTLIGHT_FIELDS = [
  'label',
  'label_it',
  'meta',
  'meta_it',
  'day',
  'month',
  'month_it',
  'title',
  'title_it',
  'summary',
  'summary_it',
  'notice',
  'notice_it',
  'details_text',
  'details_text_it',
  'details_link',
  'primary_text',
  'primary_text_it',
  'primary_link',
  'secondary_text',
  'secondary_text_it',
  'secondary_link',
];
const LONG = ['summary', 'summary_it', 'notice', 'notice_it'];

function fail(message, field) {
  return new HttpError(400, message, { field });
}

function clean(value, field, max) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (s.length > max) throw fail('Too long', field);
  return s;
}

function link(value, field) {
  const s = clean(value, field, 500);
  if (s && !SAFE_LINK.test(s)) throw fail('Links start with https:// or /', field);
  return s;
}

/** Only the fields filled in, so the templates' `or` fallbacks keep working. */
function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
}

function banner(b, i) {
  const f = (name) => `banners.${i}.${name}`;
  const out = { on: Boolean(b && b.on) };
  for (const k of BANNER_FIELDS) {
    out[k] = k === 'link' ? link(b && b[k], f(k)) : clean(b && b[k], f(k), 300);
  }
  if (!out.text) throw fail('The English text is required', f('text'));
  if (out.link && !out.link_text) throw fail('Say what the link says', f('link_text'));
  return compact(out);
}

function spotlight(s, i) {
  const f = (name) => `spotlights.${i}.${name}`;
  const kind = KINDS.includes(s && s.kind) ? s.kind : 'other';
  const out = { on: Boolean(s && s.on), kind };
  for (const k of SPOTLIGHT_FIELDS) {
    if (k.endsWith('_link')) out[k] = link(s && s[k], f(k));
    else out[k] = clean(s && s[k], f(k), LONG.includes(k) ? 600 : 160);
  }
  const lines = Array.isArray(s && s.lines) ? s.lines : [];
  if (lines.length > MAX_LINES) throw fail(`At most ${MAX_LINES} lines`, f('lines'));
  out.lines = lines
    .map((l, j) => ({
      text: clean(l && l.text, f(`lines.${j}.text`), 160),
      text_it: clean(l && l.text_it, f(`lines.${j}.text_it`), 160),
    }))
    .filter((l) => l.text || l.text_it)
    .map(compact);
  if (!out.title) throw fail('The English title is required', f('title'));
  if (!out.label) throw fail('The label (e.g. "Open call") is required', f('label'));
  for (const b of ['details', 'primary', 'secondary']) {
    if (out[`${b}_link`] && !out[`${b}_text`])
      throw fail('Say what the button says', f(`${b}_text`));
    if (out[`${b}_text`] && !out[`${b}_link`]) throw fail('Where does it go?', f(`${b}_link`));
  }
  if (out.day && !/^\d{1,2}$/.test(out.day)) throw fail('A day of the month, e.g. 5', f('day'));
  if (out.day && !out.month) throw fail('The month goes with the day', f('month'));
  return compact(out);
}

/** The copy as sent by the page, checked. */
function check(body) {
  const b = body || {};
  const banners = Array.isArray(b.banners) ? b.banners : [];
  const spotlights = Array.isArray(b.spotlights) ? b.spotlights : [];
  if (banners.length > MAX_BANNERS) throw fail(`At most ${MAX_BANNERS} banners`, 'banners');
  if (spotlights.length > MAX_SPOTLIGHTS)
    throw fail(`At most ${MAX_SPOTLIGHTS} boxes`, 'spotlights');
  return { banners: banners.map(banner), spotlights: spotlights.map(spotlight) };
}

// ── Where it starts: the YAML as the site shows it today ─────────────────────

function readYaml(name) {
  const file = path.join(__dirname, '..', 'data', name);
  return fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf8')) || {} : {};
}

/** What the site shows from the YAML today, all switched on. */
function fromYaml() {
  const anns = readYaml('global.yaml').announcements || [];
  const featured = (readYaml('events.yaml').upcoming_events || []).find(
    (e) => e.featured && e.hero
  );
  const pick = (o, keys) =>
    Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, String(o[k])]));
  return {
    banners: anns.slice(0, MAX_BANNERS).map((a) => ({ on: true, ...pick(a, BANNER_FIELDS) })),
    spotlights: featured
      ? [
          {
            on: true,
            kind: KINDS.includes(featured.category) ? featured.category : 'other',
            ...pick(featured.hero, SPOTLIGHT_FIELDS),
            lines: (featured.hero.lines || []).map((l) => pick(l, ['text', 'text_it'])),
          },
        ]
      : [],
  };
}

// ── Reading and saving ───────────────────────────────────────────────────────

async function stored() {
  const { rows } = await db.query('select value from app_settings where key = $1', [KEY]);
  return rows[0] ? rows[0].value : null;
}

/** The copy, saved from the YAML the first time. */
async function current() {
  const was = await stored();
  if (was) return was;
  const copy = { ...fromYaml(), updatedAt: new Date().toISOString(), updatedBy: null };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do nothing`,
    [KEY, JSON.stringify(copy)]
  );
  return stored();
}

/** For the page: { banners, spotlights, updatedAt, updatedBy, limits }. */
async function get(user) {
  await access.authorize(user, 'homepage');
  return {
    ...(await current()),
    limits: { banners: MAX_BANNERS, spotlights: MAX_SPOTLIGHTS, lines: MAX_LINES, kinds: KINDS },
  };
}

/**
 * Saves the whole copy. `updatedAt` is the one the page started from: if
 * someone saved in between, nothing is overwritten (409).
 */
async function save(user, body) {
  await access.authorize(user, 'homepage');
  const copy = check(body);
  const was = await current();
  if (body && body.updatedAt && was.updatedAt !== body.updatedAt) {
    throw new HttpError(
      409,
      `${was.updatedBy || 'Someone'} saved in the meantime: reload the page to see their changes`
    );
  }
  const value = { ...copy, updatedAt: new Date().toISOString(), updatedBy: user.name || null };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, JSON.stringify(value)]
  );
  return value;
}

/** What the site shows (/api/content?part=highlights): only what is on. */
async function publicExport() {
  const was = await stored();
  if (!was) return { live: false, banners: [], spotlights: [] };
  const on = (list) =>
    (list || [])
      .filter((x) => x.on)
      .map((x) => {
        const out = { ...x };
        delete out.on;
        return out;
      });
  return {
    live: true,
    banners: on(was.banners),
    spotlights: on(was.spotlights),
    updatedAt: was.updatedAt,
  };
}

module.exports = { KEY, KINDS, check, fromYaml, current, get, save, publicExport };
