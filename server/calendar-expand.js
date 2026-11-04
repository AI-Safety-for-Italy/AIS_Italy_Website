// The occurrences of the calendar's events (server/calendars.js) within a
// range of time. Pure: rows in, occurrences out, no database.
//
// A repeating event (recurrence.js: daily, weekly or monthly) keeps its local
// time in its own time zone across daylight-saving changes, as the RRULE of
// its .ics does. An all-day event is reckoned in dates (its times are the
// midnights, UTC, of its first day and of the day after its last). The starts
// a series skips are its `exdates`; an occurrence changed on its own is a row
// of its own (series_id, recurrence_id) and takes the place of the start it
// replaces.

const recurrence = require('./recurrence');

const DAY = 86400000;
// However long a series, no range lists more than this many of its occurrences.
const MAX_OCCURRENCES = 1000;

/** UTC milliseconds of a wall-clock time in `tz`. */
function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - recurrence.offsetMinutes(new Date(guess), tz) * 60000;
  // Twice, so times next to a daylight-saving change settle.
  return guess - recurrence.offsetMinutes(new Date(first), tz) * 60000;
}

/** The days in a month (m: 1-12). */
function daysIn(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The day of the month of the `k`th (1-4, or -1 for the last) `weekday` (0 Sunday). */
function nthWeekday(y, m, weekday, k) {
  if (k === -1) {
    const last = daysIn(y, m);
    const lastWeekday = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
    return last - ((lastWeekday - weekday + 7) % 7);
  }
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstWeekday + 7) % 7) + (k - 1) * 7;
}

/** The zone an event's times are reckoned in: its own, or UTC for an all-day one. */
function zoneOf(event) {
  return event.all_day ? 'UTC' : event.timezone || 'Europe/Rome';
}

/** The last instant a series may start at: the end of its `until` day, in its zone. */
function untilEnd(rec, tz) {
  if (!rec || !rec.until) return Infinity;
  const [y, m, d] = rec.until.split('-').map(Number);
  return zonedToUtc(y, m, d, 23, 59, tz) + 59999;
}

/**
 * The starts (UTC milliseconds) of a series' occurrences that overlap
 * [from, to), skipped ones (exdates) included: the caller drops those.
 * `index` of each is its place in the series, from 0.
 */
function seriesStarts(event, from, to) {
  const rec = event.recurrence;
  const start = new Date(event.starts_at).getTime();
  const length = new Date(event.ends_at).getTime() - start;
  const tz = zoneOf(event);
  const w = recurrence.wall(new Date(start), tz);
  const last = untilEnd(rec, tz);
  const interval = rec.interval || 1;
  const out = [];

  // A daily or weekly series without a count can begin near `from`, rather
  // than walk from its first occurrence.
  let n = 0;
  if (!rec.count && rec.freq !== 'monthly') {
    const period = (rec.freq === 'daily' ? 1 : 7) * interval * DAY;
    n = Math.max(0, Math.floor((from - length - start) / period) - 1);
  }
  const k = recurrence.weekOfMonth(w.d);
  for (let guard = 0; guard < 50000; guard++, n++) {
    if (rec.count && n >= rec.count) break;
    let y = w.y;
    let m = w.m;
    let d = w.d;
    if (rec.freq === 'monthly') {
      const months = w.m - 1 + n * interval;
      y = w.y + Math.floor(months / 12);
      m = (months % 12) + 1;
      d = nthWeekday(y, m, w.weekday, k);
    } else {
      const days = n * interval * (rec.freq === 'daily' ? 1 : 7);
      const dt = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
      y = dt.getUTCFullYear();
      m = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
    }
    const at = zonedToUtc(y, m, d, w.h, w.min, tz);
    if (at > last || at >= to) break;
    if (at + length > from) out.push({ at, index: n });
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

/** An event row as one occurrence starting at `at` (milliseconds). */
function occurrence(event, at, extra) {
  const length = new Date(event.ends_at).getTime() - new Date(event.starts_at).getTime();
  return {
    event,
    start: new Date(at),
    end: new Date(at + length),
    occurrenceStart: new Date(at),
    ...extra,
  };
}

/**
 * The occurrences of `events` (rows of calendar_events: single events, series
 * and their changed occurrences) overlapping [from, to), sorted by start.
 * `overrides`: every changed occurrence of these series, even those moved out
 * of the range, as [{ series_id, recurrence_id }], so the start they replace
 * is left out. Each occurrence is { event, start, end, occurrenceStart,
 * recurring }: occurrenceStart is the start in the series it stands for.
 */
function expand(events, from, to, overrides = []) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const replaced = new Set(
    overrides
      .concat(events.filter((e) => e.series_id))
      .map((o) => `${o.series_id}|${new Date(o.recurrence_id).getTime()}`)
  );
  const out = [];
  for (const event of events) {
    if (event.series_id) {
      const s = new Date(event.starts_at).getTime();
      const e = new Date(event.ends_at).getTime();
      if (s < toMs && e > fromMs) {
        out.push(
          occurrence(event, s, {
            occurrenceStart: new Date(event.recurrence_id),
            recurring: true,
          })
        );
      }
      continue;
    }
    if (!event.recurrence) {
      const s = new Date(event.starts_at).getTime();
      const e = new Date(event.ends_at).getTime();
      if (s < toMs && e > fromMs) out.push(occurrence(event, s, { recurring: false }));
      continue;
    }
    const skipped = new Set((event.exdates || []).map((x) => new Date(x).getTime()));
    for (const { at } of seriesStarts(event, fromMs, toMs)) {
      if (skipped.has(at) || replaced.has(`${event.id}|${at}`)) continue;
      out.push(occurrence(event, at, { recurring: true }));
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Whether a series still has occurrences after `at` (a Date). */
function continuesAfter(event, at) {
  if (!event.recurrence) return false;
  const after = new Date(at).getTime() + 1;
  return seriesStarts(event, after, Infinity).length > 0;
}

/** The local date ('YYYY-MM-DD') an instant falls on in `tz`. */
function localDate(at, tz) {
  const w = recurrence.wall(new Date(at), tz);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** The date before 'YYYY-MM-DD'. */
function dayBefore(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

module.exports = {
  expand,
  seriesStarts,
  continuesAfter,
  zonedToUtc,
  zoneOf,
  localDate,
  dayBefore,
  nthWeekday,
};
