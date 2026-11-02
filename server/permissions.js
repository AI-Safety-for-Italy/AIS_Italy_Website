// What a signed-in member may do in the personal area, from their Discord
// roles and from what was given to them by name.
//
// Two tables, both edited on /app/settings/permissions/ by whoever holds
// `manage`: content_role_permissions maps a Discord role to permission keys,
// user_permissions gives keys to one person. A member gets the union of the
// permissions of all their roles and their own. Nothing takes a key away:
// a person's own keys only add to their roles'. The shared-password admin
// account holds the content keys and `manage` (every key only on a developer
// machine), so there is always a way in to set things up.
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
// `help` is the line the permissions page shows under each switch.
const PERMISSIONS = [
  {
    key: 'seminar',
    label: 'Seminars',
    area: 'content',
    help: 'Publish and edit seminars on the site.',
  },
  { key: 'event', label: 'Events', area: 'content', help: 'Publish and edit events on the site.' },
  {
    key: 'media',
    label: 'Videos & podcasts',
    area: 'content',
    help: 'Publish videos and podcasts (coming later).',
  },
  { key: 'blog', label: 'Blog', area: 'content', help: 'Publish blog posts (coming later).' },
  {
    key: 'others',
    label: "Edit others' content",
    area: 'content',
    help: 'Change what other people published, not only their own.',
  },
  // In the content area for the tool's own switches (switch on/off), but
  // shown under Settings, where the permissions page is.
  {
    key: 'manage',
    label: 'Manage permissions',
    area: 'content',
    group: 'settings',
    help: 'Open this page and give the site content permissions.',
  },
  // Hands out every key but this one, the personal-data ones too: for the
  // board. Only the shared admin gives it, so who administers personal data is
  // never decided by those who hold it. Implies `manage`.
  {
    key: 'manage_all',
    label: 'Manage all permissions',
    area: 'settings',
    group: 'settings',
    help: 'Give every permission, personal data included. Only the shared admin gives this.',
  },
  {
    key: 'mentorship',
    label: 'CRM: mentorship',
    area: 'crm',
    help: 'The mentorship board: mentors, mentees, pairs and their contacts.',
  },
  { key: 'people', label: 'CRM: people', area: 'crm', help: 'The people list (coming later).' },
  { key: 'finance', label: 'CRM: finance', area: 'crm', help: 'Funding (coming later).' },
  {
    key: 'crm_admin',
    label: 'CRM: settings',
    area: 'crm',
    help: 'Which Google sheets the board reads, and importing them.',
  },
  {
    key: 'forms',
    label: 'Forms',
    area: 'forms',
    help: 'Make forms and read the answers to their own.',
  },
  {
    key: 'forms_admin',
    label: 'Forms: all forms',
    area: 'forms',
    help: 'Manage every form and read all the answers.',
  },
  {
    key: 'forms_notify',
    label: 'Forms: choose who is notified',
    area: 'forms',
    help: 'Add any member of the Discord server to the people told about new answers.',
  },
  // The member applications board (server/members.js): an area of its own.
  {
    key: 'members',
    label: 'Member applications',
    area: 'members',
    help: 'Review who asked to join, and let them into Discord.',
  },
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
// The roles the AIS server really has, highest first.
const DEV_ROLES = ['Admin', 'Direttivo', 'Organizzatori', 'Partecipanti'].map((name) => ({
  id: `dev-${name.toLowerCase()}`,
  name,
}));

// What each stand-in role starts with in a fresh local database, so that
// signing in as one shows what it would see (scripts/meet-dev.js). Only a
// starting point to try things with: the real table is set on the
// Permissions page of each environment.
const DEV_DEFAULTS = {
  'dev-admin': PERMISSIONS.map((p) => p.key),
  'dev-direttivo': [
    'seminar',
    'event',
    'others',
    'manage',
    'mentorship',
    'forms',
    'forms_admin',
    'forms_notify',
    'members',
  ],
  'dev-organizzatori': ['seminar', 'event', 'forms', 'mentorship'],
  'dev-partecipanti': [],
};

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
  rolesCache = null;
}

// Discord is asked on the request path: a slow answer must not hold the page
// (the stored roles stand when it does not answer, see refreshRoles).
const DISCORD_TIMEOUT_MS = 4000;

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
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
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
 * On every deployment (production and the previews) the shared admin password
 * opens the site's content and the permissions table, never the personal data
 * (CRM, form answers, member applications): those need a Discord sign-in, so
 * the audit trail names a person. The previews are public and their database
 * branch started as a copy of production's, so they are no exception. Only on
 * a developer machine (no VERCEL) does it open everything.
 */
