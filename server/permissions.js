// What a signed-in member may do in the personal area, from their Discord
// roles and from what was given to them by name.
//
// Two tables, both edited on /app/settings/permissions/ by whoever holds
// `manage`: content_role_permissions maps a Discord role to permission keys,
// user_permissions gives keys to one person. A member gets the union of the
// permissions of all their roles and their own. Nothing takes a key away:
// a person's own keys only add to their roles'. The shared-password admin
// account has every permission, so there is always a way in to set things up.
//
// Roles are stored on sign-in (auth.upsertDiscordUser) and checked again with
// the bot just before anything is published (refreshRoles), so someone who
// lost a role on Discord cannot keep publishing on an old session.
//
// Env (the same the rest of /app/ uses):
//   DISCORD_GUILD_ID                    the AIS server
//   DISCORD_BOT_TOKEN_AIS_TEAM_AREA     the bot, to read roles and members

const db = require('./db');
const { HttpError } = require('./http');
const audit = require('./crm/audit');

const DISCORD_API = 'https://discord.com/api/v10';

// The order is the order of the columns in the dashboard. Several areas share the
// table: the site's content (/app/content/) and the CRM board (/app/crm/,
// server/crm/). Holding a permission of one area gives nothing in the other:
// each API checks its own area (see `areas`).
const PERMISSIONS = [
  { key: 'seminar', label: 'Seminars', area: 'content' },
  { key: 'event', label: 'Events', area: 'content' },
  { key: 'media', label: 'Videos & podcasts', area: 'content' },
  { key: 'blog', label: 'Blog', area: 'content' },
  { key: 'others', label: "Edit others' content", area: 'content' },
  // In the content area for the tool's own switches (switch on/off), but
  // shown under Settings, where the permissions page is.
  { key: 'manage', label: 'Manage permissions', area: 'content', group: 'settings' },
  // Hands out every key but this one, the personal-data ones too: for the
  // board. Only the shared admin gives it, so who administers personal data is
  // never decided by those who hold it. Implies `manage`.
  { key: 'manage_all', label: 'Manage all permissions', area: 'settings', group: 'settings' },
  { key: 'mentorship', label: 'CRM: mentorship', area: 'crm' },
  { key: 'people', label: 'CRM: people', area: 'crm' },
  { key: 'finance', label: 'CRM: finance', area: 'crm' },
  { key: 'crm_admin', label: 'CRM: settings', area: 'crm' },
  { key: 'forms', label: 'Forms', area: 'forms' },
  { key: 'forms_admin', label: 'Forms: all forms', area: 'forms' },
  // The member applications board (server/members.js): an area of its own.
  { key: 'members', label: 'Member applications', area: 'members' },
];
// The tools' areas; `settings` (manage_all) opens no tool of its own.
const AREAS = [...new Set(PERMISSIONS.map((p) => p.area))].filter((a) => a !== 'settings');
const KEYS = PERMISSIONS.map((p) => p.key);

/** Which areas a set of permission keys opens: { content, crm, forms, members }. */
function areas(perms) {
  const out = {};
  AREAS.forEach((area) => {
    out[area] = PERMISSIONS.some((p) => p.area === area && perms.includes(p.key));
  });
  return out;
}

// Local development (scripts/meet-dev.js) has no Discord server: these stand
// in for the AIS roles, and the stand-in login lets you pick some.
const DEV_ROLES = [
  'Admin',
  'Direttivo',
  'communication',
  'mentorship',
  'blog',
  'Organizzatori',
  'seminars',
  'events',
  'Partecipanti',
].map((name) => ({ id: `dev-${name.toLowerCase()}`, name }));

/**
 * The local stand-ins (sign in under any name and roles, join without
 * Discord) are for a developer's own machine. On Vercel (production and
 * previews set VERCEL) they stay off whatever MEET_DEV_LOGIN says: one
 * stray variable must not open the site to anyone.
 */
function devLogin() {
  return process.env.MEET_DEV_LOGIN === '1' && !process.env.VERCEL;
}

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function botConfigured() {
  return Boolean(process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA && process.env.DISCORD_GUILD_ID);
}

