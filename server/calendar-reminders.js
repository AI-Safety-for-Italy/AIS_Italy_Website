// The calendar's reminders and announcements, sent by a job every few minutes
// (api/cron/cleanup.js?job=reminders, from .github/workflows/calendar-reminders.yml).
//
// Whoever writes an event chooses its reminders: how long before, on Discord
// and/or by email. They reach the members who turned notifications on for its
// calendar (calendar_prefs, calendars.choiceFor) and still see it, and anyone
// who answered going or maybe. Apart from those, the event is announced in the
// Discord channels its calendar names (or the ones it names itself), each at
// its own lead times.
//
// A reminder is due once its time has come, within WINDOW of it: a job that
// runs late still sends it, one far too late does not. calendar_reminders_sent
// is written before sending, so no reminder goes twice, even with two jobs.

const db = require('./db');
const mail = require('./mail');
const notify = require('./notify');
const calendars = require('./calendars');
const discord = require('./calendar-discord');
const timeOf = require('./calendar-expand');

const WINDOW_MS = 30 * 60 * 1000;
const MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** "1 day", "2 hours", "15 minutes", "now". */
function leadText(minutes) {
  if (minutes === 0) return 'now';
  if (minutes % 1440 === 0) return minutes === 1440 ? 'in 1 day' : `in ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'in 1 hour' : `in ${minutes / 60} hours`;
  return `in ${minutes} minutes`;
}

/** When, in Italian time: "Tuesday 27 October, 18:30–20:00 (Rome time)". */
function whenText(occ) {
  const e = occ.event;
  if (e.all_day) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(occ.start);
  }
  const tz = 'Europe/Rome';
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(occ.start);
  const time = (d) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  return `${day}, ${time(occ.start)}–${time(occ.end)} (Rome time)`;
}

function joinLink(e) {
  if (e.video_kind === 'link' && e.video_url) return e.video_url;
  if (e.video_kind === 'discord' && e.discord_channel_id)
    return discord.channelLink(e.discord_channel_id);
  return null;
}

/** The message, for a person or a channel: { subject, lines, discordText }. */
function message(occ, cal, minutes, origin) {
  const e = occ.event;
  const link = `${origin}/app/calendar/?event=${encodeURIComponent(e.id)}&at=${encodeURIComponent(
    occ.occurrenceStart.toISOString()
  )}`;
  const join = joinLink(e);
  const lead = leadText(minutes);
  const subject = `${minutes === 0 ? 'Starting now' : `Reminder, ${lead}`}: ${e.title}`;
  const lines = [
    `“${e.title}” (${cal.name}) ${minutes === 0 ? 'starts now' : `starts ${lead}`}: ${whenText(
      occ
    )}.` + (e.location ? `\nWhere: ${e.location}` : ''),
    join
      ? { label: e.video_kind === 'discord' ? 'Join on Discord' : 'Join the call', link: join }
      : null,
    { label: 'Open in the calendar', link },
  ].filter(Boolean);
  const discordText = [
    `📅 **${e.title}** ${minutes === 0 ? 'starts now' : `starts ${lead}`} · ${cal.name}`,
    whenText(occ) + (e.location ? ` · ${e.location}` : ''),
    join ? (e.video_kind === 'discord' ? `🔊 <#${e.discord_channel_id}>` : `🔗 ${join}`) : null,
    link,
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, lines, discordText };
}

