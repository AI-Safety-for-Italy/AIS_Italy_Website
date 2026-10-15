// Recurring meetings.
//
// A poll may say its meeting repeats: { freq: 'weekly' | 'monthly',
// interval: 1-12, until: 'YYYY-MM-DD' | null, count: 1-200 | null }. People
// vote for the first occurrence; once the time is chosen the series follows
// it — the same weekday every `interval` weeks, or the same weekday position
// in the month ("2nd Tuesday", "last Tuesday") every `interval` months.
//
// The calendar invitation then carries an RRULE, and its times are written in
// the poll's time zone with a matching VTIMEZONE, so the meeting stays at the
// same local time across daylight-saving changes.

const { HttpError } = require('./http');

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The validated recurrence from a request body, or null for none. */
function validate(value) {
  if (!value || !value.freq || value.freq === 'none') return null;
  if (!['weekly', 'monthly'].includes(value.freq)) {
    throw new HttpError(400, 'A meeting repeats weekly or monthly');
  }
  const interval =
    value.interval === undefined || value.interval === null || value.interval === ''
      ? 1
      : Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) {
    throw new HttpError(400, 'Repeat every 1 to 12 weeks or months');
  }
  let until = null;
  let count = null;
  if (value.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.until) || Number.isNaN(Date.parse(value.until))) {
      throw new HttpError(400, 'The end date is not valid');
    }
    until = value.until;
  } else if (value.count) {
    count = Number(value.count);
    if (!Number.isInteger(count) || count < 2 || count > 200) {
      throw new HttpError(400, 'A series has 2 to 200 meetings');
    }
  }
  return { freq: value.freq, interval, until, count };
}

// ── Wall-clock time in a zone ───────────────────────────────────────────────

const formatters = {};
function wall(date, tz) {
  if (!formatters[tz]) {
    formatters[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  }
  const p = {};
  for (const part of formatters[tz].formatToParts(date)) p[part.type] = part.value;
  return {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    h: +p.hour % 24,
    min: +p.minute,
    s: +p.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "20261027T090000": the local time in `tz`, for DTSTART;TZID=… */
function localStamp(date, tz) {
  const w = wall(new Date(date), tz);
  return `${w.y}${pad(w.m)}${pad(w.d)}T${pad(w.h)}${pad(w.min)}${pad(w.s)}`;
}

/** Minutes east of UTC that `tz` is at `date`. */
function offsetMinutes(date, tz) {
  const ms = new Date(date).getTime();
  const w = wall(new Date(ms), tz);
  return Math.round(
    (Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000) / 60000
  );
}

// ── RRULE ───────────────────────────────────────────────────────────────────

/** Which occurrence of its weekday a day is in its month: 1-4, or -1 for the 5th (last). */
function weekOfMonth(day) {
  const n = Math.ceil(day / 7);
  return n === 5 ? -1 : n;
}

/** The RRULE value for a recurrence starting at `start` (a Date) in `tz`. */
function rrule(rec, start, tz) {
  const w = wall(new Date(start), tz);
  const day = DAYS[w.weekday];
  const parts = [`FREQ=${rec.freq === 'weekly' ? 'WEEKLY' : 'MONTHLY'}`];
  if (rec.interval > 1) parts.push(`INTERVAL=${rec.interval}`);
  parts.push(rec.freq === 'weekly' ? `BYDAY=${day}` : `BYDAY=${weekOfMonth(w.d)}${day}`);
  if (rec.until) {
    // The whole end day counts: up to its last second in the meeting's zone.
    const [y, m, d] = rec.until.split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59) - offsetMinutes(start, tz) * 60000);
    parts.push(
      `UNTIL=${end
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')}`
    );
  } else if (rec.count) {
    parts.push(`COUNT=${rec.count}`);
  }
  return parts.join(';');
}

// ── VTIMEZONE ───────────────────────────────────────────────────────────────

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Instants where `tz` changes offset between `from` and `to` (Dates). */
function transitions(tz, from, to) {
  const DAY = 86400000;
  const found = [];
  let prev = offsetMinutes(from, tz);
  for (let t = from.getTime() + DAY; t <= to.getTime(); t += DAY) {
    const now = offsetMinutes(new Date(t), tz);
    if (now !== prev) {
      // Narrow it down to the minute.
      let lo = t - DAY;
      let hi = t;
      while (hi - lo > 60000) {
        const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
        if (offsetMinutes(new Date(mid), tz) === prev) lo = mid;
        else hi = mid;
      }
      found.push({ at: new Date(hi), from: prev, to: now });
      prev = now;
    }
  }
  return found;
}

/**
 * A VTIMEZONE for `tz`, covering the years a series starting at `start` may
 * reach. Changes are listed as dates (RDATE), which describes any zone without
 * needing its rules.
 */
function vtimezone(tz, start) {
  const begin = new Date(Date.UTC(new Date(start).getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(begin.getUTCFullYear() + 10, 11, 31));
  const changes = transitions(tz, begin, end);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (!changes.length) {
    const off = formatOffset(offsetMinutes(begin, tz));
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${off}`,
      `TZOFFSETTO:${off}`,
      'END:STANDARD'
    );
  } else {
    // Group the changes by kind (into or out of daylight time).
    const groups = new Map();
    for (const c of changes) {
      const key = `${c.from}>${c.to}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const list of groups.values()) {
      const { from, to } = list[0];
      // DTSTART/RDATE are the local time just before the change.
      const local = (c) => {
        const t = new Date(c.at.getTime() + c.from * 60000);
        return t
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}Z/, '');
      };
      const kind = to > from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${local(list[0])}`,
        `TZOFFSETFROM:${formatOffset(from)}`,
        `TZOFFSETTO:${formatOffset(to)}`
      );
      if (list.length > 1) lines.push(`RDATE:${list.slice(1).map(local).join(',')}`);
      lines.push(`END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ── Words ───────────────────────────────────────────────────────────────────

const IT_DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const IT_ORD = { 1: 'primo', 2: 'secondo', 3: 'terzo', 4: 'quarto', '-1': 'ultimo' };

/** "ogni martedì", "ogni 2 settimane, il martedì", "il secondo martedì di ogni mese"… (Italian, for emails). */
function describeIt(rec, start, tz) {
  const w = wall(new Date(start), tz);
  const day = IT_DAYS[w.weekday];
  if (rec.freq === 'weekly') {
    return rec.interval === 1 ? `ogni ${day}` : `ogni ${rec.interval} settimane, il ${day}`;
  }
  const n = weekOfMonth(w.d);
  const which = `${n === -1 ? "l'" : 'il '}${IT_ORD[n]} ${day}`;
  return rec.interval === 1 ? `${which} di ogni mese` : `${which}, ogni ${rec.interval} mesi`;
}

/** ", fino al 15 dicembre 2026", ", per 8 volte", or "" for a series with no end. */
function describeEndIt(rec) {
  if (rec.until) {
    const [y, m, d] = rec.until.split('-').map(Number);
    const end = new Intl.DateTimeFormat('it-IT', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
    return `, fino al ${end}`;
  }
  return rec.count ? `, per ${rec.count} volte` : '';
}

module.exports = {
  validate,
  rrule,
  vtimezone,
  localStamp,
  describeIt,
  describeEndIt,
  offsetMinutes,
};
