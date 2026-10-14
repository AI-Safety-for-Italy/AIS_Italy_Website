// /api/app/poll?id=<poll id>: one of the signed-in user's polls. Anyone
// else's poll answers 404.
//   GET                                     -> the poll with every response
//   PATCH  { status | title | description | location | deadline |
//            hideResponses | notify }
//   DELETE                                  -> deletes the poll
//   DELETE &response=<response id>          -> deletes one response
//   DELETE &invite=<invite id>              -> removes a guest (and their answer)
//   POST   &action=finalize { slotId }      -> marks the chosen time
//   POST   &action=unschedule               -> clears it
//   POST   &action=invite { emails }        -> invites more guests
//   POST   &action=resend&invite=<invite id> -> emails a guest's link again
const { route, sendJson, readJson, getQuery, origin, HttpError } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const polls = require('../../server/polls');
const notify = require('../../server/notify');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await polls.getPollAdmin(getQuery(req).id, user.id));
  },
  async PATCH(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, await polls.updatePoll(getQuery(req).id, await readJson(req), user.id));
  },
  async DELETE(req, res) {
    const user = await requireUser(req);
    const { id, response, invite } = getQuery(req);
    if (response) {
      sendJson(res, 200, await polls.deleteResponse(id, response, user.id));
    } else if (invite) {
      sendJson(res, 200, await polls.removeInvite(id, invite, user.id));
    } else {
      await polls.deletePoll(id, user.id);
      sendJson(res, 200, { deleted: true });
    }
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const { id, action, invite } = getQuery(req);
    const body = await readJson(req);
    const send = (poll, invites) =>
      notify.sendInvites({ poll, ownerName: user.name, invites, origin: origin(req) });

    if (action === 'finalize') {
      sendJson(res, 200, await polls.finalizePoll(id, body, user.id));
    } else if (action === 'unschedule') {
      sendJson(res, 200, await polls.unschedulePoll(id, user.id));
    } else if (action === 'invite') {
      const added = await polls.addInvites(id, body.emails, user.id);
      const outcome = await send(added.poll, added.invites);
      sendJson(res, 200, { ...(await polls.getPollAdmin(id, user.id)), outcome });
    } else if (action === 'resend') {
      const found = await polls.getInvite(id, invite, user.id);
      const outcome = await send(found.poll, [found.invite]);
      sendJson(res, 200, { ...(await polls.getPollAdmin(id, user.id)), outcome });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
