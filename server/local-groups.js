// The local groups: one per city, kept on their own board (/app/local-groups/,
// permission `local_groups`) and shown on the community page's map from Site
// content → Local groups (permission `local_groups_site`).
//
//   - A group (local_groups) has its city and where it stands (starting,
//     active, paused). Who leads it, their contacts, the WhatsApp group's
//     invite link and the team's notes are personal data or as good as a
//     key to the chat: they are kept encrypted, bound to the row, and only
//     the board reads them.
//   - What the site shows is set apart, on the same rows: whether the city
//     is on the map, the pin's place (x/y in the map's 0 0 420 560 viewBox)
//     and, if any, the page its name links to. Nothing personal: the site
//     part never sends the board's details.
//
// The site changes only on "Publish": that stores the cities it may show
// (app_settings `local_groups_published`) and rebuilds it; the build takes
// them from /api/content?part=local-groups (server/local-groups-build.js).
// Never published, community.yaml's cities stay the site.

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const access = require('./access');
const audit = require('./crm/audit');
const crm = require('./crm/crypto');

const STATUSES = [
  { key: 'starting', label: 'Starting' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
];
const STATUS_KEYS = STATUSES.map((s) => s.key);
const LIMITS = { city: 60, name: 120, email: 200, phone: 40, link: 500, notes: 2000 };
const MAX_LEADS = 6;
// The map's viewBox (src/components/italy-map.njk).
const MAP = { width: 420, height: 560 };
const PUBLISHED = 'local_groups_published';

function text(value, label, max, required) {
  const s = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (required && !s) throw new HttpError(400, `${label} is required`, { field: label });
  if (s.length > max) throw new HttpError(400, `${label} is too long`, { field: label });
  return s;
}

/** An https (or http) address, or '' when left empty. */
function link(value, label) {
  const s = text(value, label, LIMITS.link, false);
  if (!s) return '';
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(400, `${label}: a full address, starting with https://`, { field: label });
  }
  if (!/^https?:$/.test(url.protocol))
    throw new HttpError(400, `${label}: a full address, starting with https://`, { field: label });
  return url.href;
}

function context(id) {
  return `local-group:${id}`;
}

function detailsOf(row) {
  const empty = { leads: [], whatsapp: '', notes: '' };
  if (!row.details_encrypted) return empty;
  const plain = crm.decrypt(row.details_encrypted, context(row.id));
  if (plain === null) return empty;
  try {
    return { ...empty, ...JSON.parse(plain) };
  } catch {
    return empty;
  }
}

function sealDetails(id, d) {
  return crm.encrypt(JSON.stringify(d), context(id));
}

/** The leads as typed ([{ name, email, phone }]), the empty rows left out. */
function cleanLeads(list) {
  if (list !== undefined && !Array.isArray(list)) throw new HttpError(400, 'Leads: a list');
  const out = (list || [])
    .map((l) => ({
      name: text(l && l.name, 'Lead’s name', LIMITS.name, false),
      email: text(l && l.email, 'Lead’s email', LIMITS.email, false).toLowerCase(),
      phone: text(l && l.phone, 'Lead’s phone', LIMITS.phone, false),
    }))
    .filter((l) => l.name || l.email || l.phone);
  if (out.length > MAX_LEADS) throw new HttpError(400, `At most ${MAX_LEADS} leads`);
  out.forEach((l) => {
    if (!l.name) throw new HttpError(400, 'Each lead needs a name', { field: 'Lead’s name' });
    if (l.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email))
      throw new HttpError(400, `${l.email} is not an email address`, { field: 'Lead’s email' });
  });
  return out;
}

function boardOut(row) {
  const d = detailsOf(row);
  return {
    id: row.id,
    city: row.city,
    status: row.status,
    leads: d.leads,
    whatsapp: d.whatsapp,
    notes: d.notes,
    onSite: row.site_show,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
  };
}

function siteOut(row) {
  return {
    id: row.id,
    city: row.city,
    status: row.status,
    show: row.site_show,
    link: row.site_link,
    x: row.map_x === null ? null : Number(row.map_x),
    y: row.map_y === null ? null : Number(row.map_y),
  };
}

async function rows() {
  const { rows: list } = await db.query('select * from local_groups order by lower(city)');
  return list;
}

async function rowOf(id) {
  const { rows: found } = await db.query('select * from local_groups where id::text = $1', [
    String(id || ''),
  ]);
  if (!found[0]) throw new HttpError(404, 'No such local group');
  return found[0];
}

