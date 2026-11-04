/* Members board → Members (/app/members/people/): everyone in the community,
 * one row each, from /api/app/community (server/community.js).
 *
 *   - Filters on top: who needs attention (not linked, changes waiting on
 *     Discord, not online as they are here), role, working group, Discord,
 *     website, source; and those approved on Applications who have not
 *     joined Discord yet.
 *   - A row opens the member's page (/app/members/member/?id=).
 *   - Picked rows: put in a group, take out, move, make participants or
 *     organizers. Saved in the database only: on Discord the roles wait on
 *     the Discord tab, the website changes when it is updated.
 *   - "Import the old sheet": the Google Sheet's CSV, previewed as a merge
 *     (server/member-merge.js) before anything is stored.
 * Whatever people typed goes on the page as text (h() makes text nodes). */
(function () {
  'use strict';
  var M = window.Meet;
  var B = M.board;
  var h = M.h;
  var API = B.API;
  var view = document.getElementById('peopleView');

  var data = null; // { members, groups, roles, site, invited, applications }
  var discord = null; // status.discord: { perMember, available }
  var picked = new Set();
  var f = { q: '', qRaw: '', show: 'all', role: '', group: '', discord: '', site: '', source: '' };

  try {
    var saved = JSON.parse(sessionStorage.getItem('members-filters') || 'null');
    if (saved) f = Object.assign(f, saved, { q: '', qRaw: '' });
  } catch (e) {
    /* nothing remembered */
  }
  function remember() {
    try {
      sessionStorage.setItem('members-filters', JSON.stringify(f));
    } catch (e) {
      /* fine */
    }
  }

  function load() {
    return M.api('GET', API).then(function (d) {
      data = d;
      render();
    });
  }

  view.appendChild(M.loading());
  M.me.then(load).catch(B.fail(view));
  B.onStatus(function (s) {
    discord = s.discord;
    if (data) {
      data.site = s.site;
      render();
    }
  });

  // ── What each member is ──────────────────────────────────────────────────

  function discordState(m) {
    if (m.discordId) return 'linked';
    if (m.discordAbsent) return 'absent';
    return 'tolink';
  }

  function pendingOf(m) {
    return discord && discord.perMember ? discord.perMember[m.id] || 0 : 0;
  }

  function siteOf(m) {
    if (!m.publish) return 'hidden';
    var per = data.site && data.site.perMember;
    return (per && per[m.id]) || 'waiting';
  }

  function gone(m) {
    return Boolean(discord && discord.goneIds && discord.goneIds.indexOf(m.id) !== -1);
  }

  function needs(m) {
    if (m.archivedAt) return pendingOf(m) > 0;
    return (
      discordState(m) === 'tolink' ||
      pendingOf(m) > 0 ||
      Boolean(data.site && data.site.live && (siteOf(m) === 'changed' || siteOf(m) === 'waiting'))
    );
  }

  function groupTitle(id) {
    var g = data.groups.filter(function (x) {
      return x.id === id;
    })[0];
    return g ? g.titleEn : id;
  }

  function inGroup(m, id) {
    return m.groups.some(function (g) {
      return g.group === id;
    });
  }

  function matches(m) {
    // Offboarded members only under "Offboarded" (and in need of attention
    // while their roles wait to be taken off).
    if (f.show === 'archived') {
      if (!m.archivedAt) return false;
    } else if (m.archivedAt && f.show !== 'attention') return false;
    if (f.show === 'attention' && !needs(m)) return false;
    if (f.role && m.role !== f.role) return false;
    if (f.group === '-' && m.groups.length) return false;
    if (f.group && f.group !== '-' && !inGroup(m, f.group)) return false;
    if (f.discord === 'pending' && !pendingOf(m)) return false;
    if (f.discord && f.discord !== 'pending' && discordState(m) !== f.discord) return false;
    if (f.site && siteOf(m) !== f.site) return false;
    if (f.source && m.source !== f.source) return false;
    if (f.q) {
      var hay = B.fold(
        [m.name, m.location, m.areas, m.discordName, m.discordUsername]
          .concat(
            m.groups.map(function (g) {
              return groupTitle(g.group);
            })
          )
          .join(' ')
      );
      if (hay.indexOf(f.q) === -1) return false;
    }
    return true;
  }

  // ── The page ─────────────────────────────────────────────────────────────

  var searchInput = null;

  function render() {
    B.redraw(view, draw);
  }

  function draw() {
    var focused = searchInput && document.activeElement === searchInput;
    M.clear(view);
    if (!data.members.length && !data.invited.length) {
      view.appendChild(
        B.empty(
          'Nobody on the board yet',
          'People arrive when an application is approved and they join Discord, from the old sheet, or from Discord itself.',
          h('div', { class: 'mb-empty-actions' }, importButton('btn-primary'))
        )
      );
      return;
    }
    view.appendChild(toolbar());
    view.appendChild(showChips());
    if (f.show === 'invited') {
      view.appendChild(invitedList());
      return;
    }
    if (f.show === 'duplicates') {
      view.appendChild(duplicatesView());
      return;
    }
    var list = data.members.filter(matches);
    picked.forEach(function (id) {
      if (
        !list.some(function (m) {
          return m.id === id;
        })
      )
        picked.delete(id);
    });
    if (picked.size) view.appendChild(bulkBar());
    view.appendChild(table(list));
    if (focused) {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }
  }

  function select(label, key, options) {
    var s = h(
      'select',
      {
        class: 'form-input is-compact mb-filter' + (f[key] ? ' is-set' : ''),
        'aria-label': label,
        onchange: function () {
          f[key] = s.value;
          remember();
          render();
        },
      },
      options.map(function (o) {
        return h('option', { value: o[0], selected: f[key] === o[0] }, o[1]);
      })
    );
    return s;
  }

  function toolbar() {
    searchInput = h('input', {
      class: 'form-input is-compact crm-search',
      type: 'search',
      placeholder: 'Search name, place, area, Discord…',
      'aria-label': 'Search',
      value: f.qRaw,
      oninput: function () {
        f.qRaw = searchInput.value;
        f.q = B.fold(searchInput.value.trim());
        render();
      },
    });
    var anyFilter = f.role || f.group || f.discord || f.site || f.source;
    return h(
      'div',
      { class: 'crm-toolbar mb-toolbar' },
      searchInput,
      select('Role', 'role', [
        ['', 'Any role'],
        ['participant', B.roleName(data.roles, 'participant')],
        ['organizer', B.roleName(data.roles, 'organizer')],
      ]),
      select(
        'Working group',
        'group',
        [
          ['', 'Any group'],
          ['-', 'In no group'],
        ].concat(
          data.groups.map(function (g) {
            return [g.id, g.titleEn];
          })
        )
      ),
      select('Discord', 'discord', [
        ['', 'Discord: any'],
        ['linked', 'Linked'],
        ['tolink', 'To link'],
        ['absent', 'Not on Discord'],
        ['pending', 'Changes waiting'],
      ]),
      select('Website', 'site', [
        ['', 'Website: any'],
        ['online', 'Online'],
        ['changed', 'Changed'],
        ['waiting', 'Not online yet'],
        ['hidden', 'Hidden (no consent)'],
      ]),
      select('Source', 'source', [
        ['', 'From anywhere'],
        ['application', 'Applications'],
        ['sheet', 'Old sheet'],
        ['board', 'Added from Discord'],
      ]),
      anyFilter
        ? h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                f.role = f.group = f.discord = f.site = f.source = '';
                remember();
                render();
              },
            },
            'Clear filters'
          )
        : null,
      h(
        'span',
        { class: 'mb-toolbar-end' },
        h(
          'a',
          { class: 'btn btn-outline btn-sm', href: API + '?view=export', download: '' },
          'Export CSV'
        ),
        importButton('btn-outline')
      )
    );
  }

  function showChips() {
    var attention = data.members.filter(needs).length;
    var archived = data.members.filter(function (m) {
      return m.archivedAt;
    }).length;
    var chips = [
      ['all', 'Members', data.members.length - archived],
      ['attention', 'Needs attention', attention],
      ['invited', 'Invited, not on Discord yet', data.invited.length],
    ];
    if (data.duplicates || f.show === 'duplicates')
      chips.push(['duplicates', 'Possible duplicates', data.duplicates]);
    if (archived || f.show === 'archived') chips.push(['archived', 'Offboarded', archived]);
    return h(
      'div',
      { class: 'mb-show', role: 'group', 'aria-label': 'Show' },
      chips.map(function (c) {
        return h(
          'button',
          {
            type: 'button',
            class:
              'mb-show-chip' +
              ((c[0] === 'attention' || c[0] === 'duplicates') && c[2] ? ' is-warn' : ''),
            'aria-pressed': String(f.show === c[0]),
            onclick: function () {
              f.show = c[0];
              picked.clear();
              remember();
              render();
            },
          },
          c[1],
          h('span', { class: 'crm-count' }, String(c[2]))
        );
      }),
      f.show === 'attention'
        ? h(
            'span',
            { class: 'mb-show-note' },
            'Not linked to Discord, changes waiting there, or not online as they are here.'
          )
        : f.show === 'archived'
        ? h(
            'span',
            { class: 'mb-show-note' },
            'They left: kept as a record, off the website. Restore one from their page.'
          )
        : null
    );
  }

  function table(list) {
    if (!list.length)
      return h('p', { class: 'panel-note mb-none' }, 'Nobody matches these filters.');
    var allPicked = list.every(function (m) {
      return picked.has(m.id);
    });
    var head = h(
      'div',
      { class: 'mb-row mb-row-head', role: 'row' },
      h(
        'span',
        { role: 'columnheader' },
        h('input', {
          type: 'checkbox',
          'aria-label': 'Pick everyone shown',
          checked: allPicked,
          onchange: function (e) {
            list.forEach(function (m) {
              if (e.target.checked) picked.add(m.id);
              else picked.delete(m.id);
            });
            render();
          },
        })
      ),
      h('span', { role: 'columnheader' }, B.plural(list.length, 'member')),
      h('span', { role: 'columnheader' }, 'Role'),
      h('span', { role: 'columnheader' }, 'Working groups'),
      h('span', { role: 'columnheader' }, 'Discord'),
      h('span', { role: 'columnheader' }, 'Website')
    );
    return h('div', { class: 'mb-table', role: 'table' }, head, list.map(row));
  }

  function row(m) {
    var href = '/app/members/member/?id=' + encodeURIComponent(m.id);
    var ds = discordState(m);
    var pend = pendingOf(m);
    var groups = m.groups.length
      ? m.groups.map(function (g) {
          var coord = g.level === 'coordination';
          return h(
            'span',
            {
              class: 'mb-group' + (coord ? ' is-coord' : ''),
              title: coord ? 'Coordinates this group' : null,
            },
            coord ? '★ ' : '',
            groupTitle(g.group)
          );
        })
      : h('span', { class: 'crm-quiet' }, '—');
    var disc;
    if (ds === 'linked') {
      disc = h(
        'span',
        { class: 'mb-disc' },
        h(
          'span',
          { class: 'mb-disc-name' },
          '@' + (m.discordUsername || m.discordName || 'linked')
        ),
        pend
          ? B.pill('todo', pend + ' waiting', 'Changes waiting on the Discord tab')
          : discord && discord.available
          ? B.pill('ok', 'In step')
          : null
      );
    } else if (ds === 'absent') {
      disc = B.pill('muted', 'Not on Discord', m.discordNote || null);
    } else {
      disc = B.pill('todo', 'To link');
    }
    if (gone(m)) disc = B.pill('warn', 'Left the server');
    return h(
      'div',
      { class: 'mb-row' + (picked.has(m.id) ? ' is-picked' : ''), role: 'row' },
      h(
        'span',
        { role: 'cell' },
        h('input', {
          type: 'checkbox',
          'aria-label': 'Pick ' + m.name,
          checked: picked.has(m.id),
          onchange: function (e) {
            if (e.target.checked) picked.add(m.id);
            else picked.delete(m.id);
            render();
          },
        })
      ),
      h(
        'a',
        { class: 'mb-name', href: href, role: 'cell' },
        B.avatar({ name: m.name }, 28),
        h(
          'span',
          { class: 'mb-name-text' },
          h(
            'strong',
            null,
            m.name,
            m.archivedAt ? h('span', { class: 'mb-archived' }, ' Offboarded') : null
          ),
          h(
            'span',
            { class: 'mb-sub' },
            [m.location, sourceLabel(m.source)].filter(Boolean).join(' · ')
          )
        )
      ),
      h('span', { role: 'cell', 'data-label': 'Role' }, B.roleChip(data.roles, m.role)),
      h('span', { class: 'mb-groups', role: 'cell', 'data-label': 'Groups' }, groups),
      h('span', { role: 'cell', 'data-label': 'Discord' }, disc),
      h('span', { role: 'cell', 'data-label': 'Website' }, B.sitePill(siteOf(m)))
    );
  }

  // ── Possible duplicates ──────────────────────────────────────────────────

  var dupData = null;
  var dupLoading = false;

  function duplicatesView() {
    var box = h('div', { class: 'mb-dups' });
    if (!dupData) {
      box.appendChild(M.loading());
      if (!dupLoading) {
        dupLoading = true;
        M.api('GET', API + '?view=duplicates')
          .then(function (r) {
            dupData = r.groups;
            render();
          })
          .catch(M.appError)
          .then(function () {
            dupLoading = false;
          });
      }
      return box;
    }
    if (!dupData.length) {
      box.appendChild(h('p', { class: 'panel-note mb-none' }, 'No two members share a name.'));
      return box;
    }
    box.appendChild(
      h(
        'p',
        { class: 'panel-note' },
        'Members with the same name (accents, case and word order aside). Merge two records of one person, or say they are different people.'
      )
    );
    dupData.forEach(function (g) {
      box.appendChild(
        h(
          'section',
          { class: 'panel mb-dup' },
          h(
            'div',
            { class: 'mb-dup-cards' },
            g.members.map(function (m) {
              return dupCard(m, g.members);
            })
          )
        )
      );
    });
    return box;
  }

  function dupCard(m, all) {
    var others = all.filter(function (x) {
      return x.id !== m.id;
    });
    return h(
      'div',
      { class: 'mb-dup-card' },
      h(
        'a',
        { class: 'mb-name', href: '/app/members/member/?id=' + encodeURIComponent(m.id) },
        B.avatar({ name: m.name }, 28),
        h(
          'span',
          { class: 'mb-name-text' },
          h('strong', null, m.name),
          h(
            'span',
            { class: 'mb-sub' },
            sourceLabel(m.source) + (m.joinedOn ? ' · since ' + B.day(m.joinedOn) : '')
          )
        )
      ),
      h(
        'dl',
        { class: 'mb-dup-facts' },
        h('dt', null, 'Role'),
        h('dd', null, B.roleName(data.roles, m.role)),
        h('dt', null, 'Place'),
        h('dd', null, m.location || '—'),
        h('dt', null, 'Groups'),
        h('dd', null, m.groups.map((g) => groupTitle(g.group)).join(', ') || '—'),
        h('dt', null, 'Discord'),
        h('dd', null, m.discordId ? '@' + (m.discordUsername || m.discordName || 'linked') : '—'),
        h('dt', null, 'Website'),
        h('dd', null, m.publish ? 'Shown' : 'Hidden')
      ),
      others.map(function (o) {
        return h(
          'div',
          { class: 'mb-dup-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary btn-sm',
              onclick: function () {
                mergeInto(m, o);
              },
            },
            'Keep this one, merge ' +
              (others.length > 1 ? o.name + ' (' + sourceLabel(o.source) + ')' : 'the other') +
              ' in'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                M.api('POST', API + '?action=not-duplicate', { a: m.id, b: o.id })
                  .then(function () {
                    dupData = null;
                    M.toast('Told apart: not offered again');
                    return load();
                  })
                  .catch(M.appError);
              },
            },
            'Not the same person'
          )
        );
      })
    );
  }

  function mergeInto(keep, drop) {
    B.confirm({
      title: 'Merge into ' + keep.name + '?',
      text: 'Two records of one person become one: the record on the left stays, the other is removed.',
      effects: [
        {
          where: 'db',
          text:
            'What ' +
            keep.name +
            '’s record has stays; its gaps are filled from the other; the higher role, every group, the Discord account if missing, the kept answers, notes and history move over.',
        },
        {
          where: 'discord',
          text: 'Nothing changes yet: any role to give waits on the Discord tab.',
        },
        { where: 'site', text: 'Changes when the website is updated.' },
      ],
      ok: 'Merge',
    }).then(function (yes) {
      if (!yes) return;
      M.api('POST', API + '?action=merge', { keep: keep.id, drop: drop.id })
        .then(function () {
          dupData = null;
          M.toast('Merged');
          return Promise.all([load(), B.refresh()]);
        })
        .catch(M.appError);
    });
  }

  function sourceLabel(s) {
    return { sheet: 'old sheet', application: 'application', board: 'from Discord' }[s] || '';
  }

  // ── Several at once ──────────────────────────────────────────────────────

  function groupOptions() {
    return data.groups.map(function (g) {
      return h('option', { value: g.id }, g.titleEn);
    });
  }

  function bulkBar() {
    var ids = Array.from(picked);
    var groupSel = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Group' },
      groupOptions()
    );
    var toSel = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Move to', hidden: true },
      groupOptions()
    );
    var toLabel = h('span', { class: 'mb-bulk-to', hidden: true }, 'to');
    var action = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'What to do',
        onchange: function () {
          var v = action.value;
          groupSel.hidden = v === 'participant' || v === 'organizer';
          toSel.hidden = toLabel.hidden = v !== 'move';
        },
      },
      h('option', { value: 'add' }, 'Put in group'),
      h('option', { value: 'remove' }, 'Take out of group'),
      h('option', { value: 'move' }, 'Move from group'),
      h('option', { value: 'participant' }, 'Make ' + B.roleName(data.roles, 'participant')),
      h('option', { value: 'organizer' }, 'Make ' + B.roleName(data.roles, 'organizer'))
    );
    var go = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          var v = action.value;
          var who = B.plural(ids.length, 'member');
          var role = v === 'participant' || v === 'organizer';
          var text = role
            ? who + ' made ' + B.roleName(data.roles, v)
            : v === 'add'
            ? who + ' put in ' + groupTitle(groupSel.value)
            : v === 'remove'
            ? who + ' taken out of ' + groupTitle(groupSel.value)
            : who + ' moved from ' + groupTitle(groupSel.value) + ' to ' + groupTitle(toSel.value);
          B.confirm({
            title: 'Change ' + who + '?',
            effects: [
              { where: 'db', text: text + ', saved now.' },
              {
                where: 'discord',
                text: 'Nothing changes yet: their roles wait on the Discord tab, to apply.',
              },
              { where: 'site', text: 'Changes when the website is updated.' },
            ],
            ok: 'Save',
          }).then(function (yes) {
            if (!yes) return;
            go.disabled = true;
            var req = role
              ? M.api('POST', API + '?action=roles', { members: ids, role: v })
              : M.api('POST', API + '?action=tags', {
                  members: ids,
                  action: v,
                  group: groupSel.value,
                  to: v === 'move' ? toSel.value : undefined,
                });
            req
              .then(function () {
                picked.clear();
                M.toast('Saved. Apply on the Discord tab when ready.');
                return Promise.all([load(), B.refresh()]);
              })
              .catch(function (err) {
                go.disabled = false;
                M.appError(err);
              });
          });
        },
      },
      'Save'
    );
    return h(
      'div',
      { class: 'mb-bulk', role: 'region', 'aria-label': 'Picked members' },
      h('strong', null, ids.length + ' picked'),
      action,
      groupSel,
      toLabel,
      toSel,
      go,
      h(
        'button',
        {
          type: 'button',
          class: 'link-button',
          onclick: function () {
            picked.clear();
            render();
          },
        },
        'Clear'
      ),
      h('span', { class: 'mb-bulk-note' }, 'Saved in the database; on Discord when applied.')
    );
  }

  // ── Invited, not on Discord yet ──────────────────────────────────────────

  function invitedList() {
    if (!data.invited.length)
      return h('p', { class: 'panel-note mb-none' }, 'Everyone approved has joined Discord.');
    return h(
      'div',
      { class: 'mb-table mb-invited', role: 'table' },
      h(
        'div',
        { class: 'mb-row mb-row-head', role: 'row' },
        h('span', { role: 'columnheader' }, B.plural(data.invited.length, 'person', 'people')),
        h('span', { role: 'columnheader' }, 'Role'),
        h('span', { role: 'columnheader' }, 'Approved'),
        h('span', { role: 'columnheader' }, 'Their link'),
        h('span', { role: 'columnheader' })
      ),
      data.invited.map(function (a) {
        var expired = a.joinExpiresAt && new Date(a.joinExpiresAt) < new Date();
        return h(
          'div',
          { class: 'mb-row', role: 'row' },
          h(
            'span',
            { class: 'mb-name', role: 'cell' },
            B.avatar({ name: a.name }, 28),
            h('span', { class: 'mb-name-text' }, h('strong', null, a.name))
          ),
          h('span', { role: 'cell' }, B.roleChip(data.roles, a.role)),
          h('span', { role: 'cell', class: 'crm-quiet' }, B.day(a.decidedAt)),
          h(
            'span',
            { role: 'cell' },
            a.inviteError
              ? B.pill('warn', 'Email failed', a.inviteError)
              : expired
              ? B.pill('warn', 'Link expired')
              : B.pill('muted', 'Valid to ' + B.day(a.joinExpiresAt))
          ),
          h(
            'span',
            { role: 'cell' },
            data.applications
              ? h(
                  'a',
                  { class: 'btn btn-outline btn-sm', href: '/app/members/' },
                  'Open in Applications'
                )
              : null
          )
        );
      }),
      h(
        'p',
        { class: 'panel-note mb-invited-note' },
        'They come onto the board, with their answers, role and groups, when they follow their link and join Discord.'
      )
    );
  }

  // ── The old sheet ────────────────────────────────────────────────────────

  function importButton(kind) {
    return h(
      'button',
      { type: 'button', class: 'btn btn-sm ' + kind, onclick: openImport },
      'Import the old sheet'
    );
  }

  var importDialog = null;

  function openImport() {
    if (!importDialog) {
      importDialog = h('dialog', {
        class: 'meet-dialog mb-import',
        'aria-labelledby': 'mbImportTitle',
      });
      document.body.appendChild(importDialog);
    }
    var csvText = null;
    var decisions = {};
    var body = h('div', { class: 'dialog-body' });
    var foot = h('div', { class: 'dialog-foot' });
    M.clear(importDialog);
    importDialog.appendChild(body);
    importDialog.appendChild(foot);

    function close() {
      importDialog.close();
    }

    function cancel(label) {
      return h(
        'button',
        { type: 'button', class: 'btn btn-outline btn-sm', onclick: close },
        label
      );
    }

    function pickStep() {
      M.clear(body);
      M.clear(foot);
      var file = h('input', {
        type: 'file',
        accept: '.csv,text/csv',
        class: 'form-input is-compact',
      });
      var err = h('p', { class: 'form-error', hidden: true });
      body.appendChild(h('h2', { id: 'mbImportTitle' }, 'Import the old sheet'));
      body.appendChild(
        h(
          'p',
          { class: 'mb-confirm-text' },
          'The members sheet as a CSV (Google Sheets → File → Download → CSV). Nothing is stored before you see what it would do.'
        )
      );
      body.appendChild(
        h(
          'ul',
          { class: 'mb-rules' },
          h(
            'li',
            null,
            'People already here are matched by email, then by Discord account. A name alone is only a guess: you choose.'
          ),
          h(
            'li',
            null,
            'Empty fields are filled. What was changed on the board is never overwritten on its own: a newer answer shows as a conflict, to keep or take.'
          ),
          h(
            'li',
            null,
            'Groups are only added, the role never lowered. The same sheet again changes nothing.'
          ),
          h('li', null, 'Nothing is sent to Discord; the website changes only when updated.')
        )
      );
      body.appendChild(file);
      body.appendChild(err);
      var next = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          onclick: function () {
            var chosen = file.files && file.files[0];
            if (!chosen) {
              err.textContent = 'Pick the CSV file first.';
              err.hidden = false;
              return;
            }
            next.disabled = true;
            chosen.text().then(function (text) {
              csvText = text;
              preview();
            });
          },
        },
        'See what it would do'
      );
      foot.appendChild(cancel('Cancel'));
      foot.appendChild(next);
    }

    function preview() {
      M.clear(body);
      M.clear(foot);
      body.appendChild(M.loading('Reading the sheet…'));
      M.api('POST', API + '?action=preview', { csv: csvText, decisions: decisions })
        .then(report)
        .catch(function (e) {
          pickStep();
          M.appError(e);
        });
    }

    function count(n, label, tone) {
      return h(
        'span',
        { class: 'mb-import-count is-' + tone },
        h('strong', null, String(n)),
        ' ' + label
      );
    }

    function report(p) {
      M.clear(body);
      M.clear(foot);
      var c = p.counts;
      body.appendChild(h('h2', { id: 'mbImportTitle' }, 'What importing would do'));
      body.appendChild(
        h(
          'div',
          { class: 'mb-import-counts' },
          count(c.new, 'new', 'ok'),
          count(c.update, 'completed', 'ok'),
          count(c.conflict, 'to decide', c.conflict ? 'todo' : 'muted'),
          count(c.unchanged, 'unchanged', 'muted'),
          c.skip ? count(c.skip, 'left out', 'muted') : null,
          count(c.onDiscord, 'matched on Discord', 'muted')
        )
      );
      if (!p.byName)
        body.appendChild(
          h(
            'p',
            { class: 'notice mb-import-notice' },
            'Matched to Discord by email only: ' +
              (p.byNameProblem || 'the server’s list could not be read') +
              '.'
          )
        );
      var order = { conflict: 0, new: 1, update: 2, skip: 3, unchanged: 4 };
      var people = p.people.slice().sort(function (a, b) {
        return order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'it');
      });
      body.appendChild(h('div', { class: 'mb-import-list' }, people.map(personRow)));
      foot.appendChild(
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: pickStep }, 'Back')
      );
      var go = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          disabled: !(c.new + c.update + c.conflict),
          onclick: function () {
            var conflicts = 0;
            var taken = 0;
            p.people.forEach(function (x) {
              conflicts += x.conflicts.length;
              taken += ((decisions[x.key] || {}).take || []).length;
            });
            B.confirm({
              title: 'Import the sheet?',
              effects: [
                {
                  where: 'db',
                  text:
                    B.plural(c.new, 'person', 'people') +
                    ' added, ' +
                    B.plural(c.update + c.conflict, 'member') +
                    ' completed' +
                    (conflicts
                      ? '; ' +
                        taken +
                        ' of ' +
                        B.plural(conflicts, 'conflict') +
                        ' taken from the sheet, the rest kept'
                      : '') +
                    '. Every answer kept on the member.',
                },
                { where: 'discord', text: 'Nothing changes: the roles wait on the Discord tab.' },
                { where: 'site', text: 'Changes when the website is updated.' },
              ],
              ok: 'Import',
            }).then(function (yes) {
              if (!yes) return;
              go.disabled = true;
              M.api('POST', API + '?action=import', { csv: csvText, decisions: decisions })
                .then(function (r) {
                  close();
                  M.toast(
                    r.imported +
                      ' added, ' +
                      r.updated +
                      ' completed, ' +
                      r.unchanged +
                      ' unchanged'
                  );
                  return Promise.all([load(), B.refresh()]);
                })
                .catch(function (e) {
                  go.disabled = false;
                  M.appError(e);
                });
            });
          },
        },
        'Import'
      );
      foot.appendChild(go);
    }

    var STATUS = {
      new: ['ok', 'New'],
      update: ['ok', 'Completed'],
      conflict: ['todo', 'To decide'],
      unchanged: ['muted', 'Unchanged'],
      skip: ['muted', 'Left out'],
    };

    function shown(v) {
      if (v === true) return 'shown on the site';
      if (v === false) return 'not shown';
      if (v === 'organizer' || v === 'participant') return B.roleName(data && data.roles, v);
      return v || '—';
    }

    function choice(name, on, label, pick) {
      return h(
        'label',
        { class: 'check-row' },
        h('input', { type: 'radio', name: 'imp-' + name, checked: on, onchange: pick }),
        h('span', null, label)
      );
    }

    function personRow(x) {
      var d = (decisions[x.key] = decisions[x.key] || {});
      var s = STATUS[x.status];
      var lines = [];
      if (x.fill.length)
        lines.push(h('div', { class: 'mb-imp-line' }, 'Fills: ' + x.fill.join(', ')));
      if (x.addGroups.length)
        lines.push(
          h('div', { class: 'mb-imp-line' }, 'Adds to: ' + x.addGroups.map(groupTitle).join(', '))
        );
      if (x.linking && x.discord)
        lines.push(
          h(
            'div',
            { class: 'mb-imp-line' },
            'Links to Discord: ' + x.discord.name + ' (by ' + x.discord.by + ')'
          )
        );
      if (x.discord && x.discord.taken)
        lines.push(
          h(
            'div',
            { class: 'mb-imp-line is-warn' },
            'Its Discord account is another member’s: not linked.'
          )
        );
      if (x.kept.length)
        lines.push(
          h(
            'div',
            { class: 'mb-imp-line crm-quiet' },
            'Kept as on the board (changed there after this answer): ' + x.kept.join(', ')
          )
        );
      x.conflicts.forEach(function (c) {
        var take = (d.take || []).indexOf(c.field) !== -1;
        var without = function () {
          return (d.take || []).filter(function (k) {
            return k !== c.field;
          });
        };
        lines.push(
          h(
            'div',
            { class: 'mb-imp-conflict' },
            h('strong', null, c.label),
            h(
              'div',
              { class: 'mb-imp-choice', role: 'radiogroup', 'aria-label': c.label },
              choice(x.key + c.field, !take, 'Keep: ' + shown(c.here), function () {
                d.take = without();
              }),
              choice(x.key + c.field, take, 'Take the sheet’s: ' + shown(c.there), function () {
                d.take = without().concat(c.field);
              })
            )
          )
        );
      });
      if (x.duplicateOf) {
        var dup = function (v) {
          return function () {
            d.duplicate = v;
            preview();
          };
        };
        lines.push(
          h(
            'div',
            { class: 'mb-imp-conflict' },
            h(
              'strong',
              null,
              'Same name as ' +
                x.duplicateOf.name +
                (x.duplicateOf.hasEmail ? ' (with another email)' : ' (added from Discord)')
            ),
            h(
              'div',
              { class: 'mb-imp-choice', role: 'radiogroup', 'aria-label': 'Who is it' },
              choice(x.key + 'dup', x.duplicate === 'merge', 'The same person', dup('merge')),
              choice(x.key + 'dup', x.duplicate === 'new', 'Someone else', dup('new')),
              choice(x.key + 'dup', x.duplicate === 'skip', 'Leave out', dup('skip'))
            )
          )
        );
      }
      return h(
        'div',
        { class: 'mb-imp-row is-' + x.status },
        h(
          'div',
          { class: 'mb-imp-head' },
          h('strong', null, x.name),
          B.pill(s[0], s[1]),
          x.newAnswers
            ? h('span', { class: 'crm-quiet' }, B.plural(x.newAnswers, 'answer') + ' to keep')
            : null
        ),
        lines
      );
    }

    pickStep();
    importDialog.showModal();
  }
})();
