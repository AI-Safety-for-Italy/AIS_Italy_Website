// /api/content: the seminars and events published from the dashboard, for the
// site's build (server/content-build.js reads it from the site it deploys to,
// so the build needs no database address).
//   GET                  -> { live, entries }   entries shaped like data/events.yaml's
//   GET ?part=community  -> { live, groups, members }   the directory and working
//                           groups last published (server/community.js)
// Only what is on the site anyway: nothing until the content is switched on,
// and never removed items.
const { route, sendJson } = require('../server/http');
const content = require('../server/content');
const community = require('../server/community');
const { getQuery } = require('../server/http');

module.exports = route({
  async GET(req, res) {
    if (getQuery(req).part === 'community') {
      sendJson(res, 200, await community.publicExport());
      return;
    }
    const data = await content.exportForBuild();
    sendJson(res, 200, data.live ? data : { live: false, entries: [] });
  },
});
