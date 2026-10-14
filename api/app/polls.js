// /api/app/polls: the signed-in user's own polls.
//   GET   -> { polls: [...] }
//   POST  { title, description, location, durationMinutes, timezone, deadline,
//           hideResponses, slots: [ISO start, ...] } -> { id, token }
const { route, sendJson, readJson } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const polls = require('../../server/polls');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, { polls: await polls.listPolls(user.id) });
  },
  async POST(req, res) {
    const user = await requireUser(req);
    sendJson(res, 201, await polls.createPoll(await readJson(req), user.id));
  },
});
