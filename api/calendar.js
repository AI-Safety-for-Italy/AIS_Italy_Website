// /api/calendar: what the calendar (server/calendars.js) shows outside the
// personal area, signed in or not.
//   GET ?feed=<token>               -> a member's personal .ics (the calendars
//                                      they chose, among those they still see)
//   GET ?public=<slug>              -> a public calendar's .ics
//   GET ?list=1                     -> { calendars } the public calendars
//   GET ?from=…&to=…[&calendar=slug] -> { events } of the public calendars
// vercel.json serves the feeds as /calendar/feed/<token>.ics and
// /calendar/<slug>.ics, the addresses people subscribe to.
const { route, sendJson, getQuery, HttpError } = require('../server/http');
const calendars = require('../server/calendars');
const feed = require('../server/calendar-feed');

function sendIcs(res, data, { personal }) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="calendar.ics"');
  // A personal feed is nobody else's: never kept by a shared cache.
  res.setHeader(
    'Cache-Control',
    personal ? 'private, max-age=300' : 'public, max-age=300, s-maxage=300'
  );
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(feed.build(data));
}

module.exports = route({
  async GET(req, res) {
    const q = getQuery(req);
    if (q.feed !== undefined) {
      const data = await calendars.personalFeed(String(q.feed).replace(/\.ics$/, ''));
      if (!data) throw new HttpError(404, 'This calendar link no longer works');
      return sendIcs(res, data, { personal: true });
    }
    if (q.public !== undefined) {
      const data = await calendars.publicFeed(String(q.public).replace(/\.ics$/, ''));
      if (!data) throw new HttpError(404, 'No such public calendar');
      return sendIcs(res, data, { personal: false });
    }
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
    if (q.list) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ calendars: await calendars.publicCalendars() }));
    }
    if (q.from && q.to) {
      const data = await calendars.publicEvents(q);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(data));
    }
    sendJson(res, 400, { error: 'What should be shown?' });
  },
});
