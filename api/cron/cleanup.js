// /api/cron/cleanup: deletes the personal data past its keeping time
// (server/retention.js). Called once a day by .github/workflows/retention.yml.
//   POST, header "Authorization: Bearer <CRON_SECRET>"  -> { answers, applications }
// Without CRON_SECRET set on this deployment it does nothing (503).
const { route, sendJson } = require('../../server/http');
const { authorized } = require('../../server/cron');
const retention = require('../../server/retention');

module.exports = route({
  async POST(req, res) {
    authorized(req);
    sendJson(res, 200, await retention.cleanup());
  },
});
