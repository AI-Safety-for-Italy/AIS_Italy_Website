// The calendar's reminders and announcements, sent by a job every few minutes
// (api/cron/cleanup.js?job=reminders, from .github/workflows/calendar-reminders.yml).
//
// Two kinds of reminders, never mixed up:
//   the event's   chosen by whoever writes it (how long before, on Discord
//                 and/or by email), for everyone it concerns: the members who
//                 follow its calendar's reminders and still see it, those who
//                 answered going or maybe, and those invited by name who did
//                 not decline (by email, for an address that is no member).
//                 Each member may take them on a channel of their own, or not
//                 at all, for a calendar or one event.
//   one's own     chosen by a member for a calendar or one event: when, and on
//                 which channel. For them alone.
// calendars.reminderPlan works out, per member, what is due; one reminder
// of a person and lead time goes once, whichever kind asked for it. Every
// reminder carries Going / Maybe / Can't go (links by email, buttons on
// Discord: calendar-invites.js). Apart from those, the event is announced in
// the Discord channels its calendar names (or the ones it names itself), each
// at its own lead times, with the same buttons.
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
const invites = require('./calendar-invites');
const interactions = require('./discord-interactions');

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

/**
 * The message, for a person or a channel: { subject, lines, discordText }.
 * `kinds` says whose reminder it is (the event's, or the person's own), so it
 * reads as such; a `guest` (invited by address) gets no calendar link.
 */
