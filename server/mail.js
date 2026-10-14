// Outgoing email (invites to invite-only polls, notifications to owners),
// sent over SMTP with the settings the admin saves on /app/settings/.
//
// The SMTP password is kept encrypted (AES-256-GCM, key derived from
// SESSION_SECRET), so the database alone does not reveal it. Rotating
// SESSION_SECRET means entering the password again.
//
// MEET_FAKE_MAIL=1 (set by scripts/meet-dev.js) logs messages instead of
// sending them.

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');

const KEY = 'smtp';

function cipherKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update(`smtp:${secret}`).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, tag, data] = String(value)
    .split('.')
    .map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function readSettings() {
  const { rows } = await db.query('select value from app_settings where key = $1', [KEY]);
  return rows.length ? rows[0].value : null;
}

/** The SMTP settings as the admin page shows them: never the password. */
async function publicSettings() {
  const s = await readSettings();
  if (!s) return null;
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    fromEmail: s.fromEmail,
    fromName: s.fromName,
    hasPassword: Boolean(s.password),
  };
}

async function isConfigured() {
  if (process.env.MEET_FAKE_MAIL === '1') return true;
  const s = await readSettings();
  return Boolean(s && s.host && s.fromEmail && s.password);
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Saves SMTP settings. An empty password keeps the one already stored. */
async function saveSettings(body) {
  const current = (await readSettings()) || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port);
  const fromEmail = String(body.fromEmail || '')
    .trim()
    .toLowerCase();
  if (!host || host.length > 200) throw new HttpError(400, 'Enter the SMTP server');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Invalid port');
  if (!EMAIL.test(fromEmail)) throw new HttpError(400, 'Enter a valid sender address');
  const value = {
    host,
    port,
    user: String(body.user || '').trim(),
    fromEmail,
    fromName:
      String(body.fromName || '')
        .trim()
        .slice(0, 100) || 'AI Safety for Italy',
    password: body.password ? encrypt(String(body.password)) : current.password || null,
  };
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, JSON.stringify(value)]
  );
  return publicSettings();
}

// Swapped out by the tests.
let createTransport = (options) => require('nodemailer').createTransport(options);
function setTransportFactory(fn) {
  createTransport = fn;
}

/**
 * Sends one message: { to, subject, text, html, replyTo }.
 * Throws HttpError(503) when email is not set up.
 */
async function send(message) {
  if (process.env.MEET_FAKE_MAIL === '1') {
    console.log(`[fake mail] to ${message.to}: ${message.subject}\n${message.text}\n`);
    return;
  }
  const s = await readSettings();
  if (!s || !s.host || !s.password) {
    throw new HttpError(503, 'Email sending is not set up yet (admin → Settings)');
  }
  const transport = createTransport({
    host: s.host,
    port: s.port,
    // 465 speaks TLS from the start; other ports upgrade with STARTTLS.
    secure: s.port === 465,
    auth: { user: s.user || s.fromEmail, pass: decrypt(s.password) },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  await transport.sendMail({
    from: { name: s.fromName, address: s.fromEmail },
    to: message.to,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

module.exports = {
  publicSettings,
  saveSettings,
  isConfigured,
  send,
  setTransportFactory,
  encrypt,
  decrypt,
};
