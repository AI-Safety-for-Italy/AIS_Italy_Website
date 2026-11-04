// /api/app/community: the community's members and working groups
// (server/community.js), for whoever holds `community`. Every change is saved
// in the database only; Discord changes when the team applies the changes
// (?action=apply), the website when it is updated (?action=publish).
//
// Members
//   GET                                  -> { members, groups, roles, site, invited, applications }
//   GET    ?member=<id>                  -> one member's page: sources, applications,
//                                           Discord, website, history
//   PUT    ?member=<id> { name, profile, location, areas, publish, discordId }
//   POST   ?action=member-groups { member, groups?, role? }  -> one member's groups and role
//   POST   ?action=tags { members, action: add|remove|move, group, to? }  -> several at once
//   POST   ?action=roles { members, role }  -> several made participants or organizers
//   GET    ?view=export                  -> every member as a CSV file (audited)
//   POST   ?action=preview { csv, decisions? }  -> what importing the old sheet would do
//   POST   ?action=import { csv, decisions? }   -> imports it as previewed
//   POST   ?action=offboard { member, note? }   -> left the association: off the site,
//                                           their roles listed to take off on Discord
//   POST   ?action=restore { member }    -> a member again
//   GET    ?view=duplicates              -> members who may be one person twice
//   POST   ?action=merge { keep, drop }  -> two records of one person made one
//   POST   ?action=not-duplicate { a, b }  -> not the same person: not offered again
//   POST   ?action=note { member, body } -> a note for the team
//   DELETE ?note=<id>                    -> the author removes their note
//   POST   ?action=erase { member, confirm }  -> everything about them deleted
// Working groups
//   POST   ?action=group { id?, titleEn, titleIt, descriptionEn, descriptionIt, discordRoleId }
//   POST   ?action=order { ids }         -> the groups in a new order
//   POST   ?action=coordinator { group, member, on }  -> who coordinates
//   DELETE ?group=<id>                   -> a group removed (its role retired on Discord)
// Discord
//   GET    ?action=status                -> { accounts, discord, site }: the bar on top of the tabs
//   GET    ?view=discord-plan[&member=<id>]  -> the changes to apply there, and what to decide
//   POST   ?action=apply { items, member? }  -> applies picked changes on Discord
//                                           (15 a call: { done, failed, remaining, skipped })
//   POST   ?action=decide { items, choice }  -> settles items here (adopt, ignore, unlink, …)
//   GET    ?view=ignored                 -> differences left as they are
//   POST   ?action=unignore { ids }      -> listed again
//   GET    ?people=<name>                -> Discord members, to link someone's account
//   GET    ?suggest=<member id>          -> Discord accounts that may be them
//   POST   ?action=link { member, discordId | null }  -> linked or unlinked (nothing on Discord)
//   POST   ?action=absent { member, absent, note? }  -> checked: not on Discord
//   POST   ?action=rematch               -> the members not linked matched again, when sure
//   POST   ?action=follow { on }         -> told when Discord drifts from the board (daily)
// Website
//   POST   ?action=publish               -> the site shows the list as it is now
//   POST   ?action=unpublish             -> the site goes back to the YAML
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const access = require('../../access');
const permissions = require('../../permissions');
const community = require('../../community');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const { people, suggest, action, view, member } = getQuery(req);
    if (view === 'export') {
      const { filename, csv } = await community.exportCsv(user);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(csv);
      return;
    }
    if (view === 'discord-plan') {
      sendJson(res, 200, await community.discordPlanFor(user, { memberId: member }));
      return;
    }
    if (view === 'duplicates') {
      sendJson(res, 200, await community.duplicates(user));
      return;
    }
    if (view === 'ignored') {
      sendJson(res, 200, await community.ignoredList(user));
      return;
    }
    if (member !== undefined) {
      sendJson(res, 200, await community.memberDetail(user, member));
      return;
    }
    if (suggest !== undefined) {
      sendJson(res, 200, await community.discordSuggestions(user, suggest));
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
    const handlers = {
      group: () => community.saveGroup(user, body),
      order: () => community.reorderGroups(user, body.ids),
      tags: () => community.setTags(user, body),
      'member-groups': () => community.setMemberGroups(user, body.member, body),
      coordinator: () => community.setCoordinator(user, body),
      preview: () => community.importPreview(user, body.csv, body.decisions),
      import: () => community.importConfirm(user, body.csv, body.decisions),
      publish: () => community.publishSite(user),
      unpublish: () => community.unpublishSite(user),
      link: () => community.linkDiscord(user, body.member, body.discordId),
      absent: () => community.markAbsent(user, body.member, body),
      roles: () => community.setRoles(user, body),
      rematch: () => community.rematch(user),
      apply: () => community.applyDiscord(user, body),
      decide: () => community.decideDiscord(user, body),
      unignore: () => community.unignore(user, body),
      offboard: () => community.offboard(user, body.member, body),
      restore: () => community.restore(user, body.member),
      merge: () => community.mergeMembers(user, body),
      'not-duplicate': () => community.notDuplicate(user, body),
      note: () => community.addNote(user, body.member, body),
      erase: () => community.eraseMember(user, body.member, body),
      follow: () => community.setFollowing(user, Boolean(body.on)),
    };
    if (!Object.prototype.hasOwnProperty.call(handlers, action))
      throw new HttpError(400, 'Unknown action');
    sendJson(res, 200, await handlers[action]());
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
    const { group, note } = getQuery(req);
    if (note !== undefined) sendJson(res, 200, await community.deleteNote(user, note));
    else sendJson(res, 200, await community.deleteGroup(user, group));
  },
});
