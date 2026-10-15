// Messages the meeting polls send:
//   - invitations to the guests of an invite-only poll (email);
//   - to the poll's owner, about each new answer and when every guest has
//     answered, by email and/or Discord DM as their settings say.
//
// Owner notifications never make the action that triggered them fail: a
// broken mail server or a closed Discord DM is logged and skipped.

const db = require('./db');
const mail = require('./mail');
const ics = require('./ics');
const recurrence = require('./recurrence');

const DISCORD_API = 'https://discord.com/api/v10';

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Closes the automatic invitations: nobody reads replies to them.
const NO_REPLY =
  'Email inviata automaticamente: per favore non rispondere. · Automatic email, please do not reply.';

/**
 * A plain-text body and a matching simple HTML one. `lines` may hold a
 * { link }; `noReply` adds the note asking not to reply.
 */
function render(lines, { noReply = false } = {}) {
  const text =
    lines.map((l) => (typeof l === 'string' ? l : `${l.label}: ${l.link}`)).join('\n\n') +
    (noReply ? `\n\n${NO_REPLY}` : '');
  const html =
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#0f1a14;max-width:560px">' +
    lines
      .map((l) =>
        typeof l === 'string'
          ? `<p>${escapeHtml(l).replace(/\n/g, '<br>')}</p>`
          : `<p><a href="${escapeHtml(
              l.link
            )}" style="display:inline-block;padding:10px 18px;background:#00703a;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(
              l.label
            )}</a></p>`
      )
      .join('') +
    '<p style="color:#7c8a81;font-size:13px">AI Safety for Italy' +
    (noReply ? `<br>${escapeHtml(NO_REPLY)}` : '') +
    '</p></div>';
  return { text, html };
}

// ── Discord ─────────────────────────────────────────────────────────────────

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function discordAvailable() {
  return Boolean(process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA);
}

/** Sends a direct message from the AIS bot. Fails if the user blocks DMs. */
async function discordDm(discordId, content) {
  const headers = {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA}`,
    'Content-Type': 'application/json',
  };
  const channel = await fetchImpl(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ recipient_id: discordId }),
  });
  if (!channel.ok) throw new Error(`Discord DM channel failed (${channel.status})`);
  const { id } = await channel.json();
  const sent = await fetchImpl(`${DISCORD_API}/channels/${id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!sent.ok) throw new Error(`Discord DM failed (${sent.status})`);
}

// ── Owner notifications ─────────────────────────────────────────────────────

/**
 * Tells a poll's owner something happened, on the channels they chose.
 * `message` is { subject, lines } (see render). Returns the channels used.
 */
async function notifyOwner(pollId, message) {
  const { rows } = await db.query(
    `select p.notify, u.kind, u.discord_id, u.email, u.notify_email, u.notify_channel
     from polls p join app_users u on u.id = p.owner_id where p.id = $1`,
    [pollId]
  );
  const owner = rows[0];
  if (!owner || !owner.notify || owner.notify_channel === 'none') return [];

  const wantsDiscord = ['discord', 'both'].includes(owner.notify_channel);
  const wantsEmail = ['email', 'both'].includes(owner.notify_channel);
  const address = owner.notify_email || owner.email;
  const used = [];

  let discordSent = false;
  if (wantsDiscord && owner.discord_id && discordAvailable()) {
    try {
      const { text } = render(message.lines);
      await discordDm(owner.discord_id, `**${message.subject}**\n\n${text}`.slice(0, 1900));
      used.push('discord');
      discordSent = true;
    } catch (err) {
      console.error('Owner notification on Discord failed:', err.message);
    }
  }
  // Email when asked for it, and as the fallback when Discord did not work.
  if ((wantsEmail || (wantsDiscord && !discordSent)) && address && (await mail.isConfigured())) {
    try {
      await mail.send({ to: address, subject: message.subject, ...render(message.lines) });
      used.push('email');
    } catch (err) {
      console.error('Owner notification by email failed:', err.message);
    }
  }
  return used;
}

function newAnswerMessage({ poll, name, yes, maybe, origin }) {
  const counts = `${yes} yes${maybe ? `, ${maybe} if needed` : ''}`;
  return {
    subject: `New answer: ${poll.title}`,
    lines: [
      `${name} answered “${poll.title}” (${counts}).`,
      { label: 'See the answers', link: `${origin}/app/polls/poll/?id=${poll.id}` },
    ],
  };
}

function allAnsweredMessage({ poll, count, origin }) {
  return {
    subject: `Everyone answered: ${poll.title}`,
    lines: [
      `All ${count} people invited to “${poll.title}” have answered. You can choose the time.`,
      { label: 'Choose the time', link: `${origin}/app/polls/poll/?id=${poll.id}` },
    ],
  };
}

// ── Invitations ─────────────────────────────────────────────────────────────

function inviteMessage({ poll, ownerName, link }) {
  const by = ownerName ? `${ownerName} ti invita` : 'Sei invitato/a';
  const byEn = ownerName ? `${ownerName} invites you` : 'You are invited';
  return {
    subject: ownerName ? `${ownerName} ti invita: ${poll.title}` : `Invito: ${poll.title}`,
    lines: [
      `${by} a indicare quando sei disponibile per “${poll.title}”.` +
        (poll.description ? `\n\n${poll.description}` : ''),
      { label: 'Indica la tua disponibilità', link },
      `${byEn} to say when you're available for “${poll.title}”. The link above is personal: please don't forward it.`,
      ownerName ? `— ${ownerName}` : null,
    ].filter(Boolean),
  };
}

