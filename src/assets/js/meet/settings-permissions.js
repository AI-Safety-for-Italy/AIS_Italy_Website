/* /app/settings/permissions/: who may do what in the personal area. On the
 * left, the Discord roles and the people given permissions by name, each
 * with what it opens; on the right, the one picked, its permissions grouped
 * by tool, one switch each with what it allows. The API
 * (/api/app/permissions, server/permissions.js) enforces who may change what. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var page = document.getElementById('permPage');
  var roleList = document.getElementById('roleList');
  var peopleList = document.getElementById('peopleList');
  var detail = document.getElementById('permDetail');
  var pick = document.getElementById('personPick');
  var errorBox = document.getElementById('permError');
  var status = document.getElementById('permStatus');
  var STATUS_TEXT = status.textContent;
  var roles = []; // [{ roleId, roleName, permissions: [], unlisted }]
  var people = []; // [{ userId, name, avatarUrl, permissions: [] }]
  var candidates = []; // [{ userId, name, avatarUrl }]
  var keys = [];
  var grantable = null; // the keys this user may change (null: all)
  var selected = null; // the role or person shown on the right
  var dirty = false;

  // Groups take the names of the tools (src/data/tools.js) and of Settings
  // (src/data/appSettings.js), in the sidebar's order: a tool inside a group
  // of the sidebar (src/data/toolGroups.js) is named as there, "Mentorship ›
  // Selection", so each part is given apart, as it opens apart.
  var groupTitle = {};
  var areaOrder = [];
  try {
    var toolGroups = JSON.parse(document.getElementById('apToolGroups').textContent);
    JSON.parse(document.getElementById('apTools').textContent).forEach(function (tool) {
      // keysArea: a tool open to every member whose keys still have an area.
      var area = tool.area || tool.keysArea;
      if (!area || groupTitle[area]) return;
      areaOrder.push(area);
      groupTitle[area] =
        tool.group && toolGroups[tool.group]
          ? toolGroups[tool.group].title + ' › ' + (tool.navLabel || tool.title)
          : tool.title;
    });
    groupTitle.settings = JSON.parse(document.getElementById('apSettings').textContent).title;
  } catch (e) {
    /* the keys' own areas are shown instead */
  }

  detail.appendChild(M.loading());

  Promise.all([M.me, M.api('GET', '/api/app/permissions')])
    .then(function (r) {
      var data = r[1];
      keys = data.keys;
      grantable = data.grantable || null;
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
          main: role.main,
          rank: role.rank,
          permissions: saved ? saved.permissions.slice() : [],
        };
      });
      // Roles in the table that the server list did not return (deleted on
      // Discord, or no bot here): kept, and marked.
      Object.keys(byId).forEach(function (id) {
        roles.push({
          roleId: id,
          roleName: byId[id].roleName,
          main: byId[id].main,
          rank: byId[id].rank,
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
          roles: p.roles || [],
          permissions: p.permissions.slice(),
        };
      });
      candidates = data.candidates;
      selected =
        roles
          .filter(function (r) {
            return r.main;
          })
          .sort(function (a, b) {
            return a.rank - b.rank;
          })[0] ||
        roles[0] ||
        people[0] ||
        null;
      render();
    })
    .catch(function (err) {
      M.clear(detail);
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

  /** The keys grouped as the sidebar orders the tools, Settings last:
   * [{ group, title, keys: [key] }]. */
  function groups() {
    var out = [];
    keys.forEach(function (k) {
      var g = k.group || k.area;
      var last = out.filter(function (x) {
        return x.group === g;
      })[0];
      if (!last) {
        last = { group: g, title: groupTitle[g] || g, keys: [] };
        out.push(last);
      }
      last.keys.push(k);
    });
    // As the sidebar lists the tools; Settings, and what no tool opens, last.
    function rank(g) {
      if (g.group === 'settings') return 1e6;
      var i = areaOrder.indexOf(g.group);
      return i === -1 ? 1e5 : i;
    }
    return out.sort(function (a, b) {
      return rank(a) - rank(b);
    });
  }

  /** "CRM: people" -> "People": the group above already names the tool, and
   * a key named like its tool ("Forms" under Forms) is its "Access". */
  function shortLabel(k, g) {
    if (k.label === g.title) return 'Access';
    var s = k.label.replace(/^(CRM|Forms|Mentee selection): /, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** The tools a row opens, for the list on the left. */
  function opens(row) {
    return groups()
      .filter(function (g) {
        return g.keys.some(function (k) {
          return row.permissions.indexOf(k.key) !== -1;
        });
      })
      .map(function (g) {
        return g.title;
      });
  }

  function locked(k) {
    // The server refuses these too: the lock is only a courtesy.
    return Boolean(grantable) && grantable.indexOf(k.key) === -1;
  }

  function markDirty() {
    dirty = true;
    status.textContent = 'Unsaved changes';
    status.classList.add('is-dirty');
  }

  function navItem(row, label, avatar, note) {
    var tools = opens(row);
    return h(
      'button',
      {
        type: 'button',
        class: 'perm-nav-item' + (row === selected ? ' is-selected' : ''),
        'aria-current': row === selected ? 'true' : 'false',
        onclick: function () {
          selected = row;
          render();
          // In one column the switches are below the list: go to them.
          if (window.matchMedia('(max-width: 900px)').matches) {
            detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        },
      },
      avatar,
      h(
        'span',
        { class: 'perm-nav-text' },
        h('strong', null, label),
        h(
          'small',
          null,
          note ||
            (tools.length
              ? tools.length > 3
                ? tools.slice(0, 3).join(' · ') + ' · +' + (tools.length - 3)
                : tools.join(' · ')
              : 'Meeting polls only')
        )
      ),
      h('span', { class: 'perm-count' }, String(row.permissions.length))
    );
  }

  function roleItem(r) {
    return navItem(
      r,
      r.roleName,
      h('span', { class: 'perm-role-dot', 'aria-hidden': 'true' }),
      r.unlisted ? 'No longer on Discord' : null
    );
  }

  // The association's roles (Admin, Direttivo, Organizzatori, Partecipanti)
  // first; the others (the working groups' roles, used as tags, and the
  // rest) folded under "Other roles", open when one of them is picked.
  var othersOpen = false;
  function renderNav() {
    M.clear(roleList);
    // Admin, Direttivo, Organizzatori, Partecipanti, in this order.
    var main = roles
      .filter(function (r) {
        return r.main;
      })
      .sort(function (a, b) {
        return a.rank - b.rank;
      });
    var others = roles.filter(function (r) {
      return !r.main;
    });
    // Without the association's roles found (no bot here), all are shown.
    if (!main.length) {
      main = roles;
      others = [];
    }
    main.forEach(function (r) {
      roleList.appendChild(roleItem(r));
    });
    if (!roles.length) {
      roleList.appendChild(h('p', { class: 'perm-empty' }, 'No roles yet.'));
    }
    if (others.length) {
      var withKeys = others.filter(function (r) {
        return r.permissions.length;
      }).length;
      var fold = h(
        'details',
        {
          class: 'perm-others',
          ontoggle: function () {
            othersOpen = fold.open;
          },
        },
        h(
          'summary',
          null,
          'Other roles (' + others.length + ')',
          withKeys ? h('span', { class: 'perm-others-note' }, withKeys + ' with permissions') : null
        ),
        others.map(roleItem)
      );
      fold.open = othersOpen || others.indexOf(selected) !== -1;
      roleList.appendChild(fold);
    }

    M.clear(peopleList);
    people.forEach(function (p) {
      peopleList.appendChild(navItem(p, p.name, M.avatar(p, 26)));
    });
    if (!people.length) {
      peopleList.appendChild(
        h('p', { class: 'perm-empty' }, 'Nobody has permissions of their own yet.')
      );
    }

    // Who can still be added: signed in once, and not listed yet.
    M.clear(pick);
    var listed = {};
    people.forEach(function (p) {
      listed[p.userId] = true;
    });
    var free = candidates.filter(function (c) {
      return !listed[c.userId];
    });
    pick.appendChild(
      h('option', { value: '' }, free.length ? 'Choose someone…' : 'Nobody else to add')
    );
    free.forEach(function (c) {
      pick.appendChild(h('option', { value: c.userId }, c.name));
    });
    pick.disabled = !free.length;
  }

  function renderDetail() {
    M.clear(detail);
    if (!selected) {
      detail.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'Nothing to show'),
          h('p', null, 'Add a role or a person on the left.')
        )
      );
      return;
    }
    var isPerson = people.indexOf(selected) !== -1;
    var removable = isPerson || selected.unlisted;
    detail.appendChild(
      h(
        'div',
        { class: 'perm-head' },
        isPerson
          ? M.avatar(selected, 40)
          : h('span', { class: 'perm-role-dot is-big', 'aria-hidden': 'true' }),
        h(
          'div',
          null,
          h('h2', null, isPerson ? selected.name : selected.roleName),
          h(
            'p',
            { class: 'panel-note', style: 'margin:0' },
            isPerson
              ? 'On top of what their Discord roles allow: what is on here adds to their roles, it never takes anything away.'
              : 'Everyone with this role on Discord. A member with several roles gets what all of them allow together.'
          )
        ),
        removable
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm perm-remove-btn',
                onclick: function () {
                  var list = isPerson ? people : roles;
                  list.splice(list.indexOf(selected), 1);
                  selected = roles[0] || people[0] || null;
                  markDirty();
                  render();
                },
              },
              isPerson ? 'Remove person' : 'Remove role'
            )
          : null
      )
    );

    var inherited = isPerson ? fromRoles(selected) : {};
    groups().forEach(function (g) {
      var count = h('span', { class: 'perm-group-count' });
      // A switch changes its group's count and the list on the left only:
      // drawing the whole page again would send it back to the top.
      function showCount() {
        var on = g.keys.filter(function (k) {
          return selected.permissions.indexOf(k.key) !== -1 || inherited[k.key];
        }).length;
        count.className = 'perm-group-count' + (on ? ' is-on' : '');
        count.textContent = on + ' / ' + g.keys.length;
      }
      showCount();
      detail.appendChild(
        h(
          'section',
          { class: 'perm-group' },
          h('div', { class: 'perm-group-head' }, h('h3', null, g.title), count),
          g.keys.map(function (k) {
            var input = h('input', {
              type: 'checkbox',
              role: 'switch',
              class: 'fe-switch-input',
              'aria-label': k.label,
              onchange: function () {
                var i = selected.permissions.indexOf(k.key);
                if (input.checked && i === -1) selected.permissions.push(k.key);
                if (!input.checked && i !== -1) selected.permissions.splice(i, 1);
                markDirty();
                showCount();
                renderNav();
              },
            });
            input.checked = selected.permissions.indexOf(k.key) !== -1;
            // Some keys go to people by name only, never to a Discord role.
            var forPeopleOnly = k.peopleOnly && !isPerson;
            // A person already holding it through a Discord role: shown on,
            // and changed on that role, not here.
            var viaRoles = inherited[k.key];
            if (viaRoles) input.checked = true;
            input.disabled = locked(k) || forPeopleOnly || Boolean(viaRoles);
            return h(
              'label',
              {
                class:
                  'perm-row' + (viaRoles ? ' is-inherited' : input.disabled ? ' is-locked' : ''),
              },
              h(
                'span',
                { class: 'perm-row-text' },
                h(
                  'strong',
                  null,
                  shortLabel(k, g),
                  viaRoles
                    ? h(
                        'span',
                        { class: 'perm-from-role', title: 'Change it on the role' },
                        'From role: ' + viaRoles.join(', ')
                      )
                    : input.disabled
                    ? h(
                        'span',
                        {
                          class: 'perm-lock',
                          title: forPeopleOnly ? 'Given to people only' : 'Not yours to change',
                        },
                        ' 🔒'
                      )
                    : null
                ),
                k.help ? h('small', null, k.help) : null
              ),
              input
            );
          })
        )
      );
    });
  }

  /**
   * What a person holds through their Discord roles, as the roles stand on
   * this page (unsaved changes included): { key: [role names] }. The keys
   * given to people only never come from a role.
   */
  function fromRoles(person) {
    var out = {};
    roles.forEach(function (r) {
      if ((person.roles || []).indexOf(r.roleId) === -1) return;
      r.permissions.forEach(function (key) {
        var k = keys.filter(function (x) {
          return x.key === key;
        })[0];
        if (!k || k.peopleOnly) return;
        (out[key] = out[key] || []).push(r.roleName);
      });
    });
    return out;
  }

  function render() {
    renderNav();
    renderDetail();
  }

  document.getElementById('addRole').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = document.getElementById('roleId').value.trim();
    var name = document.getElementById('roleName').value.trim();
    if (!id || !name) return;
    var found = roles.filter(function (r) {
      return r.roleId === id;
    })[0];
    if (!found) {
      found = { roleId: id, roleName: name, permissions: [] };
      roles.push(found);
      markDirty();
    }
    selected = found;
    e.target.reset();
    render();
  });

  document.getElementById('addPerson').addEventListener('submit', function (e) {
    e.preventDefault();
    var who = candidates.filter(function (c) {
      return c.userId === pick.value;
    })[0];
    if (!who) return;
    var row = {
      userId: who.userId,
      name: who.name,
      avatarUrl: who.avatarUrl,
      roles: who.roles || [],
      permissions: [],
    };
    people.push(row);
    selected = row;
    markDirty();
    render();
  });

  M.unsaved(
    function () {
      return dirty;
    },
    {
      buttons: function () {
        return [document.getElementById('savePerms')];
      },
    }
  );

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
        dirty = false;
        status.textContent = STATUS_TEXT;
        status.classList.remove('is-dirty');
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
