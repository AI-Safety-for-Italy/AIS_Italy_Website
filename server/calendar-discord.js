// The calendar's side of Discord (server/calendars.js): the voice channels an
// event can take place in, the text channels it can be announced in, and the
// announcement itself, all through the AIS bot (permissions.bot).
//
// Only the text channels where the bot may both see and write are offered:
// worked out from the server's roles and each channel's overwrites, the way
// Discord does. A developer machine without the bot gets stand-ins, and the
// announcements are printed in the terminal.

const permissions = require('./permissions');
const { HttpError } = require('./http');

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ADMINISTRATOR = 1n << 3n;
const CONNECT = 1n << 20n;

const TEXT = [0, 5]; // text, announcement
const VOICE = [2, 13]; // voice, stage

const DEV_CHANNELS = {
  text: [
    { id: 'dev-general', name: 'general' },
    { id: 'dev-announcements', name: 'announcements' },
    { id: 'dev-team', name: 'team' },
  ],
  voice: [
    { id: 'dev-voice', name: 'General voice' },
    { id: 'dev-stage', name: 'Seminars stage' },
  ],
};

// The channels change rarely: kept 5 minutes, like the roles.
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

function reset() {
  cache = null;
}

/** What `member` (role ids) may do in `channel`, as Discord reckons it. */
function allowed(channel, memberRoles, memberId, roles, guildId) {
  const byId = new Map(roles.map((r) => [r.id, BigInt(r.permissions || 0)]));
  let perms = byId.get(guildId) || 0n;
  memberRoles.forEach((id) => (perms |= byId.get(id) || 0n));
  if (perms & ADMINISTRATOR) return VIEW_CHANNEL | SEND_MESSAGES | CONNECT;
  const overwrites = channel.permission_overwrites || [];
  const apply = (o) => {
    perms &= ~BigInt(o.deny || 0);
    perms |= BigInt(o.allow || 0);
  };
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) apply(everyone);
  let allow = 0n;
  let deny = 0n;
  overwrites
    .filter((o) => o.type === 0 && o.id !== guildId && memberRoles.includes(o.id))
    .forEach((o) => {
      allow |= BigInt(o.allow || 0);
      deny |= BigInt(o.deny || 0);
    });
  perms &= ~deny;
  perms |= allow;
  const own = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (own) apply(own);
  return perms;
}

/**
 * The server's channels for the calendar: { text: [{ id, name }],
 * voice: [{ id, name }] }, text ones only where the bot may write.
 */
async function channels() {
  if (!permissions.botConfigured()) {
    return permissions.devLogin() ? DEV_CHANNELS : { text: [], voice: [] };
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const guild = process.env.DISCORD_GUILD_ID;
  let list;
  let roles;
  let me;
  try {
    [list, roles, me] = await Promise.all([
      permissions.bot(`/guilds/${guild}/channels`),
      permissions.bot(`/guilds/${guild}/roles`),
      permissions.bot('/users/@me'),
    ]);
  } catch {
    throw new HttpError(502, 'Discord did not answer: try again in a moment');
  }
  if (!list.ok || !roles.ok || !me.ok)
    throw new HttpError(502, `Discord did not list the channels (${list.status})`);
  const member = await permissions.bot(`/guilds/${guild}/members/${me.body.id}`).catch(() => null);
  const botRoles = (member && member.ok && member.body.roles) || [];
  const sorted = list.body.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const can = (c, bits) => (allowed(c, botRoles, me.body.id, roles.body, guild) & bits) === bits;
  const value = {
    text: sorted
      .filter((c) => TEXT.includes(c.type) && can(c, VIEW_CHANNEL | SEND_MESSAGES))
      .map((c) => ({ id: c.id, name: c.name })),
    voice: sorted.filter((c) => VOICE.includes(c.type)).map((c) => ({ id: c.id, name: c.name })),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** The link that opens a channel of the server in Discord. */
function channelLink(channelId) {
  return `https://discord.com/channels/${process.env.DISCORD_GUILD_ID || 'dev'}/${channelId}`;
}

/** Posts `content` in a channel. Returns { sent, detail }. */
async function post(channelId, content) {
  if (!permissions.botConfigured() || String(channelId).startsWith('dev-')) {
    if (permissions.devLogin()) {
      console.log(`\n[Discord #${channelId}]\n${content}\n`);
      return { sent: true, detail: 'local: printed in the terminal' };
    }
    return { sent: false, detail: 'no Discord bot here' };
  }
  try {
    const res = await permissions.bot(`/channels/${channelId}/messages`, {
      method: 'POST',
      json: { content: content.slice(0, 1900), allowed_mentions: { parse: [] } },
    });
    if (res.ok) return { sent: true };
    console.error('Calendar announcement failed', res.status);
    return { sent: false, detail: `Discord answered ${res.status}` };
  } catch (err) {
    console.error('Calendar announcement failed', err.message);
    return { sent: false, detail: err.message };
  }
}

module.exports = { channels, channelLink, post, allowed, reset, DEV_CHANNELS };
