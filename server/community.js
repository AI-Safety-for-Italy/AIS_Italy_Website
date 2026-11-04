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
// The board is what should be; Discord and the website follow it, each when
// the team says so:
//   - Database: every change on the board is saved at once, and only there.
//   - Discord: what differs between the board and the server is worked out
//     each time (discordPlan): roles to give, roles to take off (those the
//     board took away: discord_removals, and the retired roles of groups
//     removed: discord_retired_roles), and what Discord has that the board
//     does not say (to adopt, take off or leave). Nothing changes there
//     until someone applies it (applyDiscord). Only the automatic flows act
//     at once: joining with the invite link and an approved upgrade
//     (server/members.js), which give the roles they were approved with.
//   - Website: "Update the website" stores what it may show (publishSite)
//     and rebuilds it; its directory and working groups come from that
//     published copy through /api/community (server/community-build.js).
//     Never published, the YAML stays the site.
// Data arriving from elsewhere (the old sheet, applications, Discord) is
// merged by the rules of server/member-merge.js. Managed from Members → Board,
// with the `community` permission, apart from the applications (`members`).

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const access = require('./access');
const permissions = require('./permissions');
const audit = require('./crm/audit');
const crm = require('./crm/crypto');
const { parseCsv, rowsFromValues } = require('./sheets');
const merge = require('./member-merge');

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
    // A new role for the group: the old one is retired (whoever holds it is
    // listed on the Discord tab, to take it off); the new one is missing for
    // everyone in the group until applied there.
    if (existing.discord_role_id !== roleId) {
      await retireRole(existing.discord_role_id, existing.id, existing.title_en);
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
  // A role a group has again is no longer retired.
  await db.query('delete from discord_retired_roles where role_id = $1', [roleId]);
  await audit.record(user, 'community-groups', null, {
    group: id,
    change: existing ? 'edit' : 'add',
    roleChanged: existing && existing.discord_role_id !== roleId ? true : undefined,
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
 * Removes a group: its tag goes from everyone. Its role is retired: whoever
 * holds it on Discord is listed on the Discord tab, to take it off there
 * (the role itself stays on Discord, to delete there if wanted).
 */
async function deleteGroup(user, id) {
  await access.authorize(user, 'community', { fresh: true });
  const { rows } = await db.query('select * from work_groups where id = $1', [String(id)]);
  if (!rows[0]) throw new HttpError(404, 'No such group');
  const { rows: had } = await db.query('select member_id from member_groups where group_id = $1', [
    rows[0].id,
  ]);
  await db.query('delete from work_groups where id = $1', [rows[0].id]);
  await retireRole(rows[0].discord_role_id, rows[0].id, rows[0].title_en);
  await audit.record(user, 'community-groups', null, {
    group: rows[0].id,
    change: 'delete',
    members: had.map((r) => r.member_id),
  });
  return { groups: await listGroups() };
}

async function retireRole(roleId, groupId, title) {
  if (!roleId) return;
  await db.query(
    `insert into discord_retired_roles (role_id, group_id, title) values ($1, $2, $3)
     on conflict (role_id) do update set group_id = excluded.group_id, title = excluded.title,
       retired_at = now()`,
    [roleId, groupId, title || groupId]
  );
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

// ── Partecipante, Organizzatore ──────────────────────────────────────────────
// Every member holds one of the association's two roles on Discord, the one
// of their role here (an organizer may keep Partecipante too). Its ids are
// the members board's (DISCORD_ROLE_PARTICIPANT, DISCORD_ROLE_ORGANIZER).

const MAIN_ROLES = ['participant', 'organizer'];

function mainRoleId(key) {
  // Required here: server/members.js requires this file at its top.
  return require('./members').roleId(key);
}

function hasMainRole(roles) {
  return MAIN_ROLES.some((k) => mainRoleId(k) && roles.has(mainRoleId(k)));
}

/**
 * After a member's role here changed to `role`: made an organizer, their
 * request to become one (Applications) is closed as approved.
 */
async function roleSettled(user, row, role) {
  if (role === 'organizer') await require('./members').upgradeSettled(user, row.discord_id);
}

// ── What the board changed, kept for Discord and for later imports ──────────

/** Marks `fields` of a member as set on the board now (server/member-merge.js). */
async function touch(id, fields, q = db) {
  if (!fields.length) return;
  const stamp = { source: 'board', at: new Date().toISOString() };
  await q.query(
    'update community_members set field_sources = field_sources || $2::jsonb where id = $1',
    [id, JSON.stringify(Object.fromEntries(fields.map((f) => [f, stamp])))]
  );
}

/**
 * A role the board took away from a member (`off`): to take off on Discord
 * with the next apply. Given back (not `off`): nothing to take off any more.
 */
async function queueRemoval(memberId, roleId, off, q = db) {
  if (!roleId) return;
  if (off) {
    await q.query(
      `insert into discord_removals (member_id, role_id) values ($1, $2)
       on conflict do nothing`,
      [memberId, roleId]
    );
  } else {
    await q.query('delete from discord_removals where member_id = $1 and role_id = $2', [
      memberId,
      roleId,
    ]);
  }
}

/** After a member's role here changed to `role`: Organizzatore off or not. */
async function queueMainRole(memberId, role, q = db) {
  await queueRemoval(memberId, mainRoleId('organizer'), role !== 'organizer', q);
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

/**
 * Everyone in the community, with their groups: { members, groups, roles,
 * site, invited, applications }. invited: approved on Applications, not on
 * Discord yet; applications: whether this user may open them too.
 */
async function listMembers(user) {
  await access.authorize(user, 'community');
  const { rows } = await db.query('select * from community_members order by created_at');
  const groups = await groupsByMember();
  const members = rows.map((r) => memberOut(r, groups));
  members.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  await audit.record(user, 'community-list', null, { count: members.length });
  const names = await roleNames();
  return {
    members,
    groups: (await listGroups()).map((g) => ({
      ...g,
      discordRoleName: names[g.discordRoleId] || null,
    })),
    roles: await mainRoles(names),
    site: await siteState(),
    invited: await require('./members').invited(),
    applications: (await permissions.forUser(user)).includes('members'),
  };
}

/**
 * One member's page: { member, sources, applications, discord, site,
 * history, groups, roles }.
 *   member        as listed, with where each field came from (fieldSources)
 *   sources       the old sheet's rows they came with, as answered
 *   applications  their applications and upgrades, with the answers
 *   discord       their changes waiting on Discord (discordPlan for them), or
 *                 { available: false, problem }
 *   site          online | changed | waiting | hidden, and the public entry
 *   history       the audit trail about them
 */
async function memberDetail(user, id) {
  await access.authorize(user, 'community');
  const row = await loadMember(id);
  const member = {
    ...memberOut(row, await groupsByMember()),
    fieldSources: row.field_sources || {},
  };
  const { rows: srcs } = await db.query(
    `select * from member_sources where member_id = $1 order by received_at nulls first, created_at`,
    [row.id]
  );
  const sources = srcs.map((r) => {
    let answers = null;
    try {
      answers = JSON.parse(crm.decrypt(r.answers_encrypted, sourceContext(r.id)) || 'null');
    } catch {
      answers = null;
    }
    return { id: r.id, kind: r.kind, receivedAt: r.received_at, answers };
  });
  const applications = await require('./members').applicationsOf({
    personKey: row.person_key,
    discordId: row.discord_id,
  });
  let discord;
  try {
    discord = row.discord_id
      ? await discordPlan({ memberId: row.id })
      : { available: permissions.botConfigured(), items: [], decide: [], gone: [] };
  } catch (err) {
    discord = { available: false, problem: err.message, items: [], decide: [], gone: [] };
  }
  const now = await draft();
  const state = perMemberSite(await published(), now);
  const at = now.owners.indexOf(row.id);
  const site = {
    status: state[row.id] || 'hidden',
    entry: at >= 0 ? now.members[at] : null,
  };
  const history = await audit.forMember(
    row.id,
    applications.map((a) => a.id)
  );
  await audit.record(user, 'community-member', row.id, { action: 'view' });
  const names = await roleNames();
  return {
    member,
    sources,
    applications,
    discord,
    site,
    history,
    groups: (await listGroups()).map((g) => ({
      ...g,
      discordRoleName: names[g.discordRoleId] || null,
    })),
    roles: await mainRoles(names),
  };
}

const UUID = /^[0-9a-f-]{36}$/i;

async function loadMember(id) {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, 'No such member');
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
  // Linked: no longer "not on Discord". Its roles follow when applied.
  if (discordId && discordId !== row.discord_id) {
    await db.query('update community_members set discord_absent = false where id = $1', [row.id]);
  }
  const changed = merge.TEXT.filter((f) => (next[f] || '') !== (d[f] || ''));
  if (publish !== row.publish) changed.push('publish');
  if (discordId !== row.discord_id) changed.push('discordId');
  await touch(row.id, changed);
  await audit.record(user, 'community-member', row.id, { action: 'edit', fields: changed });
  return { member: memberOut(await loadMember(row.id), await groupsByMember()) };
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
  const roleOf = new Map(groups.map((g) => [g.id, g.discordRoleId]));
  await db.transaction(async (tx) => {
    for (const row of rows) {
      // Out of `group` (remove, move): its role to take off; into a group
      // (add, move): its role no longer to take off.
      if (b.action !== 'add') await queueRemoval(row.id, roleOf.get(b.group), true, tx);
      if (b.action !== 'remove')
        await queueRemoval(row.id, roleOf.get(b.action === 'move' ? b.to : b.group), false, tx);
      await touch(row.id, ['groups'], tx);
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
  // applying the changes on the Discord tab brings it there.
  await audit.record(user, 'community-tags', null, {
    action: b.action,
    group: b.group,
    to: b.to,
    count: rows.length,
    members: rows.map((r) => r.id),
  });
  const groupsNow = await groupsByMember();
  return { members: rows.map((r) => memberOut(r, groupsNow)) };
}

/**
 * One member's working groups and role, set by hand from their page:
 * `groups` is the full list of group ids they should be in (left out:
 * unchanged), `role` participant or organizer (optional). Groups kept keep
 * their level (a coordinator stays one), new ones are taking part. Saved
 * here only: on Discord, the roles of the groups added and of the role are
 * missing, those of the groups left (and Organizzatore, made a participant)
 * are queued to take off, until applied from the Discord tab.
 * Returns { member, added, left, roleChanged }.
 */
async function setMemberGroups(user, id, body) {
  await access.authorize(user, 'community', { fresh: true });
  const row = await loadMember(id);
  const b = body || {};
  if (b.role !== undefined && !MAIN_ROLES.includes(b.role))
    throw new HttpError(400, 'Participant or organizer?', { field: 'role' });
  const roleChanged = b.role !== undefined && b.role !== row.role;
  if (b.groups === undefined) b.groups = (await groupsByMember())[row.id] || [];
  if (!Array.isArray(b.groups)) throw new HttpError(400, 'Which groups?', { field: 'groups' });
  const groups = await listGroups();
  const roleOf = new Map(groups.map((g) => [g.id, g.discordRoleId]));
  const wanted = [...new Set(b.groups.map((g) => String(g && g.group ? g.group : g)))];
  if (wanted.some((g) => !roleOf.has(g)))
    throw new HttpError(400, 'Unknown group', { field: 'groups' });
  const { rows: had } = await db.query('select group_id from member_groups where member_id = $1', [
    row.id,
  ]);
  const before = new Set(had.map((r) => r.group_id));
  const added = wanted.filter((g) => !before.has(g));
  const left = [...before].filter((g) => !wanted.includes(g));
  await db.transaction(async (tx) => {
    if (roleChanged) {
      await tx.query('update community_members set role = $2, updated_at = now() where id = $1', [
        row.id,
        b.role,
      ]);
      await queueMainRole(row.id, b.role, tx);
      await touch(row.id, ['role'], tx);
    }
    for (const g of left) {
      await tx.query('delete from member_groups where member_id = $1 and group_id = $2', [
        row.id,
        g,
      ]);
      await queueRemoval(row.id, roleOf.get(g), true, tx);
    }
    for (const g of added) {
      await tx.query(
        `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
         on conflict (member_id, group_id) do nothing`,
        [row.id, g]
      );
      await queueRemoval(row.id, roleOf.get(g), false, tx);
    }
    if (added.length || left.length) await touch(row.id, ['groups'], tx);
  });
  if (roleChanged) await roleSettled(user, row, b.role);
  await audit.record(user, 'community-tags', row.id, {
    action: 'set',
    role: roleChanged ? b.role : undefined,
    added,
    left,
  });
  return {
    member: memberOut(await loadMember(row.id), await groupsByMember()),
    added,
    left,
    roleChanged,
  };
}

// Cells starting like a formula are kept as text, so a spreadsheet never runs
// what was typed in (as the forms' export, server/forms/forms.js).
const FORMULA = /^[=+\-@\t\r]/;
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A `date` column comes back as local midnight: its day, not shifted to UTC.
function dateOnly(value) {
  if (!value) return '';
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * Every member as a CSV file, one row each, their working groups and those
 * they coordinate in their columns. Written on the audit trail.
 * Returns { filename, csv }.
 */
async function exportCsv(user) {
  await access.authorize(user, 'community', { fresh: true });
  const { rows } = await db.query('select * from community_members order by created_at');
  const tags = await groupsByMember();
  const groups = await listGroups();
  const title = new Map(groups.map((g) => [g.id, g.titleEn]));
  const list = rows.map((r) => memberOut(r, tags));
  list.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const named = (m, level) =>
    m.groups
      .filter((g) => !level || g.level === level)
      .map((g) => title.get(g.group) || g.group)
      .join('; ');
  const lines = [
    [
      'Name',
      'Role',
      'Working groups',
      'Coordinates',
      'Place',
      'Areas',
      'Profile',
      'On the site',
      'Discord name',
      'Discord username',
      'Discord id',
      'Not on Discord',
      'Source',
      'Joined on',
    ],
  ].concat(
    list.map((m) => [
      m.name,
      m.role === 'organizer' ? 'Organizer' : 'Participant',
      named(m),
      named(m, 'coordination'),
      m.location,
      m.areas,
      m.profile,
      m.publish ? 'Yes' : 'No',
      m.discordName,
      m.discordUsername,
      m.discordId || '',
      m.discordAbsent ? 'Yes' : '',
      m.source || '',
      dateOnly(m.joinedOn),
    ])
  );
  await audit.record(user, 'export', null, { part: 'community', members: list.length });
  return {
    filename: `members-${new Date().toISOString().slice(0, 10)}.csv`,
    // The BOM lets Excel read the accents as UTF-8.
    csv: '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n',
  };
}

// Who did what when nobody on the board pressed anything (audit trail).
const AUTOMATIC = { id: null, name: 'Automatic (join link)' };

/** The member's current data, for server/member-merge.js. */
async function current(row, q = db) {
  const { rows } = await q.query('select group_id from member_groups where member_id = $1', [
    row.id,
  ]);
  return { row, details: detailsOf(row) || {}, groups: rows.map((r) => r.group_id) };
}

/**
 * Writes what server/member-merge.js worked out for a member: `row` the one
 * there (null: new, with `id`), `changes` from merge.compare, `incoming` its
 * source and time. Groups added are no longer to take off on Discord.
 * Returns the member's id.
 */
async function writeMerge(q, { row, id, personKey, changes, incoming, source }) {
  const memberId = row ? row.id : id;
  const fieldSources = merge.stamped(row && row.field_sources, changes, incoming);
  if (!row) {
    await q.query(
      `insert into community_members (id, person_key, discord_id, role, publish, details_encrypted,
         source, joined_on, field_sources)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        memberId,
        personKey || null,
        changes.discordId || null,
        changes.set.role,
        changes.set.publish,
        sealDetails(memberId, changes.set),
        source,
        changes.joinedOn || null,
        JSON.stringify(fieldSources),
      ]
    );
  } else if (!merge.isEmpty(changes) || (personKey && !row.person_key)) {
    const d = { ...(detailsOf(row) || {}), ...changes.set };
    await q.query(
      `update community_members set details_encrypted = $2, role = $3, publish = $4,
         discord_id = coalesce(discord_id, $5), person_key = coalesce(person_key, $6),
         joined_on = coalesce($7, joined_on), field_sources = $8, updated_at = now()
       where id = $1`,
      [
        memberId,
        sealDetails(memberId, d),
        changes.set.role || row.role,
        changes.set.publish === undefined ? row.publish : changes.set.publish,
        changes.discordId || null,
        personKey || null,
        changes.joinedOn || null,
        JSON.stringify(fieldSources),
      ]
    );
  }
  if (changes.discordId)
    await q.query('update community_members set discord_absent = false where id = $1', [memberId]);
  const { rows: groupRows } = await q.query('select id, discord_role_id from work_groups');
  const roleOf = new Map(groupRows.map((g) => [g.id, g.discord_role_id]));
  for (const g of changes.groups) {
    if (!roleOf.has(g)) continue;
    await q.query(
      `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
       on conflict (member_id, group_id) do nothing`,
      [memberId, g]
    );
    await queueRemoval(memberId, roleOf.get(g), false, q);
  }
  if (changes.set.role === 'organizer') await queueMainRole(memberId, 'organizer', q);
  return memberId;
}

/**
 * The member an approved application becomes, or adds to (matched by email
 * key or Discord account), by the rules of server/member-merge.js: gaps
 * filled, newer answers taken, what the board set kept, the role never
 * lowered, groups only added. An automatic flow: the roles of their groups
 * are given on Discord at once (none taken away), and it is on the audit
 * trail. `source` application | upgrade, `at` when they answered, `by` who
 * approved (null: the join link). Called by server/members.js.
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
  source = 'application',
  at = null,
  by = null,
  applicationId = null,
}) {
  const key = email ? crm.personKey(email) : null;
  const { rows } = await db.query(
    `select * from community_members where ($1::text is not null and person_key = $1)
       or ($2::text is not null and discord_id = $2)
     order by (person_key = $1) desc nulls last limit 1`,
    [key, discordId || null]
  );
  const row = rows[0] || null;
  const taken = discordId && row ? await takenDiscord(discordId, row.id) : false;
  const incoming = {
    source,
    at: at || new Date(),
    details: { name, profile, location, areas },
    publish,
    role,
    groups: cleanTags(tags, await listGroups()).map((t) => t.group),
    discordId: discordId || null,
    joinedOn: new Date().toISOString().slice(0, 10),
  };
  const changes = merge.compare(row ? await current(row) : null, incoming, {
    auto: true,
    discordTaken: taken,
  });
  const id = await writeMerge(db, {
    row,
    id: crypto.randomUUID(),
    personKey: key,
    changes,
    incoming,
    source: 'application',
  });
  const member = await loadMember(id);
  const discordOk = await syncRoles(member, { addOnly: true });
  await audit.record(by || AUTOMATIC, 'community-member', id, {
    action: row ? 'merge' : 'create',
    from: source,
    application: applicationId || undefined,
    fields: Object.keys(changes.set),
    groups: changes.groups,
    kept: changes.kept.length ? changes.kept : undefined,
    discord: member.discord_id ? (discordOk ? 'roles given' : 'roles failed') : undefined,
  });
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
  if (on) await queueRemoval(row.id, g.discordRoleId, false);
  await touch(row.id, ['groups']);
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
  // Linking says who they are, nothing more: their roles follow when the
  // changes are applied on the Discord tab.
  await touch(row.id, ['discordId']);
  await audit.record(user, 'community-discord', row.id, { action: next ? 'link' : 'unlink' });
  return { member: memberOut(await loadMember(row.id), await groupsByMember()) };
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
async function serverMembers(ids, { list } = {}) {
  const want = new Set(ids);
  const found = new Map();
  const guild = process.env.DISCORD_GUILD_ID;
  // `list`: serverList() already read by the caller (null: it could not be).
  const all = list === undefined ? await serverList() : list;
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

// ── Discord against the board: what to change there ─────────────────────────
// The board says what should be; discordPlan() compares it with the server
// each time it is asked, so there is no list of changes to keep in step:
//   items   changes to make on Discord, each applied only when someone picks
//           it (applyDiscord): a role of their groups or of their role here
//           to give; a role the board took away (discord_removals) or of a
//           retired group (discord_retired_roles) to take off
//   decide  what Discord has that the board does not say (a group's role
//           without the tag, Organizzatore on a participant): to adopt here,
//           take off there, or leave (decideDiscord)
//   gone    members linked to an account no longer on the server
//   noRole  people on the server with neither role, not on the board
// What the team chose to leave as it is (member_role_ok, member_main_role_ok,
// discord_no_role_ok) is not listed again, until undone (unignore).

// Role changes per call: Discord limits how fast roles change, and a call
// must end in seconds. The page calls again until none is left.
const TAGS_PER_CALL = 15;

// The names of the server's roles, read now and then: the board shows the
// roles as Discord names them.
let roleNameCache = { at: 0, guild: null, names: null };
const ROLE_NAMES_FOR = 10 * 60 * 1000;

/** { [role id]: name } of the server's roles; what is known without the bot. */
async function roleNames() {
  const names = {};
  const members = require('./members');
  members.ROLES.forEach((r) => {
    const id = mainRoleId(r.key);
    if (id) names[id] = r.labelIt;
  });
  (await listGroups()).forEach((g) => (names[g.discordRoleId] = g.titleIt));
  const guild = process.env.DISCORD_GUILD_ID;
  if (!permissions.botConfigured()) return names;
  const fresh = roleNameCache.guild === guild && Date.now() - roleNameCache.at < ROLE_NAMES_FOR;
  if (!fresh) {
    try {
      const res = await botCall(`/guilds/${guild}/roles`);
      if (res.ok && Array.isArray(res.body)) {
        roleNameCache = {
          at: Date.now(),
          guild,
          names: Object.fromEntries(res.body.map((r) => [String(r.id), String(r.name)])),
        };
      }
    } catch {
      // Discord slow: the names known here do.
    }
  }
  const known = roleNameCache.guild === guild ? roleNameCache.names : null;
  return { ...names, ...(known || {}) };
}

/** The association's two roles as the board shows them: [{ key, roleId, name }]. */
async function mainRoles(names) {
  const n = names || (await roleNames());
  return require('./members').ROLES.map((r) => ({
    key: r.key,
    roleId: mainRoleId(r.key),
    name: (mainRoleId(r.key) && n[mainRoleId(r.key)]) || r.labelIt,
  }));
}

/**
 * The board against Discord (see above): { available, problem?, items,
 * decide, gone, noRole, noRoleProblem?, checked, failed, perMember }.
 * With `memberId`, for that member only (their account read alone, no
 * noRole). Each item has a stable `id` the page sends back:
 *   add:<member>:<role>     a role to give
 *   remove:<member>:<role>  a role to take off (`reason` untagged, role,
 *                           retired)
 *   extra:<member>:<role>   on Discord, not said here: to decide
 *   unlink:<member>         the account left the server
 *   norole:<discord id>     on the server with no role, not on the board
 */
async function discordPlan({ memberId } = {}) {
  const empty = { items: [], decide: [], gone: [], noRole: null, checked: 0, failed: 0 };
  if (!permissions.botConfigured())
    return {
      ...empty,
      available: false,
      problem: 'the Discord bot is not set up on this deployment',
      perMember: {},
    };
  const names = await roleNames();
  const groups = await listGroups();
  const rows = memberId
    ? [await loadMember(memberId)].filter((r) => r.discord_id)
    : (await db.query('select * from community_members where discord_id is not null')).rows;
  const ids = new Set(rows.map((r) => r.id));
  const tags = await groupsByMember();
  const set = async (sql, key) => new Set((await db.query(sql)).rows.map(key));
  const oks = await set(
    'select member_id, group_id, kind from member_role_ok',
    (r) => `${r.member_id}:${r.group_id}:${r.kind}`
  );
  const mainOks = await set(
    'select member_id, kind from member_main_role_ok',
    (r) => `${r.member_id}:${r.kind}`
  );
  const removals = await set(
    'select member_id, role_id from discord_removals',
    (r) => `${r.member_id}:${r.role_id}`
  );
  const retired = (await db.query('select * from discord_retired_roles')).rows;
  const list = memberId ? null : await serverList();
  const { found, gone, failed } = await serverMembers(
    rows.map((r) => r.discord_id),
    { list }
  );
  const P = mainRoleId('participant');
  const O = mainRoleId('organizer');
  const roleName = (id) => names[id] || id;
  const items = [];
  const decide = [];
  const goneOut = [];
  const stale = [];
  for (const row of rows) {
    const name = (detailsOf(row) || {}).name || '';
    if (gone.has(row.discord_id)) {
      goneOut.push({ id: `unlink:${row.id}`, memberId: row.id, name });
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
    const base = { memberId: row.id, name, discord, discordId: row.discord_id };
    const add = (roleId, reason, extra = {}) =>
      items.push({
        ...base,
        id: `add:${row.id}:${roleId}`,
        op: 'add',
        roleId,
        roleName: roleName(roleId),
        reason,
        ...extra,
      });
    const remove = (roleId, reason, extra = {}) =>
      items.push({
        ...base,
        id: `remove:${row.id}:${roleId}`,
        op: 'remove',
        roleId,
        roleName: roleName(roleId),
        reason,
        ...extra,
      });
    for (const g of groups) {
      const has = roles.has(g.discordRoleId);
      if (mine.has(g.id) && !has && !oks.has(`${row.id}:${g.id}:missing`)) {
        add(g.discordRoleId, 'group', { group: g.id });
      } else if (!mine.has(g.id) && has) {
        if (removals.has(`${row.id}:${g.discordRoleId}`))
          remove(g.discordRoleId, 'untagged', { group: g.id });
        else if (!oks.has(`${row.id}:${g.id}:extra`))
          decide.push({
            ...base,
            id: `extra:${row.id}:${g.discordRoleId}`,
            kind: 'group',
            group: g.id,
            roleId: g.discordRoleId,
            roleName: roleName(g.discordRoleId),
          });
      }
    }
    for (const r of retired) {
      if (roles.has(r.role_id))
        remove(r.role_id, 'retired', { group: r.group_id, groupTitle: r.title });
    }
    if (P && O) {
      const hasP = roles.has(P);
      const hasO = roles.has(O);
      if (row.role === 'organizer') {
        // An organizer may keep Partecipante too.
        const kind = hasP ? 'differs' : 'missing';
        if (!hasO && !mainOks.has(`${row.id}:${kind}`)) add(O, 'role', { main: kind });
      } else if (hasO) {
        if (removals.has(`${row.id}:${O}`)) {
          remove(O, 'role');
          if (!hasP) add(P, 'role', { main: 'missing' });
        } else if (!mainOks.has(`${row.id}:differs`)) {
          decide.push({
            ...base,
            id: `extra:${row.id}:${O}`,
            kind: 'main',
            roleId: O,
            roleName: roleName(O),
          });
        }
      } else if (!hasP && !mainOks.has(`${row.id}:missing`)) {
        add(P, 'role', { main: 'missing' });
      }
    }
    // Taken off by hand there already: nothing left to take off.
    for (const key of removals) {
      const [mid, roleId] = key.split(':');
      if (mid === row.id && !roles.has(roleId)) stale.push([mid, roleId]);
    }
  }
  for (const [mid, roleId] of stale) await queueRemoval(mid, roleId, false);
  const byName = (a, b) => a.name.localeCompare(b.name, 'it');
  items.sort((a, b) => byName(a, b) || a.op.localeCompare(b.op));
  decide.sort(byName);
  goneOut.sort(byName);
  const perMember = {};
  items.forEach((i) => (perMember[i.memberId] = (perMember[i.memberId] || 0) + 1));
  decide.forEach((i) => (perMember[i.memberId] = (perMember[i.memberId] || 0) + 1));
  goneOut.forEach((i) => (perMember[i.memberId] = (perMember[i.memberId] || 0) + 1));
  return {
    available: true,
    items,
    decide,
    gone: goneOut,
    checked: ids.size,
    failed,
    perMember,
    ...(memberId ? { noRole: null } : await noRole(list)),
  };
}

/** The plan as the Discord tab reads it, on the audit trail. */
async function discordPlanFor(user, { memberId } = {}) {
  await access.authorize(user, 'community');
  const plan = await discordPlan({ memberId: memberId || undefined });
  if (!memberId)
    await audit.record(user, 'community-discord', null, {
      action: 'check',
      checked: plan.checked,
      items: plan.items.length,
      decide: plan.decide.length,
    });
  return { ...plan, roles: await mainRoles(), groups: await listGroups() };
}

/**
 * Who is on the server with neither Partecipante nor Organizzatore and is
 * not on the board (joined with an invite, not through an application), the
 * ones left as they are aside: { noRole: [{ id, discordId, username,
 * displayName, avatarUrl, joinedAt }] }, or { noRole: null, noRoleProblem }
 * when the list of the server cannot be read or the roles' ids are not set.
 */
async function noRole(list) {
  if (!mainRoleId('participant') || !mainRoleId('organizer'))
    return {
      noRole: null,
      noRoleProblem: 'the ids of the Partecipante and Organizzatore roles are not set',
    };
  if (!list) return { noRole: null, noRoleProblem: listProblem || 'the server cannot be read' };
  const { rows } = await db.query(
    'select discord_id from community_members where discord_id is not null'
  );
  const onBoard = new Set(rows.map((r) => r.discord_id));
  const left = new Set(
    (await db.query('select discord_id from discord_no_role_ok')).rows.map((r) => r.discord_id)
  );
  const out = list
    .filter((m) => !onBoard.has(m.user.id) && !left.has(m.user.id))
    .filter((m) => !hasMainRole(new Set(m.roles || [])))
    .map((m) => ({
      id: `norole:${m.user.id}`,
      ...discordPerson(m),
      joinedAt: m.joined_at || null,
    }));
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'it'));
  return { noRole: out };
}

/**
 * Where the board stands against Discord and the website, for the bar on top
 * of its tabs, in counts:
 *   accounts  { members, linked, absent, toLink }: who is who on Discord
 *   discord   { available, problem?, toApply, toDecide, gone, noRole, failed,
 *             perMember }: changes waiting to be applied there, and what
 *             Discord has that the board does not say
 *   site      siteState(): what the website shows against the board
 */
async function status(user) {
  await access.authorize(user, 'community');
  const { rows } = await db.query('select discord_id, discord_absent from community_members');
  const linked = rows.filter((r) => r.discord_id).length;
  const absent = rows.filter((r) => !r.discord_id && r.discord_absent).length;
  const accounts = { members: rows.length, linked, absent, toLink: rows.length - linked - absent };
  const plan = await discordPlan();
  const discord = plan.available
    ? {
        available: true,
        toApply: plan.items.length,
        toApplyMembers: new Set(plan.items.map((i) => i.memberId)).size,
        toDecide: plan.decide.length,
        gone: plan.gone.length,
        noRole: plan.noRole ? plan.noRole.length : null,
        failed: plan.failed,
        perMember: plan.perMember,
      }
    : { available: false, problem: plan.problem, perMember: {} };
  return { accounts, discord, site: await siteState() };
}

/**
 * Applies picked changes of discordPlan on Discord: `items` their ids (with
 * `member`, that member's only). Each is checked against Discord now, so
 * what changed meanwhile is skipped; TAGS_PER_CALL a call, the page calls
 * again until `remaining` is 0. A role taken off is no longer queued.
 * Returns { done, failed, remaining, skipped }.
 */
async function applyDiscord(user, body) {
  await access.authorize(user, 'community', { fresh: true });
  if (!permissions.botConfigured())
    throw new HttpError(503, 'The Discord bot is not set up here: nothing to apply');
  const b = body || {};
  const ids = new Set((Array.isArray(b.items) ? b.items : []).map(String));
  if (!ids.size) throw new HttpError(400, 'Pick the changes to apply');
  const plan = await discordPlan({ memberId: b.member || undefined });
  const todo = plan.items.filter((i) => ids.has(i.id));
  const batch = todo.slice(0, TAGS_PER_CALL);
  const out = { done: 0, failed: 0 };
  const touched = new Set();
  for (const i of batch) {
    const ok = await discordRole(i.discordId, i.roleId, i.op === 'add');
    if (!ok) {
      out.failed++;
      continue;
    }
    out.done++;
    touched.add(i.memberId);
    if (i.op === 'remove') await queueRemoval(i.memberId, i.roleId, false);
  }
  await audit.record(user, 'community-discord', b.member || null, {
    action: 'apply',
    ...out,
    changes: batch.map((i) => `${i.op} ${i.roleName}`).slice(0, 50),
    members: [...touched],
  });
  return {
    ...out,
    remaining: todo.length - batch.length,
    skipped: ids.size - todo.length,
  };
}

const CHOICES = {
  add: ['ignore', 'untag', 'here'],
  remove: ['keep', 'forget'],
  extra: ['tag', 'remove', 'ignore'],
  unlink: ['unlink'],
  norole: ['participant', 'organizer', 'ignore'],
};

/**
 * Settles items of discordPlan here, never on Discord: `items` their ids,
 * `choice` one of CHOICES for their kind:
 *   add     ignore   leave it missing there (not listed again)
 *           untag    take the tag off here instead (a group's role)
 *           here     make them a participant here instead (Organizzatore)
 *   remove  keep     keep it on Discord: the board no longer takes it off
 *           forget   a retired group's role: stop listing it, for everyone
 *   extra   tag      adopt it here: the group's tag, or made an organizer
 *           remove   queue it to take off there
 *           ignore   leave it there (not listed again)
 *   unlink  unlink   the account left the server: unlinked here
 *   norole  participant | organizer   put on the board with that role (its
 *                    role then waits to be applied) | ignore
 * Returns { done, members }.
 */
async function decideDiscord(user, body) {
  await access.authorize(user, 'community', { fresh: true });
  const b = body || {};
  const ids = [...new Set((Array.isArray(b.items) ? b.items : []).map(String))];
  if (!ids.length || ids.length > 500) throw new HttpError(400, 'Pick from 1 to 500 items');
  const parsed = ids.map((id) => {
    const [kind, a, c] = id.split(':');
    if (!CHOICES[kind] || !CHOICES[kind].includes(b.choice))
      throw new HttpError(400, 'Not a choice for this item');
    return { kind, a, c };
  });
  const groups = await listGroups();
  const groupOfRole = new Map(groups.map((g) => [g.discordRoleId, g]));
  const O = mainRoleId('organizer');
  const P = mainRoleId('participant');
  const people =
    b.choice === 'participant' || b.choice === 'organizer'
      ? (await serverMembers(parsed.map((p) => p.a))).found
      : new Map();
  const members = new Set();
  let done = 0;
  for (const { kind, a, c } of parsed) {
    if (kind === 'norole') {
      if (!/^\d{5,25}$/.test(a) && !devMode()) throw new HttpError(400, 'Unknown Discord account');
      if (b.choice === 'ignore') {
        await db.query(
          'insert into discord_no_role_ok (discord_id) values ($1) on conflict do nothing',
          [a]
        );
        done++;
        continue;
      }
      const m = people.get(a);
      if (!m) continue; // left the server meanwhile
      const { rows: had } = await db.query(
        'select 1 from community_members where discord_id = $1',
        [a]
      );
      if (had.length) continue;
      const person = discordPerson(m);
      const id = crypto.randomUUID();
      const incoming = {
        source: 'discord',
        at: new Date(),
        details: { name: person.displayName || person.username },
        role: b.choice,
        discordId: a,
        joinedOn: m.joined_at ? String(m.joined_at).slice(0, 10) : null,
      };
      const changes = merge.compare(null, incoming);
      await writeMerge(db, { row: null, id, changes, incoming, source: 'board' });
      await db.query('update community_members set discord_info_encrypted = $2 where id = $1', [
        id,
        sealDiscordInfo(id, person),
      ]);
      members.add(id);
      done++;
      continue;
    }
    const row = await loadMember(a);
    const roleId = c;
    const group = groupOfRole.get(roleId);
    members.add(row.id);
    if (kind === 'unlink') {
      const info = discordInfoOf(row);
      await db.query(
        `update community_members set discord_id = null, discord_info_encrypted = $2,
           updated_at = now() where id = $1`,
        [row.id, sealDiscordInfo(row.id, { note: info.note })]
      );
      await touch(row.id, ['discordId']);
    } else if (kind === 'add') {
      if (b.choice === 'untag') {
        if (!group) throw new HttpError(400, 'Not a group’s role');
        await db.query('delete from member_groups where member_id = $1 and group_id = $2', [
          row.id,
          group.id,
        ]);
        await touch(row.id, ['groups']);
      } else if (b.choice === 'here') {
        if (roleId !== O) throw new HttpError(400, 'Only for Organizzatore');
        await db.query(
          `update community_members set role = 'participant', updated_at = now() where id = $1`,
          [row.id]
        );
        await touch(row.id, ['role']);
      } else if (group) {
        await db.query(
          `insert into member_role_ok (member_id, group_id, kind) values ($1, $2, 'missing')
           on conflict do nothing`,
          [row.id, group.id]
        );
      } else if (roleId === P || roleId === O) {
        // Which difference it is (missing, or the other role there) is
        // Discord's: read it again for this member.
        const plan = await discordPlan({ memberId: row.id });
        const it = plan.items.find((i) => i.id === `add:${row.id}:${roleId}`);
        await db.query(
          'insert into member_main_role_ok (member_id, kind) values ($1, $2) on conflict do nothing',
          [row.id, (it && it.main) || 'missing']
        );
      } else {
        throw new HttpError(400, 'Unknown role');
      }
    } else if (kind === 'remove') {
      if (b.choice === 'forget') {
        await db.query('delete from discord_retired_roles where role_id = $1', [roleId]);
      } else {
        await queueRemoval(row.id, roleId, false);
        if (group)
          await db.query(
            `insert into member_role_ok (member_id, group_id, kind) values ($1, $2, 'extra')
             on conflict do nothing`,
            [row.id, group.id]
          );
        else if (roleId === O)
          await db.query(
            `insert into member_main_role_ok (member_id, kind) values ($1, 'differs')
             on conflict do nothing`,
            [row.id]
          );
        else await db.query('delete from discord_retired_roles where role_id = $1', [roleId]);
      }
    } else if (kind === 'extra') {
      if (b.choice === 'remove') {
        await queueRemoval(row.id, roleId, true);
      } else if (b.choice === 'tag') {
        if (group) {
          await db.query(
            `insert into member_groups (member_id, group_id, level) values ($1, $2, 'stable')
             on conflict (member_id, group_id) do nothing`,
            [row.id, group.id]
          );
          await touch(row.id, ['groups']);
        } else if (roleId === O) {
          await db.query(
            `update community_members set role = 'organizer', updated_at = now() where id = $1`,
            [row.id]
          );
          await touch(row.id, ['role']);
          await roleSettled(user, row, 'organizer');
        }
      } else if (group) {
        await db.query(
          `insert into member_role_ok (member_id, group_id, kind) values ($1, $2, 'extra')
           on conflict do nothing`,
          [row.id, group.id]
        );
      } else {
        await db.query(
          `insert into member_main_role_ok (member_id, kind) values ($1, 'differs')
           on conflict do nothing`,
          [row.id]
        );
      }
    }
    done++;
  }
  await audit.record(
    user,
    'community-discord',
    ids.length === 1 && members.size === 1 ? [...members][0] : null,
    {
      action: `decide-${b.choice}`,
      count: done,
      members: [...members],
    }
  );
  return { done, members: [...members] };
}

/**
 * What the team chose to leave as it is between the board and Discord, to
 * undo: { ignored: [{ id, kind, memberId?, name?, group?, what, discordId? }] }.
 */
async function ignoredList(user) {
  await access.authorize(user, 'community');
  const names = new Map(
    (await db.query('select * from community_members')).rows.map((r) => [
      r.id,
      (detailsOf(r) || {}).name || '',
    ])
  );
  const out = [];
  (await db.query('select * from member_role_ok')).rows.forEach((r) =>
    out.push({
      id: `ok-group:${r.member_id}:${r.group_id}:${r.kind}`,
      kind: r.kind === 'missing' ? 'group-missing' : 'group-extra',
      memberId: r.member_id,
      name: names.get(r.member_id) || '',
      group: r.group_id,
    })
  );
  (await db.query('select * from member_main_role_ok')).rows.forEach((r) =>
    out.push({
      id: `ok-main:${r.member_id}:${r.kind}`,
      kind: r.kind === 'missing' ? 'main-missing' : 'main-differs',
      memberId: r.member_id,
      name: names.get(r.member_id) || '',
    })
  );
  (await db.query('select * from discord_no_role_ok order by created_at')).rows.forEach((r) =>
    out.push({
      id: `ok-norole:${r.discord_id}`,
      kind: 'no-role',
      discordId: r.discord_id,
      name: '',
    })
  );
  out.sort((a, b) => (a.name || '~').localeCompare(b.name || '~', 'it'));
  return { ignored: out };
}

/** Undoes "leave it" choices (ignoredList ids): they are listed again. */
async function unignore(user, body) {
  await access.authorize(user, 'community', { fresh: true });
  const ids = [...new Set((Array.isArray(body && body.ids) ? body.ids : []).map(String))];
  if (!ids.length) throw new HttpError(400, 'Pick what to list again');
  const members = new Set();
  for (const id of ids) {
    const [kind, a, c, d] = id.split(':');
    if (kind !== 'ok-norole' && !UUID.test(a)) throw new HttpError(400, 'Unknown item');
    if (kind === 'ok-group') {
      await db.query(
        'delete from member_role_ok where member_id = $1 and group_id = $2 and kind = $3',
        [a, c, d]
      );
      members.add(a);
    } else if (kind === 'ok-main') {
      await db.query('delete from member_main_role_ok where member_id = $1 and kind = $2', [a, c]);
      members.add(a);
    } else if (kind === 'ok-norole') {
      await db.query('delete from discord_no_role_ok where discord_id = $1', [a]);
    } else {
      throw new HttpError(400, 'Unknown item');
    }
  }
  await audit.record(user, 'community-discord', null, {
    action: 'unignore',
    count: ids.length,
    members: [...members],
  });
  return ignoredList(user);
}

/**
 * Several members made participants or organizers at once (Members: picked
 * people). Saved here only: on Discord the new role waits to be applied
 * (Organizzatore queued to take off from those made participants). An
 * organizer's waiting request is closed as approved. Returns { members }.
 */
async function setRoles(user, body) {
  await access.authorize(user, 'community', { fresh: true });
  const b = body || {};
  if (!MAIN_ROLES.includes(b.role)) throw new HttpError(400, 'Participant or organizer?');
  const ids = [...new Set((Array.isArray(b.members) ? b.members : []).map(String))];
  if (!ids.length || ids.length > 500) throw new HttpError(400, 'Pick from 1 to 500 people');
  const rows = [];
  for (const id of ids) rows.push(await loadMember(id));
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.query('update community_members set role = $2, updated_at = now() where id = $1', [
        row.id,
        b.role,
      ]);
      await queueMainRole(row.id, b.role, tx);
      await touch(row.id, ['role'], tx);
    }
  });
  for (const row of rows) await roleSettled(user, row, b.role);
  await audit.record(user, 'community-tags', null, {
    action: 'role',
    role: b.role,
    count: rows.length,
    members: rows.map((r) => r.id),
  });
  const groupsNow = await groupsByMember();
  const members = [];
  for (const row of rows) members.push(memberOut(await loadMember(row.id), groupsNow));
  return { members };
}

// ── Linking again, when sure ────────────────────────────────────────────────

/**
 * "Match again": links the members not linked yet (and not checked as not on
 * Discord) to their account when sure, as the import does: by email (they
 * signed in here with Discord, the same email as theirs), else by name (their
 * full name is one account's nickname, display name or username, and only
 * one's). An account another member has, or two would get, is left. Nothing
 * changes on Discord: their roles follow when the changes are applied.
 * Returns { linked, byEmail, byName, left, byNameAvailable, problem }.
 */
async function rematch(user) {
  await access.authorize(user, 'community', { fresh: true });
  const { rows } = await db.query(
    'select * from community_members where discord_id is null and not discord_absent'
  );
  const taken = new Set(
    (
      await db.query('select discord_id from community_members where discord_id is not null')
    ).rows.map((r) => r.discord_id)
  );
  const { rows: users } = await db.query(
    `select discord_id, email from app_users
     where kind = 'discord' and email is not null and discord_id is not null`
  );
  const byKey = new Map(users.map((u) => [crm.personKey(String(u.email).toLowerCase()), u]));
  const picks = new Map(); // member id -> { discordId, by, member? }
  for (const row of rows) {
    const u = row.person_key && byKey.get(row.person_key);
    if (u && !taken.has(u.discord_id)) picks.set(row.id, { discordId: u.discord_id, by: 'email' });
  }
  const server = await serverList();
  const byId = new Map((server || []).map((m) => [m.user.id, m]));
  if (server) {
    const index = new Map();
    for (const m of server) {
      const names = new Set(
        [m.nick, m.user.global_name, m.user.username].map(fold).filter((n) => n.includes(' '))
      );
      names.forEach((n) => index.set(n, (index.get(n) || new Set()).add(m)));
    }
    for (const row of rows) {
      if (picks.has(row.id)) continue;
      const full = fold((detailsOf(row) || {}).name || '');
      if (!full.includes(' ')) continue;
      const reversed = full.split(' ').reverse().join(' ');
      const hits = new Set([...(index.get(full) || []), ...(index.get(reversed) || [])]);
      if (hits.size !== 1) continue;
      const m = [...hits][0];
      if (!taken.has(m.user.id)) picks.set(row.id, { discordId: m.user.id, by: 'name' });
    }
  }
  // An account two members would both get: neither.
  const uses = {};
  picks.forEach((p) => (uses[p.discordId] = (uses[p.discordId] || 0) + 1));
  const out = { linked: 0, byEmail: 0, byName: 0 };
  const linkedIds = [];
  for (const [memberId, p] of picks) {
    if (uses[p.discordId] > 1) continue;
    const m = byId.get(p.discordId);
    const info = m ? discordPerson(m) : {};
    await db.query(
      `update community_members set discord_id = $2, discord_absent = false,
         discord_info_encrypted = $3, updated_at = now() where id = $1 and discord_id is null`,
      [memberId, p.discordId, sealDiscordInfo(memberId, info)]
    );
    out.linked++;
    out[p.by === 'email' ? 'byEmail' : 'byName']++;
    linkedIds.push(memberId);
  }
  await audit.record(user, 'community-discord', null, {
    action: 'rematch',
    ...out,
    members: linkedIds,
  });
  return {
    ...out,
    left: rows.length - out.linked,
    byNameAvailable: Boolean(server),
    problem: server ? null : listProblem,
  };
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
  // The latest answer of each email; every answer kept, as it was.
  const latest = {};
  const answers = {};
  rows.forEach((r, i) => {
    const e = norm(header(r, SHEET.email)) || `__${i}`;
    const d = sheetDate(header(r, SHEET.timestamp)) || '';
    if (!latest[e] || d >= latest[e].d) latest[e] = { d, r };
    (answers[e] = answers[e] || []).push({ d, r });
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
      // When they answered last: what a newer value on the board is held against.
      at: d ? `${d}T00:00:00.000Z` : null,
      rows: answers[e],
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

/** A sheet's row as kept on the member: [{ label, value }] and its hash. */
function sheetAnswer(r) {
  const answers = Object.entries(r)
    .map(([label, value]) => ({ label: String(label).trim(), value: String(value || '').trim() }))
    .filter((a) => a.label && a.value);
  const ref = crypto
    .createHash('sha256')
    .update(canonical(answers.map((a) => [a.label, a.value])))
    .digest('base64url');
  return { answers, ref };
}

function sourceContext(id) {
  return `member-source:${id}`;
}

/**
 * The import worked out, nothing stored: for each of the sheet's people who
 * they are on the board (matched by email, then by their Discord account,
 * and by name only as a possible duplicate), and what merging them changes
 * (server/member-merge.js). `decisions`: { [key]: { take: [field],
 * duplicate: 'merge' | 'new' | 'skip' } } as sent back from the preview.
 */
async function importPlan(csvText, decisions = {}) {
  const groups = await listGroups();
  const people = peopleFromSheet(csvText, groups);
  const { matches: discord, byName, problem } = await matchDiscord(people);
  const { rows: all } = await db.query('select * from community_members');
  const byKey = new Map(all.filter((r) => r.person_key).map((r) => [r.person_key, r]));
  const byDiscord = new Map(all.filter((r) => r.discord_id).map((r) => [r.discord_id, r]));
  const byFold = new Map();
  all.forEach((r) => {
    const n = fold((detailsOf(r) || {}).name || '');
    if (n) byFold.set(n, [...(byFold.get(n) || []), r]);
  });
  const tags = await groupsByMember();
  const { rows: refs } = await db.query(
    `select member_id, ref from member_sources where kind = 'sheet'`
  );
  const kept = new Set(refs.map((r) => `${r.member_id}:${r.ref}`));
  const claimed = new Set();
  const plan = [];
  for (const p of people) {
    const key = crm.personKey(p.email);
    const match = discord[p.email];
    let row = byKey.get(key) || null;
    let by = row ? 'email' : null;
    if (!row && match && byDiscord.get(match.id)) {
      row = byDiscord.get(match.id);
      by = 'discord';
    }
    // The same name, and nothing else in common: maybe them, never on its own.
    let duplicateOf = null;
    if (!row) {
      const same = (byFold.get(fold(p.name)) || []).filter((r) => !claimed.has(r.id));
      if (same.length === 1) duplicateOf = same[0];
    }
    const id = `s${crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16)}`;
    const choice = decisions[id] || {};
    // Without an email of its own, the other one is surely them (someone added
    // from Discord); with another email, maybe someone else of the same name.
    const duplicate = duplicateOf
      ? ['merge', 'new', 'skip'].includes(choice.duplicate)
        ? choice.duplicate
        : duplicateOf.person_key
        ? 'new'
        : 'merge'
      : null;
    if (duplicate === 'merge') {
      row = duplicateOf;
      by = 'name';
    }
    if (row) claimed.add(row.id);
    const taken = match ? byDiscord.get(match.id) : null;
    const incoming = {
      source: 'sheet',
      at: p.at,
      details: { name: p.name, profile: p.profile, location: p.location, areas: p.areas },
      publish: p.publish,
      role: p.role,
      groups: p.tags.map((t) => t.group),
      discordId: match ? match.id : null,
      joinedOn: p.joinedOn,
    };
    let changes = merge.compare(
      row
        ? { row, details: detailsOf(row) || {}, groups: (tags[row.id] || []).map((t) => t.group) }
        : null,
      incoming,
      { discordTaken: Boolean(taken && (!row || taken.id !== row.id)) }
    );
    changes = merge.takeConflicts(changes, choice.take);
    const sheetRows = p.rows.map(({ d, r }) => ({ d, ...sheetAnswer(r) }));
    const newRows = sheetRows.filter((x) => !row || !kept.has(`${row.id}:${x.ref}`));
    let status;
    if (duplicate === 'skip') status = 'skip';
    else if (!row) status = 'new';
    else if (changes.conflicts.length) status = 'conflict';
    else if (!merge.isEmpty(changes)) status = 'update';
    else status = 'unchanged';
    plan.push({
      key: id,
      p,
      row,
      by,
      personKey: key,
      incoming,
      changes,
      sheetRows: newRows,
      status,
      duplicate,
      duplicateOf,
      match,
    });
  }
  return { plan, byName, problem, groups };
}

const SHOWN = {
  name: 'Name',
  profile: 'Profile',
  location: 'Place',
  areas: 'Areas',
  role: 'Role',
  publish: 'On the site',
};

/**
 * What importing the sheet would do, nothing stored: { people: [{ key, name,
 * status, matchedBy, role, publish, tags, discord, fill, conflicts, kept,
 * addGroups, duplicateOf, duplicate, newAnswers }], counts }. status: new,
 * update (gaps filled), conflict (a newer answer than the board's, to keep or
 * take), unchanged, skip. No email leaves the server.
 */
async function importPreview(user, csvText, decisions) {
  await access.authorize(user, 'community', { fresh: true });
  const { plan, byName, problem } = await importPlan(csvText, decisions || {});
  const out = plan.map((x) => ({
    key: x.key,
    name: x.p.name,
    status: x.status,
    matchedBy: x.by,
    role: x.p.role,
    publish: x.p.publish,
    tags: x.p.tags,
    discord: x.match
      ? { id: x.match.id, name: x.match.name, by: x.match.by, taken: x.changes.discordTaken }
      : null,
    linking: Boolean(x.changes.discordId),
    fill: x.row ? Object.keys(x.changes.set).map((f) => SHOWN[f] || f) : [],
    conflicts: x.changes.conflicts.map((c) => ({
      field: c.field,
      label: SHOWN[c.field] || c.field,
      here: c.here,
      there: c.there,
    })),
    kept: x.changes.kept.map((f) => SHOWN[f] || f),
    addGroups: x.row ? x.changes.groups : [],
    duplicate: x.duplicate,
    duplicateOf: x.duplicateOf
      ? {
          id: x.duplicateOf.id,
          name: (detailsOf(x.duplicateOf) || {}).name || '',
          hasEmail: Boolean(x.duplicateOf.person_key),
        }
      : null,
    newAnswers: x.sheetRows.length,
    exists: Boolean(x.row),
  }));
  out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const count = (s) => out.filter((p) => p.status === s).length;
  return {
    people: out,
    counts: {
      people: out.length,
      new: count('new'),
      update: count('update'),
      conflict: count('conflict'),
      unchanged: count('unchanged'),
      skip: count('skip'),
      duplicates: out.filter((p) => p.duplicateOf).length,
      published: out.filter((p) => p.publish).length,
      tagged: out.filter((p) => p.tags.length).length,
      onDiscord: out.filter((p) => p.discord && !p.discord.taken).length,
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
 * Imports the sheet as the preview showed it, `decisions` included (what is
 * not decided stays as it is on the board), in one transaction: new people
 * added, the others' gaps and newer answers filled, groups only added, every
 * answer kept on the member (once: by its hash). Nothing is sent to Discord:
 * the roles wait to be applied from the Discord tab.
 * Returns { imported, updated, unchanged, skipped, conflicts, linked }.
 */
async function importConfirm(user, csvText, decisions) {
  await access.authorize(user, 'community', { fresh: true });
  const { plan } = await importPlan(csvText, decisions || {});
  const out = { imported: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, linked: 0 };
  const touched = [];
  // Sealed before the transaction: inside it, only its own queries run.
  const sealed = plan.map((x) =>
    x.sheetRows.map((r) => {
      const id = crypto.randomUUID();
      return {
        id,
        ref: r.ref,
        at: r.d ? `${r.d}T00:00:00.000Z` : null,
        answers: crm.encrypt(JSON.stringify(r.answers), sourceContext(id)),
      };
    })
  );
  await db.transaction(async (tx) => {
    for (let i = 0; i < plan.length; i++) {
      const x = plan[i];
      if (x.status === 'skip') {
        out.skipped++;
        continue;
      }
      const id = await writeMerge(tx, {
        row: x.row,
        id: crypto.randomUUID(),
        personKey: x.personKey,
        changes: x.changes,
        incoming: x.incoming,
        source: 'sheet',
      });
      for (const r of sealed[i]) {
        await tx.query(
          `insert into member_sources (id, member_id, kind, ref, answers_encrypted, received_at)
           values ($1, $2, 'sheet', $3, $4, $5) on conflict (member_id, kind, ref) do nothing`,
          [r.id, id, r.ref, r.answers, r.at]
        );
      }
      if (x.changes.discordId) {
        out.linked++;
        if (x.match && x.match.username) {
          await tx.query('update community_members set discord_info_encrypted = $2 where id = $1', [
            id,
            sealDiscordInfo(id, { ...(x.row ? discordInfoOf(x.row) : {}), ...x.match }),
          ]);
        }
      }
      if (x.status === 'new') out.imported++;
      else if (x.status === 'unchanged') out.unchanged++;
      else out.updated++;
      out.conflicts += x.changes.conflicts.length;
      if (x.status !== 'unchanged') touched.push(id);
    }
    await audit.record(user, 'community-import', null, { ...out, members: touched }, tx);
  });
  return out;
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
  const { groups, members } = await draft();
  const copy = { groups, members, publishedAt: new Date().toISOString() };
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

/**
 * Whether the list differs from what the site shows: { live, publishedAt,
 * pending, changes, members, groups, draft: { members, groups } }.
 */
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
    // On the website (the last publish) and after the next one.
    members: was ? (was.members || []).length : 0,
    groups: was ? (was.groups || []).length : 0,
    draft: { members: now.members.length, groups: now.groups.length },
    diff: siteDiff(was, now),
    // Each member against the website: online (as on the board), changed
    // (online, but not as on the board), waiting (not online yet); those not
    // in the draft are hidden (no consent).
    perMember: perMemberSite(was, now),
  };
}

/** A published entry without its position, to compare. */
const entryKey = (x) => canonical({ ...x, id: typeof x.id === 'number' ? 0 : x.id });

/**
 * What the next update changes on the website, by name: { members: { added,
 * removed, changed: [{ name, fields }] }, groups: { added, removed, changed:
 * [{ title, fields }] } }.
 */
function siteDiff(was, now) {
  const compare = (before, after, keyOf, titleOf) => {
    const a = new Map((before || []).map((x) => [keyOf(x), x]));
    const b = new Map((after || []).map((x) => [keyOf(x), x]));
    const out = { added: [], removed: [], changed: [] };
    b.forEach((x, k) => !a.has(k) && out.added.push(titleOf(x)));
    a.forEach((x, k) => !b.has(k) && out.removed.push(titleOf(x)));
    b.forEach((x, k) => {
      const y = a.get(k);
      if (!y || entryKey(x) === entryKey(y)) return;
      const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(
        (f) => f !== 'id' && canonical(x[f]) !== canonical(y[f])
      );
      out.changed.push({ title: titleOf(x), fields });
    });
    return out;
  };
  return {
    members: compare(
      was && was.members,
      now.members,
      (x) => x.name,
      (x) => x.name
    ),
    groups: compare(
      was && was.groups,
      now.groups,
      (x) => x.id,
      (x) => x.title
    ),
  };
}

function perMemberSite(was, now) {
  const online = new Map(((was && was.members) || []).map((x) => [x.name, entryKey(x)]));
  const out = {};
  now.members.forEach((x, i) => {
    const there = online.get(x.name);
    out[now.owners[i]] = !there ? 'waiting' : there === entryKey(x) ? 'online' : 'changed';
  });
  return out;
}
/**
 * What the site would show now: the groups, and the members who consented,
 * with only their public fields. { groups, members, owners }.
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
  const shown = rows
    .map((r) => {
      const d = detailsOf(r);
      if (!d || !d.name) return null;
      const m = { name: d.name };
      if (d.profile) m.profile = d.profile;
      if (d.location) m.location = d.location;
      if (d.areas) m.areas = d.areas;
      const g = (byMember[r.id] || []).map((x) => x.group);
      if (g.length) m.groups = g;
      return { owner: r.id, m };
    })
    .filter(Boolean);
  // `owners`: whose each entry is, for the board only (never published).
  return {
    groups,
    members: shown.map((x, i) => ({ id: i + 1, ...x.m })),
    owners: shown.map((x) => x.owner),
  };
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
  setMemberGroups,
  exportCsv,
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
  status,
  discordPlan,
  discordPlanFor,
  applyDiscord,
  decideDiscord,
  ignoredList,
  unignore,
  memberDetail,
  roleNames,
  setRoles,
  rematch,
  TAGS_PER_CALL,
};