async function cityTaken(city, exceptId) {
  const { rows: found } = await db.query(
    'select id from local_groups where lower(city) = lower($1) and id::text <> $2',
    [city, String(exceptId || '')]
  );
  return found.length > 0;
}

// ── The board ────────────────────────────────────────────────────────────────

/** Every group with its details: { groups, statuses }. */
async function listBoard(user) {
  await access.authorize(user, 'local_groups');
  if (!crm.configured()) throw new HttpError(503, 'CRM_ENCRYPTION_KEY is not set');
  const list = (await rows()).map(boardOut);
  await audit.record(user, 'local-groups-list', null, { groups: list.length });
  return { groups: list, statuses: STATUSES };
}

function boardFields(body) {
  const b = body || {};
  const status = b.status === undefined ? 'starting' : String(b.status);
  if (!STATUS_KEYS.includes(status)) throw new HttpError(400, 'Unknown status');
  return {
    city: text(b.city, 'City', LIMITS.city, true),
    status,
    details: {
      leads: cleanLeads(b.leads),
      whatsapp: link(b.whatsapp, 'WhatsApp link'),
      notes: String(b.notes == null ? '' : b.notes)
        .trim()
        .slice(0, LIMITS.notes),
    },
  };
}

/**
 * A new group ({ city, status?, leads?, whatsapp?, notes? }), or one changed
 * (with `id`). Returns { group }.
 */
async function saveGroup(user, body, id) {
  await access.authorize(user, 'local_groups', { fresh: true });
  if (!crm.configured()) throw new HttpError(503, 'CRM_ENCRYPTION_KEY is not set');
  const f = boardFields(body);
  const existing = id ? await rowOf(id) : null;
  if (await cityTaken(f.city, existing && existing.id))
    throw new HttpError(409, `There is a group in ${f.city} already`, { field: 'City' });
  const groupId = existing ? existing.id : crypto.randomUUID();
  if (existing) {
    await db.query(
      `update local_groups set city = $2, status = $3, details_encrypted = $4,
         updated_at = now(), updated_by_name = $5 where id = $1`,
      [groupId, f.city, f.status, sealDetails(groupId, f.details), user.name]
    );
  } else {
    await db.query(
      `insert into local_groups (id, city, status, details_encrypted, updated_by_name)
       values ($1, $2, $3, $4, $5)`,
      [groupId, f.city, f.status, sealDetails(groupId, f.details), user.name]
    );
  }
  await audit.record(user, 'local-groups-edit', groupId, { change: existing ? 'edit' : 'add' });
  return { group: boardOut(await rowOf(groupId)) };
}

/** Moves a group to another column of the board. Returns { group }. */
async function setStatus(user, id, status) {
  await access.authorize(user, 'local_groups', { fresh: true });
  if (!STATUS_KEYS.includes(status)) throw new HttpError(400, 'Unknown status');
  const row = await rowOf(id);
  await db.query(
    'update local_groups set status = $2, updated_at = now(), updated_by_name = $3 where id = $1',
    [row.id, status, user.name]
  );
  await audit.record(user, 'local-groups-edit', row.id, { status: `${row.status} → ${status}` });
  return { group: boardOut(await rowOf(row.id)) };
}

/**
 * Removes a group from the board. The site keeps showing it until the next
 * publish, like any other change.
 */
async function deleteGroup(user, id) {
  await access.authorize(user, 'local_groups', { fresh: true });
  const row = await rowOf(id);
  await db.query('delete from local_groups where id = $1', [row.id]);
  await audit.record(user, 'local-groups-edit', row.id, { change: 'delete' });
  return { ok: true };
}

// Cells starting like a formula are kept as text, so a spreadsheet never runs
// what was typed in (as the forms' export, server/forms/forms.js).
const FORMULA = /^[=+\-@\t\r]/;
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The board as a CSV file, one row per group, the leads' details joined in
 * their columns. Written on the audit trail. Returns { filename, csv }.
 */
async function exportCsv(user) {
  const { groups } = await listBoard(user);
  const label = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
  const joined = (g, k) =>
    g.leads
      .map((l) => l[k])
      .filter(Boolean)
      .join('; ');
  const lines = [
    [
      'City',
      'Status',
      'Leads',
      'Emails',
      'Phones',
      'WhatsApp',
      'On the site',
      'Notes',
      'Last changed',
    ],
  ].concat(
    groups.map((g) => [
      g.city,
      label[g.status] || g.status,
      joined(g, 'name'),
      joined(g, 'email'),
      joined(g, 'phone'),
      g.whatsapp,
      g.onSite ? 'Yes' : 'No',
      g.notes,
      g.updatedAt ? new Date(g.updatedAt).toISOString().slice(0, 10) : '',
    ])
  );
  await audit.record(user, 'export', null, { part: 'local-groups', groups: groups.length });
  return {
    filename: `local-groups-${new Date().toISOString().slice(0, 10)}.csv`,
    // The BOM lets Excel read the accents as UTF-8.
    csv: '\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n',
  };
}