async function bot(path, { method = 'GET', json } = {}) {
  const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA}` };
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(`${DISCORD_API}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/** The permission keys a set of role ids grants. */
async function forRoles(roleIds) {
  if (!roleIds || !roleIds.length) return [];
  const { rows } = await db.query(
    'select permissions from content_role_permissions where role_id = any($1)',
    [roleIds]
  );
  return withImplied(rows);
}

/** The keys held by the union of these rows, `manage_all` bringing `manage`. */
function withImplied(rows) {
  const granted = new Set();
  rows.forEach((r) => r.permissions.forEach((p) => granted.add(p)));
  if (granted.has('manage_all')) granted.add('manage');
  return KEYS.filter((k) => granted.has(k));
}

// The keys of the site's content: what the shared admin password still opens
// in production (with `manage`, to hand out everything else).
const CONTENT_ONLY = PERMISSIONS.filter((p) => p.area === 'content').map((p) => p.key);

/**
 * The permission keys of a signed-in user (from auth.currentUser).
 * In production the shared admin password opens the site's content and the
 * permissions table, never the personal data (CRM, form answers, member
 * applications): those need a Discord sign-in, so the audit trail names a
 * person. Locally and on the previews it opens everything.
 */
async function forUser(user) {
  if (user.kind === 'admin') {
    return process.env.VERCEL_ENV === 'production' ? CONTENT_ONLY.slice() : KEYS.slice();
  }
  const { rows } = await db.query(
    `select r.permissions from app_users u
       join content_role_permissions r on r.role_id = any(u.roles) where u.id = $1
     union all
     select permissions from user_permissions where user_id = $1`,
    [user.id]
  );
  return withImplied(rows);
}

/**
 * Reads the member's roles from Discord again and stores them. Without the
 * bot (or when Discord does not answer) the stored roles stand.
 */
