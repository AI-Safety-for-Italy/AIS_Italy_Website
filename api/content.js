// /api/content: the seminars and events published from the dashboard, for the
// site's build (server/content-build.js reads it from the site it deploys to,
// so the build needs no database address).
//   GET                  -> { live, entries }   entries shaped like data/events.yaml's
//   GET ?part=community  -> { live, groups, members }   the directory and working
//                           groups last published (server/community.js)
//   GET ?part=local-groups  -> { live, cities }   the local groups' cities last
//                           published (server/local-groups.js): name, pin, link
//   GET ?part=mentors    -> { live, mentors, hidden }   the mentors published from
//                           the board (server/crm/mentorship.js), photos as paths
//   GET ?part=mentor-photo&id=…  -> that published mentor's photo (image/jpeg)
//   GET ?part=highlights -> { live, banners, spotlights }   the banners and the
//                           home page boxes switched on (server/highlights.js)
// Only what is on the site anyway: nothing until the content is switched on,
// and never removed items.
const { route, sendJson, HttpError } = require('../server/http');
const content = require('../server/content');
const community = require('../server/community');
const mentorship = require('../server/crm/mentorship');
const highlights = require('../server/highlights');
const localGroups = require('../server/local-groups');
const { getQuery } = require('../server/http');

module.exports = route({
  async GET(req, res) {
    const { part, id } = getQuery(req);
    if (part === 'community') {
      sendJson(res, 200, await community.publicExport());
      return;
    }
    if (part === 'highlights') {
      sendJson(res, 200, await highlights.publicExport());
      return;
    }
    if (part === 'local-groups') {
      sendJson(res, 200, await localGroups.publicExport());
      return;
    }
    if (part === 'mentors') {
      sendJson(res, 200, await mentorship.publicExport());
      return;
    }
    if (part === 'mentor-photo') {
      const photo = /^[a-z0-9-]{1,80}$/.test(String(id || '')) && (await mentorship.photoOf(id));
      if (!photo) throw new HttpError(404, 'No such photo');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(photo);
      return;
    }
    const data = await content.exportForBuild();
    sendJson(res, 200, data.live ? data : { live: false, entries: [] });
  },
});
