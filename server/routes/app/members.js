// /api/app/members: the member applications board (server/members.js).
//   GET                                   -> { applications, roles, mailReady }
//   POST ?action=decide&id=… { decision: 'approve'|'reject', role, note }
//                                         -> { application, invite }
//   POST ?action=resend&id=…              -> a fresh join link by email
// Needs the `members` permission (server/permissions.js).
const { route, sendJson, readJson, getQuery, siteUrl, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const members = require('../../members');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await members.listApplications(user));
  },

  async POST(req, res) {
    const user = await requireUser(req);
    const query = getQuery(req);
    const body = await readJson(req);
    const ctx = { siteOrigin: siteUrl(req) };
    if (query.action === 'decide') {
      sendJson(res, 200, await members.decide(user, query.id, body, ctx));
    } else if (query.action === 'resend') {
      sendJson(res, 200, await members.resendInvite(user, query.id, ctx));
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
