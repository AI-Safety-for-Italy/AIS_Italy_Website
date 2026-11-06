// The buttons under the bot's messages (server/calendar-invites.js, Going /
// Maybe / Can't go): Discord sends each click here, signed with the
// application's key, to api/discord.js (POST). Set up once in the Discord
// developer portal: the application's "Interactions Endpoint URL" is
// https://<site>/api/discord, and its "Public Key" goes in DISCORD_PUBLIC_KEY.
//
// Every request is checked against that key before anything is read; one
// that fails is refused (Discord itself tests that, with bad signatures), and
// so is one signed more than five minutes ago (a click sent again).
//
// The signature is over the bytes Discord sent: Vercel must not read the body
// first. NODEJS_HELPERS=0 on Vercel switches its helpers off (nothing of the
// site uses them: server/http.js reads bodies and queries itself).

const crypto = require('crypto');
const invites = require('./calendar-invites');

// An Ed25519 public key as DER: this prefix, then the 32 bytes Discord shows.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function configured() {
  return /^[0-9a-f]{64}$/i.test(process.env.DISCORD_PUBLIC_KEY || '');
}

/** Whether `rawBody` was signed by Discord for this application. */
const MAX_AGE_S = 5 * 60;

function verify(rawBody, signature, timestamp, now = Date.now()) {
  if (!configured() || !signature || !timestamp || !rawBody) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_AGE_S) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(String(timestamp) + rawBody),
      key,
      Buffer.from(String(signature), 'hex')
    );
  } catch {
    return false;
  }
}

/** The answer to one interaction (already verified): the JSON to send back. */
async function handle(interaction) {
  // Discord checks the endpoint is alive.
  if (interaction.type === 1) return { type: 1 };
  if (interaction.type !== 3) return { type: 4, data: { content: 'Not supported.', flags: 64 } };
  const member = interaction.member || {};
  const u = member.user || interaction.user || {};
  const content = await invites.byDiscord(
    {
      discordId: String(u.id || ''),
      name: u.global_name || u.username || 'Discord member',
      avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
      // Pressed in a channel of the server, the click carries the member's roles.
      roles: Array.isArray(member.roles) ? member.roles : undefined,
    },
    interaction.data && interaction.data.custom_id
  );
  // Only the one who clicked sees the reply.
  return { type: 4, data: { content, flags: 64 } };
}

module.exports = { configured, verify, handle };
