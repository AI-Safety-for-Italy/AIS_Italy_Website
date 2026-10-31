// /api/app/*: every API of the personal area, as ONE Vercel function.
//
// The hosting plan allows a limited number of functions per deploy (12), and
// each tool of /app/ would add its own. So the handlers live in
// server/routes/app/ and this function sends each request to the right one:
// /api/app/forms -> server/routes/app/forms.js, /api/app/crm/mentorship ->
// server/routes/app/crm/mentorship.js. The URLs stay the same.
//
// On Vercel a rewrite in vercel.json turns /api/app/<route> into
// /api/app?__route=<route>; the local server (scripts/meet-dev.js) calls this
// file with the original path. A new tool adds its handler below.
const { sendJson } = require('../server/http');

const ROUTES = {
  content: require('../server/routes/app/content'),
  'crm/mentorship': require('../server/routes/app/crm/mentorship'),
  forms: require('../server/routes/app/forms'),
  members: require('../server/routes/app/members'),
  overview: require('../server/routes/app/overview'),
  poll: require('../server/routes/app/poll'),
  polls: require('../server/routes/app/polls'),
  settings: require('../server/routes/app/settings'),
};

/** The route asked for: from the rewrite's __route, or from the path. */
function routeOf(req) {
  const url = new URL(req.url, 'http://localhost');
  const given = url.searchParams.get('__route');
  const name = given !== null ? given : url.pathname.replace(/^\/api\/app\/?/, '');
  return name.replace(/\/+$/, '');
}

module.exports = (req, res) => {
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, routeOf(req))
    ? ROUTES[routeOf(req)]
    : null;
  if (!handler) return sendJson(res, 404, { error: 'Not found' });
  return handler(req, res);
};

module.exports.routeOf = routeOf;
module.exports.ROUTES = ROUTES;
