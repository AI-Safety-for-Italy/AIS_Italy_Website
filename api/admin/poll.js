// /api/admin/poll?id=<poll id>
//   GET                                    -> the poll with every response
//   PATCH  { status | title | description | location | deadline | hideResponses }
//   DELETE                                 -> deletes the poll
//   DELETE &response=<response id>         -> deletes one response
//   POST   &action=finalize { slotId, responseIds?, extraEmails?, createMeet? }
//   POST   &action=unschedule              -> cancels the calendar event
const { route, sendJson, readJson, getQuery, HttpError } = require('../../server/http');
const { requireAdmin } = require('../../server/auth');
const { getCalendar } = require('../../server/calendar');
const polls = require('../../server/polls');

module.exports = route({
  async GET(req, res) {
    requireAdmin(req);
    sendJson(res, 200, await polls.getPollAdmin(getQuery(req).id));
  },
  async PATCH(req, res) {
    requireAdmin(req);
    sendJson(res, 200, await polls.updatePoll(getQuery(req).id, await readJson(req)));
  },
  async DELETE(req, res) {
    requireAdmin(req);
    const { id, response } = getQuery(req);
    if (response) {
      await polls.deleteResponse(id, response);
      sendJson(res, 200, await polls.getPollAdmin(id));
    } else {
      await polls.deletePoll(id);
      sendJson(res, 200, { deleted: true });
    }
  },
  async POST(req, res) {
    requireAdmin(req);
    const { id, action } = getQuery(req);
    const body = await readJson(req);
    if (action === 'finalize') {
      sendJson(res, 200, await polls.finalizePoll(id, body, getCalendar()));
    } else if (action === 'unschedule') {
      sendJson(res, 200, await polls.unschedulePoll(id, getCalendar()));
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
