// /api/app/polls: the signed-in user's own polls.
//   GET   -> { polls: [...] }
//   POST  { title, description, location, durationMinutes, timezone, deadline,
//           hideResponses, notify, inviteOnly, invitees, slots: [ISO start, ...] }
//         -> { id, token, invites: { sent, failed } }
// An invite-only poll emails each guest their personal link straight away.
const { route, sendJson, readJson, origin } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const polls = require('../../server/polls');
const notify = require('../../server/notify');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    sendJson(res, 200, { polls: await polls.listPolls(user.id) });
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const created = await polls.createPoll(await readJson(req), user.id);
    let invites = { sent: 0, failed: 0 };
    if (created.invites.length) {
      const poll = await polls.getPollAdmin(created.id, user.id);
      invites = await notify.sendInvites({
        poll,
        ownerId: user.id,
        invites: created.invites,
        origin: origin(req),
      });
    }
    sendJson(res, 201, { id: created.id, token: created.token, invites });
  },
});
