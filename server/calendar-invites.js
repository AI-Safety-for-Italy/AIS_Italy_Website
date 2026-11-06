// Who comes to an event of the calendar (server/calendars.js), and how they say so.
//
// The people invited by name (calendar_invites): members, or any address.
// They see the event (a member in their calendar, anyone through the link of
// their invite) and answer even without seeing its calendar. A poll's meeting
// invites the people its invite was emailed to (server/polls.js).
//
// Answers come from three places and land in the same list:
//   the calendar     a member's answer to one occurrence (calendar_rsvps);
//   a link           in an invite or reminder email: Going / Maybe / Can't go,
//                    signed so it answers for that person and event only; for
//                    the whole event (an invite) or one occurrence (a reminder);
//   Discord          the buttons under an announcement or a reminder: the
//                    member who clicks, by their Discord account (made a
//                    member of the site if they never signed in).
//
// Who sees who comes, by name: whoever changes the calendar; those invited
// to the event (each other: as in a poll, unless the poll hides its answers);
// and, as the calendar chooses (attendees_visible), whoever sees it. Everyone
// else sees the numbers.

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const { isEmail } = require('./email');

const ANSWERS = ['yes', 'maybe', 'no'];
const MAX_INVITES = 200;
// Emails to addresses outside the community, per member and day: the site's
// mailbox must not become a way to mail anyone anything.
const MAX_GUEST_EMAILS_PER_DAY = 40;
const ANSWER_TEXT = {
  yes: 'Going',
  maybe: 'Maybe',
  no: 'Can’t go',
};

const calendars = () => require('./calendars');

/** The event the invites of `event` hang on: a series' first one. */
function headOf(event) {
  return event.series_id || event.id;
}

// ── Signed links ────────────────────────────────────────────────────────────

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

function sign(text) {
  return crypto
    .createHmac('sha256', secret())
    .update(`rsvp:${text}`)
    .digest('base64url')
    .slice(0, 27);
}

/**
 * A token that answers for one person: { e: event, i: invite } (the whole
 * event) or { e, o: occurrence ms, u: member } (one occurrence).
 */
function tokenFor(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac || mac.length !== 27) return null;
  const want = sign(body);
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p.e === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** The three links of an email: [{ answer, label, link }]. */
function answerLinks(site, payload) {
  const token = tokenFor(payload);
  return ANSWERS.map((answer) => ({
    answer,
    label: ANSWER_TEXT[answer],
    link: `${site.replace(/\/+$/, '')}/rsvp/?t=${encodeURIComponent(token)}&a=${answer}`,
  }));
}

/** The buttons under a Discord message, for one occurrence. */
function discordButtons(eventId, occurrenceStart) {
  const at = new Date(occurrenceStart).getTime();
  const style = { yes: 3, maybe: 2, no: 4 };
  return [
    {
      type: 1,
      components: ANSWERS.map((answer) => ({
        type: 2,
        style: style[answer],
        label: ANSWER_TEXT[answer],
        custom_id: `rsvp|${eventId}|${at}|${answer}`,
      })),
    },
  ];
}

// ── The people invited ──────────────────────────────────────────────────────

async function invitesOf(eventId, q = db) {
  const { rows } = await q.query(
    `select i.*, u.name as member_name, u.avatar_url, u.email as member_email,
       u.notify_email, u.discord_id, u.notify_channel
     from calendar_invites i left join app_users u on u.id = i.user_id
     where i.event_id = $1 order by i.created_at`,
    [eventId]
  );
  return rows;
}

/** Whether this member is invited to the event (of a series: to the series). */
async function isInvited(event, userId) {
  if (!userId) return false;
  const { rows } = await db.query(
    'select 1 from calendar_invites where event_id = $1 and user_id = $2',
    [headOf(event), userId]
  );
  return rows.length > 0;
}

/** The members whose email (from Discord, or the one they gave for notices) is this. */
async function memberByEmail(address, q = db) {
  const { rows } = await q.query(
    `select id from app_users where kind = 'discord'
       and (lower(email) = lower($1) or lower(notify_email) = lower($1)) limit 1`,
    [address]
  );
  return rows[0] ? rows[0].id : null;
}

