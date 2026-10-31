// Outgoing email (invites to invite-only polls, notifications to owners),
// sent over SMTP with the settings the admin saves on /app/polls/settings/.
//
// The SMTP password is kept encrypted (AES-256-GCM, key derived from
// SESSION_SECRET), so the database alone does not reveal it. Rotating
// SESSION_SECRET means entering the password again.
//
// MEET_FAKE_MAIL=1 (set by scripts/meet-dev.js) logs messages instead of
// sending them.

const crypto = require('crypto');
const db = require('./db');
const { isEmail } = require('./email');
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
  if (!isEmail(fromEmail)) throw new HttpError(400, 'Enter a valid sender address');
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

// A pause between messages of a batch, so a burst of invitations does not
// trip the provider's sending limits.
const BATCH_PAUSE_MS = Number(process.env.MEET_MAIL_PAUSE_MS || 400);

// Failures that will not get better for the next message of the batch.
const FATAL = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS']);

function logFake(message) {
  const from = message.senderName ? `${message.senderName} · ` : '';
  const reply = message.replyTo ? ` (reply to ${message.replyTo})` : '';
  const ical = message.icalEvent ? ` [calendar ${message.icalEvent.method} attached]` : '';
  console.log(
    `[fake mail] from ${from}mailbox to ${message.to}${reply}${ical}: ${message.subject}\n${message.text}\n`
  );
}

/**
 * Sends a batch of messages over a single SMTP connection, one after the
 * other with a short pause. Each message is { to, subject, text, html,
 * replyTo, senderName, icalEvent }; `senderName` (the person behind it) is
 * shown before the mailbox's own name, e.g. "Anna Rossi · AI Safety for
 * Italy", while the address stays the mailbox's.
 *
 * Returns one result per message: { ok: true } or { ok: false, error }. If
 * the server refuses the login or cannot be reached, the rest of the batch is
 * not attempted. Throws HttpError(503) when email is not set up.
 */
async function sendBatch(messages, { pauseMs = BATCH_PAUSE_MS } = {}) {
  if (process.env.MEET_FAKE_MAIL === '1') {
    messages.forEach(logFake);
    return messages.map(() => ({ ok: true }));
  }
  const s = await readSettings();
  if (!s || !s.host || !s.password) {
    throw new HttpError(503, 'Email sending is not set up yet (admin → General settings)');
  }
  const transport = createTransport({
    host: s.host,
    port: s.port,
    // 465 speaks TLS from the start; other ports upgrade with STARTTLS.
    secure: s.port === 465,
    auth: { user: s.user || s.fromEmail, pass: decrypt(s.password) },
    // One connection, reused for every message of the batch.
    pool: true,
    maxConnections: 1,
    maxMessages: Infinity,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  const results = [];
  let fatal = null;
  try {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (fatal) {
        results.push({ ok: false, error: fatal });
        continue;
      }
      if (i > 0 && pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      try {
        await transport.sendMail({
          from: {
            name: message.senderName ? `${message.senderName} · ${s.fromName}` : s.fromName,
            address: s.fromEmail,
          },
          to: message.to,
          replyTo: message.replyTo,
          // Every message here is sent by the app, not typed by a person:
          // tells auto-responders not to answer (RFC 3834).
          headers: { 'Auto-Submitted': 'auto-generated' },
          // A calendar invitation, shown by mail apps as an event to add.
          icalEvent: message.icalEvent,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        results.push({ ok: true });
      } catch (err) {
        console.error('Sending to', message.to, 'failed:', err.code || '', err.message);
        if (FATAL.has(err.code)) fatal = err.message;
        results.push({ ok: false, error: err.message });
      }
    }
  } finally {
    if (typeof transport.close === 'function') transport.close();
  }
  return results;
}

/** Sends one message (see sendBatch); throws if it could not be sent. */
async function send(message) {
  const [result] = await sendBatch([message]);
  if (!result.ok) throw new Error(result.error);
}

module.exports = {
  publicSettings,
  saveSettings,
  isConfigured,
  send,
  sendBatch,
  setTransportFactory,
  encrypt,
  decrypt,
};
