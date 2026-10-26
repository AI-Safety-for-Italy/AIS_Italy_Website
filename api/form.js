// /api/form: the public side of the forms, no sign-in.
//   GET  ?f=<slug>   -> the questions and a token, or { open: false } when closed
//   POST ?f=<slug>   { version, token, answers, website }  -> { ok, confirmation }
// Everything sent is checked against the form on the server
// (server/forms/schema.js) and the anti-spam tests (server/forms/guard.js);
// answers are stored encrypted.
const { route, sendJson, readJson, getQuery, clientIp, HttpError } = require('../server/http');
const crypto = require('../server/crm/crypto');
const forms = require('../server/forms/forms');

function ready() {
  // Without the keys, answers could not be stored protected: take none.
  if (!crypto.configured()) throw new HttpError(503, 'Forms are not available right now');
}

module.exports = route({
  async GET(req, res) {
    ready();
    sendJson(res, 200, await forms.publicView(getQuery(req).f));
  },
  async POST(req, res) {
    ready();
    const result = await forms.submit(getQuery(req).f, await readJson(req), clientIp(req));
    sendJson(res, 201, { ok: true, confirmation: result.confirmation });
  },
});
