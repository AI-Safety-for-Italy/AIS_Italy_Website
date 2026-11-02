/* /app/members/people/: the community's members (/api/app/community,
 * server/community.js). Their working groups are tags: picked people can be
 * put in a group, taken out, or moved to another, and Discord follows at
 * once; the site only when "Publish to the site" is pressed
 * (community-site.js). Also: one person's details and Discord account, and
 * the import of the old members sheet, with a preview first. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var view = document.getElementById('peopleView');
  var data = null;
  var picked = {};
  var filter = { q: '', group: '' };
  var LEVEL = { coordination: 'Coordinates', stable: 'Takes part' };

  view.appendChild(M.loading());
  load();

  function load() {
    Promise.all([M.me, M.api('GET', '/api/app/community')])
      .then(function (r) {
        data = r[1];
        M.communitySite.draw(data.site);
        render();
      })
      .catch(function (err) {
        M.clear(view);
        if (err.status === 403) {
          view.appendChild(
            h(
              'div',
              { class: 'empty-state' },
              h('h3', null, 'No access'),
              h('p', null, err.message)
            )
          );
          return;
        }
        M.appError(err);
      });
  }

  function groupTitle(id) {
    var g = data.groups.filter(function (x) {
      return x.id === id;
    })[0];
    return g ? g.titleEn : id;
  }

  function shown() {
    var q = filter.q.trim().toLowerCase();
    return data.members.filter(function (m) {
      if (filter.group === '__none' && m.groups.length) return false;
      if (filter.group && filter.group !== '__none') {
        if (
          !m.groups.some(function (g) {
            return g.group === filter.group;
          })
        )
          return false;
      }
      return !q || (m.name + ' ' + m.location).toLowerCase().indexOf(q) !== -1;
    });
  }

  function render() {
    M.clear(view);
    view.appendChild(toolbar());
    view.appendChild(bulkBar());
    view.appendChild(table());
    view.appendChild(importPanel());
  }

  function toolbar() {
    var search = h('input', {
      class: 'form-input is-compact',
      type: 'search',
      placeholder: 'Search by name or place',
      value: filter.q,
      'aria-label': 'Search the members',
    });
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        filter.q = search.value;
        var pos = search.selectionStart;
        render();
        var again = view.querySelector('.people-tools input[type=search]');
        again.focus();
        again.setSelectionRange(pos, pos);
      }, 180);
    });
    var group = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Working group',
        onchange: function () {
          filter.group = group.value;
          render();
        },
      },
      h('option', { value: '' }, 'Every group'),
      data.groups.map(function (g) {
        return h('option', { value: g.id }, g.titleEn + ' (' + g.members + ')');
      }),
      h('option', { value: '__none' }, 'In no group')
    );
    group.value = filter.group;
    return h(
      'div',
      { class: 'people-tools' },
      search,
      group,
      h('span', { class: 'panel-note' }, data.members.length + ' members'),
      h(
        'span',
        { class: 'people-legend people-tags' },
        h('span', { class: 'tag-chip is-coordination' }, 'Coordinates'),
        h('span', { class: 'tag-chip is-stable' }, 'Takes part')
      )
    );
  }

  function pickedIds() {
    return Object.keys(picked).filter(function (id) {
      return picked[id];
    });
  }

  // Picked people: put them in a group (taking part or coordinating), take
  // them out of one, or move them from one group to another.
  function bulkBar() {
    var ids = pickedIds();
    var bar = h('div', { class: 'bulk-bar', hidden: !ids.length });
    if (!ids.length) return bar;
    var action = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'What to do' },
      h('option', { value: 'add:stable' }, 'Put in the group, taking part'),
      h('option', { value: 'add:coordination' }, 'Put in the group, coordinating'),
      h('option', { value: 'remove' }, 'Take out of the group'),
      h('option', { value: 'move' }, 'Move from the group to…')
    );
    var groupSel = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Group' },
      data.groups.map(function (g) {
        return h('option', { value: g.id }, g.titleEn);
      })
    );
    var toSel = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'To the group', hidden: true },
      data.groups.map(function (g) {
        return h('option', { value: g.id }, g.titleEn);
      })
    );
    action.addEventListener('change', function () {
      toSel.hidden = action.value !== 'move';
    });
    var apply = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Apply');
    apply.addEventListener('click', function () {
      var parts = action.value.split(':');
      apply.disabled = true;
      M.api('POST', '/api/app/community?action=tags', {
        members: ids,
        action: parts[0],
        level: parts[1],
        group: groupSel.value,
        to: toSel.value,
      })
        .then(function (r) {
          var byId = {};
          r.members.forEach(function (m) {
            byId[m.id] = m;
          });
          data.members = data.members.map(function (m) {
            return byId[m.id] || m;
          });
          picked = {};
          M.toast(
            r.discordFailed
              ? 'Saved; Discord did not take ' + r.discordFailed + ' of the changes'
              : 'Saved, and on Discord'
          );
          M.communitySite.changed();
          return M.api('GET', '/api/app/community');
        })
        .then(function (d) {
          data.groups = d.groups;
          render();
        })
        .catch(function (err) {
          apply.disabled = false;
          M.appError(err);
        });
    });
    bar.appendChild(h('strong', null, ids.length + ' picked'));
    bar.appendChild(action);
    bar.appendChild(groupSel);
    bar.appendChild(toSel);
    bar.appendChild(apply);
    bar.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'link-button',
          onclick: function () {
            picked = {};
            render();
          },
        },
        'Clear'
      )
    );
    return bar;
  }

  function table() {
    var list = shown();
    if (!data.members.length) {
      return h(
        'div',
        { class: 'empty-state' },
        h('h3', null, 'No members yet'),
        h(
          'p',
          null,
          'Import the old members sheet below, or approve people on Applications: they join this list when they enter Discord.'
        )
      );
    }
    var all = h('input', {
      type: 'checkbox',
      'aria-label': 'Pick everyone shown',
      onchange: function () {
        list.forEach(function (m) {
          picked[m.id] = all.checked;
        });
        render();
      },
    });
    all.checked =
      list.length > 0 &&
      list.every(function (m) {
        return picked[m.id];
      });
    return h(
      'div',
      { class: 'results-wrap' },
      h(
        'table',
        { class: 'results people-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, all),
            h('th', null, 'Name'),
            h('th', null, 'Role'),
            h('th', null, 'Working groups'),
            h('th', null, 'On the site'),
            h('th', null, 'Discord')
          )
        ),
        h(
          'tbody',
          null,
          list.map(function (m) {
            var box = h('input', {
              type: 'checkbox',
              'aria-label': 'Pick ' + m.name,
              onchange: function () {
                picked[m.id] = box.checked;
                render();
              },
            });
            box.checked = Boolean(picked[m.id]);
            return h(
              'tr',
              { class: picked[m.id] ? 'is-picked' : '' },
              h('td', null, box),
              h(
                'td',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link-button people-name',
                    onclick: function () {
                      edit(m);
                    },
                  },
                  m.name
                ),
                m.location ? h('small', { class: 'people-sub' }, m.location) : null
              ),
              h('td', null, m.role === 'organizer' ? 'Organizer' : 'Participant'),
              h(
                'td',
                null,
                m.groups.length
                  ? h(
                      'span',
                      { class: 'people-tags' },
                      m.groups.map(function (g) {
                        return h(
                          'span',
                          {
                            class: 'tag-chip is-' + g.level,
                            title: LEVEL[g.level],
                          },
                          groupTitle(g.group)
                        );
                      })
                    )
                  : h('span', { class: 'panel-note' }, '—')
              ),
              h('td', null, m.publish ? 'Yes' : h('span', { class: 'panel-note' }, 'No')),
              h(
                'td',
                null,
                m.discordId
                  ? h('span', { class: 'badge badge-open' }, 'Linked')
                  : h('span', { class: 'panel-note' }, 'Not linked')
              )
            );
          })
        )
      )
    );
  }

  // ── One person ───────────────────────────────────────────────────────────

  var dialog = document.getElementById('memberDialog');
  var editing = null;
  var discordPick = null;

  function edit(m) {
    editing = m;
    discordPick = undefined;
    document.getElementById('memberTitle').textContent = m.name;
    document.getElementById('mName').value = m.name;
    document.getElementById('mProfile').value = m.profile;
    document.getElementById('mLocation').value = m.location;
    document.getElementById('mAreas').value = m.areas;
    document.getElementById('mPublish').checked = m.publish;
    document.getElementById('mDiscord').textContent = m.discordId
      ? 'Linked (' + m.discordId + '). Pick another below to change it.'
      : 'Not linked: pick their account, and they get their tags on Discord.';
    document.getElementById('mDiscordSearch').value = '';
    document.getElementById('mDiscordResults').hidden = true;
    document.getElementById('memberError').hidden = true;
    dialog.showModal();
  }

  document.getElementById('memberCancel').addEventListener('click', function () {
    dialog.close();
  });

  var searchTimer = null;
  document.getElementById('mDiscordSearch').addEventListener('input', function (e) {
    var q = e.target.value.trim();
    var results = document.getElementById('mDiscordResults');
    clearTimeout(searchTimer);
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    searchTimer = setTimeout(function () {
      M.api('GET', '/api/app/community?people=' + encodeURIComponent(q))
        .then(function (d) {
          M.clear(results);
          if (!d.people.length)
            results.appendChild(h('p', { class: 'fe-people-none' }, 'Nobody found'));
          d.people.forEach(function (p) {
            results.appendChild(
              h(
                'button',
                {
                  type: 'button',
                  class: 'fe-people-hit',
                  onclick: function () {
                    discordPick = p.discordId;
                    document.getElementById('mDiscord').textContent =
                      'Will be linked to ' + p.name + ' (' + p.discordId + ') on saving.';
                    results.hidden = true;
                  },
                },
                M.avatar(p, 24),
                h('span', null, p.name)
              )
            );
          });
          results.hidden = false;
        })
        .catch(M.appError);
    }, 250);
  });

  document.getElementById('memberForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('memberError');
    err.hidden = true;
    var body = {
      name: document.getElementById('mName').value,
      profile: document.getElementById('mProfile').value,
      location: document.getElementById('mLocation').value,
      areas: document.getElementById('mAreas').value,
      publish: document.getElementById('mPublish').checked,
    };
    if (discordPick !== undefined) body.discordId = discordPick;
    M.api('PUT', '/api/app/community?member=' + encodeURIComponent(editing.id), body)
      .then(function (r) {
        data.members = data.members.map(function (m) {
          return m.id === r.member.id ? r.member : m;
        });
        dialog.close();
        M.toast('Saved');
        M.communitySite.changed();
        render();
      })
      .catch(function (e2) {
        if (e2.status === 401) return M.appError(e2);
        err.textContent = e2.message;
        err.hidden = false;
      });
  });

  // ── The old sheet ────────────────────────────────────────────────────────

  var importText = null;
  var preview = null;

  function importPanel() {
    var file = h('input', {
      type: 'file',
      accept: '.csv,text/csv',
      class: 'form-input is-compact',
    });
    var check = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Preview');
    var out = h('div', { class: 'form-grid' });
    check.addEventListener('click', function () {
      var f = file.files && file.files[0];
      if (!f) return M.toast('Pick the CSV first', true);
      check.disabled = true;
      f.text()
        .then(function (csv) {
          importText = csv;
          return M.api('POST', '/api/app/community?action=preview', { csv: csv });
        })
        .then(function (p) {
          preview = p;
          drawPreview(out);
        })
        .catch(M.appError)
        .then(function () {
          check.disabled = false;
        });
    });
    if (preview) drawPreview(out);
    return h(
      'details',
      { class: 'panel import-panel', open: data.members.length ? null : true },
      h('summary', null, 'Import the old members sheet'),
      h(
        'p',
        { class: 'panel-note' },
        'Download the members sheet as CSV (File → Download → .csv) and pick it here. Only approved people come in; those who consented are shown on the site once published; “Coordinamento” and “Partecipazione stabile” become tags. Whoever has signed in here once is matched to their Discord account by email and gets their tags on Discord. Nothing is stored until you confirm.'
      ),
      h('div', { class: 'people-tools' }, file, check),
      out
    );
  }

  function drawPreview(out) {
    M.clear(out);
    var c = preview.counts;
    out.appendChild(
      h(
        'p',
        { class: 'notice', style: 'margin:0' },
        h('span', null, 'ⓘ'),
        h(
          'span',
          null,
          c.people +
            ' people · ' +
            c.published +
            ' shown on the site · ' +
            c.tagged +
            ' with tags · ' +
            c.onDiscord +
            ' matched to Discord (get their tags now) · ' +
            c.already +
            ' already here (tags added, nothing else changed)'
        )
      )
    );
    out.appendChild(
      h(
        'div',
        { class: 'results-wrap import-list' },
        h(
          'table',
          { class: 'results people-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Name', 'Role', 'Tags', 'On the site', 'Discord'].map(function (t) {
                return h('th', null, t);
              })
            )
          ),
          h(
            'tbody',
            null,
            preview.people.map(function (p) {
              return h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  p.name,
                  p.exists ? h('small', { class: 'people-sub' }, 'already here') : null
                ),
                h('td', null, p.role === 'organizer' ? 'Organizer' : 'Participant'),
                h(
                  'td',
                  null,
                  h(
                    'span',
                    { class: 'people-tags' },
                    p.tags.map(function (t) {
                      return h('span', { class: 'tag-chip is-' + t.level }, groupTitle(t.group));
                    })
                  )
                ),
                h('td', null, p.publish ? 'Yes' : 'No'),
                h(
                  'td',
                  null,
                  p.discord ? p.discord.name : h('span', { class: 'panel-note' }, 'not matched')
                )
              );
            })
          )
        )
      )
    );
    var go = h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm' },
      'Import ' + c.people + ' people'
    );
    go.addEventListener('click', function () {
      if (
        !window.confirm(
          'Import ' +
            c.people +
            ' people, and give ' +
            c.onDiscord +
            ' of them their tags on Discord?'
        )
      )
        return;
      go.disabled = true;
      M.api('POST', '/api/app/community?action=import', { csv: importText })
        .then(function (r) {
          M.toast(
            r.imported +
              ' imported, ' +
              r.updated +
              ' updated' +
              (r.discordFailed ? '; Discord did not take ' + r.discordFailed : '') +
              '. Publish to show them on the site.'
          );
          preview = null;
          importText = null;
          load();
        })
        .catch(function (err) {
          go.disabled = false;
          M.appError(err);
        });
    });
    out.appendChild(h('div', null, go));
  }
})();