/** Adds one invite (a member, or an address that may be a member's): its row. */
async function addInvite(eventId, { userId = null, email = null, name = null }, q = db) {
  const address = email ? String(email).trim().toLowerCase() : null;
  const member = userId || (address ? await memberByEmail(address, q) : null);
  if (member) {
    // Invited by address before signing in: that invite becomes theirs.
    await q.query(
      `update calendar_invites i set user_id = $2
       from app_users u
       where i.event_id = $1 and i.user_id is null and u.id = $2
         and (lower(i.email) = lower(u.email) or lower(i.email) = lower(u.notify_email))
         and not exists (select 1 from calendar_invites m where m.event_id = $1 and m.user_id = $2)`,
      [eventId, member]
    );
    const { rows } = await q.query(
      `insert into calendar_invites (event_id, user_id, email, name) values ($1, $2, $3, $4)
       on conflict (event_id, user_id) where user_id is not null do update set
         email = coalesce(calendar_invites.email, excluded.email)
       returning *`,
      [eventId, member, address, name]
    );
    return rows[0];
  }
  const { rows } = await q.query(
    `insert into calendar_invites (event_id, email, name) values ($1, $2, $3)
     on conflict (event_id, lower(email)) where user_id is null do update set
       name = coalesce(excluded.name, calendar_invites.name)
     returning *`,
    [eventId, address, name]
  );
  return rows[0];
}

