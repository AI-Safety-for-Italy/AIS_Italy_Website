// Admin authentication: one shared password, and a signed session cookie.
//
// Kept behind three functions — login(), logout(), requireAdmin() — so that a
// proper per-person login (e.g. Sign in with Google for team members) can
// replace it later without touching the poll code.
//
// The password is never stored: ADMIN_PASSWORD_HASH holds a scrypt hash made
// by `node scripts/meet-hash-password.js`. The session cookie is
// "<expiry>.<HMAC>" signed with SESSION_SECRET, so the server keeps no
// session table; rotating SESSION_SECRET logs everyone out.

const crypto = require('crypto');
const { HttpError, getCookie, clientIp } = require('./http');
const db = require('./db');

const COOKIE = 'ais_admin';
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

function makeSession(now = Date.now()) {
  const expires = String(now + SESSION_DAYS * 24 * 3600 * 1000);
  return `${expires}.${sign(expires)}`;
}

function isValidSession(value, now = Date.now()) {
  if (!value) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return Number(expires) > now;
}

function cookieHeader(value, maxAge) {
  // Secure everywhere but plain-http localhost, where browsers would drop it.
  const secure = process.env.MEET_INSECURE_COOKIES === '1' ? '' : '; Secure';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function isAdmin(req) {
  return isValidSession(getCookie(req, COOKIE));
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Not signed in');
}

async function login(req, res, password) {
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
  res.setHeader('Set-Cookie', cookieHeader(makeSession(), SESSION_DAYS * 24 * 3600));
}

function logout(res) {
  res.setHeader('Set-Cookie', cookieHeader('', 0));
}

module.exports = {
  hashPassword,
  verifyPassword,
  makeSession,
  isValidSession,
  isAdmin,
  requireAdmin,
  login,
  logout,
};
