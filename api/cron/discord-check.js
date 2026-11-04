// /api/cron/discord-check: compares the members board with the Discord server
// and tells whoever follows the board what changed there by hand
// (server/community.js, driftCheck). Called once a day by
// .github/workflows/discord-check.yml.
//   POST, header "Authorization: Bearer <CRON_SECRET>"  -> { checked, new, told }
// Without CRON_SECRET set on this deployment it does nothing (503).
const { route, sendJson } = require('../../server/http');
const { authorized } = require('../../server/cron');
const community = require('../../server/community');

module.exports = route({
  async POST(req, res) {
    authorized(req);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    sendJson(res, 200, await community.driftCheck({ origin: host ? `https://${host}` : null }));
  },
});
