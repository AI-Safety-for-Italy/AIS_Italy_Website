// What waits for a member in each tool of the personal area: the counts on
// the sidebar and the home page (/api/app/overview). Numbers only, never who
// or what, so the counts need no more than the permission that opens the tool.
//
// A tool adds its count here: a function (user, ctx) -> { count, label, url }
// or null, under the tool's key in src/data/tools.js. ctx holds the user's
// permission keys, areas and Discord roles.

const db = require('./db');
const permissions = require('./permissions');

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

  // New answers to the forms this member manages or reads.
  async forms(user, ctx) {
    if (!ctx.areas.forms) return null;
    const all = ctx.perms.includes('forms_admin');
    const { rows } = await db.query(
      `select count(*)::int as n from form_responses r join forms f on f.id = r.form_id
       where r.status = 'new' and r.deleted_at is null
         and ($1 or f.owner_id = $2 or f.access_roles && $3::text[])`,
      [all, user.id, ctx.roles]
    );
    return {
      count: rows[0].n,
      label: rows[0].n === 1 ? 'new answer' : 'new answers',
      url: '/app/forms/',
    };
  },

  // Applications nobody has decided on yet.
  async members(user, ctx) {
    if (!ctx.perms.includes('members')) return null;
    const { rows } = await db.query(
      `select count(*)::int as n from member_applications where status = 'pending'`
    );
    return {
      count: rows[0].n,
      label: rows[0].n === 1 ? 'application to review' : 'applications to review',
      url: '/app/members/',
    };
  },
};

/** { tools: { <key>: { count, label, url, … } } } for the tools this user may open. */
async function overview(user) {
  const perms = await permissions.forUser(user);
  const ctx = { perms, areas: permissions.areas(perms), roles: await permissions.rolesOf(user) };
  const tools = {};
  for (const [key, count] of Object.entries(COUNTS)) {
    const result = await count(user, ctx);
    if (result) tools[key] = result;
  }
  return { tools };
}

module.exports = { overview };
