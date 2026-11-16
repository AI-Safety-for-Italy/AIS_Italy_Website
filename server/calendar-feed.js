// The .ics feeds of the calendar (server/calendars.js): a member's personal
// link and each public calendar's, which Google, Outlook and Apple calendars
// subscribe to and read again on their own every few hours.
//
// Each event is one VEVENT, its UID fixed by its id, so a later read replaces
// it. A repeating one carries its RRULE and the starts it skips (EXDATE),
// written in its own time zone with a matching VTIMEZONE; an occurrence
// changed on its own is a VEVENT of the same UID with a RECURRENCE-ID. An
// all-day event is written with dates (VALUE=DATE). Text helpers: ics.js.

const ics = require('./ics');
const recurrence = require('./recurrence');
const discord = require('./calendar-discord');

const dateStamp = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');

/** DTSTART/DTEND-style property for an instant of `event`. */
function timeProp(name, at, event) {
  if (event.all_day) return `${name};VALUE=DATE:${dateStamp(at)}`;
  if (event.recurrence || event.series_id) {
    return `${name};TZID=${event.timezone}:${recurrence.localStamp(at, event.timezone)}`;
  }
  return `${name}:${ics.stamp(at)}`;
}

/** The RRULE of a series; dates only for an all-day one. */
function rrule(event) {
  if (!event.all_day) return recurrence.rrule(event.recurrence, event.starts_at, event.timezone);
  const rule = recurrence.rrule(event.recurrence, event.starts_at, 'UTC');
  return event.recurrence.until
    ? rule.replace(/UNTIL=\d{8}T\d{6}Z/, `UNTIL=${event.recurrence.until.replace(/-/g, '')}`)
    : rule;
}

function description(event) {
  const parts = [event.description];
  if (event.video_kind === 'link' && event.video_url) parts.push(`Video call: ${event.video_url}`);
  if (event.video_kind === 'discord' && event.discord_channel_id) {
    parts.push(
      `On Discord, #${event.discord_channel_name || 'voice'}: ${discord.channelLink(
        event.discord_channel_id
      )}`
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

function where(event) {
  if (event.location) return event.location;
  if (event.video_kind === 'link') return event.video_url;
  if (event.video_kind === 'discord') return `Discord #${event.discord_channel_name || 'voice'}`;
  return '';
}

// A poll's meeting has the UID of its emailed invite (ics.js: the poll's id),
// so whoever has both sees one meeting, not two; an occurrence of it changed
// on its own, its series'.
function uidOf(event, master) {
  const head = master || event;
  if (head.source === 'poll' && head.source_id) return head.source_id;
  return event.series_id || event.id;
}

function vevent(event, calendarName, masters) {
  const master = event.series_id ? masters.get(event.series_id) : null;
  // An occurrence changed on its own is written in its series' terms.
  const zoneOf = master || event;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uidOf(event, master)}@ais4i.it`,
    `SEQUENCE:${event.sequence || 0}`,
    `DTSTAMP:${ics.stamp(event.updated_at || new Date())}`,
  ];
  if (event.series_id) {
    lines.push(
      timeProp('RECURRENCE-ID', event.recurrence_id, {
        ...zoneOf,
        recurrence: zoneOf.recurrence || {},
      })
    );
  }
  const asSeries = { ...event, timezone: zoneOf.timezone, all_day: event.all_day };
  lines.push(timeProp('DTSTART', event.starts_at, asSeries));
  lines.push(timeProp('DTEND', event.ends_at, asSeries));
  if (event.recurrence && !event.series_id) {
    lines.push(`RRULE:${rrule(event)}`);
    const skipped = event.exdates || [];
    if (skipped.length) {
      lines.push(
        event.all_day
          ? `EXDATE;VALUE=DATE:${skipped.map(dateStamp).join(',')}`
          : `EXDATE;TZID=${event.timezone}:${skipped
              .map((x) => recurrence.localStamp(x, event.timezone))
              .join(',')}`
      );
    }
  }
  lines.push(`SUMMARY:${ics.escapeText(event.title)}`);
  const text = description(event);
  if (text) lines.push(`DESCRIPTION:${ics.escapeText(text)}`);
  const place = where(event);
  if (place) lines.push(`LOCATION:${ics.escapeText(place)}`);
  if (event.video_kind === 'link' && event.video_url) lines.push(`URL:${event.video_url}`);
  if (calendarName) lines.push(`CATEGORIES:${ics.escapeText(calendarName)}`);
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  return lines;
}

/**
 * The feed: { name, calendars: [rows], events: [rows of calendar_events] }
 * (calendars.personalFeed, calendars.publicFeed) as an .ics file.
 */
function build(feed) {
  const names = new Map(feed.calendars.map((c) => [c.id, c.name]));
  const masters = new Map(feed.events.filter((e) => e.recurrence).map((e) => [e.id, e]));
  // A changed occurrence whose series is not in the feed has nothing to replace.
  const events = feed.events.filter((e) => !e.series_id || masters.has(e.series_id));
  // One VTIMEZONE per zone a series is written in, from its earliest start.
  const zones = new Map();
  events
    .filter((e) => !e.all_day && (e.recurrence || e.series_id))
    .forEach((e) => {
      const master = e.series_id ? masters.get(e.series_id) : e;
      const tz = master.timezone;
      const start = new Date(master.starts_at);
      if (!zones.has(tz) || zones.get(tz) > start) zones.set(tz, start);
    });
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Safety for Italy//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${ics.escapeText(feed.name)}`,
    'X-WR-TIMEZONE:Europe/Rome',
    // Asked for, not promised: Google reads a feed again every 12-24 hours.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  zones.forEach((start, tz) => lines.push(...recurrence.vtimezone(tz, start)));
  events.forEach((e) =>
    lines.push(...vevent(e, feed.calendars.length > 1 ? names.get(e.calendar_id) : null, masters))
  );
  lines.push('END:VCALENDAR');
  return lines.map(ics.fold).join('\r\n') + '\r\n';
}

module.exports = { build };
