/* /app/review/: the mentee selection, for a reviewer.
 *   #<section>   the sections of the setup given to me (say the CV and the
 *                answers), each scored apart under its own code
 * The sections as tabs on top; the list on the left, the application and the
 * grid on the right. With one grid per question, each question's criteria
 * sit under it. Everything
 * comes from /api/app/crm/review, which never sends a name or a person key to
 * a reviewer. What the applicants wrote goes on the page as text (h() makes
 * text nodes), never as HTML. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvPage');

  var view = { part: null, overview: null, list: null, open: null, app: null };

  function sections() {
    return (view.overview && view.overview.sections) || [];
  }

  function sectionOf(key) {
    return (
      sections().filter(function (s) {
        return s.key === key;
      })[0] || null
    );
  }

  function partOfHash() {
    var p = decodeURIComponent(window.location.hash.replace('#', ''));
    if (sectionOf(p)) return p;
    return sections().length ? sections()[0].key : null;
  }

  // What a reviewer is told when the admins wrote nothing for a section.
  function noteOf(section) {
    if (section.note) return section.note;
    return section.anonymous
      ? 'Names, affiliations, emails, links and phone numbers are taken out. If you recognise the person anyway, step aside.'
      : 'This section is not anonymous. Score on the merits, and step aside if you know the person.';
  }

  function empty(title, text, extra) {
    M.clear(root);
    root.appendChild(
      h('div', { class: 'empty-state' }, h('h3', null, title), h('p', null, text), extra)
    );
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      return empty(err.status === 403 ? 'No access' : 'Not set up yet', err.message);
    }
    M.appError(err);
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function start() {
    M.clear(root).appendChild(M.loading());
    Promise.all([M.me, M.api('GET', API)])
      .then(function (r) {
        view.overview = r[1];
        view.part = partOfHash();
        if (!view.overview.reviewer) {
          return empty(
            'You are not a reviewer',
            'Only the reviewers score the applications.',
            view.overview.admin
              ? h(
                  'p',
                  null,
                  h('a', { href: '/app/review/settings/' }, 'Add yourself to the reviewers'),
                  ' to score, or read the ',
                  h('a', { href: '/app/review/summary/' }, 'summary'),
                  '.'
                )
              : null
          );
        }
        if (!view.part) {
          return empty(
            'Nothing to score',
            'No section of the selection is given to you: the admins choose who scores what.'
          );
        }
        return loadList();
      })
      .catch(fail);
  }

  function loadList() {
    return M.api('GET', API + '?part=' + view.part).then(function (list) {
      view.list = list;
      view.open = null;
      view.app = null;
      render();
      var next = firstTodo();
      if (next) openItem(next.code);
    });
  }

  function firstTodo(after) {
    var items = view.list.items;
    var from = 0;
    if (after) {
      items.forEach(function (it, i) {
        if (it.code === after) from = i + 1;
      });
    }
    var rest = items.slice(from).concat(items.slice(0, from));
    return (
      rest.filter(function (it) {
        return it.state === 'todo' || it.state === 'partial';
      })[0] || null
    );
  }

  // Scores typed and not saved: asked before another application or part
  // takes their place (and before leaving the page).
  var scoreFields = null;
  function thenLeave(go) {
    if (scoreFields) scoreFields.confirm(go);
    else go();
  }

  window.addEventListener('hashchange', function () {
    if (partOfHash() === view.part) return;
    var next = location.hash;
    if (scoreFields && scoreFields.changed()) {
      // Stay put (the address too) unless told to go.
      history.replaceState(null, '', '#' + view.part);
      return thenLeave(function () {
        scoreFields = null;
        location.hash = next;
      });
    }
    start();
  });

  // ── The page ─────────────────────────────────────────────────────────────

  var listEl, detailEl, progressEl;

  function counts() {
    var done = view.list.items.filter(function (it) {
      return it.state === 'done' || it.state === 'conflict';
    }).length;
    return { done: done, total: view.list.items.length };
  }

  function renderProgress() {
    var c = counts();
    // The current section's tab counts along.
    var tab = root.querySelector('.rv-sections a[aria-current] small');
    if (tab) tab.textContent = ' ' + c.done + '/' + c.total;
    M.clear(progressEl).appendChild(
      h(
        'div',
        { class: 'rv-progress' },
        h('span', null, h('strong', null, String(c.done)), ' of ' + c.total + ' scored'),
        h(
          'span',
          { class: 'rv-bar', 'aria-hidden': 'true' },
          h('span', { style: 'width:' + (c.total ? (100 * c.done) / c.total : 0) + '%' })
        )
      )
    );
  }

  var STATE = {
    todo: 'To score',
    partial: 'Half done',
    done: 'Scored',
    conflict: 'Stepped aside',
  };

  function renderList() {
    M.clear(listEl);
    if (!view.list.items.length) {
      listEl.appendChild(h('p', { class: 'panel-note rv-pad' }, 'No applications to score yet.'));
      return;
    }
    view.list.items.forEach(function (it) {
      listEl.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'rv-item' + (view.open === it.code ? ' is-selected' : ''),
            'aria-current': view.open === it.code ? 'true' : null,
            onclick: function () {
              if (view.open === it.code) return;
              thenLeave(function () {
                openItem(it.code);
              });
            },
          },
          h('span', { class: 'rv-code' }, it.code),
          h('span', { class: 'rv-state is-' + it.state }, STATE[it.state])
        )
      );
    });
  }

  // The sections given to me, with how far I am in each.
  function sectionTabs() {
    return h(
      'nav',
      { class: 'fr-views rv-sections', 'aria-label': 'Sections' },
      sections().map(function (s) {
        var current = s.key === view.part;
        return h(
          'a',
          {
            href: '#' + encodeURIComponent(s.key),
            'aria-current': current ? 'page' : null,
          },
          s.label,
          h('small', null, ' ' + (current ? counts().done : s.done) + '/' + s.total)
        );
      })
    );
  }

  function render() {
    M.clear(root);
    progressEl = h('div');
    listEl = h('div', { class: 'rv-list', role: 'list' });
    detailEl = h('div', { class: 'rv-detail' });
    if (sections().length > 1) root.appendChild(sectionTabs());
    root.appendChild(
      h(
        'div',
        { class: 'rv-intro' },
        h('p', { class: 'panel-note' }, noteOf(view.list.section)),
        progressEl
      )
    );
    root.appendChild(h('div', { class: 'rv-split' }, listEl, detailEl));
    renderProgress();
    renderList();
    renderDetail();
  }

  // ── One application ──────────────────────────────────────────────────────

  function openItem(code) {
    view.open = code;
    view.app = null;
    renderList();
    M.clear(detailEl).appendChild(M.loading());
    M.api('GET', API + '?part=' + view.part + '&code=' + encodeURIComponent(code))
      .then(function (app) {
        if (view.open !== code) return;
        view.app = app;
        renderDetail();
      })
      .catch(function (err) {
        if (err.status === 404) return loadList();
        fail(err);
      });
  }

  // One answer: a link to open, or the text as written (scrubbed when the
  // section is anonymous), and, with one grid per question, its criteria.
  function renderItem(item, extra) {
    var body;
    if (item.url) {
      body = h(
        'a',
        {
          class: 'btn btn-outline btn-sm',
          href: item.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'Open ↗'
      );
    } else if (item.text.trim()) {
      body = item.text;
    } else {
      body = h('span', { class: 'panel-note' }, 'No answer');
    }
    return [h('dt', null, item.label), h('dd', null, body, extra)];
  }

  function renderApplication(app, perQuestion) {
    if (!app.items.length)
      return h('p', { class: 'panel-note' }, 'Nothing to show in this section.');
    return h(
      'dl',
      { class: 'rv-answers' },
      app.items.map(function (item) {
        return renderItem(item, perQuestion ? perQuestion[item.id] : null);
      })
    );
  }

  function scaleRow(criterion, value, onChange) {
    var name = 'rv-' + criterion.key.replace(/\./g, '-');
    var options = [];
    for (var n = view.app.scale.min; n <= view.app.scale.max; n++) {
      (function (n) {
        var input = h('input', {
          type: 'radio',
          name: name,
          value: String(n),
          onchange: function () {
            onChange(n);
          },
        });
        input.checked = value === n;
        options.push(h('label', { class: 'rv-dot' }, input, h('span', null, String(n))));
      })(n);
    }
    return h(
      'fieldset',
      { class: 'rv-criterion' },
      h(
        'legend',
        null,
        h('strong', null, criterion.label),
        criterion.help ? h('small', null, criterion.help) : null
      ),
      h('div', { class: 'rv-scale' }, options)
    );
  }

  function renderDetail() {
    if (!detailEl) return;
    M.clear(detailEl);
    var app = view.app;
    if (!app) {
      if (!view.open) {
        detailEl.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, view.list.items.length ? 'All scored' : 'Nothing yet'),
            h(
              'p',
              null,
              view.list.items.length ? 'Pick one in the list to change your scores.' : ''
            )
          )
        );
      }
      return;
    }
    var mine = app.mine || { scores: {}, conflict: false, comment: '' };
    var draft = {
      scores: Object.assign({}, mine.scores),
      conflict: mine.conflict,
      comment: mine.comment || '',
    };

    // A grid for the whole section goes in the form; one per question goes
    // under each question, in the same form (form= ties the radios to it).
    var formId = 'rvForm';
    var grid = h('div', { class: 'rv-grid' });
    var perQuestion = {};
    app.grid.forEach(function (c) {
      if (c.question && !perQuestion[c.question]) {
        perQuestion[c.question] = h('div', { class: 'rv-grid rv-grid-inline' });
      }
    });
    function row(c) {
      var el = scaleRow(c, draft.scores[c.key], function (n) {
        draft.scores[c.key] = n;
      });
      el.querySelectorAll('input').forEach(function (input) {
        input.setAttribute('form', formId);
      });
      return el;
    }
    function renderGrid() {
      M.clear(grid);
      grid.hidden = draft.conflict;
      Object.keys(perQuestion).forEach(function (q) {
        M.clear(perQuestion[q]);
        perQuestion[q].hidden = draft.conflict;
      });
      app.grid.forEach(function (c) {
        (c.question ? perQuestion[c.question] : grid).appendChild(row(c));
      });
    }
    renderGrid();
    var hasSectionGrid = app.grid.some(function (c) {
      return !c.question;
    });

    var comment = h('textarea', {
      class: 'form-input',
      id: 'rvComment',
      rows: '3',
      maxlength: '2000',
      placeholder: 'What stood out, for the other reviewers’ discussion (only the admins read it).',
    });
    comment.value = draft.comment;
    var conflict = h('input', {
      type: 'checkbox',
      onchange: function () {
        draft.conflict = conflict.checked;
        renderGrid();
      },
    });
    conflict.checked = draft.conflict;
    var error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    var save = h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Save and next');

    var form = h(
      'form',
      {
        class: 'rv-form',
        id: formId,
        novalidate: true,
        onsubmit: function (e) {
          e.preventDefault();
          error.hidden = true;
          save.disabled = true;
          var code = app.code;
          M.api('POST', API + '?action=score', {
            part: app.part,
            code: code,
            scores: draft.conflict ? {} : draft.scores,
            conflict: draft.conflict,
            comment: comment.value,
          })
            .then(function (r) {
              view.list.items.forEach(function (it) {
                if (it.code === code) it.state = r.state;
              });
              renderProgress();
              scoreFields.saved();
              M.toast(r.state === 'partial' ? 'Saved, not complete yet' : 'Saved');
              // Once complete, on to the next one still to score.
              var next = r.state !== 'partial' && firstTodo(code);
              openItem(next ? next.code : code);
            })
            .catch(function (err) {
              if (err.status === 401) return M.appError(err);
              error.textContent = err.message;
              error.hidden = false;
            })
            .then(function () {
              save.disabled = false;
            });
        },
      },
      grid,
      h('label', { class: 'form-label', for: 'rvComment' }, 'Comment (optional)'),
      comment,
      h(
        'label',
        { class: 'check-row rv-conflict' },
        conflict,
        h('span', null, 'I know who this is: I step aside from scoring them')
      ),
      error,
      h('div', null, save)
    );

    detailEl.appendChild(
      h(
        'div',
        { class: 'rv-card' },
        h(
          'div',
          { class: 'rv-card-head' },
          h('h2', null, app.code),
          mine.updatedAt
            ? h('span', { class: 'panel-note' }, 'Last saved ' + M.fmtDateTime(mine.updatedAt))
            : null
        ),
        hasSectionGrid
          ? null
          : h(
              'p',
              { class: 'panel-note rv-hint' },
              'Score each question below it (1 = weak, 5 = excellent).'
            ),
        renderApplication(app, perQuestion),
        h(
          'h3',
          { class: 'rv-grid-title' },
          hasSectionGrid ? 'Your scores (1 = weak, 5 = excellent)' : 'Your review'
        ),
        form
      )
    );
    // The whole card: the scores under each question are outside the form.
    scoreFields = M.watchFields(detailEl.firstChild, {
      buttons: function () {
        return [save];
      },
    });
  }

  start();
})();
