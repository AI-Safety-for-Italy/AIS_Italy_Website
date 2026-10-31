// /api/join: the personal link an approved applicant gets by email.
//   GET ?t=…              -> sends the browser to Discord (scope guilds.join)
//   GET ?code=…&state=…   -> Discord sends it back here; the bot adds them to
//                            the server with their role (server/members.js)
// Ends on /join/?s=ok, or /join/?s=<invalid|expired|used|denied|failed>.
//
// Like /api/discord, a SameSite=Lax cookie ties the return trip to the browser
// that started it, and carries the token across it.
const crypto = require('crypto');
const { route, redirect, origin, getQuery, getCookie } = require('../server/http');
const auth = require('../server/auth');
const discord = require('../server/discord');
const members = require('../server/members');

const STATE_COOKIE = 'ais_join';

function done(res, status) {
  res.setHeader('Set-Cookie', auth.cookieHeader(STATE_COOKIE, '', 0, 'Lax'));
  redirect(res, `/join/?s=${status}`);
}

module.exports = route({
  async GET(req, res) {
    const query = getQuery(req);
    const redirectUri = `${origin(req)}/api/join`;

    if (query.t) {
      try {
        await members.checkJoinToken(query.t);
      } catch (err) {
        if (err instanceof members.JoinError) return done(res, err.code);
        throw err;
      }
      if (members.devMode()) {
        await members.completeJoinDev(query.t);
        return done(res, 'ok');
      }
      if (!discord.isConfigured()) return done(res, 'failed');
      const state = crypto.randomBytes(16).toString('base64url');
      const cookie = Buffer.from(JSON.stringify({ state, t: query.t })).toString('base64url');
      res.setHeader('Set-Cookie', auth.cookieHeader(STATE_COOKIE, cookie, 900, 'Lax'));
      return redirect(
        res,
        // email: to tell the board when the account is not the applicant's.
        discord.authorizeUrl({ state, redirectUri, scope: 'identify email guilds.join' })
      );
    }

    let saved = {};
    try {
      saved = JSON.parse(Buffer.from(getCookie(req, STATE_COOKIE) || '', 'base64url').toString());
    } catch {
      /* missing or mangled: handled as a state mismatch below */
    }
    // Without the cookie the token is lost too: the email link starts over.
    if (!saved.state || saved.state !== query.state) return done(res, 'invalid');
    if (query.error) return done(res, 'denied');
    try {
      await members.completeJoin(saved.t, { code: query.code, redirectUri });
      done(res, 'ok');
    } catch (err) {
      if (!(err instanceof members.JoinError) || err.code === 'failed') {
        console.error('Joining the server failed', err.message);
      }
      done(res, err instanceof members.JoinError ? err.code : 'failed');
    }
  },
});