/**
 * Who an invitation comes from: the poll owner's name (the shared admin
 * account has none worth showing).
 */
async function inviter(ownerId) {
  const { rows } = await db.query('select * from app_users where id = $1', [ownerId]);
  const u = rows[0];
  return { name: u && u.kind !== 'admin' ? u.name : null };
}

/**
 * Emails each invite its personal link and records the outcome on the
 * invite (sent_at, or send_error). Returns { sent, failed }.
 */
async function sendInvites({ poll, ownerId, invites, origin }) {
  const from = await inviter(ownerId);
  const messages = invites.map((invite) => {
    const link = `${origin}/meet/?p=${poll.token}&i=${invite.token}`;
    const msg = inviteMessage({ poll, ownerName: from.name, link });
    return {
      to: invite.email,
      subject: msg.subject,
      senderName: from.name,
      ...render(msg.lines, { noReply: true }),
    };
  });
  const results = await batch(messages);
  let sent = 0;
  for (let k = 0; k < invites.length; k++) {
    if (results[k].ok) {
      await db.query('update poll_invites set sent_at = now(), send_error = null where id = $1', [
        invites[k].id,
      ]);
      sent++;
    } else {
      await db.query('update poll_invites set send_error = $2 where id = $1', [
        invites[k].id,
        String(results[k].error).slice(0, 300),
      ]);
    }
  }
  return { sent, failed: invites.length - sent };
}

/** sendBatch, but a mailbox that is not set up fails every message instead. */
async function batch(messages) {
  if (!messages.length) return [];
  try {
    return await mail.sendBatch(messages);
  } catch (err) {
    return messages.map(() => ({ ok: false, error: err.message }));
  }
}

// ── Calendar invite for the chosen time ────────────────────────────────────

/**
 * The meeting's time in Italian, e.g. "martedì 27 ottobre, 09:00–10:00 (Europe/Rome)"
 * or, for a series, "ogni martedì, 09:00–10:00 (Europe/Rome), a partire da
 * martedì 27 ottobre".
 */
function when(slot, timezone, rec) {
  const day = new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(slot.start));
  const time = (d) =>
    new Intl.DateTimeFormat('it-IT', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(d));
  const hours = `${time(slot.start)}–${time(slot.end)} (${timezone.replace(/_/g, ' ')})`;
  if (rec) {
    const series = recurrence.describeIt(rec, slot.start, timezone);
    return `${series}, ${hours}, a partire da ${day}${recurrence.describeEndIt(rec)}`;
  }
  return `${day}, ${hours}`;
}

/**
 * Emails each recipient the calendar event (one email each, naming only
 * them), or its cancellation when `cancel` is set. Returns { sent, failed }.
 */
async function sendMeeting({ poll, slot, recipients, ownerId, sequence, cancel = false }) {
  const from = await inviter(ownerId);
  const settings = await mail.publicSettings();
  const organizer = {
    name: from.name || (settings && settings.fromName) || 'AI Safety for Italy',
    email: (settings && settings.fromEmail) || 'tech@ais4i.it',
  };
  const rec = poll.recurrence || null;
  const whenText = when(slot, poll.timezone, rec);
  const subject = cancel ? `Annullata: ${poll.title}` : `Invito: ${poll.title} · ${whenText}`;
  const lines = cancel
    ? [
        (rec
          ? `Tutte le riunioni della serie “${poll.title}” (${whenText}) sono state annullate.`
          : `La riunione “${poll.title}” di ${whenText} è stata annullata.`) +
          ' Se viene fissato un nuovo orario riceverai un nuovo invito.',
        rec
          ? `The “${poll.title}” meeting series has been cancelled.`
          : `The meeting “${poll.title}” has been cancelled.`,
      ]
    : [
        `${from.name ? `${from.name} ha fissato` : 'È stata fissata'} ${
          rec ? 'la serie di riunioni' : 'la riunione'
        } “${poll.title}”: ${whenText}.` +
          (poll.location ? `\nDove: ${poll.location}` : '') +
          '\n\nL’invito è allegato: aprilo per aggiungerlo al tuo calendario.',
        `“${poll.title}” is scheduled for the time above. The invitation is attached: open it to add it to your calendar.`,
        from.name ? `— ${from.name}` : null,
      ].filter(Boolean);

  const method = cancel ? 'CANCEL' : 'REQUEST';
  const results = await batch(
    recipients.map((person) => ({
      to: person.email,
      subject,
      senderName: from.name,
      icalEvent: {
        method,
        filename: 'invite.ics',
        content: ics.build(poll, slot, { method, sequence, organizer, attendee: person }),
      },
      ...render(lines, { noReply: true }),
    }))
  );
  const sent = results.filter((r) => r.ok).length;
  return { sent, failed: results.length - sent };
}

module.exports = {
  sendMeeting,
  render,
  discordAvailable,
  setFetch,
  notifyOwner,
  newAnswerMessage,
  allAnsweredMessage,
  sendInvites,
};
