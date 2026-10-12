// /api/admin/session
//   GET     -> { signedIn, calendarConnected }
//   POST    { password } -> signs in (sets the session cookie)
//   DELETE  -> signs out
const { route, sendJson, readJson } = require('../../server/http');
const auth = require('../../server/auth');
const { isConfigured } = require('../../server/calendar');

module.exports = route({
  async GET(req, res) {
    const signedIn = auth.isAdmin(req);
    sendJson(res, 200, {
      signedIn,
      calendarConnected: signedIn
        ? isConfigured() || process.env.MEET_FAKE_CALENDAR === '1'
        : undefined,
    });
  },
  async POST(req, res) {
    const { password } = await readJson(req);
    await auth.login(req, res, typeof password === 'string' ? password : '');
    sendJson(res, 200, { signedIn: true });
  },
  async DELETE(req, res) {
    auth.logout(res);
    sendJson(res, 200, { signedIn: false });
  },
});
