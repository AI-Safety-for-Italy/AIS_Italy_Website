// /api/admin/polls
//   GET   -> { polls: [...] }
//   POST  { title, description, location, durationMinutes, timezone, deadline,
//           hideResponses, slots: [ISO start, ...] } -> { id, token }
const { route, sendJson, readJson } = require('../../server/http');
const { requireAdmin } = require('../../server/auth');
const polls = require('../../server/polls');

module.exports = route({
  async GET(req, res) {
    requireAdmin(req);
    sendJson(res, 200, { polls: await polls.listPolls() });
  },
  async POST(req, res) {
    requireAdmin(req);
    sendJson(res, 201, await polls.createPoll(await readJson(req)));
  },
});
