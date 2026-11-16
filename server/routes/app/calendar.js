// /api/app/calendar: the calendar of the personal area (server/calendars.js),
// for every signed-in member; each calendar says who sees, edits and manages it.
//   GET  ?from=…&to=…[&calendars=id,id]   -> { events } (the calendars shown)
//   GET  ?calendars=1                     -> { calendars, canCreate, colors, leadTimes }
//   GET  ?event=<id>[&at=<occurrence>]    -> one occurrence, who comes, reminders
//   GET  ?prefs=1                         -> the Subscribe page's choices
//   GET  ?channels=1                      -> the Discord server's { text, voice } channels
//   GET  ?roles=1                         -> the Discord server's roles
//   GET  ?people=<name>                   -> members of the Discord server
//   GET  ?writable=1                      -> the calendars this member adds to
//   POST ?action=create-calendar {…}      -> a new calendar (calendar_create)
//   POST ?action=update-calendar&id=… {…} -> its details, access, announcements (manage)
//   POST ?action=archive&id=… { archived }  (manage)
//   POST ?action=delete-calendar&id=…     -> an archived calendar, for good (manage)
//   POST ?action=create-event {…}         -> a new event (edit)
//   POST ?action=update-event&id=…&scope=this|following|all&at=… {…}  (edit)
//   POST ?action=delete-event&id=…&scope=…&at=…                       (edit)
//   POST ?action=rsvp&id=…&at=… { answer: 'yes' | 'maybe' | 'no' | null }
//   POST ?action=save-prefs { advanced, notify, selection }
//   POST ?action=show&id=… { on }         -> one calendar on the dashboard, or not
//   POST ?action=regenerate-feed          -> a new personal .ics link
//   GET  ?invitable=<name>                -> members who can be invited by name (who adds events)
//   POST ?action=invites&id=… { members, emails }  -> who is invited to an event (edit)
//   POST ?action=send-invites&id=… { again? }      -> emails / DMs the invite (edit)
//   POST ?action=my-reminders&id=… { eventReminders, own, occurrence }
//                                         -> this member's reminders for one event
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const calendars = require('../../calendars');
const permissions = require('../../permissions');
const discord = require('../../calendar-discord');
const invites = require('../../calendar-invites');
const { siteUrl } = require('../../http');

const SCOPES = ['this', 'following', 'all'];

function scopeOf(query) {
  const scope = query.scope || 'all';
  if (!SCOPES.includes(scope)) throw new HttpError(400, 'Unknown scope');
  return { scope, occurrence: query.at };
}

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const q = getQuery(req);
    if (q.from || q.to) return sendJson(res, 200, await calendars.listEvents(user, q));
    if (q.event) return sendJson(res, 200, await calendars.getEvent(user, q.event, q.at));
    if (q.calendars) return sendJson(res, 200, await calendars.listCalendars(user));
    if (q.prefs) return sendJson(res, 200, await calendars.getPrefs(user));
    if (q.writable) return sendJson(res, 200, { calendars: await calendars.writable(user) });
    // The server's channels for who writes events; its roles and members for
    // who gives access to a calendar.
    if (q.channels) {
      if (!(await calendars.writable(user)).length)
        throw new HttpError(403, 'Only who adds events sees the channels');
      return sendJson(res, 200, await discord.channels());
    }
    if (q.invitable !== undefined) {
      if (!(await calendars.writable(user)).length)
        throw new HttpError(403, 'Only who adds events invites people');
      return sendJson(res, 200, { people: await invites.searchMembers(q.invitable) });
    }
    if (q.roles || q.people !== undefined) {
      if (!(await calendars.sharesCalendars(user)))
        throw new HttpError(403, 'Only who manages a calendar gives access to it');
      if (q.roles) return sendJson(res, 200, { roles: await permissions.guildRoles() });
      return sendJson(res, 200, { people: await permissions.searchMembers(q.people) });
    }
    throw new HttpError(400, 'What should be listed?');
  },

  async POST(req, res) {
    const user = await requireUser(req);
    const q = getQuery(req);
    const body = await readJson(req);
    switch (q.action) {
      case 'create-calendar':
        return sendJson(res, 201, await calendars.createCalendar(user, body));
      case 'update-calendar':
        return sendJson(res, 200, await calendars.updateCalendar(user, q.id, body));
      case 'archive':
        return sendJson(res, 200, await calendars.archiveCalendar(user, q.id, body.archived));
      case 'delete-calendar':
        return sendJson(res, 200, await calendars.deleteCalendar(user, q.id));
      case 'create-event':
        return sendJson(res, 201, await calendars.createEvent(user, body));
      case 'update-event':
        return sendJson(res, 200, await calendars.updateEvent(user, q.id, body, scopeOf(q)));
      case 'delete-event':
        return sendJson(res, 200, await calendars.deleteEvent(user, q.id, scopeOf(q)));
      case 'rsvp':
        return sendJson(res, 200, await calendars.rsvp(user, q.id, q.at, body.answer));
      case 'save-prefs':
        return sendJson(res, 200, await calendars.savePrefs(user, body));
      case 'show':
        return sendJson(res, 200, await calendars.setShown(user, q.id, body.on));
      case 'invites':
        return sendJson(res, 200, await invites.setInvites(user, q.id, body));
      case 'send-invites':
        return sendJson(
          res,
          200,
          await invites.sendInvites(user, q.id, {
            again: Boolean(body && body.again),
            site: siteUrl(req),
          })
        );
      case 'my-reminders':
        return sendJson(res, 200, await calendars.setEventPrefs(user, q.id, body));
      case 'regenerate-feed':
        return sendJson(res, 200, await calendars.regenerateFeed(user));
      default:
        throw new HttpError(400, 'Unknown action');
    }
  },
});
