// /api/form: the public side of the forms, no sign-in.
//   GET  ?f=<slug>   -> the questions and a token, or { open: false } when closed
//   POST ?f=<slug>   { version, token, answers, website }  -> { ok, confirmation }
// Everything sent is checked against the form on the server
// (server/forms/schema.js) and the anti-spam tests (server/forms/guard.js);
// answers are stored encrypted.
const {
  route,
  sendJson,
  readJson,
  getQuery,
  clientIp,
  siteUrl,
  HttpError,
} = require('../server/http');
const crypto = require('../server/crm/crypto');
const forms = require('../server/forms/forms');

// The owner's notification and the person's copy of their answers go out
// before answering (a Vercel function may be frozen once it has replied), but
// never hold the person up for long, and never fail the answer.
const NOTIFY_BUDGET_MS = 8000;

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
    // A bot's send is not stored and has no formId: nobody is told.
    if (result.formId) {
      let timer;
      await Promise.race([
        Promise.all([
          forms
            .notifyOwner(result.formId, siteUrl(req))
            .catch((err) => console.error('Notification failed', err)),
          forms.sendCopy(result.copy).catch((err) => console.error('Copy failed', err)),
        ]),
        new Promise((resolve) => (timer = setTimeout(resolve, NOTIFY_BUDGET_MS))),
      ]);
      clearTimeout(timer);
    }
    sendJson(res, 201, { ok: true, confirmation: result.confirmation });
  },
});
