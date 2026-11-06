/* /app/review/settings/: the setup of the mentee selection, for its admins.
 *   The source     the form whose answers are reviewed (or the mentee
 *                  applications on the board), and its questions, imported.
 *   The sections   the tabs the reviewers score apart: each with its
 *                  questions (a question in no section is shown to no one),
 *                  its grid (one for the section, or one per question), its
 *                  weight in the overall score, whether its text is made
 *                  anonymous, and the reviewers it is given to (none ticked:
 *                  every reviewer). A renamed section or criterion keeps its
 *                  scores.
 *   Reviewers      who scores: anyone who signed in with Discord. A reviewer
 *                  removed keeps the scores already given. */
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
    consent: 'Consent',
    date: 'Date',
  };

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

  function setData(d) {
    data = d;
    catalog = d.catalog;
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

  M.unsaved(
    function () {
      return Boolean(draft) && JSON.stringify(draft) !== savedDraft;
    },
    {
      buttons: function () {
        return [root.querySelector('.rv-setup-save')];
      },
    }
  );

  root.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', API + '?action=settings')])
    .then(function (r) {
      setData(r[1]);
    })
    .catch(fail);

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
        class: 'btn btn-outline btn-sm' + (opts.icon ? ' rv-icon-btn' : ''),
        'aria-label': opts.aria || null,
        title: opts.aria || null,
        disabled: opts.disabled ? true : null,
        onclick: onclick,
      },
      label
    );
  }

  // ── Criteria ─────────────────────────────────────────────────────────────

  function criterionRow(list, c, rerender) {
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
      smallButton('Remove', function () {
        list.splice(list.indexOf(c), 1);
        rerender();
      })
    );
  }

  /** A list of criteria with its "Add" button; `optional`: may be left empty. */
  function criteriaEditor(list, rerender, optional) {
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
            { class: 'form-note', style: 'margin:0' },
            optional ? 'Shown to the reviewers, not scored.' : 'No criterion yet.'
          ),
      list.map(function (c) {
        return criterionRow(list, c, rerender);
      }),
      h(
        'div',
        null,
        smallButton(
          'Add a criterion',
          function () {
            list.push({ label: '', help: '', weight: 1 });
            rerender();
          },
          { disabled: list.length >= data.limits.criteria }
        )
      )
    );
  }

  // ── The source ───────────────────────────────────────────────────────────

  function importQuestions(formId) {
    return M.api('GET', API + '?action=questions&form=' + encodeURIComponent(formId || '')).then(
      function (q) {
        var sameForm = (q.formId || null) === draft.formId;
        if (sameForm) {
          // The same form again: its new questions come in, the sections stay.
          var before = catalog.length;
          catalog = q.catalog;
          render();
          var added = catalog.length - before;
          M.toast(
            added > 0
              ? added + (added === 1 ? ' new question' : ' new questions') + ', not shown yet'
              : 'The questions are up to date'
          );
          return;
        }
        if (
          draft.sections.length &&
          !window.confirm(
            'Use this form? Its questions replace the sections set up now (the scores already given stay, under their section).'
          )
        ) {
          render();
          return;
        }
        catalog = q.catalog;
        draft.formId = q.formId;
        draft.nameQuestion = q.nameQuestion;
        draft.sections = q.sections;
        render();
        M.toast('Questions imported: check the sections, then save');
      }
    );
  }

  function sourcePanel() {
    var pick = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Form', id: 'rvForm' },
      h('option', { value: '' }, 'Mentee applications on the mentorship board'),
      data.forms.map(function (f) {
        var bits = [f.title];
        if (f.responses !== null && f.responses !== undefined) {
          bits.push(f.responses + (f.responses === 1 ? ' answer' : ' answers'));
        }
        if (f.board) bits.push('feeds the board');
        var o = h('option', { value: f.id }, bits.join(' · '));
        o.selected = f.id === draft.formId;
        return o;
      })
    );
    var importBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          importBtn.disabled = true;
          importQuestions(pick.value || null)
            .catch(function (err) {
              if (err.status === 401) return M.appError(err);
              M.toast(err.message, true);
            })
            .then(function () {
              importBtn.disabled = false;
            });
        },
      },
      'Import the questions'
    );
    var nameQ = h(
      'select',
      {
        class: 'form-input is-compact',
        id: 'rvNameQ',
        onchange: function () {
          draft.nameQuestion = nameQ.value || null;
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
    var taken = used();
    var hiddenQs = catalog.filter(function (q) {
      return !taken[q.id];
    });
    return h(
      'section',
      { class: 'panel form-grid' },
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, '1. The applications')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Choose the form whose answers the reviewers score, then import its questions: they are split into a first set of sections to adjust below. Importing the same form again only adds its new questions.'
      ),
      data.formMissing
        ? h('p', { class: 'form-error' }, 'The form in use no longer exists: choose another one.')
        : null,
      h('div', { class: 'rv-add' }, pick, importBtn),
      draft.formId !== (pick.value || null)
        ? h(
            'p',
            { class: 'form-note', style: 'margin:0' },
            'Import the questions to switch to this form.'
          )
        : null,
      h(
        'div',
        { class: 'rv-field-row' },
        h('label', { class: 'form-label', for: 'rvNameQ' }, 'The question with the name'),
        nameQ,
        h(
          'small',
          { class: 'form-note' },
          'For the summary, and taken out of the anonymous sections’ text.'
        )
      ),
      h(
        'details',
        { class: 'rv-hidden-qs' },
        h(
          'summary',
          null,
          'Not shown to the reviewers (' + hiddenQs.length + ' of ' + catalog.length + ')'
        ),
        hiddenQs.length
          ? h(
              'ul',
              null,
              hiddenQs.map(function (q) {
                return h('li', null, q.label, h('small', null, ' · ' + (TYPES[q.type] || q.type)));
              })
            )
          : h('p', { class: 'form-note' }, 'Every question is in a section.')
      )
    );
  }

  // ── Sections ─────────────────────────────────────────────────────────────

  function sectionCard(s, index, rerender) {
    var label = h('input', {
      class: 'form-input is-compact rv-sec-label',
      value: s.label,
      maxlength: '40',
      'aria-label': 'Name of the section',
      placeholder: 'Name (the reviewers’ tab)',
      oninput: function () {
        s.label = label.value;
      },
    });
    var prefix = h('input', {
      class: 'form-input is-compact rv-prefix',
      value: s.prefix || '',
      maxlength: '4',
      'aria-label': 'Code prefix',
      title: 'The codes of this section start with it, e.g. CV-K7P2Q',
      placeholder: 'Code',
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
      onchange: function () {
        s.anonymous = anon.checked;
      },
    });
    anon.checked = Boolean(s.anonymous);
    var note = h('textarea', {
      class: 'form-input',
      rows: '2',
      maxlength: String(data.limits.note),
      'aria-label': 'Note for the reviewers',
      placeholder: 'What the reviewers should look at in this section (optional)',
      oninput: function () {
        s.note = note.value;
      },
    });
    note.value = s.note || '';

    // The grid: one for the section, or one per question.
    var perQuestion = s.gridMode === 'question';
    function modeRadio(value, text) {
      var input = h('input', {
        type: 'radio',
        name: 'rv-mode-' + index,
        value: value,
        onchange: function () {
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
          rerender();
        },
      });
      input.checked = (s.gridMode || 'section') === value;
      return h('label', { class: 'check-row' }, input, h('span', null, text));
    }

    // The questions, in order, each with its grid when there is one per question.
    var questions = h(
      'ol',
      { class: 'rv-qs' },
      s.questions.map(function (id) {
        var grid = s.questionGrids[id] || [];
        if (perQuestion) s.questionGrids[id] = grid;
        var q = question(id);
        return h(
          'li',
          { class: 'rv-q' + (q ? '' : ' is-missing') },
          h(
            'div',
            { class: 'rv-q-head' },
            h(
              'span',
              { class: 'rv-q-label' },
              questionLabel(id),
              q ? h('small', null, ' · ' + (TYPES[q.type] || q.type)) : null
            ),
            h(
              'span',
              { class: 'rv-q-actions' },
              smallButton(
                '↑',
                function () {
                  move(s.questions, id, -1);
                  rerender();
                },
                { icon: true, aria: 'Move up', disabled: s.questions.indexOf(id) === 0 }
              ),
              smallButton(
                '↓',
                function () {
                  move(s.questions, id, 1);
                  rerender();
                },
                {
                  icon: true,
                  aria: 'Move down',
                  disabled: s.questions.indexOf(id) === s.questions.length - 1,
                }
              ),
              smallButton(
                'Remove',
                function () {
                  s.questions.splice(s.questions.indexOf(id), 1);
                  delete s.questionGrids[id];
                  rerender();
                },
                { aria: 'Take ' + questionLabel(id) + ' out of this section' }
              )
            )
          ),
          perQuestion ? criteriaEditor(grid, rerender, true) : null
        );
      })
    );
    var addable = catalog.filter(function (q) {
      return s.questions.indexOf(q.id) === -1;
    });
    var taken = used();
    var addPick = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Question to add' },
      h('option', { value: '' }, addable.length ? 'Add a question…' : 'Every question is here'),
      addable.map(function (q) {
        return h(
          'option',
          { value: q.id },
          q.label + (taken[q.id] ? ' (also in another section)' : '')
        );
      })
    );
    addPick.onchange = function () {
      if (!addPick.value) return;
      s.questions.push(addPick.value);
      if (perQuestion) s.questionGrids[addPick.value] = [];
      rerender();
    };

    // Who scores it: none ticked, everyone.
    var who = h(
      'div',
      { class: 'chip-group rv-who-chips' },
      data.reviewers.length
        ? data.reviewers.map(function (r) {
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
                  rerender();
                },
              },
              r.name
            );
          })
        : h('span', { class: 'form-note' }, 'Add reviewers below first.')
    );

    return h(
      'section',
      { class: 'rv-part rv-section' },
      h(
        'div',
        { class: 'rv-part-head' },
        h('span', { class: 'rv-sec-num' }, String(index + 1)),
        label,
        prefix,
        h('label', { class: 'rv-part-weight' }, 'Weight ', weight),
        h(
          'span',
          { class: 'rv-q-actions' },
          smallButton(
            '↑',
            function () {
              move(draft.sections, s, -1);
              rerender();
            },
            { icon: true, aria: 'Move the section up', disabled: index === 0 }
          ),
          smallButton(
            '↓',
            function () {
              move(draft.sections, s, 1);
              rerender();
            },
            {
              icon: true,
              aria: 'Move the section down',
              disabled: index === draft.sections.length - 1,
            }
          ),
          smallButton(
            'Remove',
            function () {
              if (
                s.key &&
                !window.confirm(
                  'Remove the section “' +
                    s.label +
                    '”? Its scores are kept, but no longer count nor show.'
                )
              )
                return;
              draft.sections.splice(draft.sections.indexOf(s), 1);
              rerender();
            },
            { disabled: draft.sections.length <= 1, aria: 'Remove the section' }
          )
        )
      ),
      h(
        'label',
        { class: 'check-row' },
        anon,
        h(
          'span',
          null,
          'Anonymous: take names, emails, links, phone numbers and the person’s short answers out of the text'
        )
      ),
      note,
      h('h4', { class: 'rv-sub' }, 'Questions shown'),
      s.questions.length
        ? questions
        : h('p', { class: 'form-error', style: 'margin:0' }, 'Pick at least one question.'),
      h('div', { class: 'rv-add' }, addPick),
      h('h4', { class: 'rv-sub' }, 'Grid'),
      h(
        'div',
        { class: 'rv-mode' },
        modeRadio('section', 'One grid for the whole section'),
        modeRadio('question', 'One grid per question')
      ),
      perQuestion
        ? h(
            'p',
            { class: 'form-note', style: 'margin:0' },
            'Each question’s criteria are set under it, above. A question without criteria is shown, not scored.'
          )
        : criteriaEditor(s.criteria, rerender, false),
      h('h4', { class: 'rv-sub' }, 'Scored by'),
      h(
        'p',
        { class: 'form-note', style: 'margin:0' },
        s.reviewers.length
          ? 'Only the reviewers ticked see this section.'
          : 'Every reviewer: tick some to give the section to them only.'
      ),
      who
    );
  }

  function setupPanel() {
    var error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    var body = h('div');
    function rerender() {
      // Redraw the whole page: the source panel lists what no section shows.
      render();
    }
    draft.sections.forEach(function (s, i) {
      body.appendChild(sectionCard(s, i, rerender));
    });
    var save = h(
      'button',
      { type: 'submit', class: 'btn btn-primary btn-sm rv-setup-save' },
      'Save the setup'
    );
    return h(
      'form',
      {
        class: 'panel form-grid',
        novalidate: true,
        onsubmit: function (e) {
          e.preventDefault();
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
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, '2. Sections and grids')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Each section is a tab the reviewers score apart, under a code of its own, so nobody can match one section with another. Each criterion is scored from 1 (weak) to 5 (excellent); a review’s total is the weighted mean of its criteria, the overall score the weighted mean of the sections. Changing the setup recomputes the summary; a criterion or section removed no longer counts, its scores are kept.'
      ),
      body,
      h(
        'div',
        null,
        smallButton(
          'Add a section',
          function () {
            draft.sections.push({
              label: 'Section ' + (draft.sections.length + 1),
              prefix: '',
              note: '',
              anonymous: true,
              weight: 1,
              reviewers: [],
              gridMode: 'section',
              questions: [],
              criteria: copy(data.defaults.criteria.answers),
              questionGrids: {},
            });
            rerender();
          },
          { disabled: draft.sections.length >= data.limits.sections }
        )
      ),
      error,
      h('div', { class: 'rv-save-bar' }, save)
    );
  }

  // ── Reviewers ────────────────────────────────────────────────────────────

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

  function reviewersPanel() {
    var pick = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Person to add' },
      h(
        'option',
        { value: '' },
        data.candidates.length ? 'Choose someone…' : 'Nobody else has signed in'
      ),
      data.candidates.map(function (c) {
        return h('option', { value: c.userId }, c.name);
      })
    );
    return h(
      'section',
      { class: 'panel form-grid' },
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, '3. Reviewers')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Reviewers see the applications under a code and their own scores only: never the names, the others’ scores nor the summary. Anyone who has signed in here with Discord can be added; each section says who scores it. Removing someone keeps the scores they gave.'
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
                  h(
                    'small',
                    null,
                    (mine.length ? 'Scores ' + mine.join(', ') : 'No section') +
                      ' · added by ' +
                      r.addedBy
                  )
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-outline btn-sm',
                    onclick: function () {
                      setReviewer({ remove: r.userId });
                    },
                  },
                  'Remove'
                )
              );
            })
          )
        : h('p', { class: 'form-note', style: 'margin:0' }, 'No reviewers yet.'),
      h(
        'form',
        {
          class: 'rv-add',
          onsubmit: function (e) {
            e.preventDefault();
            if (pick.value) setReviewer({ add: pick.value });
          },
        },
        pick,
        h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Add reviewer')
      )
    );
  }

  function render() {
    // Keep the page where it was: the whole setup is drawn again on each change.
    var y = window.scrollY;
    M.clear(root);
    root.appendChild(
      h('div', { class: 'rv-settings' }, sourcePanel(), setupPanel(), reviewersPanel())
    );
    window.scrollTo(0, y);
  }
})();
