// /api/poll?p=<poll token>[&e=<edit token>]  (public: anyone with the link)
//   GET   -> the poll, the slots and (unless hidden) everyone's answers
//   GET   &check=1&name=…&email=… -> { nameTaken, emailTaken }
//   POST  { name, email, votes: { slotId: 0|1|2 }, editToken? } -> { editToken }
const { route, sendJson, readJson, getQuery } = require('../server/http');
const polls = require('../server/polls');

module.exports = route({
  async GET(req, res) {
    const query = getQuery(req);
    if (query.check) {
      sendJson(res, 200, await polls.checkAvailability(query.p, query));
    } else {
      sendJson(res, 200, await polls.getPollPublic(query.p, query.e));
    }
  },
  async POST(req, res) {
    sendJson(res, 200, await polls.submitResponse(getQuery(req).p, await readJson(req)));
  },
});
