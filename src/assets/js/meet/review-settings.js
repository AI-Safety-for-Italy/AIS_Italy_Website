/* /app/review/settings/: the setup of the mentee selection, for its admins,
 * in three steps:
 *   1 The form       the form whose answers are reviewed (or the mentee
 *                    applications on the board), its questions imported, and
 *                    which of them holds the name.
 *   2 The sections   a grid of the questions against the sections: a tick
 *                    shows the question in that section, a question with no
 *                    tick is shown to no one. Sections are added (empty, or
 *                    from the questions left), renamed and removed there.
 *   3 Grids and      each section's order of questions, grid (one for the
 *     reviewers      section, or one per question), weight, anonymity, note
 *                    and reviewers (none ticked: every reviewer); and who
 *                    reviews at all: anyone who signed in with Discord.
 * Nothing is saved until "Save the setup". A renamed section or criterion
 * keeps its scores; a reviewer removed keeps the scores already given. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvSettings');
  var data = null;
  var catalog = []; // the source's questions: [{ id, label, type }]
  var draft = null;
  var savedDraft = ''; // the draft as saved: the setup is unsaved while they differ
  var step = 1;
  var choice = null; // the form picked in step 1, before its questions are imported
  var bar = null; // the bar at the bottom, kept to tell when something changed

  var TYPES = {
    short_text: 'Short text',
    long_text: 'Long text',
    email: 'Email',
    url: 'Link',
    number: 'Number',
    single: 'One choice',
    multi: 'Several choices',
    dropdown: 'Dropdown',
    ranking: 'Ranking',
    scale: 'Scale',
    yes_no: 'Yes / no',
    date: 'Date',
  };
  // The sections' colours (meet.css .rv-c0 to .rv-c7), the same in every step.
  var COLOURS = 8;

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

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function setData(d) {
    data = d;
    catalog = d.catalog;
    choice = d.formId || null;
    draft = {
      formId: d.formId || null,
      nameQuestion: d.nameQuestion || null,
      sections: copy(d.sections),
    };
    // As the editor holds them, so drawing it changes nothing: every list
    // there, and only the reviewers still on the team.
    var team = d.reviewers.map(function (r) {
      return r.userId;
    });
    draft.sections.forEach(function (s) {
      s.criteria = s.criteria || [];
      s.questionGrids = s.questionGrids || {};
      s.note = s.note || '';
      s.reviewers = (s.reviewers || []).filter(function (id) {
        return team.indexOf(id) !== -1;
      });
      if (s.gridMode === 'question') {
        s.questions.forEach(function (q) {
          s.questionGrids[q] = s.questionGrids[q] || [];
        });
      }
    });
    savedDraft = JSON.stringify(draft);
    render();
  }

  function isUnsaved() {
    return Boolean(draft) && JSON.stringify(draft) !== savedDraft;
  }

  M.unsaved(isUnsaved, {
    buttons: function () {
      return [root.querySelector('.rv-setup-save')];
    },
  });

  // Typing changes the draft without drawing the page again: the bar follows.
  root.addEventListener('input', function () {
    if (bar) bar.update();
  });

  root.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', API + '?action=settings')])
    .then(function (r) {
      setData(r[1]);
    })
    .catch(fail);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function question(id) {
    return (
      catalog.filter(function (q) {
        return q.id === id;
      })[0] || null
    );
  }

  function questionLabel(id) {
    var q = question(id);
    return q ? q.label : id + ' (no longer in the form)';
  }

  function used() {
    var out = {};
    draft.sections.forEach(function (s) {
      s.questions.forEach(function (id) {
        out[id] = true;
      });
    });
    return out;
  }

  function colourOf(s) {
    return 'rv-c' + (draft.sections.indexOf(s) % COLOURS);
  }

  function move(list, item, by) {
    var i = list.indexOf(item);
    var j = i + by;
    if (j < 0 || j >= list.length) return;
    list.splice(i, 1);
    list.splice(j, 0, item);
  }

  function smallButton(label, onclick, opts) {
    opts = opts || {};
    return h(
      'button',
      {
        type: 'button',
        class:
          'btn btn-sm ' +
          (opts.ghost ? 'rv-ghost' : 'btn-outline') +
          (opts.icon ? ' rv-icon-btn' : ''),
        'aria-label': opts.aria || null,
        title: opts.aria || null,
        disabled: opts.disabled ? true : null,
        onclick: onclick,
      },
      label
    );
  }

  function newSection(label, questions) {
    return {
      label: label,
      prefix: '',
      note: '',
      anonymous: true,
      weight: 1,
      reviewers: [],
      gridMode: 'section',
      questions: questions || [],
      criteria: copy(data.defaults.criteria.answers),
      questionGrids: {},
    };
  }

  function nextName() {
    return 'Section ' + (draft.sections.length + 1);
  }

  function indexIn(id) {
    for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return i;
    return catalog.length;
  }

  /** Puts a question in a section, where the form has it among the others there. */
  function addTo(s, id) {
    if (s.questions.indexOf(id) !== -1) return;
    var at = s.questions.length;
    for (var i = 0; i < s.questions.length; i++) {
      if (indexIn(s.questions[i]) > indexIn(id)) {
        at = i;
        break;
      }
    }
    s.questions.splice(at, 0, id);
    if (s.gridMode === 'question') s.questionGrids[id] = [];
  }

  function takeFrom(s, id) {
    var i = s.questions.indexOf(id);
    if (i !== -1) s.questions.splice(i, 1);
    delete s.questionGrids[id];
  }

  function removeSection(s) {
    if (
      s.key &&
      !window.confirm(
        'Remove the section “' + s.label + '”? Its scores are kept, but no longer count nor show.'
      )
    )
      return;
    draft.sections.splice(draft.sections.indexOf(s), 1);
    render();
  }

  // A segmented control: [[value, label]], the current one pressed.
  function segmented(options, current, onpick, label) {
    return h(
      'div',
      { class: 'fr-views rv-seg', role: 'radiogroup', 'aria-label': label },
      options.map(function (o) {
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(o[0] === current),
            'aria-selected': String(o[0] === current),
            onclick: function () {
              if (o[0] !== current) onpick(o[0]);
            },
          },
          o[1]
        );
      })
    );
  }

  // ── Criteria ─────────────────────────────────────────────────────────────

  function criterionRow(list, c) {
    var label = h('input', {
      class: 'form-input is-compact',
      value: c.label,
      maxlength: '80',
      'aria-label': 'Criterion',
      placeholder: 'Criterion',
      oninput: function () {
        c.label = label.value;
      },
    });
    var help = h('input', {
      class: 'form-input is-compact',
      value: c.help || '',
      maxlength: '300',
      'aria-label': 'What it means',
      placeholder: 'What it means, for the reviewers',
      oninput: function () {
        c.help = help.value;
      },
    });
    var weight = h('input', {
      class: 'form-input is-compact rv-weight',
      type: 'number',
      min: '0',
      max: '10',
      step: '0.5',
      value: String(c.weight),
      'aria-label': 'Weight',
      title: 'Weight',
      oninput: function () {
        c.weight = Number(weight.value);
      },
    });
    return h(
      'div',
      { class: 'rv-crit-row' },
      label,
      help,
      weight,
      smallButton(
        '×',
        function () {
          list.splice(list.indexOf(c), 1);
          render();
        },
        { icon: true, ghost: true, aria: 'Remove the criterion ' + (c.label || '') }
      )
    );
  }

  /** A list of criteria with its "Add" button; `optional`: may be left empty. */
  function criteriaEditor(list, optional) {
    return h(
      'div',
      { class: 'rv-criteria' },
      list.length
        ? h(
            'div',
            { class: 'rv-crit-row rv-crit-head', 'aria-hidden': 'true' },
            h('span', null, 'Criterion'),
            h('span', null, 'What it means'),
            h('span', null, 'Weight'),
            h('span')
          )
        : h(
            'p',
            { class: 'rv-muted' },
            optional ? 'Shown to the reviewers, not scored.' : 'No criterion yet.'
          ),
      list.map(function (c) {
        return criterionRow(list, c);
      }),
      h(
        'div',
        null,
        smallButton(
          '+ Criterion',
          function () {
            list.push({ label: '', help: '', weight: 1 });
            render();
          },
          { ghost: true, disabled: list.length >= data.limits.criteria }
        )
      )
    );
  }

  // ── Step 1: the form ─────────────────────────────────────────────────────

  function importQuestions(formId) {
    return M.api('GET', API + '?action=questions&form=' + encodeURIComponent(formId || '')).then(
      function (q) {
        if ((q.formId || null) === draft.formId) {
          // The same form again: its new questions come in, the sections stay.
          var before = catalog.length;
          catalog = q.catalog;
          render();
          var added = catalog.length - before;
          M.toast(
            added > 0
              ? plural(added, 'new question', 'new questions') + ': place them in step 2'
              : 'The questions are up to date'
          );
          return;
        }
        if (
          draft.sections.length &&
          !window.confirm(
            'Use this form? Its questions replace the sections set up now (the scores already given stay, under their section).'
          )
        )
          return;
        catalog = q.catalog;
        draft.formId = q.formId;
        draft.nameQuestion = q.nameQuestion;
        draft.sections = q.sections;
        step = 2;
        render();
        M.toast('Questions imported and split into a first set of sections');
      }
    );
  }

  function sourceCard(id, title, meta, badge) {
    var current = (id || null) === draft.formId;
    var picked = (id || null) === choice;
    return h(
      'button',
      {
        type: 'button',
        class: 'rv-source' + (picked ? ' is-picked' : ''),
        'aria-pressed': picked ? 'true' : 'false',
        onclick: function () {
          choice = id || null;
          render();
        },
      },
      h('span', { class: 'rv-source-radio', 'aria-hidden': 'true' }),
      h('span', { class: 'rv-source-text' }, h('strong', null, title), h('small', null, meta)),
      current ? h('span', { class: 'rv-pill is-on' }, 'In use') : null,
      badge ? h('span', { class: 'rv-pill' }, badge) : null
    );
  }

  function stepForm() {
    var changing = choice !== draft.formId;
    var go = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm ' + (changing ? 'btn-primary' : 'btn-outline'),
        onclick: function () {
          go.disabled = true;
          importQuestions(choice)
            .catch(function (err) {
              if (err.status === 401) return M.appError(err);
              M.toast(err.message, true);
            })
            .then(function () {
              go.disabled = false;
            });
        },
      },
      changing ? 'Use this form and import its questions' : 'Check for new questions'
    );
    var nameQ = h(
      'select',
      {
        class: 'form-input is-compact',
        id: 'rvNameQ',
        onchange: function () {
          draft.nameQuestion = nameQ.value || null;
          bar.update();
        },
      },
      h('option', { value: '' }, 'None'),
      catalog
        .filter(function (q) {
          return q.type === 'short_text';
        })
        .map(function (q) {
          var o = h('option', { value: q.id }, q.label);
          o.selected = q.id === draft.nameQuestion;
          return o;
        })
    );
    return h(
      'div',
      { class: 'rv-step-body' },
      stepHead(
        'Which applications are reviewed?',
        'Pick the form whose answers the reviewers score. Its questions are imported and split into a first set of sections, which you adjust in the next step.'
      ),
      data.formMissing
        ? h('p', { class: 'form-error' }, 'The form in use no longer exists: choose another one.')
        : null,
      h(
        'div',
        { class: 'rv-sources' },
        sourceCard(
          null,
          'Mentee applications on the mentorship board',
          'Everyone who applied as a mentee, as the board has them'
        ),
        data.forms.map(function (f) {
          var meta =
            f.responses === null || f.responses === undefined
              ? 'A form'
              : plural(f.responses, 'answer', 'answers');
          return sourceCard(f.id, f.title, meta, f.board ? 'Feeds the board' : null);
        })
      ),
      h('div', { class: 'rv-row-end' }, go),
      h(
        'div',
        { class: 'rv-field' },
        h('label', { class: 'form-label', for: 'rvNameQ' }, 'Which question holds the name?'),
        nameQ,
        h(
          'small',
          { class: 'rv-muted' },
          'Shown in the summary, and taken out of the text of the anonymous sections.'
        )
      )
    );
  }

  // ── Step 2: which question goes where ───────────────────────────────────

  function stepSections() {
    var taken = used();
    var left = catalog.filter(function (q) {
      return !taken[q.id];
    });
    var full = draft.sections.length >= data.limits.sections;
    var heads = draft.sections.map(function (s) {
      var name = h('input', {
        class: 'rv-matrix-name',
        value: s.label,
        maxlength: '40',
        'aria-label': 'Name of the section',
        oninput: function () {
          s.label = name.value;
        },
      });
      return h(
        'th',
        { class: 'rv-matrix-sec ' + colourOf(s), scope: 'col' },
        h(
          'div',
          { class: 'rv-matrix-head' },
          name,
          smallButton(
            '×',
            function () {
              removeSection(s);
            },
            {
              icon: true,
              ghost: true,
              aria: 'Remove the section ' + s.label,
              disabled: draft.sections.length <= 1,
            }
          )
        ),
        h('small', null, plural(s.questions.length, 'question', 'questions'))
      );
    });
    var addCol = h(
      'th',
      { class: 'rv-matrix-add' },
      smallButton(
        '+ Section',
        function () {
          draft.sections.push(newSection(nextName()));
          render();
        },
        { ghost: true, disabled: full }
      )
    );
    var rows = catalog.map(function (q) {
      var shown = taken[q.id];
      return h(
        'tr',
        { class: shown ? '' : 'is-left' },
        h(
          'th',
          { scope: 'row' },
          h('span', null, q.label),
          h(
            'small',
            null,
            TYPES[q.type] || q.type,
            q.id === draft.nameQuestion ? ' · the name' : '',
            shown ? '' : ' · not shown'
          )
        ),
        draft.sections.map(function (s) {
          var on = s.questions.indexOf(q.id) !== -1;
          var box = h('input', {
            type: 'checkbox',
            'aria-label': 'Show “' + q.label + '” in ' + s.label,
            onchange: function () {
              if (box.checked) addTo(s, q.id);
              else takeFrom(s, q.id);
              render();
            },
          });
          box.checked = on;
          return h(
            'td',
            { class: colourOf(s) },
            h('label', { class: 'rv-tile' + (on ? ' is-on' : '') }, box)
          );
        }),
        h('td', { class: 'rv-matrix-add' })
      );
    });
    return h(
      'div',
      { class: 'rv-step-body' },
      stepHead(
        'Which question goes in which section?',
        'Each section is a tab the reviewers score apart, under a code of its own. Click a cell to show the question in that section; a question can go in more than one. A question with no tick is shown to no one, as an email or a phone number should be.'
      ),
      h(
        'div',
        { class: 'rv-matrix-tools' },
        h(
          'span',
          { class: 'rv-muted' },
          h('strong', null, String(catalog.length - left.length)),
          ' of ' + plural(catalog.length, 'question', 'questions') + ' shown'
        ),
        left.length
          ? smallButton(
              '+ New section from the ' + plural(left.length, 'question', 'questions') + ' left',
              function () {
                var s = newSection(nextName());
                left.forEach(function (q) {
                  addTo(s, q.id);
                });
                draft.sections.push(s);
                render();
              },
              { disabled: full }
            )
          : null
      ),
      catalog.length
        ? h(
            'div',
            { class: 'rv-matrix-wrap' },
            h(
              'table',
              { class: 'rv-matrix' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Question'), heads, addCol)),
              h('tbody', null, rows)
            )
          )
        : h('p', { class: 'rv-muted' }, 'No questions yet: pick a form in step 1.')
    );
  }

  // ── Step 3: each section, and the reviewers ─────────────────────────────

  function sectionCard(s, index) {
    var label = h('input', {
      class: 'rv-card-name',
      value: s.label,
      maxlength: '40',
      'aria-label': 'Name of the section',
      placeholder: 'Name of the section',
      oninput: function () {
        s.label = label.value;
      },
    });
    var prefix = h('input', {
      class: 'form-input is-compact rv-prefix',
      value: s.prefix || '',
      maxlength: '4',
      'aria-label': 'Code prefix',
      placeholder: 'Auto',
      oninput: function () {
        prefix.value = prefix.value.toUpperCase().replace(/[^A-Z]/g, '');
        s.prefix = prefix.value;
      },
    });
    var weight = h('input', {
      class: 'form-input is-compact rv-weight',
      type: 'number',
      min: '0',
      max: '10',
      step: '0.5',
      value: String(s.weight),
      'aria-label': 'Weight in the overall score',
      oninput: function () {
        s.weight = Number(weight.value);
      },
    });
    var anon = h('input', {
      type: 'checkbox',
      class: 'rv-switch',
      role: 'switch',
      onchange: function () {
        s.anonymous = anon.checked;
        bar.update();
      },
    });
    anon.checked = Boolean(s.anonymous);
    var note = h('textarea', {
      class: 'form-input',
      rows: '3',
      maxlength: String(data.limits.note),
      'aria-label': 'Note for the reviewers',
      placeholder: 'What the reviewers should look at here (optional)',
      oninput: function () {
        s.note = note.value;
      },
    });
    note.value = s.note || '';

    // The grid: one for the section, or one per question.
    var perQuestion = s.gridMode === 'question';
    var mode = segmented(
      [
        ['section', 'One grid for the section'],
        ['question', 'One grid per question'],
      ],
      perQuestion ? 'question' : 'section',
      function (value) {
        s.gridMode = value;
        if (value === 'question') {
          // Each long answer starts with one criterion; the rest is shown only.
          s.questions.forEach(function (q) {
            if (s.questionGrids[q] && s.questionGrids[q].length) return;
            var info = question(q);
            s.questionGrids[q] =
              info && info.type === 'long_text'
                ? [{ label: 'Quality of the answer', help: '', weight: 1 }]
                : [];
          });
        } else if (!s.criteria.length) {
          s.criteria = copy(data.defaults.criteria.answers);
        }
        render();
      },
      'How the section is scored'
    );

    // The questions, in order, each with its grid when there is one per question.
    var questions = s.questions.length
      ? h(
          'ol',
          { class: 'rv-qs' },
          s.questions.map(function (id, i) {
            var grid = s.questionGrids[id] || [];
            if (perQuestion) s.questionGrids[id] = grid;
            var q = question(id);
            return h(
              'li',
              { class: 'rv-q' + (q ? '' : ' is-missing') },
              h(
                'div',
                { class: 'rv-q-head' },
                h('span', { class: 'rv-q-num' }, String(i + 1)),
                h(
                  'span',
                  { class: 'rv-q-label' },
                  questionLabel(id),
                  q ? h('small', null, TYPES[q.type] || q.type) : null
                ),
                h(
                  'span',
                  { class: 'rv-q-actions' },
                  smallButton(
                    '↑',
                    function () {
                      move(s.questions, id, -1);
                      render();
                    },
                    { icon: true, ghost: true, aria: 'Move up', disabled: i === 0 }
                  ),
                  smallButton(
                    '↓',
                    function () {
                      move(s.questions, id, 1);
                      render();
                    },
                    {
                      icon: true,
                      ghost: true,
                      aria: 'Move down',
                      disabled: i === s.questions.length - 1,
                    }
                  ),
                  smallButton(
                    '×',
                    function () {
                      takeFrom(s, id);
                      render();
                    },
                    { icon: true, ghost: true, aria: 'Take it out of this section' }
                  )
                )
              ),
              perQuestion ? criteriaEditor(grid, true) : null
            );
          })
        )
      : h(
          'p',
          { class: 'form-error', style: 'margin:0' },
          'No question in this section: tick some in step 2.'
        );

    // Who scores it: none ticked, everyone.
    var who = data.reviewers.length
      ? h(
          'div',
          { class: 'chip-group rv-who-chips' },
          data.reviewers.map(function (r) {
            var on = s.reviewers.indexOf(r.userId) !== -1;
            return h(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': on ? 'true' : 'false',
                onclick: function () {
                  if (on) s.reviewers.splice(s.reviewers.indexOf(r.userId), 1);
                  else s.reviewers.push(r.userId);
                  render();
                },
              },
              r.name
            );
          })
        )
      : h('span', { class: 'rv-muted' }, 'Add reviewers below first.');

    return h(
      'section',
      { class: 'rv-card-sec ' + colourOf(s) },
      h(
        'header',
        { class: 'rv-card-sec-head' },
        h('span', { class: 'rv-dot', 'aria-hidden': 'true' }),
        label,
        h(
          'span',
          { class: 'rv-q-actions' },
          smallButton(
            '↑',
            function () {
              move(draft.sections, s, -1);
              render();
            },
            { icon: true, ghost: true, aria: 'Move the section up', disabled: index === 0 }
          ),
          smallButton(
            '↓',
            function () {
              move(draft.sections, s, 1);
              render();
            },
            {
              icon: true,
              ghost: true,
              aria: 'Move the section down',
              disabled: index === draft.sections.length - 1,
            }
          ),
          smallButton(
            'Remove',
            function () {
              removeSection(s);
            },
            { ghost: true, disabled: draft.sections.length <= 1, aria: 'Remove the section' }
          )
        )
      ),
      h(
        'div',
        { class: 'rv-card-sec-body' },
        h(
          'div',
          { class: 'rv-card-main' },
          h('h4', { class: 'rv-sub' }, 'How it is scored (1 = weak, 5 = excellent)'),
          mode,
          h('h4', { class: 'rv-sub' }, 'Questions, in the order shown'),
          questions,
          perQuestion
            ? h(
                'p',
                { class: 'rv-muted' },
                'Each question has its own criteria; a question without any is shown, not scored.'
              )
            : [
                h('h4', { class: 'rv-sub' }, 'Criteria, for the whole section'),
                criteriaEditor(s.criteria, false),
              ]
        ),
        h(
          'aside',
          { class: 'rv-card-side' },
          h(
            'label',
            { class: 'rv-switch-row' },
            anon,
            h(
              'span',
              null,
              h('strong', null, 'Anonymous'),
              h('small', null, 'Names, emails, links, phone numbers and short answers taken out')
            )
          ),
          h(
            'div',
            { class: 'rv-side-pair' },
            h('label', { class: 'rv-side-field' }, h('span', null, 'Weight'), weight),
            h('label', { class: 'rv-side-field' }, h('span', null, 'Code prefix'), prefix)
          ),
          h('div', { class: 'rv-side-field' }, h('span', null, 'Note for the reviewers'), note),
          h(
            'div',
            { class: 'rv-side-field' },
            h(
              'span',
              null,
              'Scored by',
              h('small', null, s.reviewers.length ? ' · only those ticked' : ' · every reviewer')
            ),
            who
          )
        )
      )
    );
  }

  function setReviewer(body) {
    return M.api('POST', API + '?action=reviewers', body)
      .then(function () {
        return M.api('GET', API + '?action=settings');
      })
      .then(function (d) {
        // Keep the setup being edited: only the reviewers changed.
        data.reviewers = d.reviewers;
        data.candidates = d.candidates;
        render();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function reviewersBlock() {
    var pick = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Person to add' },
      h(
        'option',
        { value: '' },
        data.candidates.length ? 'Add someone who signed in…' : 'Nobody else has signed in'
      ),
      data.candidates.map(function (c) {
        return h('option', { value: c.userId }, c.name);
      })
    );
    pick.onchange = function () {
      if (pick.value) setReviewer({ add: pick.value });
    };
    return h(
      'section',
      { class: 'rv-reviewers' },
      h('h3', null, 'The reviewers'),
      h(
        'p',
        { class: 'rv-muted' },
        'They see the applications under a code and their own scores only: never the names, the others’ scores nor the summary. Added and removed at once; removing someone keeps the scores they gave.'
      ),
      data.reviewers.length
        ? h(
            'ul',
            { class: 'rv-people' },
            data.reviewers.map(function (r) {
              var mine = draft.sections
                .filter(function (s) {
                  return !s.reviewers.length || s.reviewers.indexOf(r.userId) !== -1;
                })
                .map(function (s) {
                  return s.label;
                });
              return h(
                'li',
                null,
                M.avatar({ name: r.name, avatarUrl: r.avatarUrl }, 28),
                h(
                  'span',
                  null,
                  h('strong', null, r.name),
                  h('small', null, mine.length ? 'Scores ' + mine.join(', ') : 'No section')
                ),
                smallButton(
                  'Remove',
                  function () {
                    setReviewer({ remove: r.userId });
                  },
                  { ghost: true }
                )
              );
            })
          )
        : h('p', { class: 'rv-muted' }, 'No reviewers yet.'),
      h('div', { class: 'rv-add' }, pick)
    );
  }

  function stepGrids() {
    return h(
      'div',
      { class: 'rv-step-body' },
      stepHead(
        'How is each section scored, and by whom?',
        'A review’s total is the weighted mean of its criteria; the overall score, the weighted mean of the sections. Changing this recomputes the summary; a criterion or section removed no longer counts, its scores are kept.'
      ),
      draft.sections.map(sectionCard),
      reviewersBlock()
    );
  }

  // ── The wizard ───────────────────────────────────────────────────────────

  function stepHead(title, text) {
    return h('div', { class: 'rv-step-head' }, h('h2', null, title), h('p', null, text));
  }

  function formTitle() {
    if (!draft.formId) return 'Board applications';
    var f = data.forms.filter(function (x) {
      return x.id === draft.formId;
    })[0];
    return f ? f.title : 'A form';
  }

  function wizard() {
    var shown = Object.keys(used()).length;
    var steps = [
      [1, 'Form', formTitle()],
      [
        2,
        'Sections',
        plural(draft.sections.length, 'section', 'sections') + ' · ' + shown + ' shown',
      ],
      [3, 'Grids & reviewers', plural(data.reviewers.length, 'reviewer', 'reviewers')],
    ];
    return h(
      'ol',
      { class: 'rv-wizard' },
      steps.map(function (st) {
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'rv-wizard-step' + (st[0] === step ? ' is-current' : ''),
              'aria-current': st[0] === step ? 'step' : null,
              onclick: function () {
                step = st[0];
                render();
              },
            },
            h('span', { class: 'rv-wizard-num' }, String(st[0])),
            h('span', null, h('strong', null, st[1]), h('small', null, st[2]))
          )
        );
      })
    );
  }

  function saveBar() {
    var error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    var state = h('span', { class: 'rv-state-note' });
    var save = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm rv-setup-save',
        onclick: function () {
          error.hidden = true;
          save.disabled = true;
          M.api('PUT', API + '?action=settings', draft)
            .then(function (d) {
              setData(d);
              M.toast('Setup saved');
            })
            .catch(function (err) {
              if (err.status === 401) return M.appError(err);
              error.textContent = err.message;
              error.hidden = false;
              save.disabled = false;
            });
        },
      },
      'Save the setup'
    );
    function go(to) {
      return function () {
        step = to;
        render();
        root.scrollIntoView({ block: 'start' });
      };
    }
    var el = h(
      'div',
      { class: 'rv-savebar' },
      error,
      h(
        'div',
        { class: 'rv-savebar-row' },
        step > 1 ? smallButton('← Back', go(step - 1), { ghost: true }) : h('span'),
        h(
          'span',
          { class: 'rv-savebar-end' },
          state,
          step < 3
            ? smallButton(
                step === 1 ? 'Next: sections →' : 'Next: grids & reviewers →',
                go(step + 1)
              )
            : null,
          save
        )
      )
    );
    bar = {
      el: el,
      update: function () {
        var dirty = isUnsaved();
        state.textContent = dirty ? 'Unsaved changes' : 'All saved';
        state.className = 'rv-state-note' + (dirty ? ' is-dirty' : '');
        save.disabled = !dirty;
      },
    };
    bar.update();
    return el;
  }

  function render() {
    // Keep the page where it was: the whole setup is drawn again on each change.
    var y = window.scrollY;
    M.clear(root);
    var body = step === 1 ? stepForm() : step === 2 ? stepSections() : stepGrids();
    root.appendChild(
      h(
        'div',
        { class: 'rv-setup' },
        wizard(),
        h('div', { class: 'panel rv-step' }, body),
        saveBar()
      )
    );
    window.scrollTo(0, y);
  }
})();
