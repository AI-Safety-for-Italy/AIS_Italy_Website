// /api/app/poll?id=<poll id>: one of the signed-in user's polls. Anyone
// else's poll answers 404.
//   GET                                -> the poll with every response
//   PATCH  { status | title | description | location | deadline | hideResponses }
//   DELETE                             -> deletes the poll
//   DELETE &response=<response id>     -> deletes one response
//   POST   &action=finalize { slotId } -> marks the chosen time
//   POST   &action=unschedule          -> clears it
const { route, sendJson, readJson, getQuery, HttpError } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const polls = require('../../server/polls');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await polls.getPollAdmin(getQuery(req).id, user.id));
  },
  async PATCH(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await polls.updatePoll(getQuery(req).id, await readJson(req), user.id));
  },
  async DELETE(req, res) {
    const user = await requireUser(req);
    const { id, response } = getQuery(req);
    if (response) {
      sendJson(res, 200, await polls.deleteResponse(id, response, user.id));
    } else {
      await polls.deletePoll(id, user.id);
      sendJson(res, 200, { deleted: true });
    }
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const { id, action } = getQuery(req);
    const body = await readJson(req);
    if (action === 'finalize') {
      sendJson(res, 200, await polls.finalizePoll(id, body, user.id));
    } else if (action === 'unschedule') {
      sendJson(res, 200, await polls.unschedulePoll(id, user.id));
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