/** A list of addresses as typed ("a@x.org, b@y.org" or one per line), checked. */
function addresses(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const a = String(raw || '')
      .trim()
      .toLowerCase();
    if (!a) continue;
    if (!isEmail(a)) throw new HttpError(400, `Not an email address: ${a}`, { field: 'invites' });
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Sets who is invited to an event (whoever edits it): { members: [userId],
 * emails }. Those taken off lose their invite; those kept keep their answer.
 * Returns { invites, added: [rows newly invited] }.
 */
async function setInvites(user, eventId, body) {
  const who = await calendars().whoIs(user);
  const { event } = await calendars().eventFor(eventId, who, 'edit', { pollMeeting: true });
  const head = headOf(event);
  const b = body || {};
  const members = [...new Set((Array.isArray(b.members) ? b.members : []).map(String))];
  if (members.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
    throw new HttpError(400, 'Unknown member', { field: 'invites' });
  if (members.length) {
    const { rows } = await db.query(
      `select id from app_users where kind = 'discord' and id = any($1::uuid[])`,
      [members]
    );
    if (rows.length !== members.length)
      throw new HttpError(400, 'Only people who signed in with Discord can be invited by name', {
        field: 'invites',
      });
  }
  const emails = addresses(b.emails);
  if (members.length + emails.length > MAX_INVITES)
    throw new HttpError(400, `At most ${MAX_INVITES} people`, { field: 'invites' });
  const before = await invitesOf(head);
  const added = [];
  await db.transaction(async (tx) => {
    const keep = new Set();
    for (const userId of members) {
      const row = await addInvite(head, { userId }, tx);
      keep.add(row.id);
      if (!before.some((x) => x.id === row.id)) added.push(row);
    }
    for (const email of emails) {
      const row = await addInvite(head, { email }, tx);
      keep.add(row.id);
      if (!before.some((x) => x.id === row.id)) added.push(row);
    }
    // A poll's meeting keeps the people its invite went to: only added here.
    const removable = before.filter((x) => !keep.has(x.id));
    if (event.source !== 'poll' && removable.length) {
      await tx.query('delete from calendar_invites where id = any($1::uuid[])', [
        removable.map((x) => x.id),
      ]);
    }
  });
  return { invites: await invitesOut(head), added: added.map((r) => r.id) };
}

/** The invites for whoever edits the event: [{ id, kind, userId, email, name, answer, sent }]. */
async function invitesOut(eventId) {
  return (await invitesOf(eventId)).map((r) => ({
    id: r.id,
    kind: r.user_id ? 'member' : 'email',
    userId: r.user_id,
    email: r.user_id ? null : r.email,
    name: r.member_name || r.name || r.email,
    avatarUrl: r.avatar_url || null,
    answer: r.answer,
    sent: Boolean(r.sent_at),
  }));
}

/** The poll's meeting invites the addresses its invite was emailed to. */
async function syncPollInvites(eventId, emails) {
  for (const email of emails || []) await addInvite(eventId, { email });
}

// ── Answers ─────────────────────────────────────────────────────────────────

/** A member's answer to one occurrence, or none (`answer` null). */
async function answerOccurrence(eventId, occurrenceStart, userId, answer) {
  if (!answer) {
    await db.query(
      'delete from calendar_rsvps where event_id = $1 and occurrence_start = $2 and user_id = $3',
      [eventId, occurrenceStart, userId]
    );
    return;
  }
  if (!ANSWERS.includes(answer)) throw new HttpError(400, 'Answer yes, maybe or no');
  await db.query(
    `insert into calendar_rsvps (event_id, occurrence_start, user_id, answer)
     values ($1, $2, $3, $4)
     on conflict (event_id, occurrence_start, user_id)
     do update set answer = excluded.answer, updated_at = now()`,
    [eventId, occurrenceStart, userId, answer]
  );
}

/**
 * Everyone who answered one occurrence, and those invited who did not:
 * [{ key, userId, name, avatarUrl, answer|null, invited, via }]. A member's
 * answer to the occurrence comes before their answer to the invite.
 */
async function answersOf(event, occurrenceStart) {
  const head = headOf(event);
  const { rows: rsvps } = await db.query(
    `select r.answer, r.user_id, u.name, u.avatar_url from calendar_rsvps r
     join app_users u on u.id = r.user_id
     where r.event_id = $1 and r.occurrence_start = $2 order by r.updated_at`,
    [event.id, occurrenceStart]
  );
  const invites = await invitesOf(head);
  const out = new Map();
  for (const r of rsvps) {
    out.set(`u:${r.user_id}`, {
      userId: r.user_id,
      name: r.name,
      avatarUrl: r.avatar_url,
      answer: r.answer,
      invited: false,
      via: 'calendar',
    });
  }
  for (const i of invites) {
    const key = i.user_id ? `u:${i.user_id}` : `e:${i.email}`;
    const had = out.get(key);
    if (had) {
      had.invited = true;
      continue;
    }
    out.set(key, {
      userId: i.user_id,
      name: i.member_name || i.name || i.email,
      avatarUrl: i.avatar_url || null,
      answer: i.answer,
      invited: true,
      via: i.user_id ? 'invite' : 'email',
    });
  }
  return [...out.entries()].map(([key, v]) => ({ key, ...v }));
}

/** Whether `viewer` sees the names of who comes to an event of `cal`. */
async function seesNames(event, cal, level, viewerInvited) {
  const c = calendars();
  if (c.atLeast(level, 'edit')) return true;
  if (viewerInvited) {
    if (event.source === 'poll') {
      const { rows } = await db.query('select hide_responses from polls where id = $1', [
        event.source_id,
      ]);
      return !(rows[0] && rows[0].hide_responses);
    }
    return true;
  }
  return (cal.attendees_visible || 'members') === 'members' && c.atLeast(level, 'view');
}

/** Who comes, for a card or a page: { mine, counts, people|null, namesHidden }. */
async function whoComes(event, cal, level, occurrenceStart, { userId = null, key = null } = {}) {
  // An address is shown to whoever changes the event only; to others, a guest.
  const editor = calendars().atLeast(level, 'edit');
  const head = event.series_id ? { ...event, id: event.series_id } : event;
  const answers = await answersOf(event, occurrenceStart);
  const invited = Boolean(
    (userId && answers.some((a) => a.invited && a.userId === userId)) ||
      (key && answers.some((a) => a.key === key))
  );
  const names = await seesNames(head, cal, level, invited);
  const mineRow = answers.find((a) => (userId && a.userId === userId) || (key && a.key === key));
  const count = (answer) => answers.filter((a) => a.answer === answer).length;
  return {
    mine: mineRow ? mineRow.answer : null,
    counts: {
      yes: count('yes'),
      maybe: count('maybe'),
      no: count('no'),
      waiting: answers.filter((a) => a.invited && !a.answer).length,
    },
    namesHidden: !names,
    people: names
      ? answers.map((a) => ({
          name:
            a.userId || editor
              ? a.name
              : key && a.key === key
              ? 'You'
              : a.name && !a.name.includes('@')
              ? a.name
              : 'A guest',
          avatarUrl: a.avatarUrl,
          answer: a.answer,
          invited: a.invited,
          external: !a.userId,
        }))
      : null,
  };
}

/** The next occurrence of an event from now (or its first, if none is ahead). */
function nextOccurrence(event) {
  const c = calendars();
  if (!event.recurrence || event.series_id) return c.pickOccurrence(event, null);
  const timeOf = require('./calendar-expand');
  const now = Date.now();
  const next = timeOf
    .expand([event], new Date(now), new Date(now + 400 * 86400000), [])
    .find((o) => o.event.id === event.id);
  return c.pickOccurrence(event, next ? next.occurrenceStart.toISOString() : null);
}

/** The event and occurrence a link or a button points to, checked. */
async function pointed(eventId, at) {
  const c = calendars();
  const event = await c.loadEvent(eventId).catch(() => null);
  if (!event) throw new HttpError(404, 'This event no longer exists');
  const occ = at ? c.pickOccurrence(event, new Date(Number(at)).toISOString()) : null;
  const { rows } = await db.query('select * from calendars where id = $1', [event.calendar_id]);
  return { event, occ, cal: rows[0] };
}

/**
 * What an emailed link shows, and answers when `answer` is given: the
 * event, when, where, the person's answer and who comes (as their invite
 * or their calendar lets them see it). Null for a link that is not ours.
 */
async function byLink(token, answer) {
  const p = readToken(token);
  if (!p) throw new HttpError(404, 'This link does not work: it may be incomplete');
  const { event, occ, cal } = await pointed(p.e, p.o);
  let userId = p.u || null;
  let key = null;
  if (p.i) {
    const { rows } = await db.query(
      'select * from calendar_invites where id = $1 and event_id = $2',
      [p.i, headOf(event)]
    );
    if (!rows.length) throw new HttpError(410, 'This invitation was withdrawn');
    const invite = rows[0];
    userId = invite.user_id;
    key = invite.user_id ? `u:${invite.user_id}` : `e:${invite.email}`;
    if (answer) {
      if (!ANSWERS.includes(answer)) throw new HttpError(400, 'Answer yes, maybe or no');
      await db.query('update calendar_invites set answer = $2, answered_at = now() where id = $1', [
        invite.id,
        answer,
      ]);
      // A member's own answers to the occurrences stay theirs; the invite's is the default.
    }
  } else if (userId && answer && occ) {
    await answerOccurrence(event.id, occ.occurrenceStart, userId, answer);
  }
  const shown = occ || nextOccurrence(event);
  const at = shown.occurrenceStart;
  return {
    title: event.title,
    start: shown.start.toISOString(),
    end: shown.end.toISOString(),
    allDay: event.all_day,
    timezone: event.timezone,
    location: event.location || '',
    video: event.video_kind === 'link' ? event.video_url : null,
    recurring: Boolean(event.recurrence || event.series_id),
    calendar: cal && !cal.personal_of ? cal.name : null,
    scope: p.i ? 'event' : 'occurrence',
    rsvp: await whoComes(event, cal, 'public', at, { userId, key }),
  };
}

/**
 * A click on a button under a Discord message: the member (made one if they
 * never signed in, with their roles from the click) answers if they may see
 * the event. Returns the text of the private reply.
 */
async function byDiscord({ discordId, name, avatarUrl, roles }, customId) {
  const [kind, eventId, at, answer] = String(customId || '').split('|');
  if (kind !== 'rsvp' || !ANSWERS.includes(answer)) return 'This button is not ours.';
  let found;
  try {
    found = await pointed(eventId, at);
  } catch (err) {
    return err.message;
  }
  const { event, occ, cal } = found;
  const auth = require('./auth');
  const { rows } = await db.query('select * from app_users where discord_id = $1', [discordId]);
  const user = rows[0]
    ? { id: rows[0].id, kind: 'discord', name: rows[0].name, row: rows[0] }
    : await auth.upsertDiscordUser({ discordId, name, avatarUrl, roles });
  if (!rows[0]) user.kind = 'discord';
  const c = calendars();
  const who = await c.whoIs(user);
  const level = c.levelOf(cal, who);
  if (level === null && !(await isInvited(event, user.id)))
    return 'You cannot answer for this event: its calendar is not one you see.';
  await answerOccurrence(event.id, occ.occurrenceStart, user.id, answer);
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: event.timezone || 'Europe/Rome',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(occ.start);
  return `Noted: **${ANSWER_TEXT[answer]}** for “${event.title}” (${when}). Change it with another button, or in the calendar.`;
}

// ── Sending the invites ─────────────────────────────────────────────────────

/**
 * The members who may be invited by name, matching `query`: those who
 * signed in here (an invite is answered in the calendar). [{ userId, name, avatarUrl }].
 */
async function searchMembers(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const { rows } = await db.query(
    `select id, name, avatar_url from app_users where kind = 'discord' and name ilike $1
     order by lower(name) limit 10`,
    [`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]
  );
  return rows.map((r) => ({ userId: r.id, name: r.name, avatarUrl: r.avatar_url }));
}

/**
 * Sends the invite of an event (whoever edits it) to the people invited,
 * those not sent it yet (all with `again`): an address gets the email with
 * the event attached and Going / Maybe / Can't go; a member, on the channels
 * they chose for notices (email, and Discord with the same buttons). A
 * poll's meeting is sent from the poll. Returns { sent, failed }.
 */
async function sendInvites(user, eventId, { again = false, site }) {
  const c = calendars();
  const who = await c.whoIs(user);
  const { event: asked } = await c.eventFor(eventId, who, 'edit');
  const event = asked.series_id ? await c.loadEvent(asked.series_id) : asked;
  if (event.source === 'poll')
    throw new HttpError(409, 'The invite of a poll’s meeting is sent from the poll');
  const notify = require('./notify');
  const interactions = require('./discord-interactions');
  const list = (await invitesOf(event.id)).filter((i) => again || !i.sent_at);
  const guests = list.filter((i) => !i.user_id).length;
  if (guests) {
    const { rows } = await db.query(
      `select count(*)::int as n from calendar_invites
       where sent_by = $1 and user_id is null and sent_at > now() - interval '1 day'`,
      [user.id]
    );
    if (rows[0].n + guests > MAX_GUEST_EMAILS_PER_DAY)
      throw new HttpError(
        429,
        `At most ${MAX_GUEST_EMAILS_PER_DAY} invites a day to addresses outside the community: try again tomorrow`
      );
  }
  const occ = c.pickOccurrence(event, null);
  const asPoll = {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location || (event.video_kind === 'link' ? event.video_url : ''),
    timezone: event.timezone,
    recurrence: event.recurrence,
  };
  const slot = { start: occ.start, end: occ.end };
  let sent = 0;
  let failed = 0;
  for (const i of list) {
    const wants = i.user_id ? i.notify_channel || 'email' : 'email';
    const address = i.user_id ? i.notify_email || i.member_email || i.email : i.email;
    let ok = false;
    if (address && ['email', 'both'].includes(wants)) {
      const out = await notify.sendMeeting({
        poll: asPoll,
        slot,
        recipients: [{ email: address, name: i.member_name || i.name }],
        ownerId: user.kind === 'discord' ? user.id : null,
        sequence: event.sequence || 0,
        answers: async () => answerLinks(site, { e: event.id, i: i.id }),
      });
      ok = out.sent > 0;
    }
    if (
      i.user_id &&
      i.discord_id &&
      ['discord', 'both'].includes(wants) &&
      notify.discordAvailable()
    ) {
      try {
        const when = new Intl.DateTimeFormat('en-GB', {
          timeZone: event.timezone || 'Europe/Rome',
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit',
        }).format(occ.start);
        await notify.discordDm(
          i.discord_id,
          `📅 **${user.name || 'Someone'}** invites you to **${event.title}** · ${when}` +
            (event.location ? `\n📍 ${event.location}` : '') +
            `\n${site.replace(/\/+$/, '')}/app/calendar/?event=${event.id}`,
          {
            components: interactions.configured()
              ? discordButtons(event.id, occ.occurrenceStart)
              : undefined,
          }
        );
        ok = true;
      } catch (err) {
        console.error('Invite on Discord failed:', err.message);
      }
    }
    if (ok) {
      sent++;
      await db.query('update calendar_invites set sent_at = now(), sent_by = $2 where id = $1', [
        i.id,
        user.kind === 'discord' ? user.id : null,
      ]);
    } else failed++;
  }
  return { sent, failed };
}

module.exports = {
  searchMembers,
  sendInvites,
  ANSWERS,
  ANSWER_TEXT,
  headOf,
  tokenFor,
  readToken,
  answerLinks,
  discordButtons,
  invitesOf,
  invitesOut,
  isInvited,
  addInvite,
  setInvites,
  syncPollInvites,
  answerOccurrence,
  answersOf,
  whoComes,
  byLink,
  byDiscord,
};
