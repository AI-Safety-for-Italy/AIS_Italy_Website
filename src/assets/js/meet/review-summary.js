/* /app/review/summary/: every applicant with every score, for the admins of
 * the mentee selection. One column per section of the setup, best overall
 * score first; a row opens on each reviewer's scores and comment, criterion
 * by criterion (grouped by question when a section has one grid per question). The status is the board's own: changing it
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
      // The places of the matching, to know how many to select. Not set up: no line.
      return M.api('GET', API + '?action=matching&pool=selected').then(
        function (m) {
          view.places = m.places;
          render();
        },
        function () {}
      );
    })
    .catch(fail);

  function placesLine() {
    var pl = view.places;
    if (!pl) return null;
    var part = function (label, t, extra) {
      var known = t.unknown ? t.places + '+' : String(t.places);
      return h(
        'span',
        { class: 'rv-places-part' },
        h('strong', null, label + ': '),
        known + ' places' + extra + ', ' + t.selected + ' selected'
      );
    };
    var parts = [];
    if (pl.projects.projects.length)
      parts.push(part('Projects', pl.projects, ' on ' + pl.projects.projects.length + ' projects'));
    if (pl.orientation.mentors)
      parts.push(
        part('Career orientation', pl.orientation, ' with ' + pl.orientation.mentors + ' mentors')
      );
    if (!parts.length) return null;
    return h(
      'p',
      { class: 'rv-places' },
      parts,
      h('a', { href: '/app/review/matching/' }, 'Places by project')
    );
  }

  function num(n) {
    return n === null || n === undefined ? '–' : n.toFixed(2);
  }

  function statusLabel(key) {
    var s = view.data.statuses.filter(function (x) {
      return x.key === key;
    })[0];
    return s ? s.label : key;
  }

  // Blind, someone is the code of the last section (usually the anonymous one).
  function who(p) {
    if (!view.blind) return p.name;
    var s = view.data.sections;
    return p.parts[s[s.length - 1].key].code;
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
    // Not on the mentorship board (answered a form only): no status to move.
    if (p.status === null) {
      return h(
        'span',
        { class: 'rv-status panel-note', title: 'Not on the mentorship board' },
        'Not on the board'
      );
    }
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
    return h(
      'tr',
      { class: 'rv-detail-row' },
      h(
        'td',
        { colspan: String(colspan) },
        h(
          'div',
          { class: 'rv-detail-parts' },
          view.data.sections.map(function (part) {
            var d = p.parts[part.key];
            var criteria = part.grid;
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
                          var full = c.questionLabel ? c.questionLabel + ': ' + c.label : c.label;
                          return h(
                            'th',
                            { title: full },
                            c.questionLabel ? h('small', null, c.questionLabel) : null,
                            c.label
                          );
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

    var weights = data.sections
      .map(function (p) {
        return p.label + ' ×' + p.weight;
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
            ' · overall = mean of the sections (' +
            weights +
            ')'
        )
      )
    );

    var line = placesLine();
    if (line) root.appendChild(line);

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
              : data.source === 'form'
              ? 'Nobody has answered the form chosen in the setup yet.'
              : 'No mentee has applied yet: applications come from the mentee application form.'
          )
        )
      );
      return;
    }

    var cols = 4 + data.sections.length;
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
          data.sections.map(function (s) {
            return partCell(p.parts[s.key]);
          }),
          h(
            'td',
            { class: 'rv-num rv-overall' },
            h('strong', null, num(p.overall)),
            p.partial ? h('small', { title: 'Some sections have no score yet' }, ' partial') : null
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
              data.sections.map(function (s) {
                return h(
                  'th',
                  {
                    class: 'rv-num',
                    title: s.reviewers.length ? 'Scored by ' + s.reviewers.join(', ') : null,
                  },
                  s.label
                );
              }),
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
        'Each section shows the mean of the complete reviews and how many there are; ±n: the reviewers differ by that much. Rejected applicants are no longer shown to the reviewers. Selected and later are set on the mentorship board.'
      )
    );
  }
})();
