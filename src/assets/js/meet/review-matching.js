/* /app/review/matching/: the mentees paired with the mentors after the
 * selection, for its admins.
 *
 * Projects: one card per project of the ranking question in the mentee form,
 * with its mentors and places, and the mentees who ranked it, by
 *   adjusted = overall − penalty × (their place for it − 1).
 * A suggestion pairs everyone at once (a stable matching: each mentee gets the
 * best project they ranked that would keep them); a pair is made only when
 * confirmed, and it is the mentorship board's own match.
 * Career orientation: the score only says who is in. Each mentee opens on
 * their answers, next to the mentors' profiles; the admins propose a mentor
 * and a note (a shared draft), then pair the proposals.
 * The setup (which mentors run each project, its places) is the admins' and
 * leaves the form and its answers as they are. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvMatching');

  var view = {
    data: null,
    tab: 'projects',
    pool: 'selected',
    setup: false,
    draft: null,
    busy: false,
    openOrientation: new Set(),
  };
  try {
    view.tab = localStorage.getItem('mt-tab') || 'projects';
    view.pool = localStorage.getItem('mt-pool') || 'selected';
  } catch (e) {
    /* private window: the defaults */
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      M.clear(root).appendChild(
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
    return M.api('GET', API + '?action=matching&pool=' + encodeURIComponent(view.pool)).then(
      function (data) {
        view.data = data;
        if (!data.settings.question) view.setup = true;
        render();
      }
    );
  }

  root.appendChild(M.loading());
  Promise.all([M.me, load()]).catch(fail);

  function remember(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* not remembered: fine */
    }
  }

  function num(n) {
    return n === null || n === undefined ? '–' : n.toFixed(2);
  }

  function ordinal(n) {
    return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
  }

  function statusLabel(key) {
    var s = view.data.statuses.filter(function (x) {
      return x.key === key;
    })[0];
    return s ? s.label : key || 'Not on the board';
  }

  function status(p) {
    if (!p.onBoard) return h('span', { class: 'rv-status panel-note' }, 'Not on the board');
    return h(
      'span',
      { class: 'rv-status' },
      h('span', { class: 'crm-dot', style: '--crm-dot:var(--crm-st-' + p.status + ')' }),
      statusLabel(p.status)
    );
  }

  function mentorName(key) {
    var m = view.data.mentors.concat(view.data.orientation.mentors).filter(function (x) {
      return x.key === key;
    })[0];
    return m ? m.name : '';
  }

  // ── Making a pair ──────────────────────────────────────────────────────────

  // `to`: { project } on the projects track (the mentee goes with all its
  // mentors), { mentorKey } on career orientation.
  function pair(to, menteeKey, track) {
    return M.api('POST', API + '?action=match', {
      project: to.project,
      mentorKey: to.mentorKey,
      menteeKey: menteeKey,
      track: track,
    }).then(function (r) {
      if (r && r.overCapacity && to.mentorKey)
        M.toast(mentorName(to.mentorKey) + ' is now over their places', true);
      return r;
    });
  }

  function pairAndReload(to, menteeKey, track, label) {
    if (view.busy) return;
    view.busy = true;
    pair(to, menteeKey, track)
      .then(function () {
        M.toast(label + ': paired (also on the board)');
        return load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      })
      .then(function () {
        view.busy = false;
      });
  }

  function confirmAll() {
    var list = view.data.suggestion.filter(function (s) {
      return s.ready && s.status === 'selected';
    });
    if (!list.length || view.busy) return;
    if (
      !window.confirm(
        'Make the ' + list.length + ' suggested pairs? They go on the mentorship board.'
      )
    )
      return;
    view.busy = true;
    var done = 0;
    var errors = [];
    list
      .reduce(function (chain, s) {
        return chain.then(function () {
          return pair({ project: s.project }, s.menteeKey, 'projects').then(
            function () {
              done += 1;
            },
            function (err) {
              errors.push(s.name + ': ' + err.message);
            }
          );
        });
      }, Promise.resolve())
      .then(function () {
        M.toast(
          done + ' paired' + (errors.length ? '; not paired: ' + errors.join('; ') : ''),
          Boolean(errors.length)
        );
        return load();
      })
      .catch(fail)
      .then(function () {
        view.busy = false;
      });
  }

  // ── The setup ──────────────────────────────────────────────────────────────

  function startDraft() {
    var s = view.data.settings;
    var projects = {};
    view.data.projects.forEach(function (p) {
      var set = s.projects[p.id];
      projects[p.id] = {
        mentors: set ? set.mentors.slice() : (p.guess || []).slice(),
        places: set && set.places !== null && set.places !== undefined ? String(set.places) : '',
        guessed: !set && Boolean(p.guess),
      };
    });
    view.draft = {
      formId: s.formId || '',
      question: s.question || '',
      questions: view.data.questions,
      projects: projects,
    };
  }

  function saveSetup(body) {
    if (view.busy) return;
    view.busy = true;
    M.api('PUT', API + '?action=matching-settings', body)
      .then(function () {
        M.toast('Setup saved');
        view.draft = null;
        return load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      })
      .then(function () {
        view.busy = false;
      });
  }

  function mentorPicker(entry) {
    var chips = h(
      'div',
      { class: 'mt-chips' },
      entry.mentors.map(function (key) {
        return h(
          'span',
          { class: 'rv-pill is-on mt-chip' },
          mentorName(key) || '(no longer on the board)',
          h(
            'button',
            {
              type: 'button',
              class: 'mt-chip-x',
              'aria-label': 'Remove ' + mentorName(key),
              onclick: function () {
                entry.mentors = entry.mentors.filter(function (k) {
                  return k !== key;
                });
                entry.guessed = false;
                render();
              },
            },
            '×'
          )
        );
      })
    );
    var add = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Add a mentor',
        onchange: function () {
          if (add.value && entry.mentors.indexOf(add.value) === -1) entry.mentors.push(add.value);
          entry.guessed = false;
          render();
        },
      },
      h('option', { value: '' }, entry.mentors.length ? '+ another mentor' : 'Choose the mentor…'),
      view.data.mentors
        .filter(function (m) {
          return entry.mentors.indexOf(m.key) === -1;
        })
        .map(function (m) {
          return h('option', { value: m.key }, m.name + (m.ready ? '' : ' (' + m.status + ')'));
        })
    );
    return h('div', { class: 'mt-picker' }, chips, add);
  }

  function setupPanel() {
    if (!view.draft) startDraft();
    var d = view.draft;
    var data = view.data;
    var formSelect = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Form',
        onchange: function () {
          d.formId = formSelect.value;
          d.question = '';
          d.questions = [];
          if (!d.formId) return render();
          M.api('GET', API + '?action=matching-questions&form=' + encodeURIComponent(d.formId))
            .then(function (r) {
              d.questions = r.questions;
              if (r.questions.length === 1) d.question = r.questions[0].id;
              render();
            })
            .catch(function (err) {
              M.toast(err.message, true);
            });
        },
      },
      h('option', { value: '' }, 'Choose the mentee form…'),
      data.forms.map(function (f) {
        var o = h(
          'option',
          { value: f.id },
          f.title + (f.responses !== null ? ' (' + f.responses + ' answers)' : '')
        );
        o.selected = f.id === d.formId;
        return o;
      })
    );
    var questionSelect = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Ranking question',
        disabled: !d.formId,
        onchange: function () {
          d.question = questionSelect.value;
        },
      },
      h(
        'option',
        { value: '' },
        d.formId && !d.questions.length
          ? 'No ranking question in this form'
          : 'Choose the question…'
      ),
      d.questions.map(function (q) {
        var o = h('option', { value: q.id }, q.label);
        o.selected = q.id === d.question;
        return o;
      })
    );
    var sameQuestion =
      d.formId === (data.settings.formId || '') && d.question === (data.settings.question || '');

    var body = [
      h(
        'div',
        { class: 'mt-setup-row' },
        h('label', { class: 'mt-field' }, h('span', null, 'Form'), formSelect),
        h('label', { class: 'mt-field' }, h('span', null, 'Ranking question'), questionSelect)
      ),
    ];

    if (sameQuestion && data.projects.length) {
      body.push(
        h(
          'p',
          { class: 'panel-note' },
          'Who runs each project, and how many mentees it takes. Co-mentors run it together: a mentee is paired with all of them. Places left empty: the most any of its mentors said on the board. Guesses come from the names in brackets: check them.'
        ),
        h(
          'div',
          { class: 'fr-table-wrap rv-table-wrap' },
          h(
            'table',
            { class: 'rv-table mt-setup-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Project (option)'),
                h('th', null, 'Mentors'),
                h('th', null, 'Places')
              )
            ),
            h(
              'tbody',
              null,
              data.projects.map(function (p) {
                var entry = d.projects[p.id];
                var places = h('input', {
                  class: 'form-input is-compact mt-places',
                  type: 'number',
                  min: '0',
                  max: String(data.limits.places),
                  placeholder: p.boardPlaces ? String(p.boardPlaces) : '?',
                  title: p.boardPlaces
                    ? 'From the board (' + placesSource(p) + '): leave empty to keep it'
                    : 'Not on the board: set it here',
                  value: entry.places,
                  'aria-label': 'Places for ' + p.label,
                  oninput: function () {
                    entry.places = places.value;
                  },
                });
                return h(
                  'tr',
                  { class: p.mapped || entry.mentors.length ? '' : 'mt-unmapped' },
                  h(
                    'td',
                    null,
                    p.label,
                    entry.guessed ? h('small', { class: 'mt-guess' }, ' guessed') : null,
                    !entry.mentors.length ? h('small', { class: 'rv-flag' }, 'no mentor') : null
                  ),
                  h('td', null, mentorPicker(entry)),
                  h(
                    'td',
                    null,
                    places,
                    h(
                      'small',
                      { class: 'panel-note mt-places-from' },
                      entry.places !== '' ? 'set here' : p.boardPlaces ? placesSource(p) : 'unknown'
                    )
                  )
                );
              })
            )
          )
        )
      );
    } else if (d.question) {
      body.push(h('p', { class: 'panel-note' }, 'Save to see the projects of this question.'));
    }

    return h(
      'section',
      { class: 'panel mt-setup' },
      h(
        'div',
        { class: 'panel-head' },
        h('h3', null, 'Setup'),
        h(
          'p',
          { class: 'panel-note' },
          'The form and its answers stay as they are: this only says how to read them.'
        )
      ),
      body,
      h(
        'div',
        { class: 'rv-row-end mt-setup-actions' },
        data.settings.question
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  view.draft = null;
                  view.setup = false;
                  render();
                },
              },
              'Close'
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            onclick: function () {
              var out = { formId: d.formId || null, question: d.question || null };
              if (sameQuestion) {
                out.projects = {};
                Object.keys(d.projects).forEach(function (id) {
                  var e = d.projects[id];
                  out.projects[id] = {
                    mentors: e.mentors,
                    places: e.places === '' ? null : Number(e.places),
                  };
                });
              }
              saveSetup(out);
            },
          },
          'Save setup'
        )
      )
    );
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  function actionCell(project, c) {
    if (c.here) return h('span', { class: 'rv-pill is-on' }, 'Paired');
    if (c.matchedTo) return h('span', { class: 'panel-note' }, 'With ' + c.matchedTo);
    if (!c.onBoard) return h('span', { class: 'panel-note' }, 'Not on the board');
    if (!project.ready)
      return h(
        'span',
        { class: 'panel-note', title: 'Every mentor of the project selected on the board' },
        project.mentors.length ? 'Mentor not selected' : '–'
      );
    if (c.status !== 'selected')
      return h(
        'span',
        { class: 'panel-note', title: 'Select them on the mentorship board first' },
        'Select first'
      );
    return h(
      'span',
      { class: 'mt-act' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm ' + (c.suggested ? 'btn-primary' : 'btn-outline'),
          onclick: function () {
            pairAndReload({ project: project.id }, c.key, 'projects', c.name);
          },
        },
        'Pair'
      )
    );
  }

  // Where a project's number of places comes from, in words.
  function placesSource(p) {
    var top = p.mentors.filter(function (m) {
      return m.capacity === p.boardPlaces;
    })[0];
    if (!top) return 'board';
    return top.capacityFrom === 'site'
      ? 'site entry of ' + top.name
      : 'answer of ' + top.name + ': “' + top.capacityText + '”';
  }

  function projectCard(p) {
    var full = p.places !== null && p.taken >= p.places;
    var head = h(
      'div',
      { class: 'mt-card-head' },
      h(
        'div',
        null,
        h('h3', null, p.label),
        h(
          'p',
          { class: 'panel-note' },
          p.mentors.length
            ? p.mentors
                .map(function (m) {
                  return m.name + (m.ready ? '' : ' (' + m.status + ')');
                })
                .join(', ')
            : 'No mentor set: open the setup'
        )
      ),
      h(
        'span',
        {
          class: 'rv-pill' + (full ? '' : ' is-on') + (p.places === null ? ' mt-unknown' : ''),
          title:
            p.places === null
              ? 'How many mentees it takes is not known: set it in the setup'
              : p.placesFrom === 'setup'
              ? 'Set in the setup'
              : 'From the ' + placesSource(p),
        },
        p.places === null
          ? p.taken + ' paired · places unknown'
          : p.taken + ' / ' + p.places + ' places'
      )
    );
    if (!p.candidates.length) {
      return h(
        'section',
        { class: 'panel mt-card' },
        head,
        h('p', { class: 'panel-note' }, 'Nobody ranked it.')
      );
    }
    return h(
      'section',
      { class: 'panel mt-card' + (p.mapped ? '' : ' is-unmapped') },
      head,
      h(
        'div',
        { class: 'fr-table-wrap rv-table-wrap' },
        h(
          'table',
          { class: 'rv-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '#'),
              h('th', null, 'Mentee'),
              h('th', null, 'Their choice'),
              h('th', { class: 'rv-num' }, 'Score'),
              h('th', { class: 'rv-num' }, 'Adjusted'),
              h('th', null, 'Status (board)'),
              h('th', null, '')
            )
          ),
          h(
            'tbody',
            null,
            p.candidates.map(function (c, i) {
              return h(
                'tr',
                {
                  class: c.suggested
                    ? 'mt-suggested'
                    : c.matchedTo && !c.here
                    ? 'mt-elsewhere'
                    : '',
                },
                h('td', { class: 'rv-rank' }, String(i + 1)),
                h(
                  'td',
                  { class: 'rv-who' },
                  h(
                    'strong',
                    null,
                    c.name,
                    c.suggested
                      ? h('span', { class: 'mt-star', title: 'In the suggestion' }, ' ★')
                      : null
                  ),
                  c.org ? h('small', null, c.org) : null
                ),
                h(
                  'td',
                  null,
                  h(
                    'span',
                    { class: 'rv-pill' + (c.position === 1 ? ' is-on' : '') },
                    ordinal(c.position)
                  ),
                  h('small', { class: 'panel-note' }, ' of ' + c.of)
                ),
                h(
                  'td',
                  { class: 'rv-num' },
                  num(c.overall),
                  c.partial
                    ? h('small', { title: 'Some sections have no score yet' }, ' partial')
                    : null
                ),
                h('td', { class: 'rv-num' }, h('strong', null, num(c.adjusted))),
                h('td', null, status(c)),
                h('td', { class: 'mt-act-cell' }, actionCell(p, c))
              );
            })
          )
        )
      )
    );
  }

  // How many to select: the places of each project against who chose it.
  function placesPanel(pl) {
    var t = pl.projects;
    var head =
      t.places +
      ' places on ' +
      t.projects.length +
      ' projects' +
      (t.unknown ? ' (' + t.unknown + ' without a number)' : '') +
      ' · ' +
      t.selected +
      ' mentees selected on this track · ' +
      t.paired +
      ' paired';
    var verdict =
      t.unknown || !t.projects.length
        ? null
        : t.selected < t.places
        ? h('span', { class: 'mt-places-verdict' }, t.places - t.selected + ' places still to fill')
        : t.selected > t.places
        ? h(
            'span',
            { class: 'mt-places-verdict is-over' },
            t.selected - t.places + ' selected more than the places'
          )
        : h('span', { class: 'mt-places-verdict is-even' }, 'As many selected as places');
    return h(
      'details',
      { class: 'panel mt-placesbox' },
      h('summary', null, h('strong', null, 'Places'), ' · ', head, ' ', verdict),
      h(
        'p',
        { class: 'panel-note' },
        'Places come from the setup, else the mentor’s site entry, else their answer to “how many mentees”. A project with co-mentors counts once.'
      ),
      h(
        'div',
        { class: 'fr-table-wrap rv-table-wrap' },
        h(
          'table',
          { class: 'rv-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Project'),
              h('th', { class: 'rv-num' }, 'Places'),
              h('th', { class: 'rv-num', title: 'Put it first, not rejected' }, '1st choice'),
              h('th', { class: 'rv-num', title: 'Ranked it at all, not rejected' }, 'Ranked'),
              h(
                'th',
                { class: 'rv-num', title: 'Selected (or paired), put it first' },
                'Selected, 1st'
              ),
              h('th', { class: 'rv-num' }, 'Paired')
            )
          ),
          h(
            'tbody',
            null,
            t.projects.map(function (r) {
              var short = r.places !== null && r.first < r.places;
              return h(
                'tr',
                null,
                h('td', null, r.label),
                h(
                  'td',
                  { class: 'rv-num' + (r.places === null ? ' is-empty' : '') },
                  r.places === null ? '?' : String(r.places)
                ),
                h(
                  'td',
                  { class: 'rv-num' },
                  String(r.first),
                  short
                    ? h(
                        'span',
                        { class: 'rv-flag', title: 'Fewer first choices than places' },
                        ' few'
                      )
                    : null
                ),
                h('td', { class: 'rv-num' }, String(r.ranked)),
                h('td', { class: 'rv-num' }, String(r.selectedFirst)),
                h('td', { class: 'rv-num' }, String(r.paired))
              );
            })
          )
        )
      ),
      t.unmapped
        ? h(
            'p',
            { class: 'panel-note' },
            t.unmapped + ' projects have no mentor in the setup and are not counted.'
          )
        : null
    );
  }

  function projectsTab() {
    var data = view.data;
    if (!data.settings.question) {
      return h(
        'div',
        { class: 'empty-state' },
        h('h3', null, 'Choose the ranking question'),
        h('p', null, 'In the setup: the mentee form and its question on the projects.')
      );
    }
    var mapped = data.projects.filter(function (p) {
      return p.mapped;
    }).length;
    var ready = data.suggestion.filter(function (s) {
      return s.ready && s.status === 'selected';
    });
    var out = [placesPanel(data.places)];
    var notes = [];
    if (mapped < data.projects.length)
      notes.push(
        data.projects.length -
          mapped +
          ' projects have no mentor yet: they are left out of the suggestion.'
      );
    if (data.noKey)
      notes.push(data.noKey + ' answers have no email: they cannot be linked to anyone.');
    out.push(
      h(
        'div',
        { class: 'panel mt-summary' },
        h(
          'div',
          { class: 'mt-summary-row' },
          h(
            'p',
            null,
            h(
              'strong',
              null,
              data.suggestion.length +
                (data.suggestion.length === 1 ? ' suggested pair' : ' suggested pairs')
            ),
            ' (★ below) for ',
            view.pool === 'all' ? 'everyone not rejected' : 'the selected mentees',
            '. Each mentee gets the best project they ranked that keeps them; each project keeps the best adjusted scores within its free places.'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary btn-sm',
              disabled: !ready.length,
              title: ready.length
                ? null
                : 'Only selected mentees, on a project whose mentors are all selected, can be paired',
              onclick: confirmAll,
            },
            'Pair all ' + ready.length + ' suggested'
          )
        ),
        notes.map(function (n) {
          return h('p', { class: 'panel-note' }, n);
        })
      )
    );
    data.projects.forEach(function (p) {
      out.push(projectCard(p));
    });
    return out;
  }

  // ── Career orientation ─────────────────────────────────────────────────────

  // The answers of an application worth reading to pair by fit.
  var PROFILE_LABELS = {
    role: 'Role',
    affiliation: 'Affiliation',
    background: 'Background',
    areas: 'Areas',
    motivation: 'Motivation',
    goals: 'Goals',
    hours: 'Hours a week',
    language: 'Language',
    mode: 'Meetings',
  };

  function profileList(profile) {
    var keys = Object.keys(PROFILE_LABELS).filter(function (k) {
      return profile[k];
    });
    if (!keys.length) return h('p', { class: 'panel-note' }, 'No application on the board.');
    return h(
      'dl',
      { class: 'mt-profile' },
      keys.map(function (k) {
        return [h('dt', null, PROFILE_LABELS[k]), h('dd', null, profile[k])];
      })
    );
  }

  // `changes`: any of { mentorKey, note, affinity }; the rest stays. The page
  // reloads, so the check and the counts follow.
  function saveDraft(p, changes, message) {
    var body = { menteeKey: p.key };
    Object.keys(changes).forEach(function (k) {
      body[k] = changes[k];
    });
    return M.api('PUT', API + '?action=matching-draft', body)
      .then(function () {
        M.toast(message || 'Saved');
        return load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function confirmProposals() {
    var o = view.data.orientation;
    var list = o.mentees.filter(function (p) {
      return !p.matchedTo && p.status === 'selected' && p.draft && p.draft.mentorKey;
    });
    if (!list.length || view.busy) return;
    if (!window.confirm('Pair the ' + list.length + ' proposals? They go on the mentorship board.'))
      return;
    view.busy = true;
    var done = 0;
    var errors = [];
    list
      .reduce(function (chain, p) {
        return chain.then(function () {
          return pair({ mentorKey: p.draft.mentorKey }, p.key, 'orientation').then(
            function () {
              done += 1;
            },
            function (err) {
              errors.push(p.name + ': ' + err.message);
            }
          );
        });
      }, Promise.resolve())
      .then(function () {
        M.toast(
          done + ' paired' + (errors.length ? '; not paired: ' + errors.join('; ') : ''),
          Boolean(errors.length)
        );
        return load();
      })
      .catch(fail)
      .then(function () {
        view.busy = false;
      });
  }

  function mentorsPanel(o) {
    return h(
      'details',
      { class: 'panel mt-mentors' },
      h(
        'summary',
        null,
        h('strong', null, 'Mentors on this track (' + o.mentors.length + ')'),
        h('span', { class: 'panel-note' }, ' · their profiles, places and proposals')
      ),
      h(
        'div',
        { class: 'mt-mentor-grid' },
        o.mentors.map(function (m) {
          var left = m.capacity ? m.capacity - m.taken : null;
          return h(
            'section',
            { class: 'mt-mentor' },
            h('h4', null, m.name),
            h(
              'p',
              { class: 'panel-note' },
              (left === null ? m.taken + ' paired' : left + ' of ' + m.capacity + ' places left') +
                (m.proposed ? ' · ' + m.proposed + ' proposed' : '')
            ),
            profileList(m.profile)
          );
        })
      )
    );
  }

  var AFFINITY = [
    { value: 2, key: 'strong', label: 'Strong fit' },
    { value: 1, key: 'ok', label: 'Fits' },
    { value: -1, key: 'no', label: 'No' },
  ];

  function affinityOf(p, mentorKey) {
    var marks = (p.draft && p.draft.affinity) || {};
    return marks[mentorKey];
  }

  function affinityPill(value) {
    var a = AFFINITY.filter(function (x) {
      return x.value === value;
    })[0];
    return a ? h('span', { class: 'mt-fit is-' + a.key }, a.label) : null;
  }

  // Each mentor, and how well this mentee fits them: a click marks it, a
  // second click on the same mark clears it.
  function affinityGrid(p, o) {
    return h(
      'div',
      { class: 'mt-fits' },
      o.mentors.map(function (m) {
        var mark = affinityOf(p, m.key);
        var left = m.capacity ? m.capacity - m.taken - m.proposed : null;
        return h(
          'div',
          { class: 'mt-fit-row' },
          h(
            'span',
            { class: 'mt-fit-name' },
            m.name,
            h(
              'small',
              { class: 'panel-note' },
              left === null ? '' : ' · ' + Math.max(0, left) + ' free'
            )
          ),
          h(
            'span',
            { class: 'mt-fit-buttons', role: 'group', 'aria-label': 'Fit with ' + m.name },
            AFFINITY.map(function (a) {
              return h(
                'button',
                {
                  type: 'button',
                  class: 'mt-fit is-' + a.key + (mark === a.value ? ' is-on' : ''),
                  'aria-pressed': mark === a.value ? 'true' : 'false',
                  onclick: function () {
                    var marks = {};
                    var current = (p.draft && p.draft.affinity) || {};
                    Object.keys(current).forEach(function (k) {
                      marks[k] = current[k];
                    });
                    if (mark === a.value) delete marks[m.key];
                    else marks[m.key] = a.value;
                    saveDraft(p, { affinity: marks }, 'Fit saved');
                  },
                },
                a.label
              );
            })
          )
        );
      })
    );
  }

  function checkPanel(o) {
    var c = o.check;
    var pl = view.data.places.orientation;
    var items = [
      h(
        'li',
        { class: 'is-info' },
        pl.places +
          ' places with ' +
          pl.mentors +
          ' mentors' +
          (pl.unknown ? ' (' + pl.unknown + ' without a number)' : '') +
          ' · ' +
          pl.selected +
          ' mentees selected · ' +
          pl.paired +
          ' paired'
      ),
    ];
    if (c.unassigned.length)
      items.push(
        h(
          'li',
          { class: 'is-warn' },
          c.unassigned.length + ' selected without a mentor: ' + c.unassigned.join(', ')
        )
      );
    if (c.misfit.length)
      items.push(
        h('li', { class: 'is-warn' }, 'Proposed to a mentor marked “No”: ' + c.misfit.join(', '))
      );
    if (c.overfull.length)
      items.push(h('li', { class: 'is-warn' }, 'Over their places: ' + c.overfull.join(', ')));
    if (c.placesLeft !== null && c.placesLeft < c.unassigned.length)
      items.push(
        h(
          'li',
          { class: 'is-warn' },
          'Only ' + c.placesLeft + ' places left for ' + c.unassigned.length + ' mentees'
        )
      );
    if (items.length === 1)
      items.push(
        h(
          'li',
          { class: 'is-ok' },
          c.selected
            ? 'Every selected mentee has a mentor or a proposal, within the places.'
            : 'Nobody selected to pair yet.'
        )
      );
    var gaps = o.suggestion.length;
    return h(
      'div',
      { class: 'mt-check' },
      h('ul', null, items),
      c.unassigned.length
        ? h(
            'div',
            { class: 'mt-check-fill' },
            gaps
              ? h(
                  'button',
                  { type: 'button', class: 'btn btn-outline btn-sm', onclick: fillGaps },
                  'Propose a mentor for ' + gaps + ' from the fit'
                )
              : null,
            h(
              'span',
              { class: 'panel-note' },
              gaps
                ? ' Strong fit first, then the score, within the places left. Proposals only: change them freely.'
                : 'To get proposals: open a mentee and mark how they fit each mentor with free places.'
            )
          )
        : null
    );
  }

  function fillGaps() {
    if (view.busy) return;
    view.busy = true;
    M.api('POST', API + '?action=matching-fill', {})
      .then(function (r) {
        M.toast(r.filled + ' proposed');
        return load();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      })
      .then(function () {
        view.busy = false;
      });
  }

  function proposalCell(p, o) {
    if (p.matchedTo) return h('span', { class: 'rv-pill is-on' }, p.matchedTo);
    var current = (p.draft && p.draft.mentorKey) || '';
    var pick = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Proposed mentor for ' + p.name,
        onclick: function (e) {
          e.stopPropagation();
        },
        onchange: function () {
          saveDraft(p, { mentorKey: pick.value || null }, 'Proposal saved');
        },
      },
      h('option', { value: '' }, 'No proposal'),
      o.mentors.map(function (m) {
        var free = m.capacity ? Math.max(0, m.capacity - m.taken - m.proposed) : null;
        var o2 = h(
          'option',
          { value: m.key },
          m.name +
            ' (' +
            (free === null ? m.taken + ' paired' : free + ' free') +
            (m.proposed ? ', ' + m.proposed + ' proposed' : '') +
            ')'
        );
        o2.selected = m.key === current;
        return o2;
      })
    );
    return pick;
  }

  function orientationTab() {
    var o = view.data.orientation;
    if (!o.mentees.length) {
      return h(
        'div',
        { class: 'empty-state' },
        h('h3', null, 'Nobody here yet'),
        h(
          'p',
          null,
          'Mentees on the career orientation track with a score, or selected, show here.'
        )
      );
    }
    var ready = o.mentees.filter(function (p) {
      return !p.matchedTo && p.status === 'selected' && p.draft && p.draft.mentorKey;
    });
    var proposals = o.mentees.filter(function (p) {
      return !p.matchedTo && p.draft && p.draft.mentorKey;
    }).length;
    var body = h('tbody');
    o.mentees.forEach(function (p, i) {
      var open = view.openOrientation.has(p.key);
      var toggle = function () {
        if (open) view.openOrientation.delete(p.key);
        else view.openOrientation.add(p.key);
        render();
      };
      body.appendChild(
        h(
          'tr',
          {
            class: 'rv-row' + (open ? ' is-open' : ''),
            tabindex: '0',
            'aria-expanded': open ? 'true' : 'false',
            onclick: toggle,
            onkeydown: function (e) {
              if (e.target !== this) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
              }
            },
          },
          h('td', { class: 'rv-rank' }, p.overall === null ? '' : String(i + 1)),
          h(
            'td',
            { class: 'rv-who' },
            h('strong', null, p.name),
            p.org ? h('small', null, p.org) : null,
            p.draft && p.draft.note
              ? h('small', { class: 'mt-note-line' }, '“' + p.draft.note + '”')
              : null
          ),
          h('td', { class: 'rv-num' }, num(p.overall)),
          h('td', null, status(p)),
          h(
            'td',
            { class: 'mt-act-cell' },
            h(
              'span',
              { class: 'mt-proposal' },
              proposalCell(p, o),
              !p.matchedTo && p.draft && p.draft.mentorKey
                ? affinityPill(affinityOf(p, p.draft.mentorKey))
                : null
            )
          ),
          h(
            'td',
            { class: 'mt-act-cell' },
            !p.matchedTo && p.draft && p.draft.mentorKey
              ? p.status === 'selected'
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-outline btn-sm',
                      onclick: function (e) {
                        e.stopPropagation();
                        pairAndReload(
                          { mentorKey: p.draft.mentorKey },
                          p.key,
                          'orientation',
                          p.name
                        );
                      },
                    },
                    'Pair'
                  )
                : h('span', { class: 'panel-note' }, 'Select first')
              : null
          )
        )
      );
      if (open) {
        var note = h('textarea', {
          class: 'form-input mt-note',
          rows: '2',
          maxlength: String(view.data.limits.note),
          placeholder: 'Why this mentor: seen by the other admins',
        });
        note.value = (p.draft && p.draft.note) || '';
        body.appendChild(
          h(
            'tr',
            { class: 'rv-detail-row' },
            h(
              'td',
              { colspan: '6' },
              h(
                'div',
                { class: 'mt-detail' },
                h('section', null, h('h3', null, 'Their application'), profileList(p.profile)),
                p.matchedTo
                  ? null
                  : h(
                      'section',
                      null,
                      h('h3', null, 'How they fit each mentor'),
                      affinityGrid(p, o)
                    ),
                p.matchedTo
                  ? null
                  : h(
                      'section',
                      null,
                      h('h3', null, 'Note on the proposal'),
                      note,
                      h(
                        'div',
                        { class: 'rv-row-end mt-setup-actions' },
                        p.draft && p.draft.by
                          ? h('span', { class: 'panel-note' }, 'Last change: ' + p.draft.by)
                          : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            class: 'btn btn-outline btn-sm',
                            onclick: function () {
                              saveDraft(p, { note: note.value }, 'Note saved');
                            },
                          },
                          'Save note'
                        )
                      )
                    )
              )
            )
          )
        );
      }
    });

    return [
      h(
        'div',
        { class: 'panel mt-summary' },
        h(
          'div',
          { class: 'mt-summary-row' },
          h(
            'p',
            null,
            h('strong', null, proposals + (proposals === 1 ? ' proposal' : ' proposals')),
            ' out of ' +
              o.mentees.filter(function (p) {
                return !p.matchedTo;
              }).length +
              ' to pair. The score only says who is in: open a mentee to read their answers and mark how they fit each mentor, then propose one. Proposals are a draft every admin sees; nothing goes on the board until it is paired.'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary btn-sm',
              disabled: !ready.length,
              title: ready.length ? null : 'Only selected mentees with a proposal can be paired',
              onclick: confirmProposals,
            },
            ready.length === 1 ? 'Pair the proposal' : 'Pair all ' + ready.length + ' proposals'
          )
        ),
        checkPanel(o)
      ),
      o.mentors.length
        ? mentorsPanel(o)
        : h('p', { class: 'panel-note' }, 'No mentor is selected on this track yet.'),
      h(
        'div',
        { class: 'fr-table-wrap rv-table-wrap' },
        h(
          'table',
          { class: 'rv-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '#'),
              h('th', null, 'Mentee'),
              h('th', { class: 'rv-num' }, 'Score'),
              h('th', null, 'Status (board)'),
              h('th', null, 'Proposed mentor'),
              h('th', null, '')
            )
          ),
          body
        )
      ),
    ];
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    var data = view.data;
    M.clear(root);

    var tabs = h(
      'div',
      { class: 'mt-tabs', role: 'tablist' },
      [
        ['projects', 'Projects'],
        ['orientation', 'Career orientation'],
      ].map(function (t) {
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': view.tab === t[0] ? 'true' : 'false',
            class: 'rv-pill mt-tab' + (view.tab === t[0] ? ' is-on' : ''),
            onclick: function () {
              view.tab = t[0];
              remember('mt-tab', t[0]);
              render();
            },
          },
          t[1]
        );
      })
    );
    var pool = h(
      'select',
      {
        class: 'form-input is-compact mt-pool',
        'aria-label': 'Suggest for',
        onchange: function () {
          view.pool = pool.value;
          remember('mt-pool', pool.value);
          load().catch(fail);
        },
      },
      [
        ['selected', 'Suggest for: selected mentees'],
        ['all', 'Suggest for: everyone not rejected'],
      ].map(function (x) {
        var o = h('option', { value: x[0] }, x[1]);
        o.selected = view.pool === x[0];
        return o;
      })
    );
    var penalty = h('input', {
      class: 'form-input is-compact mt-penalty',
      type: 'number',
      min: '0',
      max: String(data.limits.penalty),
      step: '0.05',
      value: String(data.settings.penalty),
      'aria-label': 'Penalty for each place down',
      onchange: function () {
        var v = Number(penalty.value);
        if (!isFinite(v) || v < 0 || v > data.limits.penalty) {
          penalty.value = String(data.settings.penalty);
          return M.toast('The penalty goes from 0 to ' + data.limits.penalty, true);
        }
        saveSetup({ penalty: v });
      },
    });

    root.appendChild(
      h(
        'div',
        { class: 'crm-toolbar rv-toolbar' },
        tabs,
        view.tab === 'projects' ? pool : null,
        view.tab === 'projects'
          ? h(
              'label',
              { class: 'mt-penalty-row', title: 'adjusted = score − penalty × (their place − 1)' },
              h('span', null, 'Penalty per place'),
              penalty
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              view.setup = !view.setup;
              view.draft = null;
              render();
            },
          },
          view.setup ? 'Hide setup' : 'Setup'
        )
      )
    );
    if (view.setup) root.appendChild(setupPanel());
    var body = view.tab === 'orientation' ? orientationTab() : projectsTab();
    (Array.isArray(body) ? body : [body]).forEach(function (n) {
      root.appendChild(n);
    });
  }
})();
