/* /app/content/permissions/: which Discord role may publish what. One row
 * per role of the server (read by the bot), one column per permission. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var box = document.getElementById('permTable');
  var errorBox = document.getElementById('permError');
  var rows = []; // [{ roleId, roleName, permissions: [] }]
  var keys = [];

  box.appendChild(M.loading());

  M.me
    .then(function () {
      return M.api('GET', '/api/app/content?action=roles');
    })
    .then(function (data) {
      keys = data.keys;
      var byId = {};
      data.table.forEach(function (r) {
        byId[r.roleId] = r;
      });
      rows = data.roles.map(function (role) {
        var saved = byId[role.id];
        delete byId[role.id];
        return {
          roleId: role.id,
          roleName: role.name,
          permissions: saved ? saved.permissions.slice() : [],
        };
      });
      // Roles in the table that the server list did not return (deleted on
      // Discord, or no bot here): kept, and marked.
      Object.keys(byId).forEach(function (id) {
        rows.push({
          roleId: id,
          roleName: byId[id].roleName,
          permissions: byId[id].permissions.slice(),
          unlisted: data.roles.length > 0,
        });
      });
      if (!data.roles.length) {
        document.getElementById('noBot').hidden = false;
        document.getElementById('addRole').hidden = false;
      }
      render();
    })
    .catch(function (err) {
      M.clear(box);
      if (err.status === 403) {
        box.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h('p', null, 'Only roles with “Manage permissions” can change this.')
          )
        );
        document.getElementById('savePerms').hidden = true;
        return;
      }
      M.appError(err);
    });

  function render() {
    M.clear(box);
    box.appendChild(
      h(
        'table',
        { class: 'results perm-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { class: 'r-name', scope: 'col' }, 'Discord role'),
            keys.map(function (k) {
              return h('th', { scope: 'col' }, k.label);
            })
          )
        ),
        h(
          'tbody',
          null,
          rows.map(function (r) {
            return h(
              'tr',
              null,
              h(
                'th',
                { class: 'r-name', scope: 'row' },
                r.roleName,
                r.unlisted ? h('small', null, ' · no longer on Discord') : null
              ),
              keys.map(function (k) {
                var check = h('input', {
                  type: 'checkbox',
                  'aria-label': r.roleName + ': ' + k.label,
                  onchange: function () {
                    var i = r.permissions.indexOf(k.key);
                    if (check.checked && i === -1) r.permissions.push(k.key);
                    if (!check.checked && i !== -1) r.permissions.splice(i, 1);
                  },
                });
                check.checked = r.permissions.indexOf(k.key) !== -1;
                return h('td', null, check);
              })
            );
          })
        )
      )
    );
  }

  document.getElementById('addRole').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = document.getElementById('roleId').value.trim();
    var name = document.getElementById('roleName').value.trim();
    if (!id || !name) return;
    if (
      !rows.some(function (r) {
        return r.roleId === id;
      })
    ) {
      rows.push({ roleId: id, roleName: name, permissions: [] });
    }
    e.target.reset();
    render();
  });

  document.getElementById('savePerms').addEventListener('click', function (e) {
    var btn = e.currentTarget;
    btn.disabled = true;
    errorBox.hidden = true;
    M.api('PUT', '/api/app/content?action=roles', {
      table: rows.map(function (r) {
        return { roleId: r.roleId, roleName: r.roleName, permissions: r.permissions };
      }),
    })
      .then(function () {
        M.toast('Permissions saved');
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      })
      .then(function () {
        btn.disabled = false;
      });
  });
})();
