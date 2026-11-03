/* /app/review/summary/: every applicant with every score, for the admins of
 * the mentee selection. Best overall score first; a row opens on each
 * reviewer's scores and comment. The status is the board's own: changing it
 * here moves the mentee on the mentorship board too. "Hide names" shows the
 * codes only, for discussing the scores before the names. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvSummary');

  var view = { data: null, blind: false, status: '', open: new Set() };
  try {
    view.blind = localStorage.getItem('rv-blind') === '1';
  } catch (e) {
    /* private window: names shown */
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

  root.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', API + '?action=summary')])
    .then(function (r) {
      view.data = r[1];
      render();
    })
    .catch(fail);

  function num(n) {
    return n === null || n === undefined ? '–' : n.toFixed(2);
  }

  function statusLabel(key) {
    var s = view.data.statuses.filter(function (x) {
      return x.key === key;
    })[0];
    return s ? s.label : key;
  }

  function who(p) {
    return view.blind ? p.parts.answers.code : p.name;
  }

  // Reviewers far apart on someone: worth a word before deciding.
  var SPREAD = 1.5;

  function partCell(part) {
    if (part.mean === null) {
      return h(
        'td',
        { class: 'rv-num is-empty' },
        '–',
        part.conflicts ? h('small', null, ' ' + part.conflicts + ' aside') : null
      );
    }
    return h(
      'td',
      { class: 'rv-num' },
      h('strong', null, num(part.mean)),
      h('small', null, ' · ' + part.count),
      part.spread !== null && part.spread >= SPREAD
        ? h(
            'span',
            { class: 'rv-flag', title: 'Reviewers differ by ' + num(part.spread) },
            ' ±' + part.spread.toFixed(1)
          )
        : null
    );
  }

  function statusSelect(p) {
    // Past the selection (Selected, Matched…): shown, changed on the board.
    if (view.data.editable.indexOf(p.status) === -1) {
      return h(
        'span',
        { class: 'rv-status', title: 'Changed on the mentorship board' },
        h('span', { class: 'crm-dot', style: '--crm-dot:var(--crm-st-' + p.status + ')' }),
        statusLabel(p.status)
      );
    }
    var select = h('select', {
      class: 'form-input is-compact rv-status-select is-' + p.status,
      'aria-label': 'Status of ' + who(p),
      onclick: function (e) {
        e.stopPropagation();
      },
      onchange: function () {
        var to = select.value;
        select.disabled = true;
        M.api('POST', API + '?action=status', { key: p.key, status: to })
          .then(function (r) {
            p.status = r.status;
            M.toast(who(p) + ': ' + statusLabel(r.status) + ' (also on the board)');
            render();
          })
          .catch(function (err) {
            select.value = p.status;
            select.disabled = false;
            if (err.status === 401) return M.appError(err);
            M.toast(err.message, true);
          });
      },
    });
    view.data.statuses.forEach(function (s) {
      if (view.data.editable.indexOf(s.key) === -1) return;
      var o = h('option', { value: s.key }, s.label);
      o.selected = s.key === p.status;
      select.appendChild(o);
    });
    return select;
  }

  function detailRow(p, colspan) {
    var grid = view.data.grid;
    return h(
      'tr',
      { class: 'rv-detail-row' },
      h(
        'td',
        { colspan: String(colspan) },
        h(
          'div',
          { class: 'rv-detail-parts' },
          view.data.parts.map(function (part) {
            var d = p.parts[part.key];
            var criteria = grid[part.key];
            return h(
              'section',
              null,
              h('h3', null, part.label + ' ', h('span', { class: 'rv-code' }, d.code)),
              d.reviews.length
                ? h(
                    'table',
                    { class: 'rv-mini' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, 'Reviewer'),
                        criteria.map(function (c) {
                          return h('th', { title: c.label }, c.label);
                        }),
                        h('th', null, 'Total')
                      )
                    ),
                    h(
                      'tbody',
                      null,
                      d.reviews.map(function (r) {
                        return [
                          h(
                            'tr',
                            { class: r.complete ? '' : 'is-incomplete' },
                            h(
                              'td',
                              null,
                              r.reviewer,
                              r.stillReviewer ? null : h('small', null, ' (no longer a reviewer)')
                            ),
                            r.conflict
                              ? h(
                                  'td',
                                  { colspan: String(criteria.length + 1), class: 'panel-note' },
                                  'Stepped aside: knows the person'
                                )
                              : [
                                  criteria.map(function (c) {
                                    var v = r.scores[c.key];
                                    return h(
                                      'td',
                                      { class: 'rv-num' },
                                      v === undefined ? '–' : String(v)
                                    );
                                  }),
                                  h(
                                    'td',
                                    { class: 'rv-num' },
                                    h('strong', null, num(r.total)),
                                    r.complete ? null : h('small', null, ' not complete')
                                  ),
                                ]
                          ),
                          r.comment
                            ? h(
                                'tr',
                                { class: 'rv-comment-row' },
                                h(
                                  'td',
                                  { colspan: String(criteria.length + 2) },
                                  '“' + r.comment + '”'
                                )
                              )
                            : null,
                        ];
                      }),
                      d.count
                        ? h(
                            'tr',
                            { class: 'rv-mean-row' },
                            h('td', null, 'Mean of ' + d.count),
                            criteria.map(function (c) {
                              return h('td', { class: 'rv-num' }, num(d.byCriterion[c.key]));
                            }),
                            h('td', { class: 'rv-num' }, h('strong', null, num(d.mean)))
                          )
                        : null
                    )
                  )
                : h('p', { class: 'panel-note' }, 'No reviews yet.')
            );
          })
        )
      )
    );
  }

  function render() {
    var data = view.data;
    M.clear(root);

    var statusFilter = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Status',
        onchange: function () {
          view.status = statusFilter.value;
          render();
        },
      },
      h('option', { value: '' }, 'All statuses'),
      data.statuses.map(function (s) {
        var o = h('option', { value: s.key }, s.label);
        o.selected = view.status === s.key;
        return o;
      })
    );
    var blind = h('input', {
      type: 'checkbox',
      onchange: function () {
        view.blind = blind.checked;
        try {
          localStorage.setItem('rv-blind', view.blind ? '1' : '0');
        } catch (e) {
          /* not remembered: fine */
        }
        render();
      },
    });
    blind.checked = view.blind;

    var weights = data.parts
      .map(function (p) {
        return p.label + ' ×' + data.weights[p.key];
      })
      .join(', ');
    root.appendChild(
      h(
        'div',
        { class: 'crm-toolbar rv-toolbar' },
        statusFilter,
        h('label', { class: 'check-row' }, blind, h('span', null, 'Hide names')),
        h(
          'span',
          { class: 'panel-note' },
          data.reviewers.length +
            (data.reviewers.length === 1 ? ' reviewer' : ' reviewers') +
            ' · overall = mean of the parts (' +
            weights +
            ')'
        )
      )
    );

    var shown = data.people.filter(function (p) {
      return !view.status || p.status === view.status;
    });
    if (!shown.length) {
      root.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'Nobody here'),
          h(
            'p',
            null,
            data.people.length
              ? 'No applicant has this status.'
              : 'No mentee has applied yet: applications come from the mentee application form.'
          )
        )
      );
      return;
    }

    var cols = 6;
    var body = h('tbody');
    shown.forEach(function (p, i) {
      var open = view.open.has(p.key);
      body.appendChild(
        h(
          'tr',
          {
            class: 'rv-row' + (open ? ' is-open' : ''),
            tabindex: '0',
            'aria-expanded': open ? 'true' : 'false',
            onclick: function () {
              if (open) view.open.delete(p.key);
              else view.open.add(p.key);
              render();
            },
            onkeydown: function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.click();
              }
            },
          },
          h('td', { class: 'rv-rank' }, p.overall === null ? '' : String(i + 1)),
          h(
            'td',
            { class: 'rv-who' },
            h('strong', null, who(p)),
            !view.blind && p.org ? h('small', null, p.org) : null
          ),
          partCell(p.parts.cv),
          partCell(p.parts.answers),
          h(
            'td',
            { class: 'rv-num rv-overall' },
            h('strong', null, num(p.overall)),
            p.partial ? h('small', { title: 'One part has no score yet' }, ' one part') : null
          ),
          h('td', null, statusSelect(p))
        )
      );
      if (open) body.appendChild(detailRow(p, cols));
    });

    root.appendChild(
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
              h('th', null, view.blind ? 'Code' : 'Applicant'),
              h('th', { class: 'rv-num' }, 'CV'),
              h('th', { class: 'rv-num' }, 'Answers'),
              h('th', { class: 'rv-num' }, 'Overall'),
              h('th', null, 'Status (board)')
            )
          ),
          body
        )
      )
    );
    root.appendChild(
      h(
        'p',
        { class: 'panel-note rv-foot' },
        'Each part shows the mean of the complete reviews and how many there are; ±n: the reviewers differ by that much. Rejected applicants are no longer shown to the reviewers. Selected and later are set on the mentorship board.'
      )
    );
  }
})();
