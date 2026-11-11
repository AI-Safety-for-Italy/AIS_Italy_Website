// /api/app/members: the member applications board (server/members.js).
//   GET                                   -> { applications, roles, mailReady }
//   POST ?action=decide&id=… { decision: 'approve'|'reject', role, note }
//                                         -> { application, invite }
//   POST ?action=resend&id=…              -> a fresh join link by email
//   POST ?action=note&id=… { note }       -> the internal note, saved alone
//   POST ?action=contacted&id=… { on }    -> marked as contacted, or not
//   POST ?action=contact&id=… { subject, text }
//                                         -> an email to the applicant asking
//                                            for more details; marks contacted
//   POST ?action=follow { on }            -> told about new applications, or not
//   GET  ?upgrade=1                       -> { can, pending, schema }: a participant
//                                            asking to become an organizer
//   POST ?action=upgrade { answers }      -> that request, on the board as an upgrade
// Needs the `members` permission (server/permissions.js).
const { route, sendJson, readJson, getQuery, siteUrl, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const members = require('../../members');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    if (getQuery(req).upgrade) {
      // The organizers' part, for a participant: no `members` permission needed.
      const state = await members.upgradeState(user);
      sendJson(res, 200, { ...state, schema: state.can ? await members.upgradeSchema() : null });
      return;
    }
    sendJson(res, 200, await members.listApplications(user));
  },

  async POST(req, res) {
    const user = await requireUser(req);
    const query = getQuery(req);
    const body = await readJson(req);
    const ctx = { siteOrigin: siteUrl(req) };
    if (query.action === 'decide') {
      sendJson(res, 200, await members.decide(user, query.id, body, ctx));
    } else if (query.action === 'upgrade') {
      sendJson(res, 201, await members.requestUpgrade(user, body.answers, ctx));
    } else if (query.action === 'follow') {
      sendJson(res, 200, await members.setFollowing(user, Boolean(body.on)));
    } else if (query.action === 'resend') {
      sendJson(res, 200, await members.resendInvite(user, query.id, ctx));
    } else if (query.action === 'note') {
      sendJson(res, 200, await members.saveNote(user, query.id, body));
    } else if (query.action === 'contacted') {
      sendJson(res, 200, await members.setContacted(user, query.id, body));
    } else if (query.action === 'contact') {
      sendJson(res, 200, await members.contact(user, query.id, body));
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
