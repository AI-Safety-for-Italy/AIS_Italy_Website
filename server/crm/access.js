// The one door every CRM endpoint goes through (api/app/crm/*).
//
//   const perms = await access.require(user, 'mentorship');
//
// It checks, in this order:
//   1. the sign-in is recent: the CRM holds personal data, so a session older
//      than 24 hours (the cookie lasts 7 days) asks for a new sign-in;
//   2. the Discord roles, read again from Discord when the last read is older
//      than five minutes, grant the permission for this part of the CRM;
//   3. a refusal for lack of permission is written to the audit trail.
// Hiding a button is never the protection: this is.

const db = require('../db');
const { HttpError } = require('../http');
const permissions = require('../permissions');
const audit = require('./audit');

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

const CRM_KEYS = permissions.PERMISSIONS.filter((p) => p.area === 'crm').map((p) => p.key);
// The forms (server/forms/) and the member applications (server/members.js)
// hold personal data too and go through this door.
const GUARDED_KEYS = permissions.PERMISSIONS.filter((p) =>
  ['crm', 'forms', 'members'].includes(p.area)
).map((p) => p.key);

async function requireRecentLogin(user, now = Date.now()) {
  const { rows } = await db.query('select last_login_at from app_users where id = $1', [user.id]);
  const last = rows[0] && rows[0].last_login_at;
  if (!last || now - new Date(last).getTime() > MAX_SESSION_AGE_MS) {
    throw new HttpError(401, 'Please sign in again to use this tool');
  }
}

/**
 * Returns the user's permissions when they hold `key` (one of CRM_KEYS).
 * Throws 401 for an old sign-in and 403 otherwise. `fresh` re-reads the
 * Discord roles whatever their age: for every change.
 */
async function requirePermission(user, key, { fresh = false } = {}) {
  if (!GUARDED_KEYS.includes(key)) throw new Error(`Not a guarded permission: ${key}`);
  await requireRecentLogin(user);
  try {
    if (fresh) return await permissions.require(user, key, { fresh: true });
    return await permissions.requireRecent(user, key);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      await audit.record(user, 'denied', null, { needs: key });
    }
    throw err;
  }
}

/** Fields only some permissions may read: { field: permission needed }. */
const FIELD_PERMISSION = {
  email: 'mentorship',
  form_email: 'mentorship',
  social: 'mentorship',
  cv: 'mentorship',
  profile: 'mentorship',
  phone: 'mentorship',
};

// The list above can miss a column a form adds later. Whatever its name, a
// value holding an email address is contact data too.
const LOOKS_LIKE_EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/;

/**
 * A copy of a record without the fields these permissions may not read, so
 * the API never sends them (as opposed to the page hiding them). Without
 * `mentorship`, any value containing an email address is dropped as well.
 */
function redact(record, perms) {
  const contacts = perms.includes('mentorship');
  const out = {};
  for (const [field, value] of Object.entries(record)) {
    const needs = FIELD_PERMISSION[field];
    if (needs && !perms.includes(needs)) continue;
    if (!contacts && LOOKS_LIKE_EMAIL.test(String(value))) continue;
    out[field] = value;
  }
  return out;
}

module.exports = { CRM_KEYS, MAX_SESSION_AGE_MS, requirePermission, requireRecentLogin, redact };
