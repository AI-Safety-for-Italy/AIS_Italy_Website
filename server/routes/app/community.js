// /api/app/community: the community's members and working groups
// (server/community.js), for whoever holds `community`.
//   GET                                  -> { members, groups, site }
//   GET    ?people=<name>                -> Discord members, to link someone's account
//   POST   ?action=group { id?, titleEn, titleIt, descriptionEn, descriptionIt,
//                          discordRoleId }    -> a new group, or one changed
//   POST   ?action=order { ids }         -> the groups in a new order
//   DELETE ?group=<id>                   -> a group removed (its tag from everyone)
//   PUT    ?member=<id> { name, profile, location, areas, publish, discordId }
//   POST   ?action=tags { members, action: add|remove|move, group, to? }  (taking part)
//   POST   ?action=coordinator { group, member, on }  -> who coordinates (Working groups)
//   POST   ?action=preview { csv }       -> what importing the old sheet would do
//   POST   ?action=import { csv }        -> imports it
//   POST   ?action=publish               -> the site shows the list as it is now
//   POST   ?action=unpublish             -> the site goes back to the YAML
//   GET    ?suggest=<member id>          -> Discord accounts that may be them
//   POST   ?action=link { member, discordId | null } -> linked (roles given, none taken)
//   POST   ?action=absent { member, absent, note? }  -> checked: not on Discord
//   GET    ?action=check                 -> roles on Discord against tags here
//   GET    ?action=status                -> { accounts, roles, site }: the bar on top of the tabs
//   POST   ?action=send-tags             -> some of the missing roles given: { given, failed, remaining }
//   POST   ?action=resolve { member, group, action: give|take|tag|untag|ok, level?, kind? }
// Tag changes reach Discord at once; the site only on publish.
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const access = require('../../access');
const permissions = require('../../permissions');
const community = require('../../community');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const { people, suggest, action } = getQuery(req);
    if (suggest !== undefined) {
      sendJson(res, 200, await community.discordSuggestions(user, suggest));
      return;
    }
    if (action === 'check') {
      sendJson(res, 200, await community.roleCheck(user));
      return;
    }
    if (action === 'status') {
      sendJson(res, 200, await community.status(user));
      return;
    }
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
    else if (action === 'coordinator')
      sendJson(res, 200, await community.setCoordinator(user, body));
    else if (action === 'preview')
      sendJson(res, 200, await community.importPreview(user, body.csv));
    else if (action === 'import') sendJson(res, 200, await community.importConfirm(user, body.csv));
    else if (action === 'publish') sendJson(res, 200, await community.publishSite(user));
    else if (action === 'unpublish') sendJson(res, 200, await community.unpublishSite(user));
    else if (action === 'link')
      sendJson(res, 200, await community.linkDiscord(user, body.member, body.discordId));
    else if (action === 'absent')
      sendJson(res, 200, await community.markAbsent(user, body.member, body));
    else if (action === 'resolve') sendJson(res, 200, await community.resolveRole(user, body));
    else if (action === 'send-tags') sendJson(res, 200, await community.sendTags(user));
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
