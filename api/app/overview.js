// /api/app/overview: what waits for the signed-in member in each tool, as
// counts for the sidebar and the home page (server/overview.js).
//   GET -> { tools: { <key>: { count, label, url } } }
const { route, sendJson } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const { overview } = require('../../server/overview');

module.exports = route({
  async GET(req, res) {
    sendJson(res, 200, await overview(await requireUser(req)));
  },
});
