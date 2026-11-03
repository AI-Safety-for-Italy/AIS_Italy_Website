// /api/app/local-groups: the local groups (server/local-groups.js).
// The board, for whoever holds `local_groups`:
//   GET                              -> { groups, statuses }   with leads and links
//   GET    ?view=export              -> the board as a CSV file (audited)
//   POST   { city, status?, leads?, whatsapp?, notes? }  -> { group }   a new one
//   PUT    ?id=… { same }            -> { group }   changed
//   POST   ?action=status { id, status }  -> { group }   moved to another column
//   DELETE ?id=…                     -> { ok }
// The site (Site content → Local groups), for whoever holds `local_groups_site`:
//   GET    ?part=site                -> { groups, site, map }   no leads, no links of the board
//   POST   ?action=publish { groups: [{ id, show, link, x, y }] }  -> { groups, site, build }
//   POST   ?action=unpublish         -> the site goes back to community.yaml's cities
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const localGroups = require('../../local-groups');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const { part, view } = getQuery(req);
    if (view === 'export') {
      const { filename, csv } = await localGroups.exportCsv(user);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(csv);
    } else if (part === 'site') sendJson(res, 200, await localGroups.listSite(user));
    else if (part === undefined) sendJson(res, 200, await localGroups.listBoard(user));
    else throw new HttpError(400, 'Unknown part');
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const { action } = getQuery(req);
    const body = (await readJson(req)) || {};
    if (action === 'status')
      sendJson(res, 200, await localGroups.setStatus(user, body.id, body.status));
    else if (action === 'publish') sendJson(res, 200, await localGroups.publishSite(user, body));
    else if (action === 'unpublish') sendJson(res, 200, await localGroups.unpublishSite(user));
    else if (action === undefined) sendJson(res, 201, await localGroups.saveGroup(user, body));
    else throw new HttpError(400, 'Unknown action');
  },
  async PUT(req, res) {
    const user = await requireUser(req);
    const { id } = getQuery(req);
    if (!id) throw new HttpError(400, 'Which group?');
    sendJson(res, 200, await localGroups.saveGroup(user, await readJson(req), id));
  },
  async DELETE(req, res) {
    const user = await requireUser(req);
    const { id } = getQuery(req);
    if (!id) throw new HttpError(400, 'Which group?');
    sendJson(res, 200, await localGroups.deleteGroup(user, id));
  },
});
