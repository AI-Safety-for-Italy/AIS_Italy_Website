// /api/app/crm/mentorship: the mentorship board. Every call needs the
// `mentorship` permission (server/access.js); changes re-read the Discord
// roles first. Everything read or changed is on the audit trail.
//   GET                                   -> the board: { mentors, mentees, matches, … }
//   GET  ?key=…&kind=mentor|mentee        -> one person, with notes and history
//   POST ?action=update  { key, kind, status?, track?, owner?: 'me'|'none' }
//   POST ?action=note    { key, kind, body }
//   POST ?action=match   { mentorKey, menteeKey, track }
//   POST ?action=end-match { id }
//   POST ?action=add { first_name, last_name, email, … }  -> a mentor to contact, by hand
//   POST ?action=remove { recordId }      -> removes someone added by hand
//   POST ?action=import&source=…          -> copies that sheet onto the board (crm_admin)
//   GET  ?action=sources                  -> { sources, serviceAccount } (crm_admin)
//   PUT  ?action=sources { <source>: { spreadsheetId, tab } }  -> the same, saved (crm_admin)
const { route, sendJson, readJson, getQuery, HttpError } = require('../../../http');
const { requireUser } = require('../../../auth');
const access = require('../../../access');
const crypto = require('../../../crm/crypto');
const mentorship = require('../../../crm/mentorship');
const sources = require('../../../crm/sources');
const records = require('../../../crm/records');

/** The sheets the board reads, for the settings page: [{ id, label, spreadsheetId, tab }]. */
async function sourceList() {
  const config = await sources.getConfig();
  return {
    sources: sources.SHEET_SOURCES.map((id) => ({
      id,
      label: sources.SOURCES[id].label,
      ...config[id],
    })),
    serviceAccount: sources.serviceAccountEmail(),
  };
}

/** Signed in, CRM set up, and allowed: returns { user, perms }. */
async function door(req, { write = false } = {}) {
  const user = await requireUser(req);
  // Without its keys the CRM would store notes and keys unprotected: refuse.
  if (!crypto.configured())
    throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
  const perms = await access.authorize(user, 'mentorship', { fresh: write });
  return { user, perms };
}

module.exports = route({
  async GET(req, res) {
    if (getQuery(req).action === 'sources') {
      const user = await requireUser(req);
      await access.authorize(user, 'crm_admin');
      sendJson(res, 200, await sourceList());
      return;
    }
    const { user, perms } = await door(req);
    const { key, kind } = getQuery(req);
    if (key) {
      sendJson(res, 200, await mentorship.person(user, perms, key, kind));
      return;
    }
    sendJson(res, 200, await mentorship.board(user));
  },

  async PUT(req, res) {
    const user = await requireUser(req);
    if (getQuery(req).action !== 'sources') throw new HttpError(400, 'Unknown action');
    await access.authorize(user, 'crm_admin', { fresh: true });
    await sources.saveConfig(user, await readJson(req));
    sendJson(res, 200, await sourceList());
  },

  async POST(req, res) {
    const query = getQuery(req);
    if (query.action === 'import') {
      const user = await requireUser(req);
      if (!crypto.configured())
        throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
      await access.authorize(user, 'crm_admin', { fresh: true });
      sendJson(res, 200, await records.importSource(user, String(query.source || '')));
      return;
    }
    const { user } = await door(req, { write: true });
    const { action } = query;
    const body = await readJson(req);
    if (action === 'add') {
      sendJson(res, 201, await mentorship.addProspect(user, body));
      return;
    }
    if (action === 'remove') {
      await records.remove(user, body.recordId);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'update') {
      const { key, kind, ...changes } = body;
      const allowed = {};
      ['status', 'track', 'owner'].forEach((f) => {
        if (changes[f] !== undefined) allowed[f] = changes[f];
      });
      sendJson(res, 200, await mentorship.update(user, key, kind, allowed));
    } else if (action === 'note') {
      await mentorship.addNote(user, body.key, body.kind, body.body);
      sendJson(res, 201, { ok: true });
    } else if (action === 'match') {
      sendJson(
        res,
        201,
        await mentorship.createMatch(user, body.mentorKey, body.menteeKey, body.track)
      );
    } else if (action === 'end-match') {
      await mentorship.endMatch(user, body.id);
      sendJson(res, 200, { ok: true });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
