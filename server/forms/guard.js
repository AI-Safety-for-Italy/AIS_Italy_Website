// Keeps bots and floods out of the public forms, without any outside service.
//
//   issueToken(formId)    handed out with the form: when it was opened, signed
//   check({ formId, token, honeypot, ip })
//       -> 'ok' | 'bot' (pretend success, store nothing) | throws 429 / 400
//
// Three tests:
//   1. the honeypot: a field people never see (hidden by the page); a bot
//      that fills every input fills it too;
//   2. time: a form sent less than MIN_FILL_MS after it was opened was not
//      filled by a person; the token proves when it was opened, and cannot be
//      forged without the server's secret;
//   3. rate: at most MAX_PER_WINDOW submissions per address and form in
//      WINDOW_MS. The address is stored only as an HMAC that changes every
//      day, and rows older than a day are deleted on each submission.

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../http');

const MIN_FILL_MS = 3000;
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;

let now = () => Date.now();
function setClock(fn) {
  now = fn || (() => Date.now());
}

function secret() {
  const base = process.env.SESSION_SECRET;
  if (!base || base.length < 32)
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  // A key of its own, derived, so a form token is never a valid session.
  return crypto.createHmac('sha256', base).update('forms-token-v1').digest();
}

function sign(text) {
  return crypto.createHmac('sha256', secret()).update(text).digest('base64url');
}

function issueToken(formId) {
  const at = String(now());
  return `${at}.${sign(`${formId}.${at}`)}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashIp(ip) {
  const day = new Date(now()).toISOString().slice(0, 10);
  return crypto
    .createHmac('sha256', secret())
    .update(`ip:${day}:${ip}`)
    .digest('base64url')
    .slice(0, 32);
}

async function check({ formId, token, honeypot, ip }) {
  if (honeypot) return 'bot';
  const [at, signature] = String(token || '').split('.');
  if (!at || !signature || !safeEqual(sign(`${formId}.${at}`), signature)) {
    throw new HttpError(400, 'This form has expired: reload the page and send it again');
  }
  const age = now() - Number(at);
  if (!(age >= 0) || age > MAX_TOKEN_AGE_MS) {
    throw new HttpError(400, 'This form has expired: reload the page and send it again');
  }
  if (age < MIN_FILL_MS) return 'bot';

  const ipHash = hashIp(ip || 'unknown');
  await db.query(`delete from form_submit_attempts where at < now() - interval '1 day'`);
  const { rows } = await db.query(
    `select count(*)::int as n from form_submit_attempts
     where ip_hash = $1 and form_id = $2 and at > $3`,
    [ipHash, formId, new Date(now() - WINDOW_MS)]
  );
  if (rows[0].n >= MAX_PER_WINDOW) {
    throw new HttpError(429, 'Too many answers from here: try again in a few minutes');
  }
  await db.query('insert into form_submit_attempts (ip_hash, form_id, at) values ($1, $2, $3)', [
    ipHash,
    formId,
    new Date(now()),
  ]);
  return 'ok';
}

module.exports = { MIN_FILL_MS, MAX_PER_WINDOW, WINDOW_MS, issueToken, check, hashIp, setClock };
