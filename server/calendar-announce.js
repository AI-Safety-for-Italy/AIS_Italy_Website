// One-off announcements of an occurrence in a Discord channel, apart from the
// lead times its calendar or the event set (calendar-reminders.js):
//   now        "Announce now" on the event's card, posted at once;
//   planned    at a day and time chosen, posted by the reminders' job
//              (calendar-reminders.run calls sendDue) once due.
// Whoever edits the event makes them, and for a poll's meeting whoever tunes
// it. Each is a row of calendar_announcements, tied to one occurrence: its
// outcome is written before posting, so none goes twice. A planned one whose
// occurrence was skipped, or is over, is left out (outcome 'skipped').

const db = require('./db');
const { HttpError } = require('./http');
const calendars = require('./calendars');
const discord = require('./calendar-discord');
const timeOf = require('./calendar-expand');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A planned one is sent within this long of its time, as the reminders.
const WINDOW_MS = 30 * 60 * 1000;
// "Announce now" in the same channel, for the same occurrence: once a while.
const AGAIN_MS = 5 * 60 * 1000;
const MAX_PLANNED = 10;

const headOf = (event) => event.series_id || event.id;

/**
 * The occurrence of the event `headId` (a series or a single event) that
 * starts at `at` in its series, as it stands now: changed on its own, moved
 * with its series or skipped. Null when it no longer happens.
 */
async function occurrenceOf(headId, at) {
  const ms = new Date(at).getTime();
  const { rows } = await db.query(
    'select * from calendar_events where id = $1 or (series_id = $1 and recurrence_id = $2)',
    [headId, new Date(ms)]
  );
  const head = rows.find((r) => r.id === headId);
  if (!head) return null;
  const changed = rows.find((r) => r.series_id === headId);
  const whole = (e, occurrenceStart) => ({
    event: e,
    start: new Date(e.starts_at),
    end: new Date(e.ends_at),
    occurrenceStart,
  });
  if (changed) return whole(changed, new Date(ms));
  // A single event: wherever it was moved since.
  if (!head.recurrence) return whole(head, new Date(head.starts_at));
  if ((head.exdates || []).some((x) => new Date(x).getTime() === ms)) return null;
  if (!timeOf.seriesStarts(head, ms, ms + 1).some((x) => x.at === ms)) return null;
  const length = new Date(head.ends_at) - new Date(head.starts_at);
  return {
    event: head,
    start: new Date(ms),
    end: new Date(ms + length),
    occurrenceStart: new Date(ms),
  };
}

/** The event and occurrence asked for, if `user` may announce it. */
async function forAnnouncing(user, id, occurrence) {
  const who = await calendars.whoIs(user);
  const { event, cal } = await calendars.eventFor(id, who, 'edit', { pollMeeting: true });
  if (cal.archived_at) throw new HttpError(409, 'This calendar is archived');
  const picked = calendars.pickOccurrence(event, occurrence);
  return { event, cal, head: headOf(event), occurrenceStart: picked.occurrenceStart, picked };
}

/** A text channel the bot may write in, as Discord names it now. */
async function channelFor(channelId) {
  const { text } = await discord.channels();
  const c = text.find((x) => x.id === String(channelId || ''));
  if (!c) throw new HttpError(400, 'Choose a Discord channel');
  if (c.canPost === false)
    throw new HttpError(400, `The bot can’t write in #${c.name}: add it to the channel on Discord`);
  return c;
}

/** The text of the announcement, `now`: how long before it starts, as the reminders say it. */
function textOf(occ, cal, now, site) {
  const { message } = require('./calendar-reminders');
  const minutes = Math.max(0, Math.round((occ.start.getTime() - now) / 60000));
  return message(occ, cal, minutes, site).discordText;
}

async function post(occ, cal, channelId, now, site) {
  const { buttonsFor } = require('./calendar-reminders');
  return discord.post(channelId, textOf(occ, cal, now, site), { components: buttonsFor(occ) });
}

/** Posts the announcement of an occurrence in a channel, now. Returns the card's detail. */
async function announceNow(user, id, { occurrence, channelId } = {}, { site } = {}) {
  await require('./permissions').refreshIfStale(user);
  const { cal, head, occurrenceStart, picked } = await forAnnouncing(user, id, occurrence);
  const now = Date.now();
  if (picked.end.getTime() <= now) throw new HttpError(409, 'This event is over');
  const channel = await channelFor(channelId);
  const { rows: recent } = await db.query(
    `select 1 from calendar_announcements
     where event_id = $1 and occurrence_start = $2 and channel_id = $3
       and outcome = 'sent' and handled_at > $4`,
    [head, occurrenceStart, channel.id, new Date(now - AGAIN_MS)]
  );
  if (recent.length) throw new HttpError(429, `Already announced in #${channel.name} a moment ago`);
  const occ = await occurrenceOf(head, occurrenceStart);
  if (!occ) throw new HttpError(404, 'This event does not happen then');
  const sent = await post(occ, cal, channel.id, now, site);
  await db.query(
    `insert into calendar_announcements (event_id, occurrence_start, channel_id, channel_name,
       send_at, outcome, handled_at, created_by)
     values ($1, $2, $3, $4, now(), $5, now(), $6)`,
    [head, occurrenceStart, channel.id, channel.name, sent.sent ? 'sent' : 'failed', user.id]
  );
  if (!sent.sent)
    throw new HttpError(502, `Discord did not take it: ${sent.detail || 'try again'}`);
  return calendars.getEvent(user, id, occurrence);
}

