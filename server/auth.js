// Who is signed in to /app/, and how they got there.
//
// Two ways in, both ending in the same session:
//   - Discord (server/discord.js): members of the AIS server with an allowed
//     role. Their account is created on their first login.
//   - The shared admin password: signs in as the single 'admin' user. The
//     password is never stored; ADMIN_PASSWORD_HASH holds a scrypt hash made
//     by `node scripts/meet-hash-password.js`.
//
// The session cookie is "<user id>.<expiry>[.<version>].<HMAC>" signed with
// SESSION_SECRET, so there is no session table. The version is the user's
// session_version when the cookie was made (left out while it is 0): signing
// out raises it, and so does leaving the Discord server, which ends every
// session of that user on every device. Rotating SESSION_SECRET signs
// everyone out.

const crypto = require('crypto');
const { HttpError, getCookie, clientIp } = require('./http');
const db = require('./db');
const { isEmail } = require('./email');

const COOKIE = 'ais_session';
const SESSION_DAYS = 7;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MINUTES = 15;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  }
  return value;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function makeSession(userId, now = Date.now(), version = 0) {
  const base = `${userId}.${now + SESSION_DAYS * 24 * 3600 * 1000}`;
  const payload = version ? `${base}.${version}` : base;
  return `${payload}.${sign(payload)}`;
}

/** { userId, version } a session cookie vouches for, or null. */
function parseSession(value, now = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const signature = parts.pop();
  if (!safeEqual(sign(parts.join('.')), signature)) return null;
  const [userId, expires, version = '0'] = parts;
  if (!(Number(expires) > now)) return null;
  return { userId, version: Number(version) };
}

/** The user id a session cookie vouches for, or null. */
function readSession(value, now = Date.now()) {
  const session = parseSession(value, now);
  return session ? session.userId : null;
}

/** A new session cookie for this user, at their current session version. */
async function sessionFor(userId) {
  const { rows } = await db.query('select session_version from app_users where id = $1', [userId]);
  return makeSession(userId, Date.now(), rows.length ? rows[0].session_version : 0);
}

/** Ends every session of this user, on every device. */
async function endSessions(userId) {
  await db.query('update app_users set session_version = session_version + 1 where id = $1', [
    userId,
  ]);
}

function cookieHeader(name, value, maxAge, sameSite = 'Strict') {
  // Secure everywhere but plain-http localhost, where browsers would drop it.
  const secure = process.env.MEET_INSECURE_COOKIES === '1' ? '' : '; Secure';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}

async function startSession(res, userId) {
  res.setHeader('Set-Cookie', cookieHeader(COOKIE, await sessionFor(userId), SESSION_DAYS * 86400));
}

function logout(res) {
  res.setHeader('Set-Cookie', cookieHeader(COOKIE, '', 0));
}

function publicUser(row) {
  return { id: row.id, kind: row.kind, name: row.name, avatarUrl: row.avatar_url };
}

/** The signed-in user ({ id, kind, name, avatarUrl }), or null. */
async function currentUser(req) {
  const session = parseSession(getCookie(req, COOKIE));
  if (!session) return null;
  const { rows } = await db.query('select * from app_users where id = $1', [session.userId]);
  // A cookie from before the last sign-out (or before leaving Discord) no longer counts.
  if (!rows.length || rows[0].session_version !== session.version) return null;
  return publicUser(rows[0]);
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Not signed in');
  return user;
}

async function passwordLogin(req, res, password) {
  const ip = clientIp(req);
  await db.query(`delete from login_attempts where attempted_at < now() - interval '1 day'`);
  const { rows } = await db.query(
    `select count(*)::int as n from login_attempts
     where ip = $1 and attempted_at > now() - make_interval(mins => $2)`,
    [ip, FAILURE_WINDOW_MINUTES]
  );
  if (rows[0].n >= MAX_FAILURES) {
    throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }
  if (!verifyPassword(password, process.env.ADMIN_PASSWORD_HASH)) {
    await db.query('insert into login_attempts (ip) values ($1)', [ip]);
    throw new HttpError(401, 'Wrong password');
  }
  await db.query('delete from login_attempts where ip = $1', [ip]);
  const admin = (
    await db.query(`update app_users set last_login_at = now() where kind = 'admin' returning *`)
  ).rows[0];
  await startSession(res, admin.id);
  return publicUser(admin);
}

/**
 * Creates the account on a first Discord login, or refreshes its name, avatar,
 * email and Discord roles on later ones. Returns the user.
 */
async function upsertDiscordUser({ discordId, name, avatarUrl, email, roles }) {
  const { rows } = await db.query(
    `insert into app_users (kind, discord_id, name, avatar_url, email, roles, roles_checked_at, last_login_at)
     values ('discord', $1, $2, $3, $4, $5, now(), now())
     on conflict (discord_id) do update set
       name = excluded.name, avatar_url = excluded.avatar_url,
       email = excluded.email, roles = excluded.roles, roles_checked_at = now(),
       last_login_at = now()
     returning *`,
    [discordId, name, avatarUrl || null, email || null, roles || []]
  );
  return publicUser(rows[0]);
}

const CHANNELS = ['email', 'discord', 'both', 'none'];

/** A user's notification preferences, for their settings page. */
async function getProfile(userId) {
  const { rows } = await db.query('select * from app_users where id = $1', [userId]);
  const u = rows[0];
  return {
    ...publicUser(u),
    discordLinked: Boolean(u.discord_id),
    discordEmail: u.email,
    notifyChannel: u.notify_channel,
    notifyEmail: u.notify_email,
  };
}

async function updateProfile(userId, body) {
  const channel = body.notifyChannel;
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Invalid notification choice');
  const address = String(body.notifyEmail || '')
    .trim()
    .toLowerCase();
  if (address && !isEmail(address)) throw new HttpError(400, 'Enter a valid email');
  await db.query('update app_users set notify_channel = $2, notify_email = $3 where id = $1', [
    userId,
    channel,
    address || null,
  ]);
  return getProfile(userId);
}

module.exports = {
  getProfile,
  updateProfile,
  COOKIE,
  hashPassword,
  verifyPassword,
  makeSession,
  sessionFor,
  endSessions,
  readSession,
  cookieHeader,
  startSession,
  logout,
  currentUser,
  requireUser,
  passwordLogin,
  upsertDiscordUser,
};
