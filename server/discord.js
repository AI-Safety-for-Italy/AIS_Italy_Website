// Sign-in with Discord (OAuth2), limited to members of the AIS Discord server
// who hold one of the allowed roles.
//
// Env:
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET  the Discord application (the one
//                                             the invite bot belongs to works)
//   DISCORD_GUILD_ID                          the AIS server
//   DISCORD_ROLES_IDS                          comma-separated role ids allowed in
//
// All four are required; without them Discord sign-in is simply not offered.
// The redirect URL to register on the application is
// https://<host>/api/discord for every host the site runs on.

const API = 'https://discord.com/api/v10';
const SCOPES = 'identify email guilds.members.read';

class LoginError extends Error {
  /** `code` is shown on the login page: denied, not_member, missing_role, failed. */
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

function config() {
  const env = process.env;
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    guildId: env.DISCORD_GUILD_ID,
    roleIds: String(env.DISCORD_ROLES_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const REQUIRED = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_GUILD_ID',
  'DISCORD_ROLES_IDS',
];

/** Names (never values) of the settings still missing, to help set it up. */
function missingSettings() {
  return REQUIRED.filter((name) => !String(process.env[name] || '').trim());
}

function isConfigured() {
  return missingSettings().length === 0 && config().roleIds.length > 0;
}

/** `scope` is the sign-in's by default; the join link asks for guilds.join. */
function authorizeUrl({ state, redirectUri, scope = SCOPES }) {
  return (
    'https://discord.com/oauth2/authorize?' +
    new URLSearchParams({
      client_id: config().clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      prompt: 'none',
    })
  );
}

async function getJson(fetchImpl, url, init, what) {
  const res = await fetchImpl(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new LoginError('failed', `${what} failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Turns the code Discord sent back into a checked profile:
 * { discordId, name, avatarUrl, email, roles }. Throws LoginError when the
 * person is not in the server or lacks an allowed role. A role is allowed when
 * it is in DISCORD_ROLES_IDS or when `allowRoles(roles)` (optional, async)
 * says so: the content tool lets in the roles it grants permissions to.
 */
async function verify({ code, redirectUri, allowRoles }, fetchImpl = fetch) {
  const c = config();
  const { auth, user } = await exchange({ code, redirectUri }, fetchImpl);

  let member;
  try {
    member = await getJson(
      fetchImpl,
      `${API}/users/@me/guilds/${c.guildId}/member`,
      auth,
      'Reading the server membership'
    );
  } catch (err) {
    // 404 (Unknown Guild / Unknown Member): not in the server.
    if (err.status === 404) throw new LoginError('not_member');
    throw err;
  }
  const roles = member.roles || [];
  const allowed =
    roles.some((role) => c.roleIds.includes(role)) || (allowRoles && (await allowRoles(roles)));
  if (!allowed) throw new LoginError('missing_role');

  // A per-server avatar wins over the account one, like in Discord itself.
  let avatarUrl = null;
  if (member.avatar) {
    avatarUrl = `https://cdn.discordapp.com/guilds/${c.guildId}/users/${user.id}/avatars/${member.avatar}.png?size=64`;
  } else if (user.avatar) {
    avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  }
  return {
    discordId: user.id,
    name: member.nick || user.global_name || user.username,
    avatarUrl,
    email: user.verified ? user.email || null : null,
    roles,
  };
}

/**
 * Turns the code Discord sent back into an access token and the profile it
 * belongs to: { accessToken, auth (headers for further calls), user }.
 */
async function exchange({ code, redirectUri }, fetchImpl = fetch) {
  const c = config();
  const token = await getJson(
    fetchImpl,
    `${API}/oauth2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    },
    'Token exchange'
  );
  const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
  const user = await getJson(fetchImpl, `${API}/users/@me`, auth, 'Reading the profile');
  return { accessToken: token.access_token, auth, user };
}

module.exports = { LoginError, isConfigured, missingSettings, authorizeUrl, verify, exchange };
