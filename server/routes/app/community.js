// /api/app/community: the community's members and working groups
// (server/community.js), for whoever holds `community`.
//   GET                                  -> { members, groups, site }
//   GET    ?people=<name>                -> Discord members, to link someone's account
//   POST   ?action=group { id?, titleEn, titleIt, descriptionEn, descriptionIt,
//                          discordRoleId }    -> a new group, or one changed
//   POST   ?action=order { ids }         -> the groups in a new order
//   DELETE ?group=<id>                   -> a group removed (its tag from everyone)
//   PUT    ?member=<id> { name, profile, location, areas, publish, discordId }
//   POST   ?action=tags { members, action: add|remove|move, group, level?, to? }
//   POST   ?action=preview { csv }       -> what importing the old sheet would do
//   POST   ?action=import { csv }        -> imports it
//   POST   ?action=publish               -> the site shows the list as it is now
//   POST   ?action=unpublish             -> the site goes back to the YAML
// Tag changes reach Discord at once; the site only on publish.
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const access = require('../../access');
const permissions = require('../../permissions');
const community = require('../../community');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const { people } = getQuery(req);
    if (people !== undefined) {
      await access.authorize(user, 'community');
      sendJson(res, 200, { people: await permissions.searchMembers(people) });
      return;
    }
    sendJson(res, 200, await community.listMembers(user));
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const { action } = getQuery(req);
    // The sheet's CSV can be a few hundred kilobytes.
    const body = (await readJson(req, { max: 5_000_000 })) || {};
    if (action === 'group') sendJson(res, 200, await community.saveGroup(user, body));
    else if (action === 'order') sendJson(res, 200, await community.reorderGroups(user, body.ids));
    else if (action === 'tags') sendJson(res, 200, await community.setTags(user, body));
    else if (action === 'preview')
      sendJson(res, 200, await community.importPreview(user, body.csv));
    else if (action === 'import') sendJson(res, 200, await community.importConfirm(user, body.csv));
    else if (action === 'publish') sendJson(res, 200, await community.publishSite(user));
    else if (action === 'unpublish') sendJson(res, 200, await community.unpublishSite(user));
    else throw new HttpError(400, 'Unknown action');
  },
  async PUT(req, res) {
    const user = await requireUser(req);
    sendJson(
      res,
      200,
      await community.updateMember(user, getQuery(req).member, await readJson(req))
    );
  },
  async DELETE(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await community.deleteGroup(user, getQuery(req).group));
  },
});
