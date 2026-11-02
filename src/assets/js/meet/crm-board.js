/* /app/crm/: the mentorship board.
 *   #mentors, #mentees  a column per stage of the selection; drag a card to
 *                       move it, or open it to see everything about them
 *   #pairs              who is paired with whom, and new pairs
 * Everything comes from /api/app/crm/mentorship, which checks the permission
 * and leaves out what this user may not read. Whatever the sheets say goes on
 * the page as text (h() makes text nodes), never as HTML. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/mentorship';
  var board = document.getElementById('crmBoard');
  var notices = document.getElementById('crmNotices');
  var toolbar = document.getElementById('crmToolbar');
  var panel = document.getElementById('personPanel');
  var panelBody = document.getElementById('personBody');

  // On a wide screen the list view shows the person beside it; elsewhere, in the dialog.
  var wide = window.matchMedia('(min-width: 1100px)');
  var asideBody = h('div', { class: 'crm-aside-body' });
  var aside = h('aside', { class: 'crm-aside', 'aria-label': 'Person details' }, asideBody);
  function inAside() {
    return wide.matches && view.mode === 'list' && view.tab !== 'pairs';
  }

  var addBtn = document.getElementById('addMentor');
  var addPanel = document.getElementById('addPanel');
  var addForm = document.getElementById('addForm');

  var view = {
    data: null,
    shown: null,
    tab: 'mentors',
    track: '',
    q: '',
    mine: false,
    open: null,
    mode: 'list',
    stage: '',
  };
  try {
    if (localStorage.getItem('crm-view') === 'board') view.mode = 'board';
  } catch (e) {
    /* private window: the default is fine */
  }

  var SOURCE_LABELS = window.CrmPerson.SOURCE_LABELS;

  function trackLabel(key) {
    if (!view.data) return key;
    var t = view.data.tracks.filter(function (x) {
      return x.key === key;
    })[0];
    return t ? t.label : 'No track yet';
  }

  function statusLabel(kind, key) {
    var s = view.data.statuses[kind].filter(function (x) {
      return x.key === key;
    })[0];
    return s ? s.label : key;
  }

  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      M.clear(board);
      toolbar.hidden = true;
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
    return M.api('GET', API).then(function (data) {
      view.data = data;
      render();
    });
  }

  board.appendChild(M.loading());
  M.me.then(load).catch(fail);

  // ── Tabs and filters ─────────────────────────────────────────────────────

  function setTab(tab) {
    view.tab = ['mentors', 'mentees', 'pairs'].indexOf(tab) === -1 ? 'mentors' : tab;
    view.stage = '';
    document.querySelectorAll('.ap-tabs a[data-tab]').forEach(function (a) {
      if (a.getAttribute('data-tab') === view.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (view.data) render();
  }
  window.addEventListener('hashchange', function () {
    setTab(location.hash.slice(1));
  });
  setTab(location.hash.slice(1));

  document.getElementById('trackFilter').addEventListener('change', function (e) {
    view.track = e.target.value;
    render();
  });
  document.getElementById('crmSearch').addEventListener('input', function (e) {
    view.q = fold(e.target.value.trim());
    render();
  });
  var modeBtns = document.querySelectorAll('#crmViews button');
  function markMode() {
    modeBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === view.mode));
    });
  }
  markMode();
  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      view.mode = b.getAttribute('data-mode');
      try {
        localStorage.setItem('crm-view', view.mode);
      } catch (e) {
        /* not remembered, still works */
      }
      markMode();
      render();
    });
  });
  document.getElementById('onlyMine').addEventListener('change', function (e) {
    view.mine = e.target.checked;
    render();
  });

  // ── Adding a mentor to contact ───────────────────────────────────────────

  function field(name, label, required, input) {
    input = input || h('input', { class: 'form-input is-compact', autocomplete: 'off' });
    input.id = 'add-' + name;
    input.name = name;
    if (required) input.required = true;
    return h(
      'div',
      null,
      h('label', { class: 'form-label', for: input.id }, label + (required ? ' *' : '')),
      input
    );
  }

  function openAdd() {
    M.clear(addForm);
    // The server reads the track from these Italian words.
    var track = h(
      'select',
      { class: 'form-input is-compact' },
      [
        ['', 'Not decided'],
        ['Progetti', 'AI safety projects'],
        ['Orientamento', 'Career orientation'],
        ['Entrambi', 'Both'],
      ].map(function (t) {
        return h('option', { value: t[0] }, t[1]);
      })
    );
    var errorEl = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save');
    addForm.appendChild(h('h2', { id: 'addTitle' }, 'Add a mentor to contact'));
    [
      field('first_name', 'First name', true),
      field('last_name', 'Last name', true),
      field('email', 'Email', true, h('input', { class: 'form-input is-compact', type: 'email' })),
      field('social', 'Social or website'),
      field('org', 'Affiliation'),
      field('career', 'Career stage'),
      field('track', 'Track', false, track),
      field('referrer', 'Recommended by'),
      field(
        'notes',
        'Area / notes',
        false,
        h('textarea', { class: 'form-input is-compact', rows: '3', maxlength: '4000' })
      ),
    ].forEach(function (f) {
      addForm.appendChild(f);
    });
    addForm.appendChild(errorEl);
    addForm.appendChild(
      h(
        'div',
        { style: 'display:flex;justify-content:flex-end;gap:0.6rem' },
        h(
          'button',
          {
            class: 'btn btn-outline btn-sm',
            type: 'button',
            onclick: function () {
              addPanel.close();
            },
          },
          'Cancel'
        ),
        save
      )
    );
    addForm.onsubmit = function (e) {
      e.preventDefault();
      var body = {};
      Array.prototype.forEach.call(addForm.elements, function (el) {
        if (el.name) body[el.name] = el.value.trim();
      });
      errorEl.hidden = true;
      save.disabled = true;
      M.api('POST', API + '?action=add', body)
        .then(function (r) {
          addPanel.close();
          M.toast('Added');
          return load().then(function () {
            openPerson(r.key, r.kind);
          });
        })
        .catch(function (err) {
          save.disabled = false;
          if (err.status === 401) return M.appError(err);
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        });
    };
    addPanel.showModal();
    document.getElementById('add-first_name').focus();
  }
  addBtn.addEventListener('click', openAdd);

  function visible(card) {
    if (view.track && card.track !== view.track && card.track !== 'both') return false;
    if (view.mine && card.ownerId !== view.data.me) return false;
    if (view.q) {
      var hay = fold([card.name, card.org, card.areas, card.project, card.referrer].join(' '));
      if (hay.indexOf(view.q) === -1) return false;
    }
    return true;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function render() {
    renderNotices();
    M.clear(board);
    toolbar.hidden = view.tab === 'pairs';
    addBtn.hidden = view.tab !== 'mentors';
    if (view.tab === 'pairs') renderPairs();
    else if (view.mode === 'board') renderKanban(view.tab === 'mentees' ? 'mentee' : 'mentor');
    else renderList(view.tab === 'mentees' ? 'mentee' : 'mentor');
    if (view.tab !== 'pairs') markEmails();
  }

  // ── The stage pill: one button, one menu, used everywhere ────────────────

  var openMenu = null;
  function closeMenu(refocus) {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    m.menu.remove();
    m.btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', m.away, true);
    document.removeEventListener('keydown', m.key, true);
    window.removeEventListener('scroll', m.away, true);
    if (refocus) m.btn.focus();
  }

  function findCard(key, kind) {
    return (kind === 'mentor' ? view.data.mentors : view.data.mentees).filter(function (c) {
      return c.key === key;
    })[0];
  }

  function dot(status) {
    return h('span', {
      class: 'crm-dot',
      'aria-hidden': 'true',
      style: '--crm-dot:var(--crm-st-' + status + ')',
    });
  }

  function stagePill(key, kind) {
    var c = findCard(key, kind);
    var locked = c.status === 'matched';
    var wrap = h('span', { class: 'crm-stage-pill' });
    var btn = h(
      'button',
      {
        type: 'button',
        class: 'crm-stage-btn',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        'aria-label': 'Stage: ' + statusLabel(kind, c.status) + '. Change',
        title: locked ? 'End the pairing first' : null,
        disabled: locked ? true : null,
      },
      dot(c.status),
      h('span', null, statusLabel(kind, c.status)),
      h('span', { 'aria-hidden': 'true' }, '▾')
    );
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (openMenu && openMenu.btn === btn) return closeMenu(true);
      closeMenu();
      var menu = h(
        'div',
        { class: 'crm-stage-menu' },
        view.data.statuses[kind].map(function (s) {
          return h(
            'button',
            {
              type: 'button',
              'aria-current': s.key === c.status ? 'true' : null,
              disabled: s.key === 'matched' ? true : null,
              onclick: function () {
                closeMenu(true);
                if (s.key !== c.status) change(key, kind, { status: s.key });
              },
            },
            dot(s.key),
            s.label
          );
        })
      );
      popMenu(btn, wrap, menu);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /** Shows `menu` (inside `wrap`) under `btn`; closes on Escape, a click elsewhere or a scroll. */
  function popMenu(btn, wrap, menu) {
    wrap.appendChild(menu);
    var r = btn.getBoundingClientRect();
    var below = window.innerHeight - r.bottom > menu.offsetHeight + 8;
    menu.style.left =
      Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = (below ? r.bottom + 4 : Math.max(4, r.top - menu.offsetHeight - 4)) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    openMenu = {
      btn: btn,
      menu: menu,
      away: function (ev) {
        if (ev.type === 'scroll' && menu.contains(ev.target)) return;
        if (ev.type === 'click' && wrap.contains(ev.target)) return;
        closeMenu();
      },
      key: function (ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu(true);
        }
      },
    };
    document.addEventListener('click', openMenu.away, true);
    document.addEventListener('keydown', openMenu.key, true);
    window.addEventListener('scroll', openMenu.away, true);
    var first = menu.querySelector('button[aria-current="true"]') || menu.querySelector('button');
    if (first) first.focus();
  }

  // ── Copy emails: who is on screen, in one of three formats ──────────────

  var emailsWrap = document.getElementById('crmEmails');
  var emailsBtn = document.getElementById('copyEmails');
  var emailsCount = document.getElementById('emailsCount');

  /** The cards on screen: the filters, and in the list view the stage chip too. */
  function onScreen() {
    var kind = view.tab === 'mentees' ? 'mentee' : 'mentor';
    return (kind === 'mentor' ? view.data.mentors : view.data.mentees).filter(function (c) {
      return visible(c) && (view.mode === 'board' || !view.stage || c.status === view.stage);
    });
  }

  function markEmails() {
    var n = onScreen().length;
    emailsCount.textContent = String(n);
    emailsBtn.disabled = n === 0;
  }

  var EMAIL_FORMATS = [
    [
      'For BCC, separated by commas',
      'a@example.org, b@example.org, …',
      function (ppl) {
        return ppl
          .map(function (x) {
            return x.email;
          })
          .join(', ');
      },
    ],
    [
      'One per line',
      'To paste into a sheet',
      function (ppl) {
        return ppl
          .map(function (x) {
            return x.email;
          })
          .join('\n');
      },
    ],
    [
      'With names',
      'Giulia Esempio <giulia@example.org>, …',
      function (ppl) {
        return ppl
          .map(function (x) {
            return x.name + ' <' + x.email + '>';
          })
          .join(', ');
      },
    ],
  ];

  function copyEmails(format) {
    var cards = onScreen();
    if (!cards.length) return;
    emailsBtn.disabled = true;
    M.api('POST', API + '?action=emails', {
      kind: cards[0].kind,
      keys: cards.map(function (c) {
        return c.key;
      }),
    })
      .then(function (r) {
        var ppl = r.people || [];
        if (!ppl.length) return M.toast('Nobody here has an email', true);
        window.CrmPerson.copyText(format(ppl), function () {
          var missing = cards.length - ppl.length;
          M.toast(
            ppl.length +
              (ppl.length === 1 ? ' email copied' : ' emails copied') +
              (missing > 0 ? ' (' + missing + ' without an email)' : '')
          );
        });
      })
      .catch(function (err) {
        if (err.status === 401) fail(err);
        else M.toast(err.message, true);
      })
      .then(markEmails);
  }

  emailsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (openMenu && openMenu.btn === emailsBtn) return closeMenu(true);
    closeMenu();
    popMenu(
      emailsBtn,
      emailsWrap,
      h(
        'div',
        { class: 'crm-stage-menu crm-emails-menu', role: 'menu' },
        EMAIL_FORMATS.map(function (f) {
          return h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              onclick: function () {
                closeMenu(true);
                copyEmails(f[2]);
              },
            },
            h('span', null, h('strong', null, f[0]), h('small', null, f[1]))
          );
        })
      )
    );
  });

  // ── List view ────────────────────────────────────────────────────────────

  function renderList(kind) {
    var all = (kind === 'mentor' ? view.data.mentors : view.data.mentees).filter(visible);
    var chips = h('div', {
      class: 'crm-stage-chips',
      role: 'group',
      'aria-label': 'Stage',
    });
    function chip(key, label, count) {
      chips.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'crm-chip',
            'aria-pressed': String(view.stage === key),
            onclick: function () {
              view.stage = key;
              render();
            },
          },
          key ? dot(key) : null,
          h('span', null, label),
          h('span', { class: 'crm-chip-count' }, String(count))
        )
      );
    }
    chip('', 'All', all.length);
    view.data.statuses[kind].forEach(function (s) {
      chip(
        s.key,
        s.label,
        all.filter(function (c) {
          return c.status === s.key;
        }).length
      );
    });
    var rows = all
      .filter(function (c) {
        return !view.stage || c.status === view.stage;
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    board.appendChild(chips);
    if (!rows.length) {
      board.appendChild(h('p', { class: 'panel-note' }, 'Nobody here with these filters.'));
      return;
    }
    var withAside = inAside();
    var sel =
      withAside &&
      (rows.filter(function (c) {
        return view.open && view.open.key === c.key && view.open.kind === c.kind;
      })[0] ||
        rows[0]);
    var list = h(
      'div',
      { class: 'crm-list' },
      h(
        'div',
        { class: 'crm-row crm-row-head' },
        h('span', null, 'Name'),
        h('span', null, 'Track'),
        h('span', null, 'Stage'),
        h('span', null, 'Owner'),
        h('span', null, 'Notes')
      ),
      rows.map(function (c) {
        return h(
          'div',
          { class: 'crm-row' + (c === sel ? ' is-selected' : ''), 'data-id': c.kind + ':' + c.key },
          h(
            'button',
            {
              type: 'button',
              class: 'crm-pick',
              'aria-current': c === sel ? 'true' : null,
              onclick: function () {
                openPerson(c.key, c.kind);
              },
            },
            h('span', { class: 'crm-pick-name' }, c.name),
            c.org ? h('span', { class: 'crm-pick-org' }, c.org) : null
          ),
          c.track
            ? h('span', null, trackLabel(c.track))
            : h('span', { class: 'crm-muted', 'aria-label': 'No track yet' }, '—'),
          stagePill(c.key, c.kind),
          c.owner ? h('span', null, c.owner) : h('span', { class: 'crm-muted' }, '—'),
          h('span', { class: 'crm-num' }, c.notes ? String(c.notes) : '')
        );
      })
    );
    if (!withAside) {
      board.appendChild(list);
      return;
    }
    board.appendChild(h('div', { class: 'crm-split' }, list, aside));
    // The aside is kept between renders; only fetch when the person changed.
    if (view.shown !== sel.kind + ':' + sel.key) openPerson(sel.key, sel.kind);
  }

  function markSelected() {
    document.querySelectorAll('#crmBoard .crm-row[data-id]').forEach(function (row) {
      var on = row.getAttribute('data-id') === view.shown;
      row.classList.toggle('is-selected', on);
      row.querySelector('.crm-pick').setAttribute('aria-current', on ? 'true' : 'false');
    });
  }

  function renderNotices() {
    M.clear(notices);
    var d = view.data;
    d.problems.forEach(function (p) {
      notices.appendChild(
        h(
          'div',
          { class: 'notice crm-notice' },
          h('span', null, h('strong', null, p.label + ': '), p.message)
        )
      );
    });
    if (d.unlinked.length) {
      notices.appendChild(
        h(
          'details',
          { class: 'notice crm-notice' },
          h(
            'summary',
            null,
            d.unlinked.length +
              (d.unlinked.length === 1 ? ' row has' : ' rows have') +
              ' no email, so cannot be tracked'
          ),
          h(
            'ul',
            null,
            d.unlinked.map(function (u) {
              return h('li', null, u.name + ' · ' + SOURCE_LABELS[u.source] + ', row ' + u.row);
            })
          ),
          h('p', null, 'Add their email in the sheet and they will appear on the board.')
        )
      );
    }
  }

  function renderKanban(kind) {
    var cards = (kind === 'mentor' ? view.data.mentors : view.data.mentees).filter(visible);
    var columns = h('div', { class: 'crm-kanban' });
    view.data.statuses[kind].forEach(function (status) {
      var inColumn = cards.filter(function (c) {
        return c.status === status.key;
      });
      var list = h('div', { class: 'crm-col-list' }, inColumn.map(cardEl));
      var col = h(
        'section',
        { class: 'crm-col', 'data-status': status.key, 'aria-label': status.label },
        h(
          'header',
          null,
          h('span', null, status.label),
          h('span', { class: 'crm-count' }, String(inColumn.length))
        ),
        list
      );
      col.addEventListener('dragover', function (e) {
        if (status.key === 'matched') return;
        e.preventDefault();
        col.classList.add('is-over');
      });
      col.addEventListener('dragleave', function () {
        col.classList.remove('is-over');
      });
      col.addEventListener('drop', function (e) {
        e.preventDefault();
        col.classList.remove('is-over');
        var moved = JSON.parse(e.dataTransfer.getData('application/x-crm') || '{}');
        if (!moved.key || moved.status === status.key) return;
        change(moved.key, moved.kind, { status: status.key });
      });
      columns.appendChild(col);
    });
    if (!cards.length) {
      board.appendChild(h('p', { class: 'panel-note' }, 'Nobody here with these filters.'));
    }
    board.appendChild(columns);
  }

  function cardEl(c) {
    var used = c.capacity ? c.matches + '/' + c.capacity + ' mentees' : null;
    var el = h(
      'div',
      {
        class: 'crm-card' + (c.status === 'matched' ? ' is-locked' : ''),
        draggable: c.status === 'matched' ? 'false' : 'true',
      },
      h(
        'button',
        {
          type: 'button',
          class: 'crm-name',
          onclick: function () {
            openPerson(c.key, c.kind);
          },
        },
        c.name
      ),
      c.org ? h('span', { class: 'crm-card-org' }, c.org) : null,
      c.project ? h('span', { class: 'crm-card-project' }, c.project) : null,
      h(
        'span',
        { class: 'crm-card-meta' },
        c.track ? h('span', { class: 'crm-tag crm-track-' + c.track }, trackLabel(c.track)) : null,
        used ? h('span', { class: 'crm-tag' }, used) : null,
        c.notes
          ? h('span', { class: 'crm-tag' }, c.notes + (c.notes === 1 ? ' note' : ' notes'))
          : null,
        c.owner ? h('span', { class: 'crm-tag crm-owner' }, '● ' + c.owner) : null
      ),
      stagePill(c.key, c.kind)
    );
    el.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData(
        'application/x-crm',
        JSON.stringify({ key: c.key, kind: c.kind, status: c.status })
      );
      e.dataTransfer.effectAllowed = 'move';
    });
    return el;
  }

  // ── Changes ──────────────────────────────────────────────────────────────

  // Optimistic: the card moves at once, the server catches up in the background.
  function change(key, kind, changes, quiet) {
    var card = findCard(key, kind);
    if (!card) return Promise.resolve();
    var before = Object.assign({}, card);
    if (changes.status) card.status = changes.status;
    if (changes.track) card.track = changes.track;
    if (changes.owner) card.ownerId = changes.owner === 'me' ? view.data.me : null;
    if (changes.owner === 'none') card.owner = null;
    closeMenu();
    render();
    syncPanel(card);
    return M.api('POST', API + '?action=update', Object.assign({ key: key, kind: kind }, changes))
      .then(function (r) {
        if (r) {
          card.status = r.status;
          card.track = r.track;
          card.ownerId = r.ownerId;
          card.owner = r.owner;
        }
        render();
        syncPanel(card);
        if (changes.status && !quiet) {
          M.toast(card.name + ' moved to ' + statusLabel(kind, card.status), false, {
            label: 'Undo',
            run: function () {
              change(key, kind, { status: before.status }, true);
            },
          });
        }
      })
      .catch(function (err) {
        Object.assign(card, before);
        render();
        syncPanel(card);
        if (err.status === 401) fail(err);
        else M.toast(err.message, true);
      });
  }

  /** The open person panel follows the card, without asking the server again. */
  function syncPanel(card) {
    if (view.open && view.open.key === card.key && view.open.kind === card.kind && view.open.sync) {
      view.open.sync(card);
    }
  }

  // ── One person ───────────────────────────────────────────────────────────

  function openPerson(key, kind) {
    var mine = { key: key, kind: kind };
    var side = inAside();
    var out = side ? asideBody : panelBody;
    view.open = mine;
    view.shown = kind + ':' + key;
    M.clear(out);
    out.appendChild(M.loading());
    if (side) markSelected();
    else if (!panel.open) panel.showModal();
    M.api('GET', API + '?key=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind))
      .then(function (p) {
        if (view.open === mine) renderPerson(p, out);
      })
      .catch(function (err) {
        if (!side) panel.close();
        fail(err);
      });
  }

  panel.addEventListener('close', function () {
    view.open = null;
    view.shown = null;
  });
  wide.addEventListener('change', function () {
    if (view.data) render();
  });

  function renderPerson(p, out) {
    var shown = window.CrmPerson.render(p, out, {
      layout: 'panel',
      me: view.data.me,
      statuses: view.data.statuses[p.kind],
      tracks: view.data.tracks,
      change: change,
      onClose: out === panelBody ? panel.close.bind(panel) : null,
      nameOf: function (key, kind) {
        var c = findCard(key, kind);
        return c && c.name;
      },
      onNoteAdded: function (fresh) {
        var card = findCard(fresh.key, fresh.kind);
        if (card) card.notes = fresh.notes.length;
        render();
      },
      onRemoved: function () {
        panel.close();
        view.open = null;
        view.shown = null;
        load().catch(fail);
      },
    });
    view.open.sync = function (card) {
      shown.sync(card);
    };
  }

  // ── Pairs ────────────────────────────────────────────────────────────────

  function renderPairs() {
    var d = view.data;
    var trackSel = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Track' },
      d.tracks
        .filter(function (t) {
          return t.key !== 'both';
        })
        .map(function (t) {
          return h('option', { value: t.key }, t.label);
        })
    );
    var mentorSel = h('select', { class: 'form-input is-compact', 'aria-label': 'Mentor' });
    var menteeSel = h('select', { class: 'form-input is-compact', 'aria-label': 'Mentee' });
    var fits = function (c, track) {
      return !c.track || c.track === 'both' || c.track === track;
    };

    function fill() {
      var track = trackSel.value;
      M.clear(mentorSel);
      M.clear(menteeSel);
      var mentors = d.mentors.filter(function (c) {
        return (c.status === 'selected' || c.status === 'matched') && fits(c, track);
      });
      var mentees = d.mentees.filter(function (c) {
        return c.status === 'selected' && fits(c, track);
      });
      mentorSel.appendChild(
        h(
          'option',
          { value: '' },
          mentors.length ? 'Choose a mentor' : 'No selected mentor on this track'
        )
      );
      mentors.forEach(function (c) {
        var room = c.capacity ? ' (' + c.matches + '/' + c.capacity + ')' : '';
        mentorSel.appendChild(h('option', { value: c.key }, c.name + room));
      });
      menteeSel.appendChild(
        h(
          'option',
          { value: '' },
          mentees.length ? 'Choose a mentee' : 'No selected mentee on this track'
        )
      );
      mentees.forEach(function (c) {
        menteeSel.appendChild(h('option', { value: c.key }, c.name));
      });
    }
    trackSel.addEventListener('change', fill);
    fill();

    var pairBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          if (!mentorSel.value || !menteeSel.value)
            return M.toast('Choose a mentor and a mentee', true);
          pairBtn.disabled = true;
          M.api('POST', API + '?action=match', {
            mentorKey: mentorSel.value,
            menteeKey: menteeSel.value,
            track: trackSel.value,
          })
            .then(function (r) {
              M.toast(
                r.overCapacity
                  ? 'Paired, but this mentor is now over the number of mentees they asked for'
                  : 'Paired',
                r.overCapacity
              );
              return load();
            })
            .catch(function (err) {
              pairBtn.disabled = false;
              fail(err);
            });
        },
      },
      'Pair them'
    );

    board.appendChild(
      h(
        'div',
        { class: 'panel crm-pair-form' },
        h('div', { class: 'panel-head' }, h('h2', null, 'New pair')),
        h(
          'p',
          { class: 'panel-note' },
          'Only people at the Selected stage, on the chosen track, are offered.'
        ),
        h('div', { class: 'crm-pair-row' }, trackSel, mentorSel, menteeSel, pairBtn)
      )
    );

    board.appendChild(
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Pairs (' + d.matches.length + ')')),
        d.matches.length
          ? h(
              'ul',
              { class: 'crm-pairs' },
              d.matches.map(function (m) {
                return h(
                  'li',
                  null,
                  h(
                    'span',
                    null,
                    h('strong', null, m.mentor.name),
                    ' → ',
                    h('strong', null, m.mentee.name)
                  ),
                  h('span', { class: 'crm-tag crm-track-' + m.track }, trackLabel(m.track)),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'link-button',
                      onclick: function () {
                        if (
                          !window.confirm(
                            'End the pair ' +
                              m.mentor.name +
                              ' → ' +
                              m.mentee.name +
                              '? Both go back to Selected.'
                          )
                        )
                          return;
                        M.api('POST', API + '?action=end-match', { id: m.id })
                          .then(load)
                          .catch(fail);
                      },
                    },
                    'End'
                  )
                );
              })
            )
          : h('p', { class: 'panel-note' }, 'No pairs yet.')
      )
    );
  }
})();
