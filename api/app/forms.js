// /api/app/forms: making forms and reading their answers (server/forms/forms.js).
//   GET                         -> { forms }   the forms this user may manage or read
//   GET    ?id=…                -> one form for the editor
//   GET    ?id=…&view=responses -> its answers, decrypted (audited)
//   POST   { title, schema? }   -> a new draft  -> { id, slug }
//   PUT    ?id=…&part=schema    { schema }      -> { version }
//   PUT    ?id=…&part=settings  { status, opensAt, closesAt, slug, settings, accessRoles }
//   DELETE ?id=…                -> deletes it (drafts without answers, or forms_admin)
// Who may do what is decided in server/forms/forms.js, on every call.
const { route, sendJson, readJson, getQuery, HttpError } = require('../../server/http');
const { requireUser } = require('../../server/auth');
const crypto = require('../../server/crm/crypto');
const forms = require('../../server/forms/forms');

async function signedIn(req) {
  const user = await requireUser(req);
  if (!crypto.configured())
    throw new HttpError(503, 'Forms are not set up here yet (encryption keys)');
  return user;
}

module.exports = route({
  async GET(req, res) {
    const user = await signedIn(req);
    const { id, view } = getQuery(req);
    if (!id) {
      sendJson(res, 200, { forms: await forms.list(user) });
    } else if (view === 'responses') {
      sendJson(res, 200, await forms.responses(user, id));
    } else {
      sendJson(res, 200, await forms.get(user, id));
    }
  },
  async POST(req, res) {
    const user = await signedIn(req);
    sendJson(res, 201, await forms.create(user, await readJson(req)));
  },
  async PUT(req, res) {
    const user = await signedIn(req);
    const { id, part } = getQuery(req);
    const body = await readJson(req);
    if (part === 'schema') sendJson(res, 200, await forms.saveSchema(user, id, body.schema));
    else if (part === 'settings') sendJson(res, 200, await forms.updateSettings(user, id, body));
    else throw new HttpError(400, 'Which part?');
  },
  async DELETE(req, res) {
    const user = await signedIn(req);
    await forms.remove(user, getQuery(req).id);
    sendJson(res, 200, { ok: true });
  },
});