async function forUser(user) {
  // Once per request: a user from auth.currentUser carries its row and lives
  // only for this request (dropped again when the roles are refreshed).
  if (user.row && user.perms) return user.perms.slice();
  const perms = await readPermissions(user);
  if (user.row)
    Object.defineProperty(user, 'perms', { value: perms, writable: true, configurable: true });
  return perms.slice();
}

async function readPermissions(user) {
  if (user.kind === 'admin') {
    return process.env.VERCEL ? CONTENT_ONLY.slice() : KEYS.slice();
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
  const row = await rowOf(user);
  const discordId = row && row.discord_id;
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
    remember(user, []);
  } else if (res.ok) {
    await db.query('update app_users set roles = $2, roles_checked_at = now() where id = $1', [
      user.id,
      res.body.roles || [],
    ]);
    remember(user, res.body.roles || []);
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

/**
 * The user's row of app_users: the one auth.currentUser read for this request
 * when there is one, else read now. Null when the user no longer exists.
 */
async function rowOf(user) {
  if (user.row) return user.row;
  const { rows } = await db.query('select * from app_users where id = $1', [user.id]);
  return rows[0] || null;
}

/** After reading the roles from Discord: the request goes on with them. */
function remember(user, roles) {
  if (!user.row) return;
  user.row.roles = roles;
  user.row.roles_checked_at = new Date();
  if ('perms' in user) user.perms = undefined;
}

/** Re-reads the Discord roles when the last read is older than `maxAgeMs`. */
async function refreshIfStale(user, { maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (user.kind === 'admin') return;
  const row = await rowOf(user);
  const checked = row && row.roles_checked_at;
  if (!checked || Date.now() - new Date(checked).getTime() > maxAgeMs) await refreshRoles(user);
}

/** The Discord role ids stored for a user (none for the shared admin). */
async function rolesOf(user) {
  if (user.kind === 'admin') return [];
  const row = await rowOf(user);
  return (row && row.roles) || [];
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
// The server's roles (not who holds them) change rarely: kept 5 minutes.
const ROLES_CACHE_MS = 5 * 60 * 1000;
let rolesCache = null;

async function guildRoles() {
  if (devLogin() && !botConfigured()) return DEV_ROLES;
  if (!botConfigured()) return [];
  if (rolesCache && Date.now() - rolesCache.at < ROLES_CACHE_MS) return rolesCache.roles;
  let res;
  try {
    res = await bot(`/guilds/${process.env.DISCORD_GUILD_ID}/roles`);
  } catch {
    throw new HttpError(502, 'Discord did not answer: try again in a moment');
  }
  if (!res.ok) throw new HttpError(502, `Discord did not list the roles (${res.status})`);
  const roles = res.body
    .filter((r) => r.name !== '@everyone' && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
  rolesCache = { at: Date.now(), roles };
  return roles;
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

/**
 * Members of the Discord server whose name matches `query`, for picking
 * someone (e.g. who is told about a form's answers): [{ discordId, name,
 * avatarUrl }], at most 10. Those who signed in here are found by name; the
 * others through the bot's member search on the Discord server (Discord
 * matches the start of a username or server nickname).
 */
async function searchMembers(query) {
  const q = String(query || '')
    .trim()
    .slice(0, 60);
  if (q.length < 2) return [];
  const found = new Map();
  const { rows } = await db.query(
    `select discord_id, name, avatar_url from app_users
     where kind = 'discord' and discord_id is not null and name ilike $1
     order by lower(name) limit 10`,
    [`%${q.replace(/[\\%_]/g, '\\$&')}%`]
  );
  rows.forEach((r) =>
    found.set(r.discord_id, { discordId: r.discord_id, name: r.name, avatarUrl: r.avatar_url })
  );
  if (botConfigured() && found.size < 10) {
    const res = await bot(
      `/guilds/${process.env.DISCORD_GUILD_ID}/members/search?limit=10&query=${encodeURIComponent(
        q
      )}`
    );
    if (!res.ok) console.error(`Discord member search failed (${res.status})`);
    if (res.ok && Array.isArray(res.body)) {
      res.body
        .filter((m) => m.user && !m.user.bot)
        .forEach((m) => {
          if (found.has(m.user.id) || found.size >= 10) return;
          found.set(m.user.id, {
            discordId: m.user.id,
            name: m.nick || m.user.global_name || m.user.username,
            avatarUrl: m.user.avatar
              ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
              : null,
          });
        });
    }
  }
  return [...found.values()];
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
  DEV_DEFAULTS,
  searchMembers,
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
  rowOf,
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
