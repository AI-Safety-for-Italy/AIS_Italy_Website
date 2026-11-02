// What waits for a member in each tool of the personal area: the counts on
// the sidebar and the home page (/api/app/overview). Numbers only, never who
// or what, so the counts need no more than the permission that opens the tool.
//
// A tool adds its count here: a function (user, ctx) -> { count, label, url }
// or null, under the tool's key in src/data/tools.js. ctx holds the user's
// permission keys, areas and Discord roles.

const db = require('./db');
const permissions = require('./permissions');
const follows = require('./follows');

const COUNTS = {
  // Own polls where everyone invited has answered: a time to choose.
  async polls(user) {
    const { rows } = await db.query(
      `select count(*) filter (where all_answered_at is not null)::int as ready,
              count(*)::int as open
       from polls where owner_id = $1 and status = 'open'`,
      [user.id]
    );
    return {
      count: rows[0].ready,
      label: rows[0].ready === 1 ? 'poll ready to choose a time' : 'polls ready to choose a time',
      open: rows[0].open,
      url: '/app/polls/',
    };
  },

  // New answers to the forms this member follows ("Notify me"): seeing a
  // form is not following it.
  async forms(user, ctx) {
    if (!ctx.areas.forms) return null;
    const n = await require('./forms/forms').followedNewAnswers(user);
    return {
      count: n,
      label: n === 1 ? 'new answer' : 'new answers',
      url: '/app/forms/',
    };
  },

  // Applications nobody has decided on yet, for those following the board.
  async members(user, ctx) {
    if (!ctx.perms.includes('members')) return null;
    const following = await follows.isFollowing(user.id, 'members');
    const { rows } = following
      ? await db.query(
          `select count(*)::int as n from member_applications where status = 'pending'`
        )
      : { rows: [{ n: 0 }] };
    return {
      count: rows[0].n,
      label: rows[0].n === 1 ? 'application to review' : 'applications to review',
      url: '/app/members/',
    };
  },
};

/** { tools: { <key>: { count, label, url, … } } } for the tools this user may open. */
async function overview(user) {
  const [perms, roles] = await Promise.all([permissions.forUser(user), permissions.rolesOf(user)]);
  const areas = permissions.areas(perms);
  // Reading some form's answers opens the forms tool too (api/auth.js).
  if (!areas.forms) areas.forms = await require('./forms/forms').readsAny(user);
  const ctx = { perms, areas, roles };
  // The counts do not depend on each other: all at once.
  const results = await Promise.all(Object.values(COUNTS).map((count) => count(user, ctx)));
  const tools = {};
  Object.keys(COUNTS).forEach((key, i) => {
    if (results[i]) tools[key] = results[i];
  });
  return { tools };
}

module.exports = { overview };
