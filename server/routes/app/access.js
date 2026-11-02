// /api/app/access: who can open a tool, for the faces at the top of its pages
// (the tools without items shared one by one: site content, the mentorship
// board and selection, the members' applications and board; the polls and
// forms show their own on each card).
//   GET ?tool=<key of src/data/tools.js>[&section=<key of its sections>]
//        -> { access: [{ kind: 'person' | 'role', name, avatarUrl?, what }] }
// Only for someone who can open that tool themselves. It says who holds the
// tool's permissions, by Discord role and by name (and, for the selection, who
// reviews), never anything about the tool's content.
const { route, sendJson, getQuery, HttpError } = require('../../http');
const { requireUser } = require('../../auth');
const permissions = require('../../permissions');
const tools = require('../../../src/data/tools');

const WITH_FACES = tools.filter((t) => t.faces).map((t) => t.key);

/** The labels of these keys, without the tool's own prefix ("CRM: "). */
function labels(keys) {
  return keys
    .map((k) => permissions.PERMISSIONS.find((p) => p.key === k).label)
    .map((l) => l.replace(/^(CRM|Forms|Mentee selection): /, ''))
    .map((l) => l.charAt(0).toUpperCase() + l.slice(1))
    .join(', ');
}

/**
 * Who opens `tool`, or one of its parts (`section`, a box on its page): who
 * holds the part's key, one of the keys the tool needs (`needsAny`), or a
 * key of its area.
 */
async function accessOf(tool, section) {
  const area = tool.area;
  const inArea = section
    ? [section.needs]
    : tool.needsAny || permissions.PERMISSIONS.filter((p) => p.area === area).map((p) => p.key);
  const out = [];
  for (const r of await permissions.listRolePermissions()) {
    const keys = r.permissions.filter(
      (k) => inArea.includes(k) && !permissions.PEOPLE_ONLY.includes(k)
    );
    if (keys.length) out.push({ kind: 'role', name: r.roleName, what: `Role: ${labels(keys)}` });
  }
  for (const p of await permissions.listUserPermissions()) {
    const keys = p.permissions.filter((k) => inArea.includes(k));
    if (keys.length)
      out.push({ kind: 'person', name: p.name, avatarUrl: p.avatarUrl, what: labels(keys) });
  }
  if (area === 'review') {
    // Required here: the selection's module reads the permissions too.
    for (const r of await require('../../crm/review').reviewers()) {
      const known = out.find((o) => o.kind === 'person' && o.name === r.name);
      if (known) known.what += ', reviewer';
      else out.push({ kind: 'person', name: r.name, avatarUrl: r.avatarUrl, what: 'Reviewer' });
    }
  }
  return out;
}

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const tool = tools.find((t) => t.key === getQuery(req).tool);
    if (!tool || !WITH_FACES.includes(tool.key)) throw new HttpError(404, 'Unknown tool');
    const areas = permissions.areas(await permissions.forUser(user));
    if (tool.area === 'review' && !areas.review)
      areas.review = await require('../../crm/review').isReviewer(user);
    const perms = await permissions.forUser(user);
    const { section: sectionKey } = getQuery(req);
    const section = sectionKey ? (tool.sections || []).find((x) => x.key === sectionKey) : null;
    if (sectionKey && !section) throw new HttpError(404, 'Unknown part');
    const needed = section ? [section.needs] : tool.needsAny;
    if (!areas[tool.area] || (needed && !needed.some((k) => perms.includes(k))))
      throw new HttpError(403, 'You cannot open this tool');
    sendJson(res, 200, { access: await accessOf(tool, section) });
  },
});

module.exports.accessOf = accessOf;