function message(occ, cal, minutes, origin, kinds = [], { guest = false } = {}) {
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
    guest ? null : { label: 'Open in the calendar', link },
    kinds.length
      ? kinds.includes('own') && !kinds.includes('event')
        ? 'One of your own reminders (Calendar → Subscribe, or the event’s card, to change them).'
        : 'A reminder of the event, set by whoever organises it' +
          (guest ? '.' : ' (to stop them: Calendar → Subscribe, or the event’s card).')
      : null,
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

/** The buttons to answer from Discord, when Discord can send the clicks here. */
function buttonsFor(occ) {
  return interactions.configured()
    ? invites.discordButtons(occ.event.id, occ.occurrenceStart)
    : undefined;
}

/**
 * Sends one reminder to one person, on these channels: on Discord with the
 * answer buttons, by email with the answer links (`answers`).
 */
async function remind(person, msg, channels, { buttons, answers } = {}) {
  const used = [];
  if (channels.includes('discord') && person.discord_id && notify.discordAvailable()) {
    try {
      await notify.discordDm(
        person.discord_id,
        `**${msg.subject}**\n\n${notify.render(msg.lines).text}`.slice(0, 1900),
        { components: buttons }
      );
      used.push('discord');
    } catch (err) {
      console.error('Calendar reminder on Discord failed:', err.message);
    }
  }
  const address = person.notify_email || person.email;
  if (channels.includes('email') && address && (await mail.isConfigured())) {
    try {
      const lines = answers ? msg.lines.concat(notify.answerBlock(answers)) : msg.lines;
      await mail.send({ to: address, subject: msg.subject, ...notify.render(lines) });
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

  // Every member's choices: who follows which calendar, and their own reminders.
  const { rows: prefRows } = await db.query(
    `select p.*, u.id as uid, u.kind from calendar_prefs p join app_users u on u.id = p.user_id`
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

  // Each event's own choices of its members, read once.
  const heads = [...new Set(rows.map((r) => r.series_id || r.id))];
  const { rows: allEventPrefs } = heads.length
    ? await db.query('select * from calendar_event_prefs where event_id = any($1::uuid[])', [heads])
    : { rows: [] };
  const prefsByEvent = new Map();
  allEventPrefs.forEach((p) => {
    if (!prefsByEvent.has(p.event_id)) prefsByEvent.set(p.event_id, []);
    prefsByEvent.get(p.event_id).push(p);
  });

  const whoCache = new Map();
  const whoOf = async (user) => {
    if (!whoCache.has(user.id)) whoCache.set(user.id, await calendars.whoIs(user));
    return whoCache.get(user.id);
  };

  let reminders = 0;
  let announcements = 0;
  for (const occ of timeOf.expand(rows, from, to, overrides)) {
    const e = occ.event;
    const cal = byId.get(e.calendar_id);
    const startMs = occ.start.getTime();
    // Nothing of it can be due: skip the reading of who is concerned.
    const leads = new Set((e.reminders || []).map((r) => r.minutes));
    followers.forEach((f) => {
      const chosen = (f.prefs.selection || {})[cal.id];
      ((chosen && chosen.own) || []).forEach((r) => leads.add(r.minutes));
    });
    const eventPrefs = prefsByEvent.get(invites.headOf(e)) || [];
    eventPrefs.forEach((p) => (p.own || []).forEach((r) => leads.add(r.minutes)));
    if (![...leads].some((m) => due(startMs, m))) {
      announcements += await announce(occ, cal, startMs, due, site);
      continue;
    }

    const people = await concerned(occ, cal, followers, eventPrefs, whoOf);
    const buttons = buttonsFor(occ);
    for (const p of people.members) {
      const plan = calendars.reminderPlan(e, cal, p.prefs, p.eventPref, {
        attending: p.answer === 'yes' || p.answer === 'maybe' || (p.invited && !p.answer),
        declined: p.answer === 'no',
      });
      for (const item of plan) {
        if (!due(startMs, item.minutes)) continue;
        if (!(await claim(occ, item.minutes, { userId: p.row.id }))) continue;
        const msg = message(occ, cal, item.minutes, site, item.kinds);
        const answers = invites.answerLinks(site, {
          e: e.id,
          o: occ.occurrenceStart.getTime(),
          u: p.row.id,
        });
        if ((await remind(p.row, msg, item.channels, { buttons, answers })).length) reminders++;
      }
    }
    // Those invited by address, no members: the event's reminders, by email.
    for (const inv of people.guests) {
      for (const r of e.reminders || []) {
        if (!due(startMs, r.minutes)) continue;
        if (!(await claim(occ, r.minutes, { channelId: `invite:${inv.id}` }))) continue;
        const msg = message(occ, cal, r.minutes, site, ['event'], { guest: true });
        const answers = invites.answerLinks(site, { e: invites.headOf(e), i: inv.id });
        if ((await remind({ email: inv.email }, msg, ['email'], { answers })).length) reminders++;
      }
    }
    announcements += await announce(occ, cal, startMs, due, site);
  }
  return { reminders, announcements };
}

/** The announcements due in the Discord channels of an occurrence: how many went. */
async function announce(occ, cal, startMs, due, site) {
  const e = occ.event;
  let n = 0;
  const channels = e.announce === null || e.announce === undefined ? cal.announce : e.announce;
  for (const c of channels || []) {
    for (const minutes of c.minutes || []) {
      if (!due(startMs, minutes)) continue;
      if (!(await claim(occ, minutes, { channelId: c.channelId }))) continue;
      const sent = await discord.post(c.channelId, message(occ, cal, minutes, site).discordText, {
        components: buttonsFor(occ),
      });
      if (sent.sent) n++;
    }
  }
  return n;
}

/**
 * Who an occurrence concerns: { members: [{ row, prefs, eventPref, answer,
 * invited }], guests: [invite rows of addresses, not declined] }. A member
 * is concerned when they see its calendar or are invited to it.
 */
async function concerned(occ, cal, followers, eventPrefs, whoOf) {
  const e = occ.event;
  const head = invites.headOf(e);
  const { rows: answered } = await db.query(
    'select user_id, answer from calendar_rsvps where event_id = $1 and occurrence_start = $2',
    [e.id, occ.occurrenceStart]
  );
  const invited = await invites.invitesOf(head);
  const byUser = new Map();
  const ensure = async (userId) => {
    if (byUser.has(userId)) return byUser.get(userId);
    const f = followers.find((x) => x.row.id === userId);
    let row = f && f.row;
    if (!row) {
      const { rows } = await db.query('select * from app_users where id = $1', [userId]);
      row = rows[0];
    }
    if (!row) return null;
    const entry = {
      row,
      prefs: f ? f.prefs : { selection: {} },
      eventPref: eventPrefs.find((p) => p.user_id === userId) || null,
      answer: null,
      invited: false,
    };
    byUser.set(userId, entry);
    return entry;
  };
  for (const f of followers) {
    const level = calendars.levelOf(cal, await whoOf(f.user));
    if (calendars.atLeast(level, 'view')) await ensure(f.row.id);
  }
  for (const inv of invited.filter((i) => i.user_id)) {
    const p = await ensure(inv.user_id);
    if (p) {
      p.invited = true;
      p.answer = p.answer || inv.answer;
    }
  }
  for (const a of answered) {
    const p = await ensure(a.user_id);
    if (p) p.answer = a.answer;
  }
  for (const ep of eventPrefs) await ensure(ep.user_id);
  // Only those who still see the event: through its calendar or an invite.
  const members = [];
  for (const p of byUser.values()) {
    if (p.invited) members.push(p);
    else {
      const level = calendars.levelOf(cal, await whoOf({ id: p.row.id, kind: p.row.kind }));
      if (calendars.atLeast(level, 'view')) members.push(p);
    }
  }
  return {
    members,
    guests: invited.filter((i) => !i.user_id && i.email && i.answer !== 'no'),
  };
}

module.exports = { run, message, leadText };
