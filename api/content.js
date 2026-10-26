// /api/content: the seminars and events published from the dashboard, for the
// site's build (server/content-build.js reads it from the site it deploys to,
// so the build needs no database address).
//   GET -> { live, entries }   entries shaped like data/events.yaml's
// Only what is on the site anyway: nothing until the content is switched on,
// and never removed items.
const { route, sendJson } = require('../server/http');
const content = require('../server/content');

module.exports = route({
  async GET(req, res) {
    const data = await content.exportForBuild();
    sendJson(res, 200, data.live ? data : { live: false, entries: [] });
  },
});
