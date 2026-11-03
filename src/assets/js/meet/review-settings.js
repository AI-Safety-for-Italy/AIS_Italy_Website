/* /app/review/settings/: the grid of the mentee selection and its reviewers,
 * for the admins of the selection.
 *   The grid    the criteria each part (CV, answers) is scored on, 1 to 5,
 *               each with a weight; and the weight of each part in the
 *               overall score. A renamed criterion keeps its scores.
 *   Reviewers   who scores: anyone who signed in with Discord. A reviewer
 *               removed keeps the scores already given. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvSettings');
  var data = null;
  var draft = null;
  var savedDraft = ''; // the draft as saved: the grid is unsaved while they differ

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

  function setData(d) {
    data = d;
    draft = {
      grid: {},
      weights: Object.assign({}, d.weights),
    };
    d.parts.forEach(function (p) {
      draft.grid[p.key] = d.grid[p.key].map(function (c) {
        return Object.assign({}, c);
      });
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
        return [root.querySelector('.rv-grid-save')];
      },
    }
  );

  root.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', API + '?action=settings')])
    .then(function (r) {
      setData(r[1]);
    })
    .catch(fail);

  // ── The grid ─────────────────────────────────────────────────────────────

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
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          'aria-label': 'Remove ' + c.label,
          disabled: list.length <= 1 ? true : null,
          onclick: function () {
            list.splice(list.indexOf(c), 1);
            rerender();
          },
        },
        'Remove'
      )
    );
  }

  function gridPanel() {
    var error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    var body = h('div');
    function rerender() {
      M.clear(body);
      data.parts.forEach(function (part) {
        var list = draft.grid[part.key];
        var w = h('input', {
          class: 'form-input is-compact rv-weight',
          type: 'number',
          min: '0',
          max: '10',
          step: '0.5',
          value: String(draft.weights[part.key]),
          'aria-label': 'Weight of the ' + part.label + ' part',
          oninput: function () {
            draft.weights[part.key] = Number(w.value);
          },
        });
        body.appendChild(
          h(
            'section',
            { class: 'rv-part' },
            h(
              'div',
              { class: 'rv-part-head' },
              h('h3', null, part.label),
              h('label', { class: 'rv-part-weight' }, 'Weight in the overall score ', w)
            ),
            h(
              'div',
              { class: 'rv-crit-row rv-crit-head', 'aria-hidden': 'true' },
              h('span', null, 'Criterion'),
              h('span', null, 'What it means'),
              h('span', null, 'Weight'),
              h('span')
            ),
            list.map(function (c) {
              return criterionRow(list, c, rerender);
            }),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                disabled: list.length >= 12 ? true : null,
                onclick: function () {
                  list.push({ label: '', help: '', weight: 1 });
                  rerender();
                },
              },
              'Add a criterion'
            )
          )
        );
      });
    }
    rerender();
    var save = h(
      'button',
      { type: 'submit', class: 'btn btn-primary btn-sm rv-grid-save' },
      'Save the grid'
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
          M.api('PUT', API + '?action=settings', { grid: draft.grid, weights: draft.weights })
            .then(function (d) {
              setData(d);
              M.toast('Grid saved');
            })
            .catch(function (err) {
              if (err.status === 401) return M.appError(err);
              error.textContent = err.message;
              error.hidden = false;
              save.disabled = false;
            });
        },
      },
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, 'The grid')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Each criterion is scored from 1 (weak) to 5 (excellent). A review’s total is the weighted mean of its criteria; the overall score is the weighted mean of the parts. Changing the grid recomputes the summary; a criterion removed no longer counts, its scores are kept.'
      ),
      body,
      error,
      h('div', null, save)
    );
  }

  // ── Reviewers ────────────────────────────────────────────────────────────

  function setReviewer(body) {
    return M.api('POST', API + '?action=reviewers', body)
      .then(function () {
        return M.api('GET', API + '?action=settings');
      })
      .then(function (d) {
        // Keep the grid being edited: only the reviewers changed.
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
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, 'Reviewers')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Reviewers see the applications under a code and their own scores only: never the names, the others’ scores nor the summary. Anyone who has signed in here with Discord can be added. Removing someone keeps the scores they gave.'
      ),
      data.reviewers.length
        ? h(
            'ul',
            { class: 'rv-people' },
            data.reviewers.map(function (r) {
              return h(
                'li',
                null,
                M.avatar({ name: r.name, avatarUrl: r.avatarUrl }, 28),
                h(
                  'span',
                  null,
                  h('strong', null, r.name),
                  h('small', null, 'added by ' + r.addedBy)
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
    M.clear(root);
    root.appendChild(h('div', { class: 'rv-settings' }, reviewersPanel(), gridPanel()));
  }
})();