/** Writes that this went out; false when it already had. */
async function claim(occ, minutes, { userId = null, channelId = null }) {
  const { rows } = await db.query(
    `insert into calendar_reminders_sent (event_id, occurrence_start, minutes, user_id, channel_id)
     values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
    [occ.event.id, occ.occurrenceStart, minutes, userId, channelId]
  );
  return rows.length > 0;
}

/**
 * Who is reminded of an occurrence: the members with notifications on for its
 * calendar who still see it, and those who answered going or maybe.
 * [{ id, kind, discord_id, email, notify_email }]
 */
async function recipients(occ, cal, followers) {
  const out = new Map();
  for (const f of followers) {
    const who = await calendars.whoIs(f.user);
    const level = calendars.levelOf(cal, who);
    if (level && calendars.choiceFor(f.prefs, cal).notify) out.set(f.row.id, f.row);
  }
  const { rows } = await db.query(
    `select u.* from calendar_rsvps r join app_users u on u.id = r.user_id
     where r.event_id = $1 and r.occurrence_start = $2 and r.answer in ('yes', 'maybe')`,
    [occ.event.id, occ.occurrenceStart]
  );
  rows.forEach((u) => out.set(u.id, u));
  return [...out.values()];
}

/** Sends one reminder to one person, on the channels the event chose. */
async function remind(person, msg, channels) {
  const used = [];
  if (channels.includes('discord') && person.discord_id && notify.discordAvailable()) {
    try {
      await notify.discordDm(
        person.discord_id,
        `**${msg.subject}**\n\n${notify.render(msg.lines).text}`.slice(0, 1900)
      );
      used.push('discord');
    } catch (err) {
      console.error('Calendar reminder on Discord failed:', err.message);
    }
  }
  const address = person.notify_email || person.email;
  if (channels.includes('email') && address && (await mail.isConfigured())) {
    try {
      await mail.send({ to: address, subject: msg.subject, ...notify.render(msg.lines) });
      used.push('email');
    } catch (err) {
      console.error('Calendar reminder by email failed:', err.message);
    }
  }
  return used;
}

/**
 * Sends what is due at `now`. Returns { reminders, announcements }, the
 * number sent of each.
 */
async function run({ now = new Date(), origin } = {}) {
  const site = (origin || process.env.SITE_URL || 'https://www.ais4i.it').replace(/\/+$/, '');
  const nowMs = new Date(now).getTime();
  const from = new Date(nowMs - WINDOW_MS);
  const to = new Date(nowMs + MAX_LEAD_MS + WINDOW_MS);
  const { rows: cals } = await db.query('select * from calendars where archived_at is null');
  if (!cals.length) return { reminders: 0, announcements: 0 };
  const byId = new Map(cals.map((c) => [c.id, c]));
  const { rows } = await db.query(
    `select * from calendar_events where calendar_id = any($1::uuid[])
       and starts_at < $3 and (recurrence is not null or ends_at > $2)`,
    [[...byId.keys()], from, to]
  );
  const series = rows.filter((r) => r.recurrence).map((r) => r.id);
  const overrides = series.length
    ? (
        await db.query(
          'select series_id, recurrence_id from calendar_events where series_id = any($1::uuid[])',
          [series]
        )
      ).rows
    : [];
  const due = (startMs, minutes) => {
    const at = startMs - minutes * 60000;
    return at <= nowMs && at > nowMs - WINDOW_MS;
  };

  // The members who may want reminders: those with notifications on.
  const { rows: prefRows } = await db.query(
    `select p.*, u.id as uid, u.kind from calendar_prefs p join app_users u on u.id = p.user_id
     where p.notify or p.advanced`
  );
  const { rows: users } = prefRows.length
    ? await db.query('select * from app_users where id = any($1::uuid[])', [
        prefRows.map((p) => p.uid),
      ])
    : { rows: [] };
  const userRows = new Map(users.map((u) => [u.id, u]));
  const followers = prefRows
    .filter((p) => userRows.has(p.uid))
    .map((p) => ({
      prefs: p,
      user: { id: p.uid, kind: p.kind },
      row: userRows.get(p.uid),
    }));

  let reminders = 0;
  let announcements = 0;
  for (const occ of timeOf.expand(rows, from, to, overrides)) {
    const e = occ.event;
    const cal = byId.get(e.calendar_id);
    const startMs = occ.start.getTime();
    for (const r of e.reminders || []) {
      if (!due(startMs, r.minutes)) continue;
      const msg = message(occ, cal, r.minutes, site);
      for (const person of await recipients(occ, cal, followers)) {
        if (!(await claim(occ, r.minutes, { userId: person.id }))) continue;
        if ((await remind(person, msg, r.channels)).length) reminders++;
      }
    }
    const channels = e.announce === null || e.announce === undefined ? cal.announce : e.announce;
    for (const c of channels || []) {
      for (const minutes of c.minutes || []) {
        if (!due(startMs, minutes)) continue;
        if (!(await claim(occ, minutes, { channelId: c.channelId }))) continue;
        const sent = await discord.post(c.channelId, message(occ, cal, minutes, site).discordText);
        if (sent.sent) announcements++;
      }
    }
  }
  return { reminders, announcements };
}

module.exports = { run, message, leadText };
