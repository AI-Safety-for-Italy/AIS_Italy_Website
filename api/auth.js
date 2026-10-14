// /api/auth
//   GET     -> { user, discord, devLogin }: who is signed in, and which ways in
//              are available on this deployment
//   POST    ?action=password { password } -> signs in as the admin
//   POST    ?action=dev { name }          -> local development only
//   DELETE  -> signs out
// Discord sign-in itself goes through /api/discord.
const { route, sendJson, readJson, getQuery, HttpError } = require('../server/http');
const auth = require('../server/auth');
const discord = require('../server/discord');

module.exports = route({
  async GET(req, res) {
    sendJson(res, 200, {
      user: await auth.currentUser(req),
      discord: discord.isConfigured(),
      devLogin: process.env.MEET_DEV_LOGIN === '1',
    });
  },
  async POST(req, res) {
    const { action } = getQuery(req);
    const body = await readJson(req);
    if (action === 'password') {
      const password = typeof body.password === 'string' ? body.password : '';
      sendJson(res, 200, { user: await auth.passwordLogin(req, res, password) });
    } else if (action === 'dev' && process.env.MEET_DEV_LOGIN === '1') {
      // Stands in for Discord on a local machine, where there is no app to
      // sign in with. Each name is its own account.
      const name =
        String(body.name || '')
          .trim()
          .slice(0, 60) || 'Test user';
      const user = await auth.upsertDiscordUser({
        discordId: `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
      });
      auth.startSession(res, user.id);
      sendJson(res, 200, { user });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
  async DELETE(req, res) {
    auth.logout(res);
    sendJson(res, 200, { user: null });
  },
});
