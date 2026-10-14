// /api/poll?p=<poll token>[&e=<edit token>][&i=<invite token>]
// Public: anyone with the link, or for an invite-only poll, a guest's
// personal link (the invite token).
//   GET   -> the poll, the slots and (unless hidden) everyone's answers
//   GET   &check=1&name=…&email=… -> { nameTaken, emailTaken }
//   POST  { name, email, votes: { slotId: 0|1|2 }, editToken?, inviteToken? }
//         -> { editToken }
const { route, sendJson, readJson, getQuery, origin } = require('../server/http');
const polls = require('../server/polls');
const notify = require('../server/notify');

// Owner notifications go out before answering (a Vercel function may be
// frozen once it has replied), but never hold the voter up for long.
const NOTIFY_BUDGET_MS = 8000;

async function notifyOwner(result, site) {
  const { poll } = result;
  if (result.isNew) {
    await notify.notifyOwner(poll.id, notify.newAnswerMessage({ ...result, origin: site }));
  }
  const everyone = await polls.markAllAnswered(poll.id);
  if (everyone) {
    await notify.notifyOwner(
      poll.id,
      notify.allAnsweredMessage({ poll, count: everyone, origin: site })
    );
  }
}

module.exports = route({
  async GET(req, res) {
    const query = getQuery(req);
    if (query.check) {
      sendJson(res, 200, await polls.checkAvailability(query.p, query));
    } else {
      sendJson(res, 200, await polls.getPollPublic(query.p, query.e, query.i));
    }
  },
  async POST(req, res) {
    const result = await polls.submitResponse(getQuery(req).p, await readJson(req));
    let timer;
    await Promise.race([
      notifyOwner(result, origin(req)).catch((err) => console.error('Notification failed', err)),
      new Promise((resolve) => (timer = setTimeout(resolve, NOTIFY_BUDGET_MS))),
    ]);
    clearTimeout(timer);
    sendJson(res, 200, { editToken: result.editToken });
  },
});