async function refreshRoles(user) {
  if (user.kind === 'admin' || !botConfigured()) return;
  const { rows } = await db.query('select discord_id from app_users where id = $1', [user.id]);
  const discordId = rows[0] && rows[0].discord_id;
  if (!discordId || discordId.startsWith('dev-')) return;
  let res;
  try {
    res = await bot(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordId}`);
  } catch (err) {
    console.error('Reading Discord roles failed', err.message);
    return;
  }
  // 404: no longer in the server, so no roles at all, and no session either.
  if (res.status === 404) {
    await db.query(
      `update app_users set roles = '{}', roles_checked_at = now(),
         session_version = session_version + 1 where id = $1`,
      [user.id]
    );
  } else if (res.ok) {
    await db.query('update app_users set roles = $2, roles_checked_at = now() where id = $1', [
      user.id,
      res.body.roles || [],
    ]);
  } else {
    console.error('Reading Discord roles failed', res.status);
  }
}

/**
 * Throws 403 unless the user holds `key` (after refreshing their roles when
 * `fresh`). Returns all their permissions.
 */
async function require_(user, key, { fresh = false } = {}) {
  if (fresh) await refreshRoles(user);
  const perms = await forUser(user);
  if (!perms.includes(key)) throw new HttpError(403, 'Your Discord roles do not allow this');
  return perms;
}

/**
 * Like require(), but re-reads the Discord roles only when the last check is
 * older than `maxAgeMs` (default 5 minutes): for reads, which are frequent,
 * where `fresh` on every call would hit Discord's rate limits. The shared-
 * password admin has no Discord roles, so there is nothing to refresh.
 */
async function requireRecent(user, key, { maxAgeMs = 5 * 60 * 1000 } = {}) {
  await refreshIfStale(user, { maxAgeMs });
  return require_(user, key);
}

/** Re-reads the Discord roles when the last read is older than `maxAgeMs`. */
async function refreshIfStale(user, { maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (user.kind === 'admin') return;
  const { rows } = await db.query('select roles_checked_at from app_users where id = $1', [
    user.id,
  ]);
  const checked = rows[0] && rows[0].roles_checked_at;
  if (!checked || Date.now() - new Date(checked).getTime() > maxAgeMs) await refreshRoles(user);
}

/** The Discord role ids stored for a user (none for the shared admin). */
async function rolesOf(user) {
  if (user.kind === 'admin') return [];
  const { rows } = await db.query('select roles from app_users where id = $1', [user.id]);
  return rows.length ? rows[0].roles : [];
}

/**
 * May someone with these roles do something here? Also yes when the Discord
 * account `discordId` was given permissions by name: the sign-in lets them in.
 */
async function anyContentRole(roleIds, discordId) {
  if ((await forRoles(roleIds)).length > 0) return true;
  if (!discordId) return false;
  const { rows } = await db.query(
    `select 1 from user_permissions p join app_users u on u.id = p.user_id
     where u.discord_id = $1 and cardinality(p.permissions) > 0`,
    [String(discordId)]
  );
  return rows.length > 0;
}

/** The server's roles, for the permissions table: [{ id, name }]. */
async function guildRoles() {
  if (devLogin() && !botConfigured()) return DEV_ROLES;
  if (!botConfigured()) return [];
  const res = await bot(`/guilds/${process.env.DISCORD_GUILD_ID}/roles`);
  if (!res.ok) throw new HttpError(502, `Discord did not list the roles (${res.status})`);
  return res.body
    .filter((r) => r.name !== '@everyone' && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
}

/** Rows of the permissions table: [{ roleId, roleName, permissions }]. */
async function listRolePermissions() {
  const { rows } = await db.query(
    'select role_id, role_name, permissions from content_role_permissions order by role_name'
  );
  return rows.map((r) => ({
    roleId: r.role_id,
    roleName: r.role_name,
    permissions: r.permissions,
  }));
}

/** People given permissions by name: [{ userId, name, avatarUrl, permissions }]. */
async function listUserPermissions() {
  const { rows } = await db.query(
    `select p.user_id, u.name, u.avatar_url, p.permissions from user_permissions p
     join app_users u on u.id = p.user_id order by lower(u.name)`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    permissions: r.permissions,
  }));
}

/** Who can be given permissions by name: everyone who signed in with Discord. */
async function discordPeople() {
  const { rows } = await db.query(
    `select id, name, avatar_url from app_users where kind = 'discord' order by lower(name)`
  );
  return rows.map((r) => ({ userId: r.id, name: r.name, avatarUrl: r.avatar_url }));
}

/** May `user` change who holds the keys outside the site's content? */
function canGrantAll(user) {
  return Boolean(user) && user.kind === 'admin';
}

/**
 * The keys `user` (holding `perms`) may give or take away: all of them for
 * the shared admin; all but `manage_all` with `manage_all`; else the site's
 * content keys (with `manage`).
 */
function grantable(user, perms) {
  if (canGrantAll(user)) return KEYS.slice();
  if (perms.includes('manage_all')) return KEYS.filter((k) => k !== 'manage_all');
  return CONTENT_ONLY.slice();
}

/** The checked keys of one row of the table. */
function cleanKeys(row) {
  const perms = Array.isArray(row && row.permissions) ? row.permissions : [];
  if (perms.some((p) => !KEYS.includes(p))) throw new HttpError(400, 'Unknown permission');
  return KEYS.filter((k) => perms.includes(k));
}

/** The keys that differ between two maps of id -> keys. */
function changedKeys(before, after) {
  const touched = new Set();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id) || [];
    const b = after.get(id) || [];
    a.filter((k) => !b.includes(k)).forEach((k) => touched.add(k));
    b.filter((k) => !a.includes(k)).forEach((k) => touched.add(k));
  }
  return touched;
}

/**
 * Replaces the permissions of the Discord roles (`roles`: [{ roleId,
 * roleName, permissions }]) and, when given, of the people (`people`:
 * [{ userId, permissions }]). Rows left without permissions are dropped.
 * With `actor` (a request from the dashboard), only the keys grantable() lets
 * them change may differ: `manage` hands out the content keys only, so a
 * content role cannot give itself more, nor give it to a person.
 * Every change from the dashboard is on the audit trail.
 * Returns { roles, people }.
 */
async function savePermissions({ roles, people }, actor) {
  if (!Array.isArray(roles)) throw new HttpError(400, 'Expected a list of roles');
  if (people !== undefined && !Array.isArray(people))
    throw new HttpError(400, 'Expected a list of people');
  const cleanRoles = [];
  const seen = new Set();
  for (const row of roles) {
    const roleId = String((row && row.roleId) || '').trim();
    const roleName = String((row && row.roleName) || '')
      .trim()
      .slice(0, 100);
    if (!/^[\w-]{1,40}$/.test(roleId) || !roleName) throw new HttpError(400, 'Invalid role');
    if (seen.has(roleId)) throw new HttpError(400, `${roleName} is listed twice`);
    seen.add(roleId);
    const permissions = cleanKeys(row);
    if (permissions.length) cleanRoles.push({ roleId, roleName, permissions });
  }
  let cleanPeople = null;
  if (people) {
    cleanPeople = [];
    const ids = new Set();
    for (const row of people) {
      const userId = String((row && row.userId) || '');
      if (!/^[0-9a-f-]{36}$/i.test(userId) || ids.has(userId))
        throw new HttpError(400, 'Invalid person');
      ids.add(userId);
      const permissions = cleanKeys(row);
      if (permissions.length) cleanPeople.push({ userId, permissions });
    }
    // Only accounts signed in with Discord: the shared admin has every key.
    const known = new Set((await discordPeople()).map((p) => p.userId));
    if (cleanPeople.some((p) => !known.has(p.userId))) throw new HttpError(400, 'Unknown person');
  }

  const touched = changedKeys(
    new Map((await listRolePermissions()).map((r) => [r.roleId, r.permissions])),
    new Map(cleanRoles.map((r) => [r.roleId, r.permissions]))
  );
  if (cleanPeople) {
    changedKeys(
      new Map((await listUserPermissions()).map((p) => [p.userId, p.permissions])),
      new Map(cleanPeople.map((p) => [p.userId, p.permissions]))
    ).forEach((k) => touched.add(k));
  }
  if (actor) {
    const allowed = grantable(actor, await forUser(actor));
    const refused = [...touched].filter((k) => !allowed.includes(k));
    if (refused.length) {
      throw new HttpError(
        403,
        refused.includes('manage_all')
          ? 'Only the shared admin can give or take away “Manage all permissions”'
          : 'Changing who may use the CRM, forms and member applications needs “Manage all permissions”'
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx.query('delete from content_role_permissions');
    for (const r of cleanRoles) {
      await tx.query(
        'insert into content_role_permissions (role_id, role_name, permissions) values ($1, $2, $3)',
        [r.roleId, r.roleName, r.permissions]
      );
    }
    if (cleanPeople) {
      await tx.query('delete from user_permissions');
      for (const p of cleanPeople) {
        await tx.query('insert into user_permissions (user_id, permissions) values ($1, $2)', [
          p.userId,
          p.permissions,
        ]);
      }
    }
    // Which keys changed, never whose: the table itself says who holds what.
    if (actor && touched.size) {
      await audit.record(actor, 'permissions-change', null, { keys: [...touched] }, tx);
    }
  });
  return { roles: await listRolePermissions(), people: await listUserPermissions() };
}

/** The roles' table only, as before people could be given keys by name. */
async function saveRolePermissions(list, actor) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of roles');
  return (await savePermissions({ roles: list }, actor)).roles;
}

module.exports = {
  PERMISSIONS,
  KEYS,
  areas,
  DEV_ROLES,
  devLogin,
  setFetch,
  botConfigured,
  bot,
  forRoles,
  forUser,
  refreshRoles,
  require: require_,
  requireRecent,
  refreshIfStale,
  rolesOf,
  anyContentRole,
  guildRoles,
  listRolePermissions,
  listUserPermissions,
  discordPeople,
  canGrantAll,
  grantable,
  savePermissions,
  saveRolePermissions,
};
