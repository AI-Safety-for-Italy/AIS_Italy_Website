/* /app/members/groups/: the community's working groups (server/community.js):
 * their names and descriptions in both languages, their order on the site,
 * the Discord role each one is, and who coordinates each: the only place
 * coordinators are chosen. On Discord they are roles; here only
 * tags, never permissions. A new group needs its role made on Discord first.
 * The site shows the change once published (community-site.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var view = document.getElementById('groupsView');
  var groups = [];
  var members = []; // everyone, with their groups and levels (for the coordinators)
  var editing = null; // a group's id, or 'new'

  view.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', '/api/app/community')])
    .then(function (r) {
      groups = r[1].groups;
      members = r[1].members;
      M.communitySite.draw(r[1].site);
      render();
    })
    .catch(function (err) {
      M.clear(view);
      if (err.status === 403) {
        view.appendChild(
          h('div', { class: 'empty-state' }, h('h3', null, 'No access'), h('p', null, err.message))
        );
        return;
      }
      M.appError(err);
    });

  function render() {
    M.clear(view);
    view.appendChild(
      h(
        'p',
        { class: 'panel-note' },
        'Each group is a role on Discord: those in it get the role, and lose it when taken out (Members). Here the groups are only tags: they open nothing in the dashboard. The order is the site’s.'
      )
    );
    var list = h('div', { class: 'wg-list' });
    groups.forEach(function (g, i) {
      list.appendChild(editing === g.id ? form(g) : card(g, i));
    });
    view.appendChild(list);
    view.appendChild(
      editing === 'new'
        ? form(null)
        : h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                editing = 'new';
                render();
              },
            },
            '+ Add a working group'
          )
    );
  }

  function move(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= groups.length) return;
    var ids = groups.map(function (g) {
      return g.id;
    });
    var t = ids[i];
    ids[i] = ids[j];
    ids[j] = t;
    M.api('POST', '/api/app/community?action=order', { ids: ids })
      .then(function (r) {
        groups = r.groups;
        M.communitySite.changed();
        render();
      })
      .catch(M.appError);
  }

  function inGroup(m, g, level) {
    return m.groups.some(function (t) {
      return t.group === g.id && (!level || t.level === level);
    });
  }

  function setCoordinator(g, member, on) {
    return M.api('POST', '/api/app/community?action=coordinator', {
      group: g.id,
      member: member.id,
      on: on,
    })
      .then(function (r) {
        members = r.members;
        if (on && !inGroup(member, g)) g.members++;
        M.toast(member.name + (on ? ' coordinates ' : ' no longer coordinates ') + g.titleEn);
        render();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  /** Who coordinates the group: each can be taken back, others added. */
  function coordinators(g) {
    var current = members.filter(function (m) {
      return inGroup(m, g, 'coordination');
    });
    // Those in the group first, then everyone else.
    var others = members
      .filter(function (m) {
        return !inGroup(m, g, 'coordination');
      })
      .sort(function (a, b) {
        return (
          (inGroup(b, g) ? 1 : 0) - (inGroup(a, g) ? 1 : 0) || a.name.localeCompare(b.name, 'it')
        );
      });
    var pick = h(
      'select',
      {
        class: 'form-input is-compact wg-coord-pick',
        'aria-label': 'Add a coordinator of ' + g.titleEn,
        onchange: function () {
          var m = members.filter(function (x) {
            return x.id === pick.value;
          })[0];
          if (m) setCoordinator(g, m, true);
        },
      },
      h('option', { value: '' }, '+ Add a coordinator…'),
      others.map(function (m) {
        return h('option', { value: m.id }, m.name + (inGroup(m, g) ? '' : ' (not in the group)'));
      })
    );
    return h(
      'div',
      { class: 'wg-coords' },
      h('span', { class: 'wg-coords-label' }, 'Coordinators'),
      current.length
        ? current.map(function (m) {
            return h(
              'span',
              { class: 'tag-chip is-coordination wg-coord' },
              m.name,
              h(
                'button',
                {
                  type: 'button',
                  class: 'wg-coord-x',
                  'aria-label': m.name + ' no longer coordinates ' + g.titleEn,
                  title: 'No longer coordinates (still takes part)',
                  onclick: function () {
                    setCoordinator(g, m, false);
                  },
                },
                '×'
              )
            );
          })
        : h('span', { class: 'panel-note' }, 'None yet'),
      pick
    );
  }

  function card(g, i) {
    return h(
      'div',
      { class: 'panel wg-card' },
      h(
        'div',
        { class: 'wg-order' },
        h('button', {
          type: 'button',
          class: 'fe-tool',
          title: 'Up',
          'aria-label': 'Move ' + g.titleEn + ' up',
          disabled: i === 0 ? true : null,
          onclick: function () {
            move(i, -1);
          },
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6"/></svg>',
        }),
        h('button', {
          type: 'button',
          class: 'fe-tool',
          title: 'Down',
          'aria-label': 'Move ' + g.titleEn + ' down',
          disabled: i === groups.length - 1 ? true : null,
          onclick: function () {
            move(i, 1);
          },
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>',
        })
      ),
      h(
        'div',
        { class: 'wg-text' },
        h(
          'h3',
          null,
          g.titleEn,
          g.titleIt !== g.titleEn ? h('span', { class: 'panel-note' }, ' · ' + g.titleIt) : null
        ),
        g.descriptionEn ? h('p', null, g.descriptionEn) : null,
        h(
          'p',
          { class: 'panel-note', style: 'margin:0' },
          g.members +
            (g.members === 1 ? ' member' : ' members') +
            ' · Discord role ' +
            g.discordRoleId
        ),
        coordinators(g)
      ),
      h(
        'div',
        { class: 'wg-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              editing = g.id;
              render();
            },
          },
          'Edit'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger-outline btn-sm',
            onclick: function () {
              if (
                !window.confirm(
                  'Remove “' +
                    g.titleEn +
                    '”? Its ' +
                    g.members +
                    ' members lose the tag (and the role on Discord). The role itself stays on Discord.'
                )
              )
                return;
              M.api('DELETE', '/api/app/community?group=' + encodeURIComponent(g.id))
                .then(function (r) {
                  groups = r.groups;
                  M.communitySite.changed();
                  M.toast('Removed');
                  render();
                })
                .catch(M.appError);
            },
          },
          'Remove'
        )
      )
    );
  }

  function form(g) {
    var field = function (label, input, note) {
      return h(
        'div',
        null,
        h('label', { class: 'form-label' }, label, input),
        note ? h('p', { class: 'form-note', style: 'margin:.3rem 0 0' }, note) : null
      );
    };
    var titleEn = h('input', {
      class: 'form-input is-compact',
      maxlength: '80',
      value: g ? g.titleEn : '',
    });
    var titleIt = h('input', {
      class: 'form-input is-compact',
      maxlength: '80',
      value: g ? g.titleIt : '',
    });
    var descEn = h('textarea', { class: 'form-input is-compact', rows: '2', maxlength: '400' });
    descEn.value = g ? g.descriptionEn : '';
    var descIt = h('textarea', { class: 'form-input is-compact', rows: '2', maxlength: '400' });
    descIt.value = g ? g.descriptionIt : '';
    var role = h('input', {
      class: 'form-input is-compact',
      maxlength: '25',
      inputmode: 'numeric',
      value: g ? g.discordRoleId : '',
      placeholder: '1566885628547960922',
    });
    var error = h('p', { class: 'form-error', hidden: true });
    var save = h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm' },
      g ? 'Save' : 'Add the group'
    );
    save.addEventListener('click', function () {
      error.hidden = true;
      save.disabled = true;
      M.api('POST', '/api/app/community?action=group', {
        id: g ? g.id : undefined,
        titleEn: titleEn.value,
        titleIt: titleIt.value,
        descriptionEn: descEn.value,
        descriptionIt: descIt.value,
        discordRoleId: role.value.trim(),
      })
        .then(function () {
          return M.api('GET', '/api/app/community');
        })
        .then(function (d) {
          groups = d.groups;
          editing = null;
          M.communitySite.changed();
          M.toast(g ? 'Saved' : 'Group added');
          render();
        })
        .catch(function (err) {
          save.disabled = false;
          if (err.status === 401) return M.appError(err);
          error.textContent = err.message;
          error.hidden = false;
        });
    });
    return h(
      'div',
      { class: 'panel form-grid wg-form' },
      h('h3', { style: 'margin:0' }, g ? 'Edit ' + g.titleEn : 'A new working group'),
      h(
        'div',
        { class: 'fe-row' },
        field('Name (English)', titleEn),
        field('Name (Italian)', titleIt)
      ),
      h(
        'div',
        { class: 'fe-row' },
        field('Description (English)', descEn),
        field('Description (Italian)', descIt)
      ),
      field(
        'Discord role id',
        role,
        g
          ? 'Changing it moves everyone in the group to the new role on Discord.'
          : 'Make the role on Discord first (Server settings → Roles → Create Role), then right-click it → Copy Role ID. The bot’s own role must sit above it.'
      ),
      error,
      h(
        'div',
        { class: 'wk-nav' },
        save,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              editing = null;
              render();
            },
          },
          'Cancel'
        )
      )
    );
  }
})();
