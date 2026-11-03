// /api/app/highlights: the banners and the home page boxes (server/highlights.js).
//   GET           -> { banners, spotlights, updatedAt, updatedBy, limits }
//   PUT { banners, spotlights, updatedAt } -> the saved copy, and the build
//                    it started: { ...copy, build }
// For whoever holds `homepage`; checked in server/highlights.js.
const { route, sendJson, readJson } = require('../../http');
const { requireUser } = require('../../auth');
const highlights = require('../../highlights');
const publish = require('../../content-publish');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await highlights.get(user));
  },

  async PUT(req, res) {
    const user = await requireUser(req);
    const saved = await highlights.save(user, await readJson(req));
    sendJson(res, 200, { ...saved, build: await publish.triggerBuild() });
  },
});
