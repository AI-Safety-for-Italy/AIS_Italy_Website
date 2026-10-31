// /api/app/overview: what waits for the signed-in member in each tool, as
// counts for the sidebar and the home page (server/overview.js).
//   GET -> { tools: { <key>: { count, label, url } } }
const { route, sendJson } = require('../../http');
const { requireUser } = require('../../auth');
const { overview } = require('../../overview');

module.exports = route({
  async GET(req, res) {
    sendJson(res, 200, await overview(await requireUser(req)));
  },
});
