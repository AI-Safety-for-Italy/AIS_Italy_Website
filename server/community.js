// The community: its working groups and its members, kept here rather than in
// the old Google Sheet (scripts/update-members.py, data/members.yaml).
//
//   - A working group (work_groups) has its Discord role. On Discord it is a
//     role, here it is only a tag: it never opens anything in the dashboard.
//   - A member (community_members) is someone let in: approved on the member
//     applications board, or imported once from the old sheet. Their name,
//     profile link, place and areas are kept encrypted, bound to their row;
//     `publish` says whether the site may show them (their consent).
//   - member_groups says which groups each is in, and at which level:
//     stable, or coordination for the group's coordinators, who are chosen
//     on Working groups only (setCoordinator), never from a form or a sheet.
//
// Every change of tags is mirrored on Discord at once (the bot gives or takes
// the group's role). The site changes only when someone presses "Publish to
// the site": that stores what it may show (publishSite) and rebuilds it; its
// directory and working groups come from that published copy through
// /api/community (server/community-build.js). Never published, the YAML stays
// the site. Managed from Members → Board (Members and Working groups), with
// the `community` permission, apart from the applications (`members`).

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
  await access.authorize(user, 'community', { fresh: true });
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
  await access.authorize(user, 'community', { fresh: true });
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
  await access.authorize(user, 'community', { fresh: true });
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
 * groups given, those of the other groups taken away (with `addOnly`, only
 * given). Returns whether all went.
 */
async function syncRoles(member, { addOnly = false } = {}) {
  if (!member.discord_id) return true;
  const groups = await listGroups();
  const { rows } = await db.query('select group_id from member_groups where member_id = $1', [
    member.id,
  ]);
  const mine = new Set(rows.map((r) => r.group_id));
  let ok = true;
  for (const g of groups) {
    // `addOnly`: the roles of their tags given, none taken away (someone
    // just linked or imported may hold roles given by hand on Discord: the
    // check of roles and tags shows those, for the team to decide).
    if (addOnly && !mine.has(g.id)) continue;
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
    discordName: discordInfoOf(row).displayName || '',
    discordUsername: discordInfoOf(row).username || '',
    discordAbsent: row.discord_absent,
    discordNote: discordInfoOf(row).note || '',
    source: row.source,
    joinedOn: row.joined_on,
    groups: groups[row.id] || [],
  };
}

