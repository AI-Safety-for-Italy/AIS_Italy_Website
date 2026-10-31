// Keeps personal data out of the database in the clear.
//
//   personKey(email)         an opaque key for a person: the HMAC of their
//                            email, so the database can point at someone
//                            ("this card moved to Contacted") without holding
//                            their address, and cannot be reversed without the
//                            secret.
//   encrypt(text, context)   AES-256-GCM, for the free notes, which may well
//   decrypt(blob, context)   contain personal data. `context` (the person key,
//                            say) is authenticated with the text, so a note
//                            copied onto another person's row fails to open.
//
// Env (both required outside local development; missing means the CRM refuses
// to start rather than store anything unprotected):
//   CRM_ENCRYPTION_KEY           32 random bytes, base64 (`openssl rand -base64 32`)
//   CRM_ENCRYPTION_KEY_PREVIOUS  the old key while rotating: still opens old
//                                notes, never used to write new ones
//   CRM_KEY_SECRET               at least 32 characters, for the person keys.
//                                Changing it orphans every person key: do not.
//
// The local server (scripts/meet-dev.js) sets throwaway development values.

const crypto = require('crypto');
const { isEmail, normalizeEmail } = require('../email');

const VERSION = 'v1';

function encryptionKeys() {
  const keys = [process.env.CRM_ENCRYPTION_KEY, process.env.CRM_ENCRYPTION_KEY_PREVIOUS]
    .filter(Boolean)
    .map((value) => Buffer.from(value, 'base64'));
  if (!keys.length) throw new Error('CRM_ENCRYPTION_KEY is not set');
  keys.forEach((key) => {
    if (key.length !== 32) throw new Error('CRM_ENCRYPTION_KEY must be 32 bytes, base64');
  });
  return keys;
}

function keySecret() {
  const value = process.env.CRM_KEY_SECRET;
  if (!value || value.length < 32) {
    throw new Error('CRM_KEY_SECRET must be set to at least 32 characters');
  }
  return value;
}

/** True when the CRM can protect what it stores. */
function configured() {
  try {
    encryptionKeys();
    keySecret();
    return true;
  } catch {
    return false;
  }
}

/** The opaque key for an email, or null when there is no usable address. */
function personKey(email) {
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized)) return null;
  return crypto
    .createHmac('sha256', keySecret())
    .update(`person:${normalized}`)
    .digest('base64url')
    .slice(0, 32);
}

function encrypt(plain, context = '') {
  const [key] = encryptionKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p))
    .join('.');
}

/** The text, or null when the blob is not ours, was altered, or has another context. */
function decrypt(blob, context = '') {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, iv, tag, body] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64url')));
  for (const key of encryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(String(context)));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      /* wrong key or altered: try the previous key, then give up */
    }
  }
  return null;
}

module.exports = { configured, normalizeEmail, personKey, encrypt, decrypt };
