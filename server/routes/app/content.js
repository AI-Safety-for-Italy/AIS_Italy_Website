// /api/app/content: seminars and events published from the dashboard.
//   GET                           -> { items, permissions, activity, live }
//   GET    ?id=…                  -> one item: { …, form, versions }
//   POST   {fields}               -> publishes a new item  -> { id, publish }
//   PUT    ?id=… {fields}         -> saves changes         -> { id, publish }
//   DELETE ?id=…                  -> removes it from the site (restorable)
//   POST   ?action=restore&id=…&version=…  -> puts back an earlier version
//   POST   ?action=preview {fields}        -> the entry the fields make, or
//                                             the first validation error
//   POST   ?action=switch-on      -> imports data/events.yaml's seminars and
//                                    events and puts the site on them (manage)
//   POST   ?action=switch-off     -> the site goes back to the YAML (manage)
// `publish` says whether the rebuild started and the team was told
// (server/content-publish.js). Permissions: server/permissions.js, edited
// through /api/app/permissions.
const { route, sendJson, readJson, getQuery, siteUrl, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const content = require('../../content');
const access = require('../../access');
const permissions = require('../../permissions');
const publish = require('../../content-publish');

async function after(req, user, result) {
  return publish.afterSave({ user, result, siteOrigin: siteUrl(req) });
}

/**
 * The list, history and preview are for people who can publish something
 * here: a permission of the CRM board gives nothing in this tool.
 */
async function requireSomePermission(user) {
  if (!permissions.areas(await permissions.forUser(user)).content) {
    throw new HttpError(403, 'Your Discord roles do not give access to the content tool');
  }
}

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const query = getQuery(req);
    await requireSomePermission(user);
    if (query.id) {
      sendJson(res, 200, await content.getItem(query.id, user));
      return;
    }
    const list = await content.listItems(user);
    sendJson(res, 200, {
      ...list,
      activity: await content.recentActivity(),
      live: await content.isLive(),
    });
  },

  async POST(req, res) {
    const user = await requireUser(req);
    const query = getQuery(req);
    const body = await readJson(req);
    if (query.action === 'preview') {
      await requireSomePermission(user);
      sendJson(res, 200, { entry: content.toEntry(body) });
      return;
    }
    if (query.action === 'restore') {
      const result = await content.restoreVersion(user, query.id, query.version);
      sendJson(res, 200, { id: result.id, publish: await after(req, user, result) });
      return;
    }
    if (query.action === 'switch-on' || query.action === 'switch-off') {
      await access.authorize(user, 'manage', { fresh: true });
      const on = query.action === 'switch-on';
      let result = {};
      if (on) result = await content.switchOn(`${user.name} (switch on)`);
      else await content.setLive(false);
      sendJson(res, 200, { ...result, live: on, build: await publish.triggerBuild() });
      return;
    }
    if (query.action) throw new HttpError(400, 'Unknown action');
    const result = await content.saveItem(user, body);
    sendJson(res, 201, { id: result.id, publish: await after(req, user, result) });
  },

  async PUT(req, res) {
    const user = await requireUser(req);
    const query = getQuery(req);
    if (!query.id) throw new HttpError(400, 'Which item?');
    const result = await content.saveItem(user, await readJson(req), query.id);
    sendJson(res, 200, { id: result.id, publish: await after(req, user, result) });
  },

  async DELETE(req, res) {
    const user = await requireUser(req);
    const { id } = getQuery(req);
    if (!id) throw new HttpError(400, 'Which item?');
    const result = await content.deleteItem(user, id);
    sendJson(res, 200, { id: result.id, publish: await after(req, user, result) });
  },
});
