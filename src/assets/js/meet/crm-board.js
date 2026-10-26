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

  var view = { data: null, tab: 'mentors', track: '', q: '', mine: false, open: null };

  var SOURCE_LABELS = {
    mentors_prospective: 'List to contact',
    mentors_applications: 'Mentor application',
    mentees_interest: 'Expression of interest',
  };

  var FIELD_LABELS = {
    timestamp: 'Sent',
    consent: 'Privacy notice',
    first_name: 'First name',
    last_name: 'Last name',
    name: 'Name',
    email: 'Email',
    form_email: 'Form email',
    social: 'Social',
    org: 'Affiliation',
    affiliation: 'Affiliation',
    role: 'Role',
    career: 'Career stage',
    track: 'Track',
    tracks: 'Tracks',
    referrer: 'Recommended by',
    notes: 'Area / notes',
    contacted: 'Contacted',
    replied: 'Replied',
    reply_note: 'What they said',
    cv: 'CV',
    profile: 'Profile',
    country: 'Country and time zone',
    background: 'Background',
    areas: 'Areas',
    language: 'Language',
    mode: 'Meetings',
    editions: 'Editions',
    project_title: 'Project',
    project_area: 'Project area',
    project_abstract: 'Abstract',
    compute: 'Compute needed',
    interview: 'Interviews mentees',
    mentees: 'Mentees wanted',
    hours_mentee: 'Hours a week (mentee)',
    hours_mentor: 'Hours a week (mentor)',
    co_mentor: 'Co-mentor',
    applying_as: 'Applying as',
  };

  var ACTION_LABELS = {
    'view-person': 'opened the card',
    'view-note': 'read the notes',
    'set-status': 'changed',
    'add-note': 'added a note',
    'set-match': 'pairing',
    denied: 'was refused',
  };

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

  /** Only real web links become links. */
  function safeLink(url) {
    return /^https:\/\/[^\s]+$/i.test(String(url || '')) ? url : null;
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
    document.querySelectorAll('#crmTabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === view.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (view.data) render();
  }
  window.addEventListener('hashchange', function () {
    setTab(location.hash.slice(1));
  });
  setTab(location.hash.slice(1));

  document.querySelectorAll('#trackFilter .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      view.track = chip.getAttribute('data-track');
      document.querySelectorAll('#trackFilter .chip').forEach(function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
      render();
    });
  });
  document.getElementById('crmSearch').addEventListener('input', function (e) {
    view.q = fold(e.target.value.trim());
    render();
  });
  document.getElementById('onlyMine').addEventListener('change', function (e) {
    view.mine = e.target.checked;
    render();
  });

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
    if (view.tab === 'pairs') renderPairs();
    else renderKanban(view.tab === 'mentees' ? 'mentee' : 'mentor');
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
      'button',
      {
        type: 'button',
        class: 'crm-card' + (c.status === 'matched' ? ' is-locked' : ''),
        draggable: c.status === 'matched' ? 'false' : 'true',
        onclick: function () {
          openPerson(c.key, c.kind);
        },
      },
      h('strong', null, c.name),
      c.org ? h('span', { class: 'crm-card-org' }, c.org) : null,
      c.project ? h('span', { class: 'crm-card-project' }, c.project) : null,
      h(
        'span',
        { class: 'crm-card-meta' },
        h('span', { class: 'crm-tag crm-track-' + (c.track || 'none') }, trackLabel(c.track)),
        used ? h('span', { class: 'crm-tag' }, used) : null,
        c.notes
          ? h('span', { class: 'crm-tag' }, c.notes + (c.notes === 1 ? ' note' : ' notes'))
          : null,
        c.owner ? h('span', { class: 'crm-tag crm-owner' }, '● ' + c.owner) : null
      )
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

  function change(key, kind, changes) {
    var body = Object.assign({ key: key, kind: kind }, changes);
    return M.api('POST', API + '?action=update', body)
      .then(function () {
        return load();
      })
      .then(function () {
        if (view.open && view.open.key === key && view.open.kind === kind) openPerson(key, kind);
      })
      .catch(fail);
  }

  // ── One person ───────────────────────────────────────────────────────────

  function openPerson(key, kind) {
    view.open = { key: key, kind: kind };
    M.clear(panelBody);
    panelBody.appendChild(M.loading());
    if (!panel.open) panel.showModal();
    M.api('GET', API + '?key=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind))
      .then(renderPerson)
      .catch(function (err) {
        panel.close();
        fail(err);
      });
  }

  panel.addEventListener('close', function () {
    view.open = null;
  });

  function renderPerson(p) {
    M.clear(panelBody);
    var email = p.email
      ? h('a', { href: 'mailto:' + encodeURIComponent(p.email).replace(/%40/g, '@') }, p.email)
      : null;

    var statusSelect = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Stage' },
      view.data.statuses[p.kind].map(function (s) {
        var o = h('option', { value: s.key }, s.label);
        if (s.key === p.status) o.selected = true;
        if (s.key === 'matched' && p.status !== 'matched') o.disabled = true;
        return o;
      })
    );
    statusSelect.addEventListener('change', function () {
      change(p.key, p.kind, { status: statusSelect.value });
    });

    var trackSelect = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Track' },
      [h('option', { value: '' }, 'As in the sheets')].concat(
        view.data.tracks.map(function (t) {
          var o = h('option', { value: t.key }, t.label);
          if (t.key === p.track) o.selected = true;
          return o;
        })
      )
    );
    trackSelect.addEventListener('change', function () {
      change(p.key, p.kind, { track: trackSelect.value || null });
    });

    var mine = p.ownerId && p.ownerId === view.data.me;
    var ownerBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm',
        onclick: function () {
          change(p.key, p.kind, { owner: mine ? 'none' : 'me' });
        },
      },
      mine ? 'Drop' : 'Take on'
    );

    panelBody.appendChild(
      h(
        'div',
        { class: 'crm-person-head' },
        h(
          'div',
          null,
          h('span', { class: 'eyebrow' }, p.kind === 'mentor' ? 'Mentor' : 'Mentee'),
          h('h2', { id: 'personName' }, p.name),
          p.org ? h('p', { class: 'panel-note' }, p.org) : null,
          email
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': 'Close',
            onclick: function () {
              panel.close();
            },
          },
          '×'
        )
      )
    );

    panelBody.appendChild(
      h(
        'div',
        { class: 'crm-person-controls' },
        h('label', null, h('span', { class: 'form-label' }, 'Stage'), statusSelect),
        h('label', null, h('span', { class: 'form-label' }, 'Track'), trackSelect),
        h(
          'div',
          null,
          h('span', { class: 'form-label' }, 'Followed by'),
          h('div', { class: 'crm-owner-row' }, h('span', null, p.owner || 'Nobody yet'), ownerBtn)
        )
      )
    );
    if (p.status === 'matched') {
      panelBody.appendChild(
        h('p', { class: 'panel-note' }, 'Paired: end the pair (in Pairs) to move them by hand.')
      );
    }

    // Notes
    var noteInput = h('textarea', {
      class: 'form-input is-compact',
      rows: '3',
      maxlength: '4000',
      placeholder: 'A note for the team (encrypted when stored)…',
      'aria-label': 'New note',
    });
    var noteBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          var text = noteInput.value.trim();
          if (!text) return;
          noteBtn.disabled = true;
          M.api('POST', API + '?action=note', { key: p.key, kind: p.kind, body: text })
            .then(function () {
              return load();
            })
            .then(function () {
              openPerson(p.key, p.kind);
            })
            .catch(function (err) {
              noteBtn.disabled = false;
              fail(err);
            });
        },
      },
      'Add note'
    );
    panelBody.appendChild(
      h(
        'section',
        { class: 'crm-section' },
        h('h3', null, 'Notes'),
        p.notes.length
          ? h(
              'ul',
              { class: 'crm-notes' },
              p.notes.map(function (n) {
                return h(
                  'li',
                  null,
                  h('p', null, n.body),
                  h('small', null, n.author + ' · ' + M.fmtDateTime(n.createdAt, 'Europe/Rome'))
                );
              })
            )
          : h('p', { class: 'panel-note' }, 'No notes yet.'),
        noteInput,
        h('div', { class: 'crm-note-actions' }, noteBtn)
      )
    );

    // What the sheets say
    panelBody.appendChild(
      h(
        'section',
        { class: 'crm-section' },
        h('h3', null, 'From the sheets'),
        p.sheets.map(function (s) {
          return h(
            'details',
            { class: 'crm-sheet', open: p.sheets.length === 1 ? true : null },
            h('summary', null, (SOURCE_LABELS[s.source] || s.label) + ' · row ' + s.row),
            h(
              'dl',
              null,
              Object.keys(s.fields).map(function (f) {
                var value = s.fields[f];
                var link = (f === 'cv' || f === 'profile' || f === 'social') && safeLink(value);
                return [
                  h('dt', null, FIELD_LABELS[f] || f),
                  h(
                    'dd',
                    null,
                    link
                      ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, value)
                      : value
                  ),
                ];
              })
            )
          );
        })
      )
    );

    // History
    if (p.history.length) {
      panelBody.appendChild(
        h(
          'section',
          { class: 'crm-section' },
          h('h3', null, 'History'),
          h(
            'ul',
            { class: 'activity-list' },
            p.history.map(function (a) {
              var what = ACTION_LABELS[a.action] || a.action;
              var d = a.detail || {};
              if (a.action === 'set-status' && d.to)
                what = 'moved ' + statusLabel(p.kind, d.from) + ' → ' + statusLabel(p.kind, d.to);
              else if (a.action === 'set-status' && d.owner)
                what = d.owner === 'me' ? 'took them on' : 'dropped them';
              else if (a.action === 'set-status' && 'track' in d)
                what = 'set the track: ' + trackLabel(d.track);
              else if (a.action === 'set-match')
                what =
                  (d.action === 'create' ? 'paired them' : 'ended the pair') +
                  ' (' +
                  trackLabel(d.track) +
                  ')';
              return h(
                'li',
                null,
                h('span', { class: 'activity-when' }, M.fmtDateTime(a.at, 'Europe/Rome')),
                h('span', null, h('strong', null, a.userName), ' ' + what)
              );
            })
          )
        )
      );
    }
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
