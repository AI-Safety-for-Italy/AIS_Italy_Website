// /api/app/permissions: who may do what in the personal area
// (/app/settings/permissions/), for whoever holds `manage`.
//   GET  -> { keys, roles, table, people, candidates, grantable, canGrantAll }
//           roles: the Discord server's roles ({ id, name, main }: main for
//           Admin, Direttivo, Organizzatori, Partecipanti; the others are
//           shown apart); table: what each role holds; people: who holds keys
//           by name (with their Discord roles); candidates: who can be added;
//           grantable: the keys this user may change
//   PUT  { roles, people }  -> saves both  -> { table, people }
// The rules (who may hand out which key) are in server/permissions.js.
const { route, sendJson, readJson } = require('../../http');
const { requireUser } = require('../../auth');
const access = require('../../access');
const permissions = require('../../permissions');

module.exports = route({
  async GET(req, res) {
    const user = await requireUser(req);
    const perms = await access.authorize(user, 'manage');
    const [roles, table, people, candidates] = await Promise.all([
      permissions.guildRoles(),
      permissions.listRolePermissions(),
      permissions.listUserPermissions(),
      permissions.discordPeople(),
    ]);
    sendJson(res, 200, {
      keys: permissions.PERMISSIONS,
      roles: roles.map((r) => ({ ...r, main: permissions.isMainRole(r) })),
      table: table.map((r) => ({
        ...r,
        main: permissions.isMainRole({ id: r.roleId, name: r.roleName }),
      })),
      people,
      candidates,
      grantable: permissions.grantable(user, perms),
      canGrantAll: permissions.canGrantAll(user),
    });
  },

  async PUT(req, res) {
    const user = await requireUser(req);
    const perms = await access.authorize(user, 'manage', { fresh: true });
    // Handing out personal-data keys asks for a recent sign-in, like reading them.
    if (perms.includes('manage_all')) await access.authorize(user, 'manage_all');
    const body = await readJson(req);
    const saved = await permissions.savePermissions(
      { roles: body.roles, people: body.people },
      user
    );
    sendJson(res, 200, { table: saved.roles, people: saved.people });
  },
});
