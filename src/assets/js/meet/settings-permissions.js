/* /app/settings/permissions/: who may do what in the personal area. Two
 * tables with the same columns (the permission keys, grouped by tool): one
 * row per Discord role, and one row per person given keys by name. The API
 * (/api/app/permissions, server/permissions.js) enforces who may change what. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var page = document.getElementById('permPage');
  var roleBox = document.getElementById('roleTable');
  var peopleBox = document.getElementById('peopleTable');
  var pick = document.getElementById('personPick');
  var errorBox = document.getElementById('permError');
  var roles = []; // [{ roleId, roleName, permissions: [], unlisted }]
  var people = []; // [{ userId, name, avatarUrl, permissions: [] }]
  var candidates = []; // [{ userId, name, avatarUrl }]
  var keys = [];
  var canGrantAll = true;

  // Column groups take the names of the tools (src/data/tools.js) and of
  // Settings (src/data/appSettings.js), as the sidebar shows them.
  var groupTitle = {};
  try {
    JSON.parse(document.getElementById('apTools').textContent).forEach(function (tool) {
      if (tool.area && !groupTitle[tool.area]) groupTitle[tool.area] = tool.title;
    });
    groupTitle.settings = JSON.parse(document.getElementById('apSettings').textContent).title;
  } catch (e) {
    /* the keys' own areas are shown instead */
  }

  roleBox.appendChild(M.loading());

  M.me
    .then(function () {
      return M.api('GET', '/api/app/permissions');
    })
    .then(function (data) {
      keys = data.keys;
      canGrantAll = data.canGrantAll !== false;
      document.getElementById('permLocked').hidden = canGrantAll;
      var byId = {};
      data.table.forEach(function (r) {
        byId[r.roleId] = r;
      });
      roles = data.roles.map(function (role) {
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
        roles.push({
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
      people = data.people.map(function (p) {
        return {
          userId: p.userId,
          name: p.name,
          avatarUrl: p.avatarUrl,
          permissions: p.permissions.slice(),
        };
      });
      candidates = data.candidates;
      render();
    })
    .catch(function (err) {
      M.clear(roleBox);
      if (err.status === 403) {
        M.clear(page);
        page.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h('p', null, 'Only people with “Manage permissions” can change this.')
          )
        );
        return;
      }
      M.appError(err);
    });

  /** The keys in column order, with the group each belongs to: the tools
   * first, as in the sidebar, then Settings. */
  function columns() {
    var all = keys.map(function (k) {
      return { key: k, group: k.group || k.area };
    });
    return all
      .filter(function (c) {
        return c.group !== 'settings';
      })
      .concat(
        all.filter(function (c) {
          return c.group === 'settings';
        })
      );
  }

  /** "CRM: people" -> "People": the group above already names the tool,
   * and a key named like its tool ("Forms" under Forms) is its "Access". */
  function shortLabel(c) {
    if (c.key.label === groupTitle[c.group]) return 'Access';
    var s = c.key.label.replace(/^(CRM|Forms): /, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function head(firstLabel) {
    var groups = [];
    columns().forEach(function (c) {
      var last = groups[groups.length - 1];
      if (last && last.group === c.group) last.span++;
      else groups.push({ group: c.group, span: 1 });
    });
    return h(
      'thead',
      null,
      h(
        'tr',
        { class: 'r-date' },
        h('th', { class: 'r-name', scope: 'col' }),
        groups.map(function (g) {
          return h(
            'th',
            { scope: 'colgroup', colspan: String(g.span) },
            groupTitle[g.group] || g.group
          );
        })
      ),
      h(
        'tr',
        { class: 'r-time' },
        h('th', { class: 'r-name', scope: 'col' }, firstLabel),
        columns().map(function (c) {
          return h('th', { scope: 'col', title: c.key.label }, shortLabel(c));
        })
      )
    );
  }

  function checks(row, name) {
    return columns().map(function (c) {
      var k = c.key;
      var check = h('input', {
        type: 'checkbox',
        'aria-label': name + ': ' + k.label,
        onchange: function () {
          var i = row.permissions.indexOf(k.key);
          if (check.checked && i === -1) row.permissions.push(k.key);
          if (!check.checked && i !== -1) row.permissions.splice(i, 1);
        },
      });
      check.checked = row.permissions.indexOf(k.key) !== -1;
      // The server refuses these too: greying them out is only a courtesy.
      check.disabled = !canGrantAll && k.area !== 'content';
      return h('td', null, check);
    });
  }

  function render() {
    M.clear(roleBox);
    roleBox.appendChild(
      h(
        'table',
        { class: 'results perm-table' },
        head('Discord role'),
        h(
          'tbody',
          null,
          roles.map(function (r) {
            return h(
              'tr',
              null,
              h(
                'th',
                { class: 'r-name', scope: 'row' },
                r.roleName,
                r.unlisted ? h('small', null, ' · no longer on Discord') : null
              ),
              checks(r, r.roleName)
            );
          })
        )
      )
    );

    M.clear(peopleBox);
    if (!people.length) {
      peopleBox.appendChild(
        h('p', { class: 'perm-empty' }, 'Nobody has permissions of their own yet.')
      );
    } else {
      peopleBox.appendChild(
        h(
          'table',
          { class: 'results perm-table' },
          head('Person'),
          h(
            'tbody',
            null,
            people.map(function (p) {
              return h(
                'tr',
                null,
                h(
                  'th',
                  { class: 'r-name', scope: 'row' },
                  h(
                    'span',
                    { class: 'perm-person' },
                    M.avatar(p, 22),
                    h('span', null, p.name),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'perm-remove',
                        'aria-label': 'Remove ' + p.name,
                        title: 'Remove: they keep what their roles allow',
                        onclick: function () {
                          people.splice(people.indexOf(p), 1);
                          render();
                        },
                      },
                      '×'
                    )
                  )
                ),
                checks(p, p.name)
              );
            })
          )
        )
      );
    }

    // Who can still be added: signed in once, and not in the table yet.
    M.clear(pick);
    var listed = {};
    people.forEach(function (p) {
      listed[p.userId] = true;
    });
    var free = candidates.filter(function (c) {
      return !listed[c.userId];
    });
    pick.appendChild(
      h('option', { value: '' }, free.length ? 'Choose someone…' : 'Everyone is listed')
    );
    free.forEach(function (c) {
      pick.appendChild(h('option', { value: c.userId }, c.name));
    });
    pick.disabled = !free.length;
  }

  document.getElementById('addRole').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = document.getElementById('roleId').value.trim();
    var name = document.getElementById('roleName').value.trim();
    if (!id || !name) return;
    if (
      !roles.some(function (r) {
        return r.roleId === id;
      })
    ) {
      roles.push({ roleId: id, roleName: name, permissions: [] });
    }
    e.target.reset();
    render();
  });

  document.getElementById('addPerson').addEventListener('submit', function (e) {
    e.preventDefault();
    var who = candidates.filter(function (c) {
      return c.userId === pick.value;
    })[0];
    if (!who) return;
    people.push({ userId: who.userId, name: who.name, avatarUrl: who.avatarUrl, permissions: [] });
    render();
  });

  document.getElementById('savePerms').addEventListener('click', function (e) {
    var btn = e.currentTarget;
    btn.disabled = true;
    errorBox.hidden = true;
    M.api('PUT', '/api/app/permissions', {
      roles: roles.map(function (r) {
        return { roleId: r.roleId, roleName: r.roleName, permissions: r.permissions };
      }),
      people: people.map(function (p) {
        return { userId: p.userId, permissions: p.permissions };
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