/** Plans an announcement of an occurrence in a channel, at `sendAt`. Returns the card's detail. */
async function plan(user, id, { occurrence, channelId, sendAt } = {}) {
  await require('./permissions').refreshIfStale(user);
  const { head, occurrenceStart, picked } = await forAnnouncing(user, id, occurrence);
  const at = new Date(sendAt);
  if (typeof sendAt !== 'string' || Number.isNaN(at.getTime()))
    throw new HttpError(400, 'Choose a day and time');
  if (at.getTime() < Date.now() - 60000) throw new HttpError(400, 'That time has passed');
  if (at.getTime() >= picked.end.getTime())
    throw new HttpError(400, 'Choose a time before the event ends');
  const channel = await channelFor(channelId);
  const { rows: pending } = await db.query(
    `select count(*)::int as n from calendar_announcements
     where event_id = $1 and occurrence_start = $2 and outcome is null`,
    [head, occurrenceStart]
  );
  if (pending[0].n >= MAX_PLANNED)
    throw new HttpError(400, `At most ${MAX_PLANNED} planned announcements for one event`);
  await db.query(
    `insert into calendar_announcements (event_id, occurrence_start, channel_id, channel_name,
       send_at, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [head, occurrenceStart, channel.id, channel.name, at, user.id]
  );
  return calendars.getEvent(user, id, occurrence);
}

/** Removes a planned announcement not sent yet. Returns the card's detail. */
async function cancel(user, plannedId) {
  if (!UUID.test(String(plannedId || ''))) throw new HttpError(404, 'Announcement not found');
  const { rows } = await db.query('select * from calendar_announcements where id = $1', [
    plannedId,
  ]);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Announcement not found');
  // Who may announce the series (or the single event) may take it back.
  const who = await calendars.whoIs(user);
  await calendars.eventFor(row.event_id, who, 'edit', { pollMeeting: true });
  const { rows: gone } = await db.query(
    'delete from calendar_announcements where id = $1 and outcome is null returning id',
    [plannedId]
  );
  if (!gone.length) throw new HttpError(409, 'It has already gone out');
  const occ = await occurrenceOf(row.event_id, row.occurrence_start);
  if (!occ) return { deleted: true };
  return calendars.getEvent(user, occ.event.id, occ.occurrenceStart.toISOString());
}

/**
 * For the card of an occurrence, to whoever may announce it: the channels it
 * is announced in by its lead times (to offer first), and its one-off
 * announcements, [{ id, channelId, name, sendAt, status }] — status
 * 'planned', 'sent', 'failed', 'skipped' or 'missed' (its job ran too late).
 */
async function listFor(event, cal, occurrenceStart) {
  const head = headOf(event);
  const { rows } = await db.query(
    `select * from calendar_announcements
     where event_id = $1 and ($3 or occurrence_start = $2)
     order by send_at`,
    [head, occurrenceStart, !event.recurrence && !event.series_id]
  );
  const now = Date.now();
  const channels =
    event.announce === null || event.announce === undefined ? cal.announce || [] : event.announce;
  return {
    channels: channels.map((c) => ({ channelId: c.channelId, name: c.name })),
    list: rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      name: r.channel_name,
      sendAt: new Date(r.send_at).toISOString(),
      status: r.outcome || (new Date(r.send_at).getTime() < now - WINDOW_MS ? 'missed' : 'planned'),
    })),
  };
}

/** Posts the planned announcements due at `now`: how many went. */
async function sendDue({ now = new Date(), site }) {
  const nowMs = new Date(now).getTime();
  const { rows } = await db.query(
    `select * from calendar_announcements
     where outcome is null and send_at <= $1 and send_at > $2 order by send_at`,
    [new Date(nowMs), new Date(nowMs - WINDOW_MS)]
  );
  let n = 0;
  for (const row of rows) {
    const occ = await occurrenceOf(row.event_id, row.occurrence_start);
    const { rows: calRows } = occ
      ? await db.query('select * from calendars where id = $1', [occ.event.calendar_id])
      : { rows: [] };
    const cal = calRows[0];
    const live = occ && cal && !cal.archived_at && occ.end.getTime() > nowMs;
    // Claimed before posting: two jobs never both send it.
    const { rows: claimed } = await db.query(
      `update calendar_announcements set outcome = $2, handled_at = now()
       where id = $1 and outcome is null returning id`,
      [row.id, live ? 'sent' : 'skipped']
    );
    if (!claimed.length || !live) continue;
    const sent = await post(occ, cal, row.channel_id, nowMs, site);
    if (sent.sent) n++;
    else
      await db.query(`update calendar_announcements set outcome = 'failed' where id = $1`, [
        row.id,
      ]);
  }
  return n;
}

module.exports = { announceNow, plan, cancel, listFor, sendDue, occurrenceOf };