/** Everyone in the community, with their groups: { members, groups, live }. */
async function listMembers(user) {
  await access.authorize(user, 'community');
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
  await access.authorize(user, 'community', { fresh: true });
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
  // Linked: no longer "not on Discord". Its roles follow with "Give the roles".
  if (discordId && discordId !== row.discord_id) {
    await db.query('update community_members set discord_absent = false where id = $1', [row.id]);
  }
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
  await access.authorize(user, 'community', { fresh: true });
  const b = body || {};
  const ids = Array.isArray(b.members) ? b.members.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Pick someone');
  const groups = await listGroups();
  const known = (g) => groups.some((x) => x.id === g);
  if (!known(b.group)) throw new HttpError(400, 'Unknown group', { field: 'group' });
  if (b.action === 'move' && (!known(b.to) || b.to === b.group))
    throw new HttpError(400, 'Move them to another group', { field: 'to' });
  if (!['add', 'remove', 'move'].includes(b.action))
    throw new HttpError(400, 'Add, remove or move?');

  const rows = [];
  for (const id of ids) rows.push(await loadMember(id));
  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (b.action === 'add') {
        await tx.query(
          `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
           on conflict (member_id, group_id) do nothing`,
          [row.id, b.group]
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
  // Discord is not touched here: the tags are what Discord should have, and
  // "Give the roles" (sendTags) brings it there; a role whose tag was taken
  // away shows among the differences, to take away or keep.
  await audit.record(user, 'community-tags', null, {
    action: b.action,
    group: b.group,
    to: b.to,
    count: rows.length,
  });
  const groupsNow = await groupsByMember();
  return { members: rows.map((r) => memberOut(r, groupsNow)) };
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
  // Taking part in each: who coordinates is chosen on Working groups.
  for (const t of cleanTags(tags, await listGroups())) {
    await db.query(
      `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
       on conflict (member_id, group_id) do nothing`,
      [id, t.group]
    );
  }
  const member = await loadMember(id);
  await syncRoles(member, { addOnly: true });
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

/**
 * Makes a member a coordinator of a group (`on`), or takes it back: the only
 * way someone coordinates (Working groups). A coordinator not in the group is
 * put in it (its role follows with "Give the roles"); taken back, they still
 * take part.
 * Returns { members } as listMembers has them.
 */
async function setCoordinator(user, { group, member, on } = {}) {
  await access.authorize(user, 'community', { fresh: true });
  const g = (await listGroups()).find((x) => x.id === group);
  if (!g) throw new HttpError(400, 'Unknown group');
  const row = await loadMember(member);
  if (on) {
    await db.query(
      `insert into member_groups (member_id, group_id, level) values ($1, $2, 'coordination')
       on conflict (member_id, group_id) do update set level = 'coordination'`,
      [row.id, g.id]
    );
  } else {
    await db.query(
      `update member_groups set level = 'stable' where member_id = $1 and group_id = $2`,
      [row.id, g.id]
    );
  }
  await audit.record(user, 'community-tags', row.id, {
    action: on ? 'coordinator' : 'not-coordinator',
    group: g.id,
  });
  const groups = await groupsByMember();
  const { rows } = await db.query('select * from community_members order by created_at');
  return { members: rows.map((r) => memberOut(r, groups)) };
}

// ── Linking to Discord, and their roles against their tags ──────────────────
// The old sheet has no Discord username, so most of those imported are not
// linked: here the team finds each one on the server (suggested by name),
// marks who is not on Discord at all, and compares everyone's roles there
// with their tags here. Who they are on Discord (username, display name) is
// kept, encrypted, with a note.

const MAX_NOTE = 300;

function discordContext(id) {
  return `community-discord:${id}`;
}

/** { username, displayName, note } as stored for a member, or {}. */
function discordInfoOf(row) {
  if (!row.discord_info_encrypted) return {};
  const plain = crm.decrypt(row.discord_info_encrypted, discordContext(row.id));
  try {
    return (plain && JSON.parse(plain)) || {};
  } catch {
    return {};
  }
}

function sealDiscordInfo(id, info) {
  return crm.encrypt(
    JSON.stringify({
      username: info.username || '',
      displayName: info.displayName || '',
      note: info.note || '',
    }),
    discordContext(id)
  );
}

/** A member of the Discord server as the page shows them. */
function discordPerson(m) {
  const u = (m && m.user) || {};
  return {
    discordId: u.id,
    username: u.username || '',
    displayName: m.nick || u.global_name || u.username || '',
    avatarUrl: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : null,
  };
}

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Calls the bot, waiting once when Discord asks to slow down. */
async function botCall(path, opts) {
  let res = await permissions.bot(path, opts);
  if (res.status === 429) {
    const wait = Math.min(Number(res.body && res.body.retry_after) || 1, 3);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    res = await permissions.bot(path, opts);
  }
  return res;
}

/** Members of the server whose username or nickname starts with `query`. */
async function searchServer(query) {
  const res = await botCall(
    `/guilds/${process.env.DISCORD_GUILD_ID}/members/search?limit=10&query=${encodeURIComponent(
      query
    )}`
  );
  if (!res.ok || !Array.isArray(res.body)) return [];
  return res.body.filter((m) => m.user && !m.user.bot);
}

/**
 * The Discord accounts that may be this member, best first: { suggestions:
 * [{ discordId, username, displayName, avatarUrl, score }] }. Searched by
 * their full name, then each of its words (Discord matches the start of a
 * username or nickname); accounts already linked to someone else are left
 * out. score 3: the same name; 2: every word of it; 1: one word.
 */
async function discordSuggestions(user, id) {
  await access.authorize(user, 'community');
  const row = await loadMember(id);
  if (!permissions.botConfigured()) return { suggestions: [], bot: false };
  const name = (detailsOf(row) || {}).name || '';
  const full = fold(name);
  const words = full.split(' ').filter((w) => w.length >= 2);
  const found = new Map();
  for (const q of [...new Set([full, ...words])].filter(Boolean).slice(0, 4)) {
    for (const m of await searchServer(q)) found.set(m.user.id, m);
  }
  const { rows } = await db.query(
    'select discord_id from community_members where discord_id is not null and id <> $1',
    [row.id]
  );
  const taken = new Set(rows.map((r) => r.discord_id));
  const suggestions = [...found.values()]
    .filter((m) => !taken.has(m.user.id))
    .map((m) => {
      const p = discordPerson(m);
      const names = [p.displayName, m.user.global_name, p.username].map(fold);
      let score = 0;
      if (names.includes(full)) score = 3;
      else if (words.length > 1 && names.some((n) => words.every((w) => n.includes(w)))) score = 2;
      else if (names.some((n) => words.some((w) => n.includes(w)))) score = 1;
      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName, 'it'))
    .slice(0, 6);
  return { suggestions, bot: true };
}

/**
 * Links a member to a Discord account (`discordId`), or unlinks them (null).
 * The roles of their tags are given; none is taken away. Who they are on
 * Discord is read and kept. Returns { member, discordFailed }.
 */
async function linkDiscord(user, id, discordId) {
  await access.authorize(user, 'community', { fresh: true });
  const row = await loadMember(id);
  const next = discordId ? String(discordId) : null;
  if (next && !/^\d{5,25}$/.test(next)) throw new HttpError(400, 'Unknown Discord account');
  if (next && (await takenDiscord(next, row.id)))
    throw new HttpError(409, 'Another member is this Discord account');
  let info = discordInfoOf(row);
  if (next && permissions.botConfigured()) {
    let res = null;
    try {
      res = await botCall(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${next}`);
    } catch {
      res = null; // Discord slow: linked anyway, the name comes with the next check
    }
    if (res && res.status === 404) throw new HttpError(404, 'Not on the Discord server');
    if (res && res.ok) {
      const p = discordPerson(res.body);
      info = { ...info, username: p.username, displayName: p.displayName };
    }
  }
  if (!next) info = { note: info.note };
  await db.query(
    `update community_members set discord_id = $2, discord_absent = false,
       discord_info_encrypted = $3, updated_at = now() where id = $1`,
    [row.id, next, sealDiscordInfo(row.id, info)]
  );
  const updated = await loadMember(row.id);
  // Discord changes only with "Give the roles" (sendTags): linking says who
  // they are, nothing more.
  await audit.record(user, 'community-discord', row.id, { action: next ? 'link' : 'unlink' });
  return { member: memberOut(updated, await groupsByMember()) };
}

/** Marks a member as checked and not on Discord (or not any more), with a note. */
async function markAbsent(user, id, { absent, note } = {}) {
  await access.authorize(user, 'community', { fresh: true });
  const row = await loadMember(id);
  if (absent && row.discord_id)
    throw new HttpError(409, 'They are linked to Discord: unlink first');
  const info = { ...discordInfoOf(row) };
  if (note !== undefined) info.note = text(note, 'Note', MAX_NOTE, false);
  await db.query(
    `update community_members set discord_absent = $2, discord_info_encrypted = $3,
       updated_at = now() where id = $1`,
    [row.id, Boolean(absent), sealDiscordInfo(row.id, info)]
  );
  await audit.record(user, 'community-discord', row.id, {
    action: absent ? 'not-on-discord' : 'to-check',
  });
  return { member: memberOut(await loadMember(row.id), await groupsByMember()) };
}

// Why the last serverList() came back empty-handed, in words for the team
// (the import's preview shows it), or null when it read the list.
let listProblem = null;

/** What Discord's refusal to list the members means, for the team. */
function listRefusal(res) {
  const code = res.body && res.body.code;
  if (res.status === 403)
    return 'Discord refused to list the server’s members: turn on “Server Members Intent” for the bot (Developer Portal → the application → Bot → Privileged Gateway Intents), and check the bot is on the server';
  if (res.status === 401)
    return 'Discord did not accept the bot’s token (DISCORD_BOT_TOKEN_AIS_TEAM_AREA)';
  if (res.status === 404 || code === 10004)
    return 'Discord does not know the server (DISCORD_GUILD_ID), or the bot is not on it';
  return `Discord did not list the members (${res.status}${code ? `, code ${code}` : ''})`;
}

/**
 * Everyone on the Discord server, bots left out, in pages of 1000; null when
 * the bot may not read the list (no bot here, or the Server Members intent
 * off in the Developer Portal): `listProblem` then says why, and the reason
 * is in the logs too.
 */
async function serverList() {
  listProblem = null;
  if (!permissions.botConfigured()) {
    listProblem =
      'the Discord bot is not set up on this deployment (DISCORD_BOT_TOKEN_AIS_TEAM_AREA and DISCORD_GUILD_ID)';
    return null;
  }
  const guild = process.env.DISCORD_GUILD_ID;
  const out = [];
  let after = '0';
  for (let page = 0; page < 20; page++) {
    let res = null;
    try {
      res = await botCall(`/guilds/${guild}/members?limit=1000&after=${after}`);
    } catch (err) {
      listProblem = 'Discord did not answer in time: try again in a moment';
      console.error('Listing the Discord members failed', err.message);
      return null;
    }
    if (!res.ok || !Array.isArray(res.body)) {
      listProblem = listRefusal(res);
      console.error(
        `Listing the Discord members failed (${res.status})`,
        (res.body && res.body.message) || ''
      );
      return null;
    }
    out.push(...res.body.filter((m) => m.user && !m.user.bot));
    if (res.body.length < 1000) break;
    after = res.body[res.body.length - 1].user.id;
  }
  return out;
}

/**
 * The server's members among `ids`: { found: Map(id -> member), gone: Set of
 * ids no longer on the server, failed }. The whole list when the bot may read
 * it (serverList), else one by one.
 */
async function serverMembers(ids) {
  const want = new Set(ids);
  const found = new Map();
  const guild = process.env.DISCORD_GUILD_ID;
  const all = await serverList();
  const listed = Boolean(all);
  if (all) all.forEach((m) => want.has(m.user.id) && found.set(m.user.id, m));
  const gone = new Set();
  let failed = 0;
  if (listed) {
    want.forEach((id) => !found.has(id) && gone.add(id));
    return { found, gone, failed };
  }
  for (const id of want) {
    let res = null;
    try {
      res = await botCall(`/guilds/${guild}/members/${id}`);
    } catch {
      res = null;
    }
    if (res && res.ok) found.set(id, res.body);
    else if (res && res.status === 404) gone.add(id);
    else failed++;
  }
  return { found, gone, failed };
}

/**
 * Everyone linked, their roles on Discord against their tags here: { members:
 * [{ id, name, discord, notOnServer, missing: [group], extra: [group] }] with
 * a difference only, groups, checked, failed }. missing: a tag without its
 * role; extra: a working group's role without the tag. Differences the team
 * left as they are (member_role_ok) are not listed again.
 */
async function roleCheck(user) {
  await access.authorize(user, 'community');
  if (!permissions.botConfigured())
    throw new HttpError(503, 'The Discord bot is not set up here: nothing to compare with');
  const result = await differences();
  await audit.record(user, 'community-discord', null, {
    action: 'check',
    checked: result.checked,
    differences: result.members.length,
  });
  return result;
}

/** roleCheck's comparison, without the audit line (also for the status bar). */
async function differences() {
  const groups = await listGroups();
  const { rows } = await db.query('select * from community_members where discord_id is not null');
  const tags = await groupsByMember();
  const oks = new Set(
    (await db.query('select member_id, group_id, kind from member_role_ok')).rows.map(
      (r) => `${r.member_id}:${r.group_id}:${r.kind}`
    )
  );
  const { found, gone, failed } = await serverMembers(rows.map((r) => r.discord_id));
  const members = [];
  for (const row of rows) {
    const name = (detailsOf(row) || {}).name || '';
    if (gone.has(row.discord_id)) {
      members.push({ id: row.id, name, notOnServer: true, missing: [], extra: [] });
      continue;
    }
    const m = found.get(row.discord_id);
    if (!m) continue;
    const discord = discordPerson(m);
    // Who they are there, kept the first time it is read.
    const info = discordInfoOf(row);
    if (!info.username && discord.username) {
      await db.query('update community_members set discord_info_encrypted = $2 where id = $1', [
        row.id,
        sealDiscordInfo(row.id, { ...info, ...discord }),
      ]);
    }
    const roles = new Set(m.roles || []);
    const mine = new Set((tags[row.id] || []).map((t) => t.group));
    const missing = groups
      .filter((g) => mine.has(g.id) && !roles.has(g.discordRoleId))
      .filter((g) => !oks.has(`${row.id}:${g.id}:missing`))
      .map((g) => g.id);
    const extra = groups
      .filter((g) => !mine.has(g.id) && roles.has(g.discordRoleId))
      .filter((g) => !oks.has(`${row.id}:${g.id}:extra`))
      .map((g) => g.id);
    if (missing.length || extra.length)
      members.push({ id: row.id, name, discord, notOnServer: false, missing, extra });
  }
  members.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return { members, groups, checked: rows.length, failed };
}

/**
 * Where the members board stands, for the bar on top of its tabs: three
 * questions, each answered with counts only.
 *   accounts  { members, linked, absent, toLink }: who is who on Discord
 *   roles     { available, problem?, missing, missingMembers, extra, gone }:
 *             tags here without their role there (fixed by "Give the roles"),
 *             roles there without a tag here, linked accounts gone from the
 *             server; read from Discord, so `available` false without the bot
 *   site      { live, publishedAt, pending, changes }: the public directory
 */
async function status(user) {
  await access.authorize(user, 'community');
  const { rows } = await db.query('select discord_id, discord_absent from community_members');
  const linked = rows.filter((r) => r.discord_id).length;
  const absent = rows.filter((r) => !r.discord_id && r.discord_absent).length;
  const accounts = { members: rows.length, linked, absent, toLink: rows.length - linked - absent };
  let roles;
  if (!permissions.botConfigured()) {
    roles = {
      available: false,
      problem: 'the Discord bot is not set up on this deployment',
    };
  } else {
    const d = await differences();
    roles = {
      available: true,
      missing: d.members.reduce((n, m) => n + m.missing.length, 0),
      missingMembers: d.members.filter((m) => m.missing.length).length,
      extra: d.members.reduce((n, m) => n + m.extra.length, 0),
      gone: d.members.filter((m) => m.notOnServer).length,
      failed: d.failed,
    };
  }
  return { accounts, roles, site: await siteState() };
}

// Role changes per call: Discord limits how fast roles change, and a call
// must end in seconds. The page calls again until none is left.
const TAGS_PER_CALL = 15;

/**
 * "Send tags to Discord": gives everyone linked the roles of their tags they
 * do not have yet, TAGS_PER_CALL at a time; none is taken away, and a missing
 * role left as it is on the check (member_role_ok) is not given. Returns
 * { given, failed, remaining } (remaining: still to give after this call).
 */
async function sendTags(user) {
  await access.authorize(user, 'community', { fresh: true });
  if (!permissions.botConfigured())
    throw new HttpError(503, 'The Discord bot is not set up here: nothing to send');
  const groups = await listGroups();
  const roleOf = new Map(groups.map((g) => [g.id, g.discordRoleId]));
  const { rows } = await db.query('select * from community_members where discord_id is not null');
  const tags = await groupsByMember();
  const oks = new Set(
    (
      await db.query(`select member_id, group_id from member_role_ok where kind = 'missing'`)
    ).rows.map((r) => `${r.member_id}:${r.group_id}`)
  );
  const withTags = rows.filter((r) => (tags[r.id] || []).length);
  const { found } = await serverMembers(withTags.map((r) => r.discord_id));
  const todo = [];
  for (const row of withTags) {
    const m = found.get(row.discord_id);
    if (!m) continue; // not on the server (any more): the check shows them
    const has = new Set(m.roles || []);
    for (const t of tags[row.id]) {
      const role = roleOf.get(t.group);
      if (role && !has.has(role) && !oks.has(`${row.id}:${t.group}`))
        todo.push({ discordId: row.discord_id, role });
    }
  }
  let given = 0;
  let failed = 0;
  for (const t of todo.slice(0, TAGS_PER_CALL)) {
    if (await discordRole(t.discordId, t.role, true)) given++;
    else failed++;
  }
  await audit.record(user, 'community-discord', null, { action: 'send-tags', given, failed });
  return { given, failed, remaining: Math.max(todo.length - TAGS_PER_CALL, 0) };
}

/**
 * Settles one difference of roleCheck: `action`
 *   give   the role on Discord, for a tag here
 *   untag  the tag here, for a role missing there
 *   tag    the tag here (taking part), for a role there
 *   take   the role away on Discord, for no tag here
 *   ok     left as it is (`kind`: missing | extra): not listed again
 */
async function resolveRole(user, body) {
  await access.authorize(user, 'community', { fresh: true });
  const b = body || {};
  const row = await loadMember(b.member);
  if (!row.discord_id) throw new HttpError(409, 'Not linked to Discord');
  const group = (await listGroups()).find((g) => g.id === b.group);
  if (!group) throw new HttpError(400, 'Unknown group');
  let discordFailed = false;
  if (b.action === 'give' || b.action === 'take') {
    discordFailed = !(await discordRole(row.discord_id, group.discordRoleId, b.action === 'give'));
  } else if (b.action === 'tag') {
    await db.query(
      `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
       on conflict (member_id, group_id) do nothing`,
      [row.id, group.id]
    );
  } else if (b.action === 'untag') {
    await db.query('delete from member_groups where member_id = $1 and group_id = $2', [
      row.id,
      group.id,
    ]);
  } else if (b.action === 'ok') {
    if (!['missing', 'extra'].includes(b.kind)) throw new HttpError(400, 'Missing or extra?');
    await db.query(
      `insert into member_role_ok (member_id, group_id, kind) values ($1, $2, $3)
       on conflict do nothing`,
      [row.id, group.id, b.kind]
    );
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  await audit.record(user, 'community-discord', row.id, { action: b.action, group: group.id });
  return { ok: !discordFailed, discordFailed };
}

// ── The old sheet, once ──────────────────────────────────────────────────────
// The rules of scripts/update-members.py: approved ("Approvato", or someone who
// first registered before approvals existed and nobody rejected); published
// when they registered before the consent question, or consented; the answers
// "Coordinamento" and "Partecipazione stabile" give a group's tag (taking
// part: who coordinates is chosen on Working groups).

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
          // "Coordinamento" was asked on the form: it counts as taking part,
          // who coordinates is chosen on Working groups.
          if (v.startsWith('coordinamento') || v === 'partecipazione stabile')
            return { group: g.id, level: 'stable' };
          return null;
        })
        .filter(Boolean),
    });
  }
  return people;
}

/** Their Discord accounts, for those who signed in here (by their Discord email). */
/**
 * The Discord account of each of the sheet's people, before anything is
 * stored: { [email]: { id, name, username, displayName, by } }.
 *   by 'email'  they signed in here with Discord under that email
 *   by 'name'   their name on the sheet is, letter for letter (accents and
 *               case aside), the nickname, display name or username of one
 *               account on the server, and of no other; nor is that account
 *               anyone else's on the sheet or on the board
 * The second needs the server's list (serverList): `byName` says whether it
 * could be read. Anyone else is left for Members → Discord.
 */
async function matchDiscord(people) {
  const out = {};
  const byEmail = await discordByEmail(people.map((p) => p.email));
  Object.entries(byEmail).forEach(([email, d]) => (out[email] = { ...d, by: 'email' }));
  const server = await serverList();
  if (!server) return { matches: out, byName: false, problem: listProblem };
  const { rows } = await db.query(
    'select discord_id, person_key from community_members where discord_id is not null'
  );
  const linkedTo = new Map(rows.map((r) => [r.discord_id, r.person_key]));
  const index = new Map();
  for (const m of server) {
    const names = new Set(
      [m.nick, m.user.global_name, m.user.username].map(fold).filter((n) => n.includes(' '))
    );
    names.forEach((n) => index.set(n, (index.get(n) || new Set()).add(m)));
  }
  const candidates = {};
  for (const p of people) {
    if (out[p.email]) continue;
    const full = fold(p.name);
    const reversed = full.split(' ').reverse().join(' ');
    const hits = new Set([...(index.get(full) || []), ...(index.get(reversed) || [])]);
    if (hits.size !== 1) continue;
    const m = [...hits][0];
    const owner = linkedTo.get(m.user.id);
    if (owner && owner !== crm.personKey(p.email)) continue;
    candidates[p.email] = m;
  }
  // An account two people of the sheet would both get: neither.
  const uses = {};
  Object.values(candidates).forEach((m) => (uses[m.user.id] = (uses[m.user.id] || 0) + 1));
  Object.values(out).forEach((d) => (uses[d.id] = (uses[d.id] || 0) + 1));
  for (const [email, m] of Object.entries(candidates)) {
    if (uses[m.user.id] > 1) continue;
    const p = discordPerson(m);
    out[email] = {
      id: m.user.id,
      name: p.displayName,
      username: p.username,
      displayName: p.displayName,
      by: 'name',
    };
  }
  return { matches: out, byName: true, problem: null };
}

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
  await access.authorize(user, 'community', { fresh: true });
  const groups = await listGroups();
  const people = peopleFromSheet(csvText, groups);
  const { matches: discord, byName, problem } = await matchDiscord(people);
  const { rows } = await db.query(
    'select person_key from community_members where person_key is not null'
  );
  const have = new Set(rows.map((r) => r.person_key));
  const out = people.map((p) => ({
    name: p.name,
    role: p.role,
    publish: p.publish,
    tags: p.tags,
    discord: discord[p.email]
      ? { id: discord[p.email].id, name: discord[p.email].name, by: discord[p.email].by }
      : null,
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
      byName: out.filter((p) => p.discord && p.discord.by === 'name').length,
      already: out.filter((p) => p.exists).length,
    },
    // Whether the server's list could be read, for matching by name, and
    // if not, why.
    byName,
    byNameProblem: problem,
  };
}

/**
 * Brings the sheet's people in (those already here are updated, their tags
 * added to) and links those matched to Discord (matchDiscord). Nothing is
 * sent to Discord: the tags become roles with "Send tags to Discord"
 * (sendTags). Returns { imported, updated, linked }.
 */
async function importConfirm(user, csvText) {
  await access.authorize(user, 'community', { fresh: true });
  const groups = await listGroups();
  const people = peopleFromSheet(csvText, groups);
  const { matches: discord } = await matchDiscord(people);
  let imported = 0;
  let updated = 0;
  let linked = 0;
  for (const p of people) {
    const key = crm.personKey(p.email);
    const found = (await db.query('select * from community_members where person_key = $1', [key]))
      .rows[0];
    const id = found ? found.id : crypto.randomUUID();
    const match = discord[p.email];
    const account = match && !(await takenDiscord(match.id, id)) ? match.id : null;
    if (found) {
      await db.query(
        `update community_members set discord_id = coalesce(discord_id, $2), updated_at = now() where id = $1`,
        [id, account]
      );
      updated++;
    } else {
      await db.query(
        `insert into community_members (id, person_key, discord_id, role, publish, details_encrypted, source, joined_on)
         values ($1, $2, $3, $4, $5, $6, 'sheet', $7)`,
        [id, key, account, p.role, p.publish, sealDetails(id, p), p.joinedOn]
      );
      imported++;
    }
    // Who they are on Discord, kept as when linked on Members → Discord.
    const now = await loadMember(id);
    if (account && now.discord_id === account) {
      linked++;
      if (match.username) {
        await db.query(
          'update community_members set discord_info_encrypted = $2, discord_absent = false where id = $1',
          [id, sealDiscordInfo(id, { ...discordInfoOf(now), ...match })]
        );
      }
    }
    for (const t of p.tags) {
      await db.query(
        `insert into member_groups (member_id, group_id, level) values ($1, $2, $3)
         on conflict (member_id, group_id) do nothing`,
        [id, t.group, t.level]
      );
    }
  }
  await audit.record(user, 'community-import', null, { imported, updated, linked });
  return { imported, updated, linked };
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
  await access.authorize(user, 'community', { fresh: true });
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
  await access.authorize(user, 'community', { fresh: true });
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
  // How many people and groups the site would show differently: added,
  // removed or changed (the ids are positions, so left out).
  const keyed = (list) =>
    new Set(list.map((x) => canonical({ ...x, id: x.id && typeof x.id === 'number' ? 0 : x.id })));
  const diff = (a, b) => [...a].filter((x) => !b.has(x)).length;
  let changes = 0;
  if (was) {
    for (const k of ['members', 'groups']) {
      const before = keyed(was[k] || []);
      const after = keyed(now[k] || []);
      changes += Math.max(diff(before, after), diff(after, before));
    }
  } else {
    changes = now.members.length + now.groups.length;
  }
  return {
    live: Boolean(was),
    publishedAt: was ? was.publishedAt : null,
    pending: !same,
    changes: same ? 0 : Math.max(changes, 1),
  };
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
  setCoordinator,
  discordSuggestions,
  linkDiscord,
  markAbsent,
  roleCheck,
  status,
  sendTags,
  resolveRole,
};
