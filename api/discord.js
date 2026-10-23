// /api/discord: sign-in with Discord.
//   GET [?next=/app/…]        -> sends the browser to Discord
//   GET ?code=…&state=…       -> Discord sends it back here; signs in and
//                                goes on to `next` (or /app/)
// Failures land on /app/login/?error=<code>.
//
// The state cookie ties the return trip to the browser that started it. It
// is SameSite=Lax because the return is a navigation coming from discord.com,
// which a Strict cookie would not be sent with.
const crypto = require('crypto');
const { route, redirect, origin, getQuery, getCookie } = require('../server/http');
const auth = require('../server/auth');
const discord = require('../server/discord');
const permissions = require('../server/permissions');

const STATE_COOKIE = 'ais_oauth';
const NEXT = /^\/app\/[\w/-]*(\?[\w=&%.-]*)?$/;

function fail(res, code) {
  res.setHeader('Set-Cookie', auth.cookieHeader(STATE_COOKIE, '', 0, 'Lax'));
  redirect(res, `/app/login/?error=${encodeURIComponent(code)}`);
}

module.exports = route({
  async GET(req, res) {
    const query = getQuery(req);
    if (!discord.isConfigured()) return fail(res, 'unavailable');
    const redirectUri = `${origin(req)}/api/discord`;

    if (!query.code && !query.error) {
      const state = crypto.randomBytes(16).toString('base64url');
      const next = NEXT.test(query.next || '') ? query.next : '/app/';
      const cookie = Buffer.from(JSON.stringify({ state, next })).toString('base64url');
      res.setHeader('Set-Cookie', auth.cookieHeader(STATE_COOKIE, cookie, 600, 'Lax'));
      return redirect(res, discord.authorizeUrl({ state, redirectUri }));
    }

    let saved = {};
    try {
      saved = JSON.parse(Buffer.from(getCookie(req, STATE_COOKIE) || '', 'base64url').toString());
    } catch {
      /* missing or mangled: handled as a state mismatch below */
    }
    if (!saved.state || saved.state !== query.state) return fail(res, 'expired');
    if (query.error) return fail(res, 'denied');

    try {
      // Roles given content permissions on the dashboard get in too.
      const profile = await discord.verify({
        code: query.code,
        redirectUri,
        allowRoles: permissions.anyContentRole,
      });
      const user = await auth.upsertDiscordUser(profile);
      res.setHeader('Set-Cookie', [
        auth.cookieHeader(STATE_COOKIE, '', 0, 'Lax'),
        auth.cookieHeader(auth.COOKIE, auth.makeSession(user.id), 7 * 86400),
      ]);
      redirect(res, NEXT.test(saved.next || '') ? saved.next : '/app/');
    } catch (err) {
      if (!(err instanceof discord.LoginError) || err.code === 'failed') {
        console.error('Discord sign-in failed', err.message, err.body || '');
      }
      fail(res, err instanceof discord.LoginError ? err.code : 'failed');
    }
  },
});
