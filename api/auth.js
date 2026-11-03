// /api/auth
//   GET     -> { user, permissions, discord, devLogin, devRoles }: who is signed
//              in, what their Discord roles let them do with the site's
//              content, and which ways in are available on this deployment
//   POST    ?action=password { password } -> signs in as the admin
//   POST    ?action=dev { name, roles }   -> local development only; roles
//                                           are ids from devRoles
//   DELETE  -> signs out, on every device
// Discord sign-in itself goes through /api/discord.
const { route, sendJson, readJson, getQuery, HttpError } = require('../server/http');
const auth = require('../server/auth');
const discord = require('../server/discord');
const permissions = require('../server/permissions');
const forms = require('../server/forms/forms');
const members = require('../server/members');
const review = require('../server/crm/review');
const { withTiming } = require('../server/timing');

const handler = route({
  async GET(req, res) {
    const user = await auth.currentUser(req);
    const devLogin = permissions.devLogin();
    const perms = user ? await permissions.forUser(user) : [];
    const areas = permissions.areas(perms);
    // Reading a form's answers (added by name, or by a role ticked on it)
    // opens the forms tool too, on those forms only.
    if (user && !areas.forms) areas.forms = await forms.readsAny(user).catch(() => false);
    // The reviewers of the mentee selection hold no key: they are on its list.
    if (user && !areas.review) areas.review = await review.isReviewer(user).catch(() => false);
    // A participant may ask to become an organizer (/app/organizer/).
    if (user) areas.upgrade = (await members.upgradeState(user).catch(() => ({}))).can === true;
    sendJson(res, 200, {
      user,
      permissions: perms,
      // Which tools these permissions open: { content, crm, forms, members }.
      areas,
      discord: discord.isConfigured(),
      // Setting names only, so a half-done setup says what it still needs.
      discordMissing: discord.isConfigured() ? undefined : discord.missingSettings(),
      devLogin,
      devRoles: devLogin ? permissions.DEV_ROLES : undefined,
    });
  },
  async POST(req, res) {
    const { action } = getQuery(req);
    const body = await readJson(req);
    if (action === 'password') {
      const password = typeof body.password === 'string' ? body.password : '';
      sendJson(res, 200, { user: await auth.passwordLogin(req, res, password) });
    } else if (action === 'dev' && permissions.devLogin()) {
      // Stands in for Discord on a local machine, where there is no app to
      // sign in with. Each name is its own account.
      const name =
        String(body.name || '')
          .trim()
          .slice(0, 60) || 'Test user';
      const devIds = permissions.DEV_ROLES.map((r) => r.id);
      const roles = (Array.isArray(body.roles) ? body.roles : []).filter((r) => devIds.includes(r));
      const user = await auth.upsertDiscordUser({
        discordId: `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        roles,
      });
      await auth.startSession(res, user.id);
      sendJson(res, 200, { user });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
  async DELETE(req, res) {
    // Signing out ends the sessions of this account on every device too.
    const user = await auth.currentUser(req);
    if (user) await auth.endSessions(user.id);
    auth.logout(res);
    sendJson(res, 200, { user: null });
  },
});

module.exports = withTiming(handler);
