// /api/app/poll?id=<poll id>: one of the signed-in user's polls. Anyone
// else's poll answers 404.
//   GET                                     -> the poll with every response
//   PATCH  { status | title | description | location | deadline |
//            hideResponses | notify }
//   DELETE                                  -> deletes the poll
//   DELETE &response=<response id>          -> deletes one response
//   DELETE &invite=<invite id>              -> removes a guest (and their answer)
//   GET    &format=ics                      -> the chosen time as a calendar file
//   POST   &action=finalize { slotId, sendInvite?, emails?, extraEmails? }
//                                           -> marks the chosen time, and can
//                                              email the calendar invite
//   POST   &action=send-meeting { emails?, extraEmails? }
//                                           -> emails the calendar invite for
//                                              the chosen time (again)
//   POST   &action=unschedule               -> clears it (and cancels the
//                                              emailed invite, if any)
//   POST   &action=invite { emails }        -> invites more guests
//   POST   &action=resend&invite=<invite id> -> emails a guest's link again
const { route, sendJson, readJson, getQuery, siteUrl, HttpError } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const polls = require('../../server/polls');
const notify = require('../../server/notify');
const ics = require('../../server/ics');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const { id, format } = getQuery(req);
    if (format === 'ics') {
      const { poll, slot } = await polls.getMeeting(id, user.id);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      const name = poll.title.replace(/[^\w\s-]/g, '').trim() || 'meeting';
      res.setHeader('Content-Disposition', `attachment; filename="${name}.ics"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(ics.build(poll, slot, { sequence: poll.meeting_sequence }));
      return;
    }
    sendJson(res, 200, await polls.getPollAdmin(id, user.id));
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
      notify.sendInvites({ poll, ownerId: user.id, invites, origin: siteUrl(req) });

    if (action === 'finalize') {
      let result = await polls.finalizePoll(id, body, user.id);
      if (body.sendInvite) {
        const meeting = await polls.prepareMeetingInvite(id, user.id, body);
        const outcome = await notify.sendMeeting({ ...meeting, ownerId: user.id });
        result = { ...(await polls.getPollAdmin(id, user.id)), outcome };
      }
      sendJson(res, 200, result);
    } else if (action === 'send-meeting') {
      const meeting = await polls.prepareMeetingInvite(id, user.id, body);
      const outcome = await notify.sendMeeting({ ...meeting, ownerId: user.id });
      sendJson(res, 200, { ...(await polls.getPollAdmin(id, user.id)), outcome });
    } else if (action === 'unschedule') {
      const result = await polls.unschedulePoll(id, user.id);
      const { cancel, ...poll } = result;
      if (cancel) {
        poll.outcome = await notify.sendMeeting({
          poll,
          slot: cancel.slot,
          recipients: cancel.emails.map((email) => ({ email })),
          ownerId: user.id,
          sequence: cancel.sequence,
          cancel: true,
        });
      }
      sendJson(res, 200, poll);
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
