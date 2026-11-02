// The community: its working groups and its members, kept here rather than in
// the old Google Sheet (scripts/update-members.py, data/members.yaml).
//
//   - A working group (work_groups) has its Discord role. On Discord it is a
//     role, here it is only a tag: it never opens anything in the dashboard.
//   - A member (community_members) is someone let in: approved on the member
//     applications board, or imported once from the old sheet. Their name,
//     profile link, place and areas are kept encrypted, bound to their row;
//     `publish` says whether the site may show them (their consent).
//   - member_groups says which groups each is in, and at which level
//     (coordination, stable): the levels that give the group's tag.
//
// Every change of tags is mirrored on Discord at once (the bot gives or takes
// the group's role). The site changes only when someone presses "Publish to
// the site": that stores what it may show (publishSite) and rebuilds it; its
// directory and working groups come from that published copy through
// /api/community (server/community-build.js). Never published, the YAML stays
// the site. Managed from Member applications → Members and Working groups,
// with the `members` permission.

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const access = require('./access');
const permissions = require('./permissions');
const audit = require('./crm/audit');
const crm = require('./crm/crypto');
const { parseCsv, rowsFromValues } = require('./sheets');

const LEVELS = ['coordination', 'stable'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LIMITS = { title: 80, description: 400, name: 200, profile: 500, location: 200, areas: 1000 };

function devMode() {
  return permissions.devLogin() && !permissions.botConfigured();
}

function validRoleId(value) {
  const s = String(value || '').trim();
  return /^\d{5,25}$/.test(s) || (devMode() && /^[\w-]{1,40}$/.test(s)) ? s : null;
}

function text(value, label, max, required) {
  const s = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (required && !s) throw new HttpError(400, `${label} is required`, { field: label });
  if (s.length > max) throw new HttpError(400, `${label} is too long`, { field: label });
  return s;
}

function context(id) {
  return `community:${id}`;
}

function detailsOf(row) {
  const plain = row.details_encrypted ? crm.decrypt(row.details_encrypted, context(row.id)) : null;
  if (plain === null) return null;
  try {
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

function sealDetails(id, d) {
  return crm.encrypt(
    JSON.stringify({
      name: d.name || '',
      profile: d.profile || '',
      location: d.location || '',
      areas: d.areas || '',
    }),
    context(id)
  );
}

// ── Working groups ───────────────────────────────────────────────────────────

function groupOut(r) {
  return {
    id: r.id,
    titleEn: r.title_en,
    titleIt: r.title_it,
    descriptionEn: r.description_en,
    descriptionIt: r.description_it,
    discordRoleId: r.discord_role_id,
    sheetColumn: r.sheet_column,
    position: r.position,
    members: r.members === undefined ? undefined : Number(r.members),
  };
}

async function listGroups() {
  const { rows } = await db.query(
    `select g.*, (select count(*) from member_groups m where m.group_id = g.id) as members
     from work_groups g order by g.position, g.title_en`
  );
  return rows.map(groupOut);
}

/**
 * Creates a group ({ id?, titleEn, titleIt, descriptionEn?, descriptionIt?,
 * discordRoleId }) or changes one (with the `id` of an existing group). A new
 * group needs the id of its role on Discord, made there first.
 */
async function saveGroup(user, body) {
  await access.authorize(user, 'members', { fresh: true });
  const b = body || {};
  const existing = b.id
    ? (await db.query('select * from work_groups where id = $1', [String(b.id)])).rows[0]
    : null;
  const roleId = validRoleId(b.discordRoleId);
  if (!roleId)
    throw new HttpError(400, 'The Discord role id (Server settings → Roles → Copy role ID)', {
      field: 'discordRoleId',
    });
  const fields = {
    titleEn: text(b.titleEn, 'English name', LIMITS.title, true),
    titleIt: text(b.titleIt, 'Italian name', LIMITS.title, true),
    descriptionEn: text(b.descriptionEn, 'English description', LIMITS.description, false),
    descriptionIt: text(b.descriptionIt, 'Italian description', LIMITS.description, false),
  };
  const taken = await db.query('select id from work_groups where discord_role_id = $1', [roleId]);
  if (taken.rows.length && (!existing || taken.rows[0].id !== existing.id))
    throw new HttpError(409, 'Another group has this Discord role', { field: 'discordRoleId' });

  let id;
  if (existing) {
    id = existing.id;
    await db.query(
      `update work_groups set title_en = $2, title_it = $3, description_en = $4,
         description_it = $5, discord_role_id = $6, updated_at = now() where id = $1`,
      [id, fields.titleEn, fields.titleIt, fields.descriptionEn, fields.descriptionIt, roleId]
    );
    // A new role for the group: the people in it move to it on Discord.
    if (existing.discord_role_id !== roleId) {
      await syncGroupMembers(id, { oldRoleId: existing.discord_role_id });
    }
  } else {
    id = b.id ? String(b.id) : slugify(fields.titleEn);
    if (!SLUG.test(id))
      throw new HttpError(400, 'Use lower-case letters, digits and dashes', { field: 'id' });
    const { rows } = await db.query(
      'select coalesce(max(position), 0) + 1 as next from work_groups'
    );
    try {
      await db.query(
        `insert into work_groups (id, title_en, title_it, description_en, description_it,
           discord_role_id, position) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          fields.titleEn,
          fields.titleIt,
          fields.descriptionEn,
          fields.descriptionIt,
          roleId,
          rows[0].next,
        ]
      );
    } catch (err) {
      if (err.code === '23505' || /unique|duplicate/i.test(err.message || ''))
        throw new HttpError(409, 'There is a group with this id already', { field: 'id' });
      throw err;
    }
  }
  await audit.record(user, 'community-groups', null, {
    group: id,
    change: existing ? 'edit' : 'add',
  });
  return {
    group: groupOut((await db.query('select * from work_groups where id = $1', [id])).rows[0]),
  };
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** The groups in a new order (every id, once). */
async function reorderGroups(user, ids) {
  await access.authorize(user, 'members', { fresh: true });
  const all = (await listGroups()).map((g) => g.id);
  if (!Array.isArray(ids) || ids.length !== all.length || all.some((id) => !ids.includes(id)))
    throw new HttpError(400, 'Every group, once');
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.query('update work_groups set position = $2 where id = $1', [ids[i], i + 1]);
    }
  });
  await audit.record(user, 'community-groups', null, { change: 'order' });
  return { groups: await listGroups() };
}

/**
 * Removes a group: its tag goes from everyone (and its role from them on
 * Discord). The role itself stays on Discord, to delete there if wanted.
 */
async function deleteGroup(user, id) {
  await access.authorize(user, 'members', { fresh: true });
  const { rows } = await db.query('select * from work_groups where id = $1', [String(id)]);
  if (!rows[0]) throw new HttpError(404, 'No such group');
  const affected = await membersOf(rows[0].id);
  await db.query('delete from work_groups where id = $1', [rows[0].id]);
  for (const m of affected) {
    if (m.discord_id) await discordRole(m.discord_id, rows[0].discord_role_id, false);
  }
  await audit.record(user, 'community-groups', null, { group: rows[0].id, change: 'delete' });
  return { groups: await listGroups() };
}

async function membersOf(groupId) {
  const { rows } = await db.query(
    `select c.* from community_members c join member_groups m on m.member_id = c.id
     where m.group_id = $1`,
    [groupId]
  );
  return rows;
}

// ── Discord ──────────────────────────────────────────────────────────────────

/** Gives (on) or takes away a role on Discord. Locally, without a bot, nothing. */
async function discordRole(discordId, roleId, on) {
  if (!permissions.botConfigured() || !/^\d{5,25}$/.test(String(discordId))) return true;
  const res = await permissions.bot(
    `/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`,
    { method: on ? 'PUT' : 'DELETE' }
  );
  // 404: not (or no longer) on the server; nothing to change there.
  if (!res.ok && res.status !== 404) {
    console.error(`Discord role ${on ? 'add' : 'remove'} failed (${res.status})`);
    return false;
  }
  return true;
}

/**
 * Makes a member's tags on Discord what they are here: the roles of their
 * groups given, those of the other groups taken away. Returns whether all went.
 */
async function syncRoles(member) {
  if (!member.discord_id) return true;
  const groups = await listGroups();
  const { rows } = await db.query('select group_id from member_groups where member_id = $1', [
    member.id,
  ]);
  const mine = new Set(rows.map((r) => r.group_id));
  let ok = true;
  for (const g of groups) {
    ok = (await discordRole(member.discord_id, g.discordRoleId, mine.has(g.id))) && ok;
  }
  return ok;
}

async function syncGroupMembers(groupId, { oldRoleId } = {}) {
  const { rows } = await db.query('select discord_role_id from work_groups where id = $1', [
    groupId,
  ]);
  for (const m of await membersOf(groupId)) {
    if (!m.discord_id) continue;
    if (oldRoleId) await discordRole(m.discord_id, oldRoleId, false);
    await discordRole(m.discord_id, rows[0].discord_role_id, true);
  }
}

// ── Members ──────────────────────────────────────────────────────────────────

async function groupsByMember() {
  const { rows } = await db.query('select member_id, group_id, level from member_groups');
  const out = {};
  rows.forEach((r) =>
    (out[r.member_id] = out[r.member_id] || []).push({ group: r.group_id, level: r.level })
  );
  return out;
}

function memberOut(row, groups) {
  const d = detailsOf(row) || { name: '(cannot be opened with the current key)' };
  return {
    id: row.id,
    name: d.name,
    profile: d.profile || '',
    location: d.location || '',
    areas: d.areas || '',
    role: row.role,
    publish: row.publish,
    discordId: row.discord_id,
    source: row.source,
    joinedOn: row.joined_on,
    groups: groups[row.id] || [],
  };
}

/** Everyone in the community, with their groups: { members, groups, live }. */
async function listMembers(user) {
  await access.authorize(user, 'members');
  const { rows } = await db.query('select * from community_members order by created_at');
  const groups = await groupsByMember();
  const members = rows.map((r) => memberOut(r, groups));
  members.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  await audit.record(user, 'community-list', null, { count: members.length });
  return { members, groups: await listGroups(), site: await siteState() };
}

async function loadMember(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new HttpError(404, 'No such member');
  const { rows } = await db.query('select * from community_members where id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'No such member');
  return rows[0];
}

/** Changes a member: their details, publish, and the Discord account they are. */
async function updateMember(user, id, body) {
  await access.authorize(user, 'members', { fresh: true });
  const row = await loadMember(id);
  const b = body || {};
  const d = detailsOf(row) || {};
  const next = {
    name: b.name === undefined ? d.name : text(b.name, 'Name', LIMITS.name, true),
    profile:
      b.profile === undefined ? d.profile : text(b.profile, 'Profile', LIMITS.profile, false),
    location:
      b.location === undefined ? d.location : text(b.location, 'Place', LIMITS.location, false),
    areas: b.areas === undefined ? d.areas : text(b.areas, 'Areas', LIMITS.areas, false),
  };
  if (next.profile && !/^https?:\/\//i.test(next.profile))
    throw new HttpError(400, 'A link starting with https://', { field: 'profile' });
  let discordId = row.discord_id;
  if (b.discordId !== undefined) {
    discordId = b.discordId ? String(b.discordId) : null;
    if (discordId && !/^[\w-]{1,40}$/.test(discordId))
      throw new HttpError(400, 'Unknown Discord account', { field: 'discordId' });
    const other = discordId
      ? (
          await db.query('select id from community_members where discord_id = $1 and id <> $2', [
            discordId,
            row.id,
          ])
        ).rows[0]
      : null;
    if (other)
      throw new HttpError(409, 'Another member is this Discord account', { field: 'discordId' });
  }
  const publish = b.publish === undefined ? row.publish : Boolean(b.publish);
  await db.query(
    `update community_members set details_encrypted = $2, publish = $3, discord_id = $4,
       updated_at = now() where id = $1`,
    [row.id, sealDetails(row.id, next), publish, discordId]
  );
  const updated = await loadMember(row.id);
  // A newly linked account gets its tags on Discord.
  if (discordId && discordId !== row.discord_id) await syncRoles(updated);
  await audit.record(user, 'community-member', row.id, { publish, linked: Boolean(discordId) });
  return { member: memberOut(updated, await groupsByMember()) };
}

/**
 * Tags several members at once. `action`:
 *   add     { group, level }  puts them in the group (or changes their level)
 *   remove  { group }         takes them out of it
 *   move    { group, to }     takes them out of `group` into `to`, same level
 * Each is mirrored on Discord. Returns { members, discordFailed }.
 */
async function setTags(user, body) {
  await access.authorize(user, 'members', { fresh: true });
  const b = body || {};
  const ids = Array.isArray(b.members) ? b.members.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Pick someone');
  const groups = await listGroups();
  const known = (g) => groups.some((x) => x.id === g);
  if (!known(b.group)) throw new HttpError(400, 'Unknown group', { field: 'group' });
  if (b.action === 'move' && (!known(b.to) || b.to === b.group))
    throw new HttpError(400, 'Move them to another group', { field: 'to' });
  if (b.action === 'add' && !LEVELS.includes(b.level))
    throw new HttpError(400, 'Coordination or stable participation', { field: 'level' });
  if (!['add', 'remove', 'move'].includes(b.action))
    throw new HttpError(400, 'Add, remove or move?');

  const rows = [];
  for (const id of ids) rows.push(await loadMember(id));
  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (b.action === 'add') {
        await tx.query(
          `insert into member_groups (member_id, group_id, level) values ($1, $2, $3)
           on conflict (member_id, group_id) do update set level = excluded.level`,
          [row.id, b.group, b.level]
        );
      } else if (b.action === 'remove') {
        await tx.query('delete from member_groups where member_id = $1 and group_id = $2', [
          row.id,
          b.group,
        ]);
      } else {
        const { rows: had } = await tx.query(
          'delete from member_groups where member_id = $1 and group_id = $2 returning level',
          [row.id, b.group]
        );
        if (!had[0]) continue;
        await tx.query(
          `insert into member_groups (member_id, group_id, level) values ($1, $2, $3)
           on conflict (member_id, group_id) do nothing`,
          [row.id, b.to, had[0].level]
        );
      }
    }
  });
  let discordFailed = 0;
  for (const row of rows) if (!(await syncRoles(row))) discordFailed++;
  await audit.record(user, 'community-tags', null, {
    action: b.action,
    group: b.group,
    to: b.to,
    count: rows.length,
  });
  const groupsNow = await groupsByMember();
  return { members: rows.map((r) => memberOut(r, groupsNow)), discordFailed };
}

/**
 * The member an approved application becomes (or updates, matched by email
 * key or Discord account): its details, role, tags and publish consent, and
 * the tags on Discord. Called by the members board (server/members.js).
 */
async function fromApplication({
  email,
  name,
  profile,
  location,
  areas,
  publish,
  role,
  tags,
  discordId,
}) {
  const key = email ? crm.personKey(email) : null;
  const { rows } = await db.query(
    'select * from community_members where ($1::text is not null and person_key = $1) or ($2::text is not null and discord_id = $2) limit 1',
    [key, discordId || null]
  );
  const id = rows[0] ? rows[0].id : crypto.randomUUID();
  const before = rows[0] ? detailsOf(rows[0]) || {} : {};
  const d = {
    name: name || before.name || '',
    profile: profile || before.profile || '',
    location: location || before.location || '',
    areas: areas || before.areas || '',
  };
  if (rows[0]) {
    await db.query(
      `update community_members set details_encrypted = $2, role = $3, discord_id = coalesce($4, discord_id),
         person_key = coalesce(person_key, $5), publish = $6, updated_at = now() where id = $1`,
      [
        id,
        sealDetails(id, d),
        role,
        discordId || null,
        key,
        publish === undefined ? rows[0].publish : Boolean(publish),
      ]
    );
  } else {
    await db.query(
      `insert into community_members (id, person_key, discord_id, role, publish, details_encrypted, source, joined_on)
       values ($1, $2, $3, $4, $5, $6, 'application', current_date)`,
      [id, key, discordId || null, role, Boolean(publish), sealDetails(id, d)]
    );
  }
  for (const t of cleanTags(tags, await listGroups())) {
    await db.query(
      `insert into member_groups (member_id, group_id, level) values ($1, $2, $3)
       on conflict (member_id, group_id) do update set level = excluded.level`,
      [id, t.group, t.level]
    );
  }
  const member = await loadMember(id);
  await syncRoles(member);
  return member;
}

/** Tags as sent ([{ group, level }]): only known groups and levels, once each. */
function cleanTags(tags, groups) {
  const seen = new Set();
  return (Array.isArray(tags) ? tags : []).filter((t) => {
    if (!t || !groups.some((g) => g.id === t.group) || !LEVELS.includes(t.level)) return false;
    if (seen.has(t.group)) return false;
    seen.add(t.group);
    return true;
  });
}

// ── The old sheet, once ──────────────────────────────────────────────────────
// The rules of scripts/update-members.py: approved ("Approvato", or someone who
// first registered before approvals existed and nobody rejected); published
// when they registered before the consent question, or consented; the levels
// "Coordinamento" and "Partecipazione stabile" give a group's tag.

const SHEET = {
  timestamp: 'Informazioni cronologiche',
  name: 'Nome',
  surname: 'Cognome',
  email: 'Indirizzo email',
  profile: 'Sito o profilo professionale',
  country: 'Paese in cui ti trovi attualmente',
  city: 'Città in cui vivi attualmente',
  areas: 'Quali aree ti interessano di più?',
  involvement: 'Come ti piacerebbe partecipare alla community?',
  consent: 'Consenso alla pubblicazione del profilo nella Community',
  status: 'Stato',
};
const CONSENT_VALUE =
  'acconsento alla pubblicazione delle informazioni sopra indicate nella sezione "community" del sito web.';
const AREA_OPTIONS = [
  'Interpretability (mechanistic interpretability, analisi delle rappresentazioni, ecc.)',
  'Evaluation (capability evaluations, dangerous capability evals, benchmarking)',
  'Alignment (RLHF, scalable oversight, value alignment)',
  'Robustness e adversarial ML',
  'AI governance e policy',
  "Etica dell'AI e impatto sociale",
  'Sicurezza informatica per modelli di frontiera',
  'Rischi catastrofici / esistenziali',
];
const GRANDFATHER_BEFORE = '2026-06-30';
const LEGACY_BEFORE = '2026-10-04';

const norm = (s) =>
  String(s || '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** "06/05/2026 11.33.30" (or ISO) -> '2026-05-06', or null. */
function sheetDate(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function header(row, wanted) {
  const key = Object.keys(row).find((k) => norm(k) === norm(wanted));
  return key ? String(row[key] || '').trim() : '';
}

/** The sheet's rows -> the people to bring in (approved only, one per email). */
function peopleFromSheet(csvText, groups) {
  const rows = rowsFromValues(parseCsv(csvText));
  if (!rows.length || !Object.keys(rows[0]).some((k) => norm(k) === norm(SHEET.email)))
    throw new HttpError(400, 'This is not the members sheet (no "Indirizzo email" column)');
  const first = {};
  rows.forEach((r) => {
    const e = norm(header(r, SHEET.email));
    const d = sheetDate(header(r, SHEET.timestamp));
    if (e && d && (!first[e] || d < first[e])) first[e] = d;
  });
  // The latest answer of each email.
  const latest = {};
  rows.forEach((r, i) => {
    const e = norm(header(r, SHEET.email)) || `__${i}`;
    const d = sheetDate(header(r, SHEET.timestamp)) || '';
    if (!latest[e] || d >= latest[e].d) latest[e] = { d, r };
  });
  const people = [];
  for (const [e, { d, r }] of Object.entries(latest)) {
    if (e.startsWith('__')) continue;
    const verdict = norm(header(r, SHEET.status));
    const legacy = first[e] && first[e] < LEGACY_BEFORE;
    if (verdict === 'rifiutato' || !(verdict === 'approvato' || legacy)) continue;
    const city = header(r, SHEET.city);
    const country = header(r, SHEET.country);
    const answerAreas = norm(header(r, SHEET.areas));
    people.push({
      email: e,
      name: `${header(r, SHEET.name)} ${header(r, SHEET.surname)}`.replace(/\s+/g, ' ').trim(),
      profile: /^https?:\/\//i.test(header(r, SHEET.profile)) ? header(r, SHEET.profile) : '',
      location:
        city && norm(city) === norm(country) ? country : [city, country].filter(Boolean).join(', '),
      areas: AREA_OPTIONS.filter((o) => answerAreas.includes(norm(o))).join(', '),
      publish: (d && d < GRANDFATHER_BEFORE) || norm(header(r, SHEET.consent)) === CONSENT_VALUE,
      role: /organizzatore/i.test(header(r, SHEET.involvement)) ? 'organizer' : 'participant',
      joinedOn: first[e] || d || null,
      tags: groups
        .filter((g) => g.sheetColumn)
        .map((g) => {
          const v = norm(header(r, g.sheetColumn));
          if (v.startsWith('coordinamento')) return { group: g.id, level: 'coordination' };
          if (v === 'partecipazione stabile') return { group: g.id, level: 'stable' };
          return null;
        })
        .filter(Boolean),
    });
  }
  return people;
}

/** Their Discord accounts, for those who signed in here (by their Discord email). */
async function discordByEmail(emails) {
  if (!emails.length) return {};
  const { rows } = await db.query(
    `select lower(email) as email, discord_id, name from app_users
     where kind = 'discord' and email is not null and lower(email) = any($1::text[])`,
    [emails]
  );
  const out = {};
  rows.forEach((r) => (out[r.email] = { id: r.discord_id, name: r.name }));
  return out;
}

/**
 * What importing the sheet would do, nothing stored: { people: [{ name, role,
 * publish, tags, discord, exists }], counts }. No email leaves the server.
 */
async function importPreview(user, csvText) {
  await access.authorize(user, 'members', { fresh: true });
  const groups = await listGroups();
  const people = peopleFromSheet(csvText, groups);
  const discord = await discordByEmail(people.map((p) => p.email));
  const { rows } = await db.query(
    'select person_key from community_members where person_key is not null'
  );
  const have = new Set(rows.map((r) => r.person_key));
  const out = people.map((p) => ({
    name: p.name,
    role: p.role,
    publish: p.publish,
    tags: p.tags,
    discord: discord[p.email] || null,
    exists: have.has(crm.personKey(p.email)),
  }));
  out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return {
    people: out,
    counts: {
      people: out.length,
      published: out.filter((p) => p.publish).length,
      tagged: out.filter((p) => p.tags.length).length,
      onDiscord: out.filter((p) => p.discord).length,
      already: out.filter((p) => p.exists).length,
    },
  };
}

/**
 * Brings the sheet's people in (those already here are updated, their tags
 * added to), gives the matched ones their tags on Discord, and switches the
 * site over to this list. Returns { imported, updated, discordFailed }.
 */
async function importConfirm(user, csvText) {
  await access.authorize(user, 'members', { fresh: true });
  const groups = await listGroups();
  const people = peopleFromSheet(csvText, groups);
  const discord = await discordByEmail(people.map((p) => p.email));
  let imported = 0;
  let updated = 0;
  let discordFailed = 0;
  for (const p of people) {
    const key = crm.personKey(p.email);
    const found = (await db.query('select * from community_members where person_key = $1', [key]))
      .rows[0];
    const id = found ? found.id : crypto.randomUUID();
    const linked = discord[p.email] ? discord[p.email].id : null;
    if (found) {
      await db.query(
        `update community_members set discord_id = coalesce(discord_id, $2), updated_at = now() where id = $1`,
        [id, linked && !(await takenDiscord(linked, id)) ? linked : null]
      );
      updated++;
    } else {
      await db.query(
        `insert into community_members (id, person_key, discord_id, role, publish, details_encrypted, source, joined_on)
         values ($1, $2, $3, $4, $5, $6, 'sheet', $7)`,
        [
          id,
          key,
          linked && !(await takenDiscord(linked, id)) ? linked : null,
          p.role,
          p.publish,
          sealDetails(id, p),
          p.joinedOn,
        ]
      );
      imported++;
    }
    for (const t of p.tags) {
      await db.query(
        `insert into member_groups (member_id, group_id, level) values ($1, $2, $3)
         on conflict (member_id, group_id) do nothing`,
        [id, t.group, t.level]
      );
    }
    if (!(await syncRoles(await loadMember(id)))) discordFailed++;
  }
  await audit.record(user, 'community-import', null, { imported, updated });
  return { imported, updated, discordFailed };
}

async function takenDiscord(discordId, exceptId) {
  const { rows } = await db.query(
    'select 1 from community_members where discord_id = $1 and id <> $2',
    [discordId, exceptId]
  );
  return rows.length > 0;
}

// ── The site ─────────────────────────────────────────────────────────────────

const PUBLISHED = 'community_published';

/** What was last published to the site, or null (never: the YAML is the site). */
async function published() {
  const { rows } = await db.query('select value from app_settings where key = $1', [PUBLISHED]);
  return rows[0] && rows[0].value && rows[0].value.groups ? rows[0].value : null;
}

async function isLive() {
  return Boolean(await published());
}

/**
 * Publishes the directory and the working groups as they are now: the site
 * shows this copy from its next build, which starts here. Returns
 * { publishedAt, build }.
 */
async function publishSite(user) {
  await access.authorize(user, 'members', { fresh: true });
  const copy = { ...(await draft()), publishedAt: new Date().toISOString() };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [PUBLISHED, JSON.stringify(copy)]
  );
  const build = await require('./content-publish').triggerBuild();
  await audit.record(user, 'community-import', null, {
    published: copy.members.length,
    groups: copy.groups.length,
  });
  return { publishedAt: copy.publishedAt, build };
}

/** Takes the site back to the YAML (data/members.yaml, community.yaml). */
async function unpublishSite(user) {
  await access.authorize(user, 'members', { fresh: true });
  await db.query('delete from app_settings where key = $1', [PUBLISHED]);
  const build = await require('./content-publish').triggerBuild();
  await audit.record(user, 'community-import', null, { published: false });
  return { publishedAt: null, build };
}

function canonical(value) {
  return JSON.stringify(value, (key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce((o, k) => ((o[k] = v[k]), o), {})
      : v
  );
}

/** Whether the list differs from what the site shows: { live, publishedAt, pending }. */
async function siteState() {
  const now = await draft();
  const was = await published();
  // jsonb keeps keys in its own order: compare with sorted keys.
  const same =
    was &&
    canonical({ groups: was.groups, members: was.members }) ===
      canonical({ groups: now.groups, members: now.members });
  return { live: Boolean(was), publishedAt: was ? was.publishedAt : null, pending: !same };
}
/**
 * What the site would show now: the groups, and the members who consented,
 * with only their public fields. { groups, members }.
 */
async function draft() {
  const groups = (await listGroups()).map((g) => ({
    id: g.id,
    title: g.titleEn,
    title_it: g.titleIt,
    description: g.descriptionEn,
    description_it: g.descriptionIt,
    form_keys: [g.id],
  }));
  const { rows } = await db.query(
    'select * from community_members where publish order by joined_on nulls last, created_at'
  );
  const byMember = await groupsByMember();
  const members = rows
    .map((r) => {
      const d = detailsOf(r);
      if (!d || !d.name) return null;
      const m = { name: d.name };
      if (d.profile) m.profile = d.profile;
      if (d.location) m.location = d.location;
      if (d.areas) m.areas = d.areas;
      const g = (byMember[r.id] || []).map((x) => x.group);
      if (g.length) m.groups = g;
      return m;
    })
    .filter(Boolean)
    .map((m, i) => ({ id: i + 1, ...m }));
  return { groups, members };
}

/** What the site shows (/api/community): the published copy. { live, groups, members }. */
async function publicExport() {
  const was = await published();
  return was
    ? { live: true, groups: was.groups, members: was.members, publishedAt: was.publishedAt }
    : { live: false, groups: [], members: [] };
}
module.exports = {
  LEVELS,
  listGroups,
  saveGroup,
  reorderGroups,
  deleteGroup,
  listMembers,
  updateMember,
  setTags,
  fromApplication,
  cleanTags,
  importPreview,
  importConfirm,
  publishSite,
  unpublishSite,
  siteState,
  isLive,
  publicExport,
  syncRoles,
};
