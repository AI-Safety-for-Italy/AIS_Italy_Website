// What a signed-in member may do with the site's content, from their Discord
// roles.
//
// The content_role_permissions table maps a role to permission keys; it is
// edited from the dashboard by whoever holds `manage`. A member gets the union
// of the permissions of all their roles. The shared-password admin account
// has every permission, so there is always a way in to set things up.
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

const DISCORD_API = 'https://discord.com/api/v10';

// The order is the order of the columns in the dashboard.
const PERMISSIONS = [
  { key: 'seminar', label: 'Seminars' },
  { key: 'event', label: 'Events' },
  { key: 'media', label: 'Videos & podcasts' },
  { key: 'blog', label: 'Blog' },
  { key: 'others', label: "Edit others' content" },
  { key: 'manage', label: 'Manage permissions' },
];
const KEYS = PERMISSIONS.map((p) => p.key);

// Local development (scripts/meet-dev.js) has no Discord server: these stand
// in for the AIS roles, and the stand-in login lets you pick some.
const DEV_ROLES = [
  'Admin',
  'Direttivo',
  'communication',
  'blog',
  'Organizzatori',
  'seminars',
  'events',
  'Partecipanti',
].map((name) => ({ id: `dev-${name.toLowerCase()}`, name }));

function isDev() {
  return process.env.MEET_DEV_LOGIN === '1';
}

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function botConfigured() {
  return Boolean(process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA && process.env.DISCORD_GUILD_ID);
}

async function bot(path) {
  const res = await fetchImpl(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA}` },
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
  const granted = new Set();
  rows.forEach((r) => r.permissions.forEach((p) => granted.add(p)));
  return KEYS.filter((k) => granted.has(k));
}

/** The permission keys of a signed-in user (from auth.currentUser). */
async function forUser(user) {
  if (user.kind === 'admin') return KEYS.slice();
  const { rows } = await db.query('select roles from app_users where id = $1', [user.id]);
  return forRoles(rows.length ? rows[0].roles : []);
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
  // 404: no longer in the server, so no roles at all.
  if (res.status === 404) {
    await db.query(`update app_users set roles = '{}' where id = $1`, [user.id]);
  } else if (res.ok) {
    await db.query('update app_users set roles = $2 where id = $1', [
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

/** May at least one of these roles do something with content? */
async function anyContentRole(roleIds) {
  return (await forRoles(roleIds)).length > 0;
}

/** The server's roles, for the permissions table: [{ id, name }]. */
async function guildRoles() {
  if (isDev() && !botConfigured()) return DEV_ROLES;
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

/**
 * Replaces the permissions table with `list` ([{ roleId, roleName,
 * permissions }]). Roles left without permissions are dropped.
 */
async function saveRolePermissions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of roles');
  const clean = [];
  const seen = new Set();
  for (const row of list) {
    const roleId = String((row && row.roleId) || '').trim();
    const roleName = String((row && row.roleName) || '')
      .trim()
      .slice(0, 100);
    if (!/^[\w-]{1,40}$/.test(roleId) || !roleName) throw new HttpError(400, 'Invalid role');
    if (seen.has(roleId)) throw new HttpError(400, `${roleName} is listed twice`);
    seen.add(roleId);
    const perms = Array.isArray(row.permissions) ? row.permissions : [];
    if (perms.some((p) => !KEYS.includes(p))) throw new HttpError(400, 'Unknown permission');
    if (perms.length) {
      clean.push({ roleId, roleName, permissions: KEYS.filter((k) => perms.includes(k)) });
    }
  }
  await db.transaction(async (tx) => {
    await tx.query('delete from content_role_permissions');
    for (const r of clean) {
      await tx.query(
        'insert into content_role_permissions (role_id, role_name, permissions) values ($1, $2, $3)',
        [r.roleId, r.roleName, r.permissions]
      );
    }
  });
  return listRolePermissions();
}

module.exports = {
  PERMISSIONS,
  KEYS,
  DEV_ROLES,
  setFetch,
  forRoles,
  forUser,
  refreshRoles,
  require: require_,
  anyContentRole,
  guildRoles,
  listRolePermissions,
  saveRolePermissions,
};
