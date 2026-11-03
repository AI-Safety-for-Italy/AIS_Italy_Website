/* /app/local-groups/: the local groups' board (server/local-groups.js).
 * A column per status (starting, active, paused), a card per city: who leads
 * it, the WhatsApp link, whether the site's map shows it. Drag a card to move
 * it; open it to change the city, the leads and their contacts, the link and
 * the notes. Everything comes from /api/app/local-groups, which checks
 * `local_groups`; whatever was typed goes on the page as text (h() makes text
 * nodes), never as HTML. What the site shows is set in Site content → Local
 * groups (local-groups-site.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/local-groups';
  var board = document.getElementById('lgBoard');
  var toolbar = document.getElementById('lgToolbar');
  var search = document.getElementById('lgSearch');
  var newBtn = document.getElementById('lgNew');
  var panel = document.getElementById('lgPanel');
  var form = document.getElementById('lgForm');

  var data = null; // { groups, statuses }
  var q = '';
  var mode = 'board'; // or 'table'
  try {
    if (localStorage.getItem('local-groups-view') === 'table') mode = 'table';
  } catch (e) {
    /* private window: the board is fine */
  }
  var views = document.getElementById('lgViews');
  function showMode() {
    views.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
    });
  }
  showMode();
  views.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (!b) return;
    mode = b.getAttribute('data-mode');
    try {
      localStorage.setItem('local-groups-view', mode);
    } catch (err) {
      /* not remembered: fine */
    }
    showMode();
    render();
  });

  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      M.clear(board);
      toolbar.hidden = true;
      newBtn.hidden = true;
      board.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, err.status === 403 ? 'No access' : 'Not set up yet'),
          h('p', null, err.message)
        )
      );
      return;
    }
    M.appError(err);
  }

  function load() {
    return M.api('GET', API).then(function (d) {
      data = d;
      render();
    });
  }

  board.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', API), M.permissions])
    .then(function (r) {
      data = r[1];
      toolbar.hidden = false;
      newBtn.hidden = false;
      siteNote(r[2].indexOf('local_groups_site') !== -1);
      render();
      if (/[?&]new=1/.test(location.search)) openGroup(null);
    })
    .catch(fail);

  function siteNote(canEdit) {
    var note = document.getElementById('lgSiteNote');
    note.appendChild(document.createTextNode('Which of them the site’s map shows: '));
    note.appendChild(
      canEdit
        ? h('a', { href: '/app/content/local-groups/' }, 'Site content → Local groups')
        : h('span', null, 'Site content → Local groups')
    );
    note.appendChild(document.createTextNode('.'));
  }

  search.addEventListener('input', function () {
    q = fold(search.value.trim());
    render();
  });
  newBtn.addEventListener('click', function () {
    openGroup(null);
  });

  function visible(g) {
    if (!q) return true;
    var hay = [g.city, g.notes]
      .concat(
        g.leads.map(function (l) {
          return l.name + ' ' + l.email;
        })
      )
      .join(' ');
    return fold(hay).indexOf(q) !== -1;
  }

  // ── The board ────────────────────────────────────────────────────────────

  function render() {
    M.clear(board);
    var shown = data.groups.filter(visible);
    if (!data.groups.length) {
      board.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'No local groups yet'),
          h('p', null, 'Add the first one with “New local group”.')
        )
      );
      return;
    }
    if (!shown.length) board.appendChild(h('p', { class: 'panel-note' }, 'No group matches.'));
    if (mode === 'table') {
      board.appendChild(table(shown));
      return;
    }
    var columns = h('div', { class: 'crm-kanban lg-kanban' });
    data.statuses.forEach(function (status) {
      var inColumn = shown.filter(function (g) {
        return g.status === status.key;
      });
      var col = h(
        'section',
        { class: 'crm-col', 'data-status': status.key, 'aria-label': status.label },
        h(
          'header',
          null,
          h('span', null, status.label),
          h('span', { class: 'crm-count' }, String(inColumn.length))
        ),
        h('div', { class: 'crm-col-list' }, inColumn.map(cardEl))
      );
      col.addEventListener('dragover', function (e) {
        e.preventDefault();
        col.classList.add('is-over');
      });
      col.addEventListener('dragleave', function () {
        col.classList.remove('is-over');
      });
      col.addEventListener('drop', function (e) {
        e.preventDefault();
        col.classList.remove('is-over');
        var id = e.dataTransfer.getData('application/x-local-group');
        if (id) move(id, status.key);
      });
      columns.appendChild(col);
    });
    board.appendChild(columns);
  }

  function statusLabel(key) {
    var s = data.statuses.filter(function (x) {
      return x.key === key;
    })[0];
    return s ? s.label : key;
  }

  function order(status) {
    return data.statuses
      .map(function (x) {
        return x.key;
      })
      .indexOf(status);
  }

  /** The same groups as rows: every lead with their contacts. A row opens the group. */
  function table(list) {
    var lines = function (g, render) {
      return g.leads.length
        ? g.leads.map(function (l) {
            return h('div', null, render(l));
          })
        : '—';
    };
    var body = h(
      'tbody',
      null,
      list
        .slice()
        .sort(function (a, b) {
          return order(a.status) - order(b.status) || a.city.localeCompare(b.city, 'it');
        })
        .map(function (g) {
          var tr = h(
            'tr',
            { tabindex: '0', title: 'Open ' + g.city },
            h('td', null, h('strong', null, g.city)),
            h('td', null, statusLabel(g.status)),
            h(
              'td',
              null,
              lines(g, function (l) {
                return l.name;
              })
            ),
            h(
              'td',
              null,
              lines(g, function (l) {
                return l.email ? h('a', { href: 'mailto:' + l.email }, l.email) : '—';
              })
            ),
            h(
              'td',
              null,
              lines(g, function (l) {
                return l.phone || '—';
              })
            ),
            h(
              'td',
              null,
              g.whatsapp
                ? h(
                    'a',
                    { href: g.whatsapp, target: '_blank', rel: 'noopener noreferrer' },
                    'WhatsApp ↗'
                  )
                : '—'
            ),
            h('td', null, g.onSite ? 'Yes' : 'No'),
            h('td', { title: g.notes }, g.notes || '')
          );
          tr.addEventListener('click', function (e) {
            if (e.target.closest('a')) return;
            openGroup(g);
          });
          tr.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') openGroup(g);
          });
          return tr;
        })
    );
    return h(
      'div',
      { class: 'fr-table-wrap lg-table-wrap' },
      h(
        'table',
        { class: 'fr-table lg-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['City', 'Status', 'Leads', 'Email', 'Phone', 'WhatsApp', 'On the site', 'Notes'].map(
              function (t) {
                return h('th', { scope: 'col' }, t);
              }
            )
          )
        ),
        body
      )
    );
  }

  function cardEl(g) {
    var el = h(
      'div',
      { class: 'crm-card lg-card', draggable: 'true' },
      h(
        'button',
        {
          type: 'button',
          class: 'crm-name',
          onclick: function () {
            openGroup(g);
          },
        },
        g.city
      ),
      g.leads.length
        ? h(
            'span',
            { class: 'crm-card-org' },
            g.leads
              .map(function (l) {
                return l.name;
              })
              .join(', ')
          )
        : h('span', { class: 'crm-card-org lg-missing' }, 'No lead yet'),
      h(
        'span',
        { class: 'crm-card-meta' },
        g.whatsapp
          ? h(
              'a',
              {
                class: 'crm-tag lg-wa',
                href: g.whatsapp,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: 'Open the WhatsApp group',
              },
              'WhatsApp ↗'
            )
          : h('span', { class: 'crm-tag lg-missing' }, 'No WhatsApp link'),
        g.onSite ? h('span', { class: 'crm-tag' }, 'On the site') : null
      )
    );
    el.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('application/x-local-group', g.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    return el;
  }

  // Optimistic: the card moves at once, the server catches up.
  function move(id, status) {
    var g = data.groups.filter(function (x) {
      return x.id === id;
    })[0];
    if (!g || g.status === status) return;
    var before = g.status;
    g.status = status;
    render();
    M.api('POST', API + '?action=status', { id: id, status: status })
      .then(function (r) {
        Object.assign(g, r.group);
        render();
      })
      .catch(function (err) {
        g.status = before;
        render();
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  // ── A group: new or changed ──────────────────────────────────────────────

  var fields = M.watchFields(form, {
    active: function () {
      return panel.open;
    },
  });
  function close() {
    fields.confirm(function () {
      panel.close();
    });
  }
  panel.addEventListener('cancel', function (e) {
    e.preventDefault();
    close();
  });

  function input(attrs, value) {
    var el = h('input', Object.assign({ class: 'form-input is-compact' }, attrs));
    el.value = value || '';
    return el;
  }

  function field(label, control, note) {
    return h(
      'div',
      null,
      h('label', { class: 'form-label' }, label, control),
      note ? h('p', { class: 'form-note', style: 'margin:.3rem 0 0' }, note) : null
    );
  }

  function leadRow(lead, list) {
    var row = h(
      'div',
      { class: 'lg-lead' },
      input(
        { 'data-lead': 'name', placeholder: 'Name', 'aria-label': 'Name', maxlength: '120' },
        lead.name
      ),
      input(
        {
          'data-lead': 'email',
          type: 'email',
          placeholder: 'Email',
          'aria-label': 'Email',
          maxlength: '200',
        },
        lead.email
      ),
      input(
        {
          'data-lead': 'phone',
          type: 'tel',
          placeholder: 'Phone',
          'aria-label': 'Phone',
          maxlength: '40',
        },
        lead.phone
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'fe-tool lg-lead-x',
          title: 'Remove this lead',
          'aria-label': 'Remove this lead',
          onclick: function () {
            row.remove();
            if (!list.children.length) list.appendChild(leadRow({}, list));
          },
        },
        '×'
      )
    );
    return row;
  }

  function leadsOf(list) {
    return [].map.call(list.querySelectorAll('.lg-lead'), function (row) {
      var out = {};
      row.querySelectorAll('[data-lead]').forEach(function (el) {
        out[el.getAttribute('data-lead')] = el.value.trim();
      });
      return out;
    });
  }

  /** The contacts of the leads, as links to write to them. */
  function contacts(g) {
    var withContact = g.leads.filter(function (l) {
      return l.email || l.phone;
    });
    if (!withContact.length) return null;
    return h(
      'ul',
      { class: 'lg-contacts' },
      withContact.map(function (l) {
        return h(
          'li',
          null,
          h('strong', null, l.name),
          l.email ? h('a', { href: 'mailto:' + l.email }, l.email) : null,
          l.phone ? h('a', { href: 'tel:' + l.phone.replace(/[^\d+]/g, '') }, l.phone) : null
        );
      })
    );
  }

  function openGroup(g) {
    M.clear(form);
    var city = input({ maxlength: '60', required: true, placeholder: 'Bologna' }, g && g.city);
    var status = h(
      'select',
      { class: 'form-input is-compact' },
      data.statuses.map(function (s) {
        return h('option', { value: s.key }, s.label);
      })
    );
    status.value = g ? g.status : 'starting';
    var leads = h('div', { class: 'lg-leads' });
    (g && g.leads.length ? g.leads : [{}]).forEach(function (l) {
      leads.appendChild(leadRow(l, leads));
    });
    var addLead = h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        onclick: function () {
          leads.appendChild(leadRow({}, leads));
          leads.lastChild.querySelector('input').focus();
        },
      },
      '+ Add a lead'
    );
    var whatsapp = input(
      { type: 'url', maxlength: '500', placeholder: 'https://chat.whatsapp.com/…' },
      g && g.whatsapp
    );
    var notes = h('textarea', { class: 'form-input is-compact', rows: '3', maxlength: '2000' });
    notes.value = g ? g.notes : '';
    var errorEl = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var save = h(
      'button',
      { class: 'btn btn-primary btn-sm', type: 'submit' },
      g ? 'Save' : 'Add the group'
    );

    form.appendChild(h('h2', { id: 'lgTitle' }, g ? g.city : 'A new local group'));
    if (g) {
      var c = contacts(g);
      if (c) form.appendChild(c);
    }
    form.appendChild(h('div', { class: 'fe-row' }, field('City', city), field('Status', status)));
    form.appendChild(
      h('div', null, h('span', { class: 'form-label' }, 'Who leads it'), leads, addLead)
    );
    form.appendChild(
      field(
        'WhatsApp group',
        whatsapp,
        'The invite link (WhatsApp → the group → Invite via link). Only the board sees it.'
      )
    );
    form.appendChild(field('Notes', notes));
    form.appendChild(errorEl);
    form.appendChild(
      h(
        'div',
        { class: 'lg-dialog-actions' },
        g
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-danger-outline btn-sm',
                onclick: function () {
                  remove(g);
                },
              },
              'Remove'
            )
          : null,
        h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: close }, 'Cancel'),
        save
      )
    );
    if (g && g.updatedBy)
      form.appendChild(
        h(
          'p',
          { class: 'panel-note', style: 'margin:0' },
          'Last changed by ' + g.updatedBy + ', ' + M.fmtDateTime(g.updatedAt)
        )
      );

    form.onsubmit = function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      save.disabled = true;
      var body = {
        city: city.value,
        status: status.value,
        leads: leadsOf(leads),
        whatsapp: whatsapp.value.trim(),
        notes: notes.value,
      };
      M.api(g ? 'PUT' : 'POST', g ? API + '?id=' + encodeURIComponent(g.id) : API, body)
        .then(function () {
          fields.saved();
          panel.close();
          M.toast(g ? 'Saved' : 'Group added');
          return load();
        })
        .catch(function (err) {
          save.disabled = false;
          if (err.status === 401) return M.appError(err);
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        });
    };
    fields.saved();
    if (!panel.open) panel.showModal();
    city.focus();
  }

  function remove(g) {
    if (
      !window.confirm(
        'Remove the group of ' +
          g.city +
          ' from the board?' +
          (g.onSite
            ? ' The site keeps showing it until Site content → Local groups is published again.'
            : '')
      )
    )
      return;
    M.api('DELETE', API + '?id=' + encodeURIComponent(g.id))
      .then(function () {
        fields.saved();
        panel.close();
        M.toast('Removed');
        return load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }
})();
