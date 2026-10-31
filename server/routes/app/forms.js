// /api/app/forms: making forms and reading their answers (server/forms/forms.js).
//   GET                         -> { forms }   the forms this user may manage or read
//   GET    ?meta=1              -> { templates, types, roles } for the editor
//   GET    ?id=…                -> one form for the editor
//   GET    ?id=…&view=responses -> its answers, decrypted (audited)
//   GET    ?id=…&view=export    -> the answers as a CSV file (managers, audited)
//   POST   { title, schema? }   -> a new draft  -> { id, slug }
//   PUT    ?id=…&part=schema    { schema }      -> { version }
//   PUT    ?id=…&part=settings  { status, opensAt, closesAt, slug, settings, accessRoles }
//   PUT    ?id=…&part=response&response=…  { status }  -> where the team is with it
//   DELETE ?id=…                -> deletes it (drafts without answers, or forms_admin)
//   DELETE ?id=…&response=…     -> deletes one answer for good (managers)
// Who may do what is decided in server/forms/forms.js, on every call.
const { route, sendJson, readJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const crypto = require('../../crm/crypto');
const forms = require('../../forms/forms');

async function signedIn(req) {
  const user = await requireUser(req);
  if (!crypto.configured())
    throw new HttpError(503, 'Forms are not set up here yet (encryption keys)');
  return user;
}

module.exports = route({
  async GET(req, res) {
    const user = await signedIn(req);
    const { id, view, meta } = getQuery(req);
    if (meta) {
      sendJson(res, 200, await forms.meta(user));
    } else if (!id) {
      sendJson(res, 200, { forms: await forms.list(user) });
    } else if (view === 'responses') {
      sendJson(res, 200, await forms.responses(user, id));
    } else if (view === 'export') {
      const { filename, csv } = await forms.exportCsv(user, id);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(csv);
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
    const { id, part, response } = getQuery(req);
    const body = await readJson(req);
    if (part === 'schema') sendJson(res, 200, await forms.saveSchema(user, id, body.schema));
    else if (part === 'settings') sendJson(res, 200, await forms.updateSettings(user, id, body));
    else if (part === 'response')
      sendJson(res, 200, await forms.setResponseStatus(user, id, response, body.status));
    else throw new HttpError(400, 'Which part?');
  },
  async DELETE(req, res) {
    const user = await signedIn(req);
    const { id, response } = getQuery(req);
    if (response) sendJson(res, 200, await forms.deleteResponse(user, id, response));
    else {
      await forms.remove(user, id);
      sendJson(res, 200, { ok: true });
    }
  },
});
