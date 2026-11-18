// /api/app/polls: the signed-in user's polls, and those shared with them.
//   GET   -> { polls: [...] }  (each with canManage, notifyMe and access)
//   GET   ?calendars=1 -> { calendars } the meeting can land in (those this user adds to)
//   GET   ?busy=1&from=…&to=… -> { busy: [{ start, end, allDay, title, color }] } the events
//                          of the calendars this user shows: to pick times around them
//   POST  { title, description, location, durationMinutes, timezone, deadline,
//           hideResponses, notify, inviteOnly, invitees, slots: [ISO start, ...],
//           calendarId? }
//         -> { id, token, invites: { sent, failed } }
// An invite-only poll emails each guest their personal link straight away.
const { route, sendJson, readJson, getQuery, siteUrl } = require('../../http');
const { requireUser } = require('../../auth');
const polls = require('../../polls');
const notify = require('../../notify');
const calendars = require('../../calendars');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const q = getQuery(req);
    if (q.calendars) {
      sendJson(res, 200, { calendars: await calendars.writable(user) });
      return;
    }
    if (q.busy) {
      // What this member already has: their own calendar view, nothing more.
      const { events } = await calendars.listEvents(user, { from: q.from, to: q.to });
      sendJson(res, 200, {
        busy: events.map((e) => ({
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          title: e.title,
          color: e.color,
        })),
      });
      return;
    }
    sendJson(res, 200, { polls: await polls.listPolls(user) });
  },
  async POST(req, res) {
    const user = await requireUser(req);
    const body = await readJson(req);
    // The calendar is checked first: one this member adds to, or none.
    const calendarId = await calendars.pollCalendarChoice(user, body && body.calendarId);
    const created = await polls.createPoll(body, user.id, { calendarId });
    let invites = { sent: 0, failed: 0 };
    if (created.invites.length) {
      const poll = await polls.getPollAdmin(created.id, user.id);
      invites = await notify.sendInvites({
        poll,
        ownerId: user.id,
        invites: created.invites,
        origin: siteUrl(req),
      });
    }
    sendJson(res, 201, { id: created.id, token: created.token, invites });
  },
});
