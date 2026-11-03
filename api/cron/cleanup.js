// /api/cron/cleanup: deletes the personal data past its keeping time
// (server/retention.js). Called once a day by .github/workflows/retention.yml.
//   POST, header "Authorization: Bearer <CRON_SECRET>"  -> { answers, applications }
// Without CRON_SECRET set on this deployment it does nothing (503).
const crypto = require('crypto');
const { route, sendJson, HttpError } = require('../../server/http');
const retention = require('../../server/retention');

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || '');
  if (secret.length < 32) throw new HttpError(503, 'The cleanup is not set up here');
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Not allowed');
}

module.exports = route({
  async POST(req, res) {
    authorized(req);
    sendJson(res, 200, await retention.cleanup());
  },
});