// ── The site (Site content → Local groups) ──────────────────────────────────

/** What the site would show now: the cities ticked, with their pin and link. */
function draftOf(list) {
  return list
    .filter((r) => r.site_show && r.map_x !== null && r.map_y !== null)
    .map((r) => {
      const c = { name: r.city, x: round(r.map_x), y: round(r.map_y) };
      if (r.site_link) c.link = r.site_link;
      return c;
    });
}

function round(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** What was last published, or null (never: community.yaml is the site). */
async function published() {
  const { rows: found } = await db.query('select value from app_settings where key = $1', [
    PUBLISHED,
  ]);
  const v = found[0] && found[0].value;
  return v && Array.isArray(v.cities) ? v : null;
}

// jsonb keeps keys in its own order: compare the cities field by field.
function same(cities) {
  return JSON.stringify(cities.map((c) => [c.name, c.x, c.y, c.link || '']));
}

async function siteState(list) {
  const was = await published();
  const now = draftOf(list);
  return {
    live: Boolean(was),
    publishedAt: was ? was.publishedAt : null,
    pending: !was || same(was.cities) !== same(now),
  };
}

/** The site part: { groups, site } with nothing of the board's details. */
async function listSite(user) {
  await access.authorize(user, 'local_groups_site');
  const list = await rows();
  return { groups: list.map(siteOut), site: await siteState(list), map: MAP };
}

function coordinate(value, max, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new HttpError(400, `${label}: the pin is off the map`);
  return round(n);
}

/**
 * Saves what the site shows of each group ({ groups: [{ id, show, link, x,
 * y }] }) and publishes it: the site shows these cities from its next build,
 * which starts here. Returns { site, build, groups }.
 */
async function publishSite(user, body) {
  await access.authorize(user, 'local_groups_site', { fresh: true });
  const given = (body && body.groups) || [];
  if (!Array.isArray(given)) throw new HttpError(400, 'Groups: a list');
  const known = new Map((await rows()).map((r) => [r.id, r]));
  const changes = given.map((g) => {
    const row = known.get(String(g && g.id));
    if (!row) throw new HttpError(404, 'One of these groups is no longer on the board');
    const show = g.show === true;
    const x = coordinate(g.x, MAP.width, row.city);
    const y = coordinate(g.y, MAP.height, row.city);
    if (show && (x === null || y === null))
      throw new HttpError(400, `${row.city}: place it on the map first`, { group: row.id });
    return { id: row.id, show, link: link(g.link, `${row.city}’s link`), x, y };
  });
  await db.transaction(async (tx) => {
    for (const c of changes) {
      await tx.query(
        `update local_groups set site_show = $2, site_link = $3, map_x = $4, map_y = $5
         where id = $1`,
        [c.id, c.show, c.link, c.x, c.y]
      );
    }
  });
  const list = await rows();
  const copy = { cities: draftOf(list), publishedAt: new Date().toISOString() };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [PUBLISHED, JSON.stringify(copy)]
  );
  const build = await require('./content-publish').triggerBuild();
  await audit.record(user, 'local-groups-site', null, { published: copy.cities.length });
  return { groups: list.map(siteOut), site: await siteState(list), build };
}

/** Takes the site back to community.yaml's cities. */
async function unpublishSite(user) {
  await access.authorize(user, 'local_groups_site', { fresh: true });
  await db.query('delete from app_settings where key = $1', [PUBLISHED]);
  const build = await require('./content-publish').triggerBuild();
  await audit.record(user, 'local-groups-site', null, { published: false });
  const list = await rows();
  return { groups: list.map(siteOut), site: await siteState(list), build };
}

/** What the site shows (/api/content?part=local-groups): { live, cities }. */
async function publicExport() {
  const was = await published();
  return was
    ? { live: true, cities: was.cities, publishedAt: was.publishedAt }
    : { live: false, cities: [] };
}

module.exports = {
  STATUSES,
  MAP,
  listBoard,
  saveGroup,
  setStatus,
  deleteGroup,
  exportCsv,
  listSite,
  publishSite,
  unpublishSite,
  publicExport,
};
