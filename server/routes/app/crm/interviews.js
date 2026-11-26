// /api/app/crm/interviews: the interviews of the mentee selection
// (server/crm/interviews.js). Every call needs an admin of the selection
// (`review_admin`) or an interviewer, and a recent sign-in; what each may do
// is checked below, and everything read or changed is on the audit trail.
//   GET                                    -> my shortlists to interview      (interviewer)
//   GET  ?action=session&project=…&key=…   -> one interview, mine             (interviewer)
//        …&interviewer=<userId>            -> someone's interview, read only  (admin)
//   PUT  ?action=session { project, key, scores?, conflict?, done?, heldOn?, notes?,
//                          transcript?, comment?, plan?, own?, notesByItem?, asked?,
//                          timer?: start|pause|reset, duration?: minutes|null } (interviewer)
//   GET  ?action=plan&project=…            -> my questions for a project      (interviewer)
//   PUT  ?action=plan { project, plan, own, duration?: minutes|null }         (interviewer)
//   GET  ?action=admin                     -> setup, interviewers, projects, progress (admin)
//   GET  ?action=scores                    -> the interviews' means by mentee (admin)
//   PUT  ?action=settings { criteria?, questions?, weight?, duration?, version? } (admin; 409 if stale)
//   POST ?action=interviewers { add | remove: userId }                     (admin)
//   POST ?action=assign { project, interviewerId, menteeKeys: null | [key] } (admin)
//   POST ?action=unassign { id }                                           (admin)
const { route, sendJson, readJson, getQuery, HttpError } = require('../../../http');
const { requireUser } = require('../../../auth');
const crypto = require('../../../crm/crypto');
const interviews = require('../../../crm/interviews');

/** Signed in, CRM set up, admin or interviewer: returns { user, role }. */
async function door(req, { write = false } = {}) {
  const user = await requireUser(req);
  // What is written is encrypted with the CRM's keys: without them, refuse.
  if (!crypto.configured())
    throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
  const role = await interviews.roleOf(user, { fresh: write });
  return { user, role };
}

module.exports = route({
  async GET(req, res) {
    const { user, role } = await door(req);
    const { action, project, key, interviewer } = getQuery(req);
    if (action === 'admin') {
      interviews.requireAdmin(role);
      sendJson(res, 200, await interviews.adminPage(user));
    } else if (action === 'scores') {
      interviews.requireAdmin(role);
      sendJson(res, 200, await interviews.scores(user));
    } else if (action === 'plan') {
      sendJson(res, 200, await interviews.planPage(user, project));
    } else if (action === 'session') {
      sendJson(
        res,
        200,
        await interviews.session(user, role, { project, key, interviewerId: interviewer })
      );
    } else if (!action) {
      sendJson(res, 200, await interviews.overview(user, role));
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },

  async PUT(req, res) {
    const { action } = getQuery(req);
    if (!['settings', 'session', 'plan'].includes(action))
      throw new HttpError(400, 'Unknown action');
    // Saving an interview (often, while it goes) trusts roles checked in the
    // last five minutes; the setup asks Discord again.
    const { user, role } = await door(req, { write: action === 'settings' });
    // An interview carries its transcript (up to 200,000 characters, more
    // once escaped in JSON): a larger body than the default.
    const body = (await readJson(req, action === 'session' ? { max: 2_000_000 } : undefined)) || {};
    if (action === 'session') {
      sendJson(res, 200, await interviews.save(user, body));
      return;
    }
    if (action === 'plan') {
      sendJson(res, 200, await interviews.savePlan(user, body));
      return;
    }
    interviews.requireAdmin(role);
    await interviews.saveSettings(user, body);
    sendJson(res, 200, await interviews.adminPage(user));
  },

  async POST(req, res) {
    const { action } = getQuery(req);
    if (!['interviewers', 'assign', 'unassign'].includes(action))
      throw new HttpError(400, 'Unknown action');
    const { user, role } = await door(req, { write: true });
    interviews.requireAdmin(role);
    const body = (await readJson(req)) || {};
    if (action === 'interviewers') {
      await interviews.setInterviewer(user, { add: body.add, remove: body.remove });
    } else if (action === 'assign') {
      await interviews.assign(user, body);
    } else {
      await interviews.unassign(user, body);
    }
    sendJson(res, 200, await interviews.adminPage(user));
  },
});
