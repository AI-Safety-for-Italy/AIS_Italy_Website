// /api/app/crm/review: the mentee selection (server/crm/review.js). Every call
// needs an admin of the panel (`review_admin`) or a reviewer, and a recent
// sign-in; what each may do is checked below, and everything read or changed
// is on the audit trail. Reviewers never receive a name nor a person key.
// `part` is a section of the setup (its key).
//   GET                                   -> { admin, reviewer, sections: [{ key, total, done }] }
//   GET  ?part=<section>                  -> my list: { grid, items: [{ code, state }] }   (reviewer)
//   GET  ?part=…&code=…                   -> one application, anonymous, and my review  (reviewer)
//   POST ?action=score { part, code, scores, conflict?, comment? }                      (reviewer)
//   GET  ?action=summary                  -> everyone, with names and every score       (admin)
//   POST ?action=status { key, status }   -> the board's status of a mentee             (admin)
//   GET  ?action=settings                 -> { formId, sections, catalog, forms, reviewers… } (admin)
//   GET  ?action=questions&form=<id|>     -> a form's questions and a first split        (admin)
//   PUT  ?action=settings { formId?, nameQuestion?, sections? }                         (admin)
//   POST ?action=reviewers { add | remove: userId }                                     (admin)
const { route, sendJson, readJson, getQuery, HttpError } = require('../../../http');
const { requireUser } = require('../../../auth');
const crypto = require('../../../crm/crypto');
const review = require('../../../crm/review');

/** Signed in, CRM set up, admin or reviewer: returns { user, role }. */
async function door(req, { write = false } = {}) {
  const user = await requireUser(req);
  // The comments are encrypted with the CRM's keys: without them, refuse.
  if (!crypto.configured())
    throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
  const role = await review.roleOf(user, { fresh: write });
  return { user, role };
}

module.exports = route({
  async GET(req, res) {
    const { user, role } = await door(req);
    const { action, part, code, form } = getQuery(req);
    if (action === 'summary') {
      review.requireAdmin(role);
      sendJson(res, 200, await review.summary(user));
    } else if (action === 'settings') {
      review.requireAdmin(role);
      sendJson(res, 200, await review.settingsPage(user));
    } else if (action === 'questions') {
      review.requireAdmin(role);
      sendJson(res, 200, await review.questions(user, form));
    } else if (part && code) {
      review.requireReviewer(role);
      sendJson(res, 200, await review.application(user, part, code));
    } else if (part) {
      review.requireReviewer(role);
      sendJson(res, 200, await review.list(user, part));
    } else {
      sendJson(res, 200, await review.overview(user, role));
    }
  },

  async PUT(req, res) {
    if (getQuery(req).action !== 'settings') throw new HttpError(400, 'Unknown action');
    const { user, role } = await door(req, { write: true });
    review.requireAdmin(role);
    await review.saveSettings(user, await readJson(req));
    sendJson(res, 200, await review.settingsPage(user));
  },

  async POST(req, res) {
    const { action } = getQuery(req);
    // A score trusts roles checked in the last five minutes, as reads do, so
    // going through the list stays quick; the admins' changes ask Discord again.
    const { user, role } = await door(req, { write: action !== 'score' });
    const body = (await readJson(req)) || {};
    if (action === 'score') {
      review.requireReviewer(role);
      sendJson(res, 200, await review.score(user, body));
    } else if (action === 'status') {
      review.requireAdmin(role);
      sendJson(res, 200, await review.setStatus(user, body.key, body.status));
    } else if (action === 'reviewers') {
      review.requireAdmin(role);
      sendJson(res, 200, {
        reviewers: await review.setReviewer(user, { add: body.add, remove: body.remove }),
      });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
