/* /app/calendar/calendars/: the calendars this member sees, each with what
 * they may do in it. Whoever manages one opens its panel: its name, colour
 * and description; who views, edits and manages it, as three separate
 * sections; the Discord channels its events are announced in; archiving it.
 * Whoever holds “Calendar: new calendars” creates new ones. The API
 * (/api/app/calendar, server/calendars.js) decides. */
(function () {
  'use strict';
  var M = window.Meet;
  var Cal = window.Cal;
  var h = M.h;

  var cardsEl = document.getElementById('calCards');
  var archivedBox = document.getElementById('calArchived');
  var archivedEl = document.getElementById('calArchivedCards');
  var panel = document.getElementById('calPanel');
  var panelBody = document.getElementById('calPanelBody');
  var form = document.getElementById('calPanelForm');
  var createBtn = document.getElementById('calCreate');
  var data = null;
  var editing = null; // the calendar in the panel, null for a new one
  var fields = null;
  var dirty = false;

  document.querySelectorAll('[data-icon]').forEach(function (el) {
    el.appendChild(Cal.svg(Cal.LEVELS[el.getAttribute('data-icon')].icon));
  });

  function load() {
    M.clear(cardsEl).appendChild(M.loading());
    return M.api('GET', Cal.API + '?calendars=1')
      .then(function (d) {
        data = d;
        createBtn.hidden = !d.canCreate;
        document.getElementById('calCreateNote').hidden = d.canCreate;
        render();
      })
      .catch(function (err) {
        M.clear(cardsEl).appendChild(h('div', { class: 'empty-state' }, h('p', null, err.message)));
        M.appError(err);
      });
  }

  function accessLine(c) {
    if (!c.access) return null;
    var parts = [];
    var count = function (a) {
      if (a.all) return 'every member';
      var n = a.roles.length + a.people.length;
      if (!n) return null;
      return (
        a.roles
          .map(function (r) {
            return '@' + r.name;
          })
          .concat(
            a.people.map(function (p) {
              return p.name;
            })
          )
          .slice(0, 3)
          .join(', ') + (n > 3 ? ' +' + (n - 3) : '')
      );
    };
    ['view', 'edit', 'manage'].forEach(function (l) {
      var who = count(c.access[l]);
      if (who) parts.push(h('span', null, h('strong', null, Cal.LEVELS[l].label + ': '), who));
    });
    if (c.isPublic) parts.unshift(h('span', null, h('strong', null, 'Public')));
    return parts.length ? h('p', { class: 'cal-card-access' }, parts) : null;
  }

  function calendarCard(c) {
    return h(
      'article',
      {
        class: 'cal-cal-card panel' + (c.archived ? ' is-archived' : ''),
        style: '--cal-color:' + c.color,
      },
      h(
        'div',
        { class: 'cal-cal-head' },
        h('span', { class: 'cal-cal-swatch', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'cal-cal-title' },
          h('h3', null, c.name),
          h(
            'div',
            { class: 'cal-cal-badges' },
            Cal.levelBadge(c.level === 'public' ? 'public' : c.level),
            c.isPublic && c.level !== 'public' ? Cal.levelBadge('public') : null,
            c.system ? h('span', { class: 'cal-tag' }, 'From Site content') : null,
            c.archived ? h('span', { class: 'cal-tag' }, 'Archived') : null
          )
        )
      ),
      c.description ? h('p', { class: 'cal-cal-desc' }, c.description) : null,
      accessLine(c),
      c.announce && c.announce.length
        ? h(
            'p',
            { class: 'cal-card-access' },
            h('strong', null, 'Announced in '),
            Cal.announceSummary(c.announce)
          )
        : null,
      h(
        'div',
        { class: 'cal-cal-foot' },
        c.owner
          ? h('span', { class: 'cal-owner' }, M.avatar(c.owner, 20), 'Created by ' + c.owner.name)
          : h('span'),
        c.canManage
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  openPanel(c);
                },
              },
              'Manage'
            )
          : h('span', { class: 'cal-muted' }, Cal.LEVELS[c.level].text)
      )
    );
  }

  function render() {
    var live = data.calendars.filter(function (c) {
      return !c.archived;
    });
    var archived = data.calendars.filter(function (c) {
      return c.archived;
    });
    M.clear(cardsEl);
    if (!live.length) {
      cardsEl.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'No calendar yet'),
          h('p', null, 'Nothing is shared with you so far.')
        )
      );
    }
    live.forEach(function (c) {
      cardsEl.appendChild(calendarCard(c));
    });
    archivedBox.hidden = !archived.length;
    M.clear(archivedEl);
    archived.forEach(function (c) {
      archivedEl.appendChild(calendarCard(c));
    });
  }

  // ── The panel ───────────────────────────────────────────────────────────

  function section(title, note, children) {
    return h(
      'section',
      { class: 'cal-panel-section' },
      h('h3', { class: 'cal-panel-title' }, title),
      note ? h('p', { class: 'form-note cal-fieldset-note' }, note) : null,
      children
    );
  }

  function preview(list, name) {
    var first = list[0];
    var lead = first ? Cal.leadLabel(first.minutes[0] || 0).toLowerCase() : '1 day before';
    return h(
      'div',
      { class: 'cal-preview' },
      h('span', { class: 'cal-preview-bot', 'aria-hidden': 'true' }, 'AIS'),
      h(
        'div',
        null,
        h('p', { class: 'cal-preview-who' }, 'AIS bot', h('small', null, ' · ' + lead)),
        h(
          'p',
          null,
          '📅 ',
          h('strong', null, 'Reading group'),
          ' starts soon · ' + (name || 'Calendar')
        ),
        h('p', { class: 'cal-muted' }, 'Tuesday 10 November, 18:30–20:00 (Rome time)'),
        h('p', { class: 'cal-muted' }, '🔊 #voice · link to the event')
      )
    );
  }

  function openPanel(c) {
    editing = c;
    dirty = false;
    var changed = function () {
      dirty = true;
    };
    document.getElementById('calPanelTitle').textContent = c ? c.name : 'New calendar';
    M.clear(panelBody);

    var name = h('input', {
      class: 'form-input',
      id: 'cpName',
      maxlength: '80',
      required: true,
      placeholder: 'e.g. Working group on policy',
    });
    name.value = c ? c.name : '';
    var desc = h('textarea', {
      class: 'form-input is-compact',
      id: 'cpDesc',
      rows: '2',
      maxlength: '1000',
      placeholder: 'What goes in it, who it is for',
    });
    desc.value = c ? c.description || '' : '';
    var color = c ? c.color : data.colors[(data.calendars.length + 2) % data.colors.length];
    var swatches = h('div', { class: 'cal-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
    function drawSwatches() {
      M.clear(swatches);
      data.colors.forEach(function (col) {
        swatches.appendChild(
          h('button', {
            type: 'button',
            class: 'cal-swatch' + (col === color ? ' is-on' : ''),
            role: 'radio',
            'aria-checked': col === color ? 'true' : 'false',
            'aria-label': 'Colour ' + col,
            style: 'background:' + col,
            onclick: function () {
              color = col;
              dirty = true;
              drawSwatches();
            },
          })
        );
      });
    }
    drawSwatches();
    [name, desc].forEach(function (el) {
      el.addEventListener('input', changed);
    });

    var access = (c && c.access) || { view: { all: true }, edit: {}, manage: {} };
    var levels = {};
    var ladder = h('div', { class: 'cal-ladder' });
    ['view', 'edit', 'manage'].forEach(function (l, i) {
      levels[l] = Cal.accessLevel({
        level: l,
        value: access[l],
        isPublic: c ? c.isPublic : false,
        onChange: changed,
      });
      if (i)
        ladder.appendChild(
          h('div', { class: 'cal-ladder-step', 'aria-hidden': 'true' }, 'includes everything above')
        );
      ladder.appendChild(levels[l].el);
    });

    var announce = Cal.announceRows({
      value: (c && c.announce) || [],
      onChange: function () {
        dirty = true;
        drawPreview();
      },
    });
    var previewBox = h('div');
    function drawPreview() {
      M.clear(previewBox).appendChild(preview(announce.get(), name.value));
    }
    drawPreview();

    panelBody.appendChild(
      section('Details', null, [
        h('div', null, h('label', { class: 'form-label', for: 'cpName' }, 'Name'), name),
        h(
          'div',
          null,
          h(
            'label',
            { class: 'form-label', for: 'cpDesc' },
            'Description ',
            h('span', { class: 'form-hint' }, 'optional')
          ),
          desc
        ),
        h('div', null, h('span', { class: 'form-label' }, 'Colour'), swatches),
      ])
    );
    panelBody.appendChild(
      section(
        'Who has access',
        'Three levels, each for every member, Discord roles or people by name. Each includes the ones before it; whoever created the calendar, and the calendar admins, always manage it.',
        ladder
      )
    );
    panelBody.appendChild(
      section(
        'Announcements on Discord',
        'The AIS bot posts each event of this calendar in these channels, at the times chosen. An event can choose its own instead, or none.',
        [
          announce.el,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm cal-add',
              onclick: function () {
                announce.add();
              },
            },
            '+ Add a channel'
          ),
          previewBox,
        ]
      )
    );
    if (c && !c.system) {
      panelBody.appendChild(
        section(
          c.archived ? 'Archived' : 'Archive',
          c.archived
            ? 'Hidden from everyone but who manages it. Bring it back, or delete it and its events for good.'
            : 'Hides the calendar and its events from everyone but who manages it. It can be brought back.',
          h(
            'div',
            { class: 'cal-danger' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  archive(c, !c.archived);
                },
              },
              c.archived ? 'Bring it back' : 'Archive the calendar'
            ),
            c.archived
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-danger-outline btn-sm',
                    onclick: function () {
                      destroy(c);
                    },
                  },
                  'Delete for good'
                )
              : null
          )
        )
      );
    }
    panelBody.appendChild(
      h('div', { class: 'form-error', id: 'cpError', role: 'alert', hidden: true })
    );

    fields = {
      get: function () {
        return {
          name: name.value,
          description: desc.value,
          color: color,
          isPublic: levels.view.isPublic(),
          access: { view: levels.view.get(), edit: levels.edit.get(), manage: levels.manage.get() },
          announce: announce.get(),
        };
      },
      focus: function () {
        name.focus();
      },
    };
    if (!panel.open) panel.showModal();
    if (!c) setTimeout(fields.focus, 30);
  }

  function showError(message) {
    var el = document.getElementById('cpError');
    if (!el) return M.toast(message, true);
    el.textContent = message;
    el.hidden = !message;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = fields.get();
    if (!body.name.trim()) {
      showError('Give the calendar a name');
      fields.focus();
      return;
    }
    var save = document.getElementById('calPanelSave');
    save.disabled = true;
    var url = editing
      ? Cal.API + '?action=update-calendar&id=' + encodeURIComponent(editing.id)
      : Cal.API + '?action=create-calendar';
    M.api('POST', url, body)
      .then(function () {
        dirty = false;
        panel.close();
        M.toast(editing ? 'Calendar saved' : 'Calendar created');
        load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        showError(err.message);
      })
      .then(function () {
        save.disabled = false;
      });
  });

  function archive(c, archived) {
    M.api('POST', Cal.API + '?action=archive&id=' + encodeURIComponent(c.id), {
      archived: archived,
    })
      .then(function () {
        dirty = false;
        panel.close();
        M.toast(archived ? 'Calendar archived' : 'Calendar back');
        load();
      })
      .catch(M.appError);
  }

  function destroy(c) {
    if (
      !window.confirm('Delete “' + c.name + '” and all its events for good? This cannot be undone.')
    )
      return;
    M.api('POST', Cal.API + '?action=delete-calendar&id=' + encodeURIComponent(c.id), {})
      .then(function () {
        dirty = false;
        panel.close();
        M.toast('Calendar deleted');
        load();
      })
      .catch(M.appError);
  }

  function closePanel() {
    if (dirty && !window.confirm('Leave without saving the changes?')) return;
    dirty = false;
    panel.close();
  }
  document.getElementById('calPanelCancel').addEventListener('click', closePanel);
  document.getElementById('calPanelClose').addEventListener('click', closePanel);
  panel.addEventListener('cancel', function (e) {
    if (dirty) {
      e.preventDefault();
      closePanel();
    }
  });
  createBtn.addEventListener('click', function () {
    openPanel(null);
  });

  M.me.then(load);
})();
