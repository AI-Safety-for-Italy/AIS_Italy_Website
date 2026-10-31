// /api/app/settings
//   GET                         -> { profile, discordBot, mail: { configured, smtp? } }
//                                  (smtp only for the admin)
//   PATCH { notifyChannel, notifyEmail }  -> the user's own notification choices
//   PUT   { host, port, user, password, fromEmail, fromName }  -> SMTP (admin)
//   POST  ?action=test { to }   -> sends a test email (admin)
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const auth = require('../../auth');
const mail = require('../../mail');
const notify = require('../../notify');

function requireAdmin(user) {
  if (user.kind !== 'admin') throw new HttpError(403, 'Only the admin can change this');
}

module.exports = route({
  async GET(req, res) {
    const user = await auth.requireUser(req);
    sendJson(res, 200, {
      profile: await auth.getProfile(user.id),
      discordBot: notify.discordAvailable(),
      mail: {
        configured: await mail.isConfigured(),
        smtp: user.kind === 'admin' ? await mail.publicSettings() : undefined,
      },
    });
  },
  async PATCH(req, res) {
    const user = await auth.requireUser(req);
    sendJson(res, 200, { profile: await auth.updateProfile(user.id, await readJson(req)) });
  },
  async PUT(req, res) {
    const user = await auth.requireUser(req);
    requireAdmin(user);
    sendJson(res, 200, { smtp: await mail.saveSettings(await readJson(req)) });
  },
  async POST(req, res) {
    const user = await auth.requireUser(req);
    requireAdmin(user);
    if (getQuery(req).action !== 'test') throw new HttpError(400, 'Unknown action');
    const { to } = await readJson(req);
    if (typeof to !== 'string' || !to.includes('@')) throw new HttpError(400, 'Enter an address');
    try {
      await mail.send({
        to,
        subject: 'Test email from the AI Safety for Italy personal area',
        ...notify.render(['If you can read this, email sending works.']),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `The mail server refused: ${err.message}`);
    }
    sendJson(res, 200, { sent: true });
  },
});
