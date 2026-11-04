// /api/cron/cleanup: deletes the personal data past its keeping time
// (server/retention.js). Called once a day by .github/workflows/retention.yml.
//   POST, header "Authorization: Bearer <CRON_SECRET>"  -> { answers, applications }
//   POST ?job=reminders  -> { reminders, announcements }: the calendar's
//        reminders and Discord announcements due now (server/calendar-reminders.js),
//        every 10 minutes from .github/workflows/calendar-reminders.yml. Here
//        rather than a function of its own: the plan allows 12 per deploy.
// Without CRON_SECRET set on this deployment it does nothing (503).
const { route, sendJson, getQuery, siteUrl } = require('../../server/http');
const { authorized } = require('../../server/cron');
const retention = require('../../server/retention');
const reminders = require('../../server/calendar-reminders');

module.exports = route({
  async POST(req, res) {
    authorized(req);
    if (getQuery(req).job === 'reminders') {
      sendJson(res, 200, await reminders.run({ origin: siteUrl(req) }));
      return;
    }
    sendJson(res, 200, await retention.cleanup());
  },
});
