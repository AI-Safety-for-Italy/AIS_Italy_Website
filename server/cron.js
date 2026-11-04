// The scheduled jobs' door (api/cron/*): called by GitHub Actions with the
// shared CRON_SECRET (at least 32 characters), compared in constant time.
// Without it set on this deployment, every job says it is not set up (503).
const crypto = require('crypto');
const { HttpError } = require('./http');

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || '');
  if (secret.length < 32) throw new HttpError(503, 'The scheduled jobs are not set up here');
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Not allowed');
}

module.exports = { authorized };
