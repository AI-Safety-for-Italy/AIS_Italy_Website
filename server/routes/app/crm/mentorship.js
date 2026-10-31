// /api/app/crm/mentorship: the mentorship board. Every call needs the
// `mentorship` permission (server/access.js); changes re-read the Discord
// roles first. Everything read or changed is on the audit trail.
//   GET                                   -> the board: { mentors, mentees, matches, … }
//   GET  ?key=…&kind=mentor|mentee        -> one person, with notes and history
//   POST ?action=update  { key, kind, status?, track?, owner?: 'me'|'none' }
//   POST ?action=note    { key, kind, body }
//   POST ?action=match   { mentorKey, menteeKey, track }
//   POST ?action=end-match { id }
const { route, sendJson, readJson, getQuery, HttpError } = require('../../../http');
const { requireUser } = require('../../../auth');
const access = require('../../../access');
const crypto = require('../../../crm/crypto');
const mentorship = require('../../../crm/mentorship');

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
    const { user, perms } = await door(req);
    const { key, kind } = getQuery(req);
    if (key) {
      sendJson(res, 200, await mentorship.person(user, perms, key, kind));
      return;
    }
    sendJson(res, 200, await mentorship.board(user));
  },

  async POST(req, res) {
    const { user } = await door(req, { write: true });
    const { action } = getQuery(req);
    const body = await readJson(req);
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
