/* /app/review/summary/: every applicant with every score, for the admins of
 * the mentee selection. With a pre-screening, those it excluded are in a
 * table of their own below the ranking. One column per section of the setup,
 * then the overall (the projects score) and, with a section for the projects
 * only, the advising score apart; ranked by the one chosen, best first; a row opens on each reviewer's scores and comment, criterion
 * by criterion (grouped by question when a section has one grid per question). The status is the board's own: changing it
 * here moves the mentee on the mentorship board too. "Hide names" shows the
 * codes only, for discussing the scores before the names. With a
 * pre-screening, who was excluded there is last, with why and by whom, and
 * can be brought back into the sections. The threshold, set here, leaves the
 * worst share of a section (the CV) out of the sections after it: those below
 * go after the others, marked, and come back when it is moved. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvSummary');

  var view = { data: null, blind: false, status: '', sort: 'overall', open: new Set() };
  // The interviews (server/crm/interviews.js), when there are some: a column
  // of their own, and on request a total with them weighed in. Neither
  // changes the overall, which stays the selection's.
  view.iv = null;
  view.ivTotal = false;
  try {
    view.ivTotal = localStorage.getItem('rv-iv-total') === '1';
    view.blind = localStorage.getItem('rv-blind') === '1';
    view.sort = localStorage.getItem('rv-sort') || 'overall';
  } catch (e) {
    /* private window: names shown, by the overall */
  }

  // The scores a ranking can go by. Advising only when some section is for
  // the projects track only: without one it is the overall.
  var SCORES = [
    ['overall', 'Overall', 'partial'],
    ['advising', 'Advising', 'advisingPartial'],
  ];
  function split() {
    return view.data.sections.some(function (s) {
      return s.projectsOnly;
    });
  }
  function scores() {
    return split() ? SCORES : SCORES.slice(0, 1);
  }
  function hasInterviews() {
    return Boolean(view.iv && Object.keys(view.iv.people).length);
  }
  // Each person's interview mean and the total with it, for the table: the
  // overall weighs 1, the interview the setup's weight; no interview, no total.
  function withInterviews() {
    if (!hasInterviews()) return;
    var w = Number(view.iv.weight) || 0;
    view.data.people.forEach(function (p) {
      var iv = view.iv.people[p.key] || null;
      p.interview = iv ? iv.mean : null;
      p.interviews = iv ? iv.interviews : [];
      p.ivTotal =
        iv && p.overall !== null && p.overall !== undefined
          ? Math.round(((p.overall + w * iv.mean) / (1 + w)) * 100) / 100
          : null;
    });
  }
  function sortKey() {
    if (view.ivTotal && hasInterviews()) return 'ivTotal';
    var key = view.sort;
    return scores().some(function (s) {
      return s[0] === key;
    })
      ? key
      : 'overall';
  }

  // The server's order (pre-screening out, below the threshold, flagged last),
  // then the chosen score, best first; no score after, by name.
  function ranked(list) {
    var key = sortKey();
    var tier = function (p) {
      if (p.prescreen && p.prescreen.decision === 'exclude') return 3;
      if (p.gate === 'below') return 2;
      return p.exclusions.length ? 1 : 0;
    };
    return list.slice().sort(function (x, y) {
      var t = tier(x) - tier(y);
      if (t) return t;
      var a = x[key];
      var b = y[key];
      if (a === null && b === null) return x.name.localeCompare(y.name, 'it');
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    });
  }

  function scoreCell(p, s, chosen) {
    return h(
      'td',
      { class: 'rv-num' + (chosen ? ' rv-overall' : '') },
      h('strong', null, num(p[s[0]])),
      p[s[2]] ? h('small', { title: 'Some sections have no score yet' }, ' partial') : null
    );
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
      // The interviews' scores; none, or not set up: no column.
      M.api('GET', '/api/app/crm/interviews?action=scores').then(
        function (iv) {
          view.iv = iv;
          render();
        },
        function () {}
      );
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

  function screenedOut(p) {
    return Boolean(p.prescreen && p.prescreen.decision === 'exclude');
  }

  // Brings someone excluded at the pre-screening back into the sections.
  function readmit(p, button) {
    if (!window.confirm('Bring ' + who(p) + ' back? They go into the sections, to be scored.'))
      return;
    button.disabled = true;
    M.api('POST', API + '?action=readmit', { key: p.key, decision: 'pass' })
      .then(function () {
        return M.api('GET', API + '?action=summary');
      })
      .then(function (d) {
        view.data = d;
        M.toast('Back in the sections');
        render();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
        button.disabled = false;
      });
  }

  function detailRow(p, colspan) {
    return h(
      'tr',
      { class: 'rv-detail-row' },
      h(
        'td',
        { colspan: String(colspan) },
        p.exclusions.length
          ? h(
              'ul',
              { class: 'rv-excl-list' },
              p.exclusions.map(function (x) {
                return h('li', null, x.reason + ' — ' + x.reviewer + ' (' + x.section + ')');
              })
            )
          : null,
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
                              r.stillReviewer ? null : h('small', null, ' (no longer a reviewer)'),
                              r.flags && r.flags.length
                                ? h(
                                    'span',
                                    { class: 'rv-excl-badge', title: 'Reason to exclude' },
                                    r.flags
                                      .map(function (f) {
                                        return f.label;
                                      })
                                      .join(' · ')
                                  )
                                : null
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
                                    r.complete
                                      ? r.missing
                                        ? h(
                                            'small',
                                            {
                                              title:
                                                'Done before a criterion was added: counts on the criteria it has',
                                            },
                                            ' ' + r.missing + ' new missing'
                                          )
                                        : null
                                      : h('small', null, ' not complete')
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
          }),
          p.interviews && p.interviews.length ? interviewsPart(p) : null
        )
      )
    );
  }

  // The interviews done, each with its grid, in the detail of a row.
  function interviewsPart(p) {
    var criteria = view.iv.criteria;
    return h(
      'section',
      null,
      h('h3', null, 'Interviews'),
      h(
        'table',
        { class: 'rv-mini' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Interviewer'),
            criteria.map(function (c) {
              return h('th', { class: 'rv-num', title: c.label }, c.label);
            }),
            h('th', null, 'Total')
          )
        ),
        h(
          'tbody',
          null,
          p.interviews.map(function (x) {
            return h(
              'tr',
              null,
              h('td', null, x.interviewer, h('small', null, ' · ' + x.projectLabel)),
              criteria.map(function (c) {
                var v = x.scores[c.key];
                return h('td', { class: 'rv-num' }, v === undefined ? '–' : String(v));
              }),
              h('td', { class: 'rv-num' }, h('strong', null, num(x.mean)))
            );
          })
        )
      ),
      h(
        'p',
        { class: 'panel-note' },
        h('a', { href: '/app/review/interviews/#admin/progress' }, 'Read the interviews')
      )
    );
  }

  function render() {
    var data = view.data;
    M.clear(root);
    withInterviews();
    var ivOn = hasInterviews();
    var ivTotal = h('input', {
      type: 'checkbox',
      onchange: function () {
        view.ivTotal = ivTotal.checked;
        try {
          localStorage.setItem('rv-iv-total', view.ivTotal ? '1' : '0');
        } catch (e) {
          /* not remembered: fine */
        }
        render();
      },
    });
    ivTotal.checked = view.ivTotal;

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
    // Ranked by the total with the interview: no other order to pick.
    var sortBy =
      split() && !(ivOn && view.ivTotal)
        ? h(
            'select',
            {
              class: 'form-input is-compact',
              'aria-label': 'Rank by',
              onchange: function () {
                view.sort = sortBy.value;
                try {
                  localStorage.setItem('rv-sort', view.sort);
                } catch (e) {
                  /* not remembered: fine */
                }
                render();
              },
            },
            SCORES.map(function (s) {
              var o = h('option', { value: s[0] }, 'Rank by ' + s[1]);
              o.selected = sortKey() === s[0];
              return o;
            })
          )
        : null;

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
        sortBy,
        h('label', { class: 'check-row' }, blind, h('span', null, 'Hide names')),
        ivOn
          ? h(
              'label',
              {
                class: 'check-row',
                title:
                  'Ranks by the overall and the interview together (interview ×' +
                  view.iv.weight +
                  '); the overall stays as it is',
              },
              ivTotal,
              h('span', null, 'Total with interview')
            )
          : null,
        // The whole summary, names and comments included, whatever is shown.
        ['csv', 'json'].map(function (format) {
          return h(
            'a',
            {
              class: 'btn btn-outline btn-sm',
              href: API + '?action=export&format=' + format,
              download: '',
              title: 'Every applicant and every review, with names and comments',
            },
            'Download ' + format.toUpperCase()
          );
        }),
        h(
          'span',
          { class: 'panel-note' },
          data.reviewers.length +
            (data.reviewers.length === 1 ? ' reviewer' : ' reviewers') +
            ' · overall = mean of the sections (' +
            weights +
            ')' +
            (split() ? ' (the projects score) · advising = without the projects-only sections' : '')
        )
      )
    );

    var line = placesLine();
    if (line) root.appendChild(line);

    var all = data.people.filter(function (p) {
      return !view.status || p.status === view.status;
    });
    var shown = ranked(
      all.filter(function (p) {
        return !screenedOut(p);
      })
    );
    var key = sortKey();
    var rejected = all.filter(screenedOut);
    var screen = screeningLine();
    if (screen) root.appendChild(screen);
    var gate = gateLine();
    if (gate) root.appendChild(gate);
    if (!all.length) {
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

    var cols = 3 + data.sections.length + scores().length + (ivOn ? (view.ivTotal ? 2 : 1) : 0);
    var body = h('tbody');
    shown.forEach(function (p, i) {
      var open = view.open.has(p.key);
      body.appendChild(
        h(
          'tr',
          {
            class:
              'rv-row' + (open ? ' is-open' : '') + (p.exclusions.length ? ' is-excluded' : ''),
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
          h(
            'td',
            { class: 'rv-rank' },
            p[key] === null || p.exclusions.length || p.gate === 'below' ? '' : String(i + 1)
          ),
          h(
            'td',
            { class: 'rv-who' },
            h('strong', null, who(p)),
            !view.blind && p.org ? h('small', null, p.org) : null,
            p.gate === 'below' || p.gate === 'waiting'
              ? h(
                  'span',
                  {
                    class: 'rv-excl-badge rv-gate-badge is-' + p.gate,
                    title:
                      p.gate === 'below'
                        ? 'Not shown in the sections after ' + data.gate.label
                        : 'Shown in the sections after ' +
                          data.gate.label +
                          ' once every reviewer has scored it',
                  },
                  p.gate === 'below' ? 'Below the threshold' : 'Waiting for ' + data.gate.label
                )
              : null,
            p.exclusions.length
              ? h(
                  'span',
                  {
                    class: 'rv-excl-badge',
                    title: p.exclusions
                      .map(function (x) {
                        return x.reason + ' (' + x.reviewer + ')';
                      })
                      .join('\n'),
                  },
                  p.exclusions
                    .map(function (x) {
                      return x.reason;
                    })
                    .filter(function (r, k, all) {
                      return all.indexOf(r) === k;
                    })
                    .join(' · ')
                )
              : null
          ),
          data.sections.map(function (s) {
            return partCell(p.parts[s.key]);
          }),
          scores().map(function (s) {
            return scoreCell(p, s, s[0] === key);
          }),
          ivOn
            ? h(
                'td',
                {
                  class: 'rv-num',
                  title: p.interviews.length
                    ? p.interviews
                        .map(function (x) {
                          return x.interviewer + ' (' + x.projectLabel + '): ' + num(x.mean);
                        })
                        .join('\n')
                    : 'No interview done yet',
                },
                num(p.interview),
                p.interviews.length > 1 ? h('small', null, ' ×' + p.interviews.length) : null
              )
            : null,
          ivOn && view.ivTotal
            ? h('td', { class: 'rv-num rv-overall' }, h('strong', null, num(p.ivTotal)))
            : null,
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
              scores().map(function (s) {
                return h('th', { class: 'rv-num' }, s[1]);
              }),
              ivOn
                ? h(
                    'th',
                    { class: 'rv-num', title: 'The mean of the interviews done' },
                    'Interview'
                  )
                : null,
              ivOn && view.ivTotal
                ? h(
                    'th',
                    {
                      class: 'rv-num',
                      title: 'Overall ×1 and interview ×' + view.iv.weight + ', weighted',
                    },
                    'Total'
                  )
                : null,
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
        'Each section shows the mean of the complete reviews and how many there are; ±n: the reviewers differ by that much. Someone a reviewer flagged with a reason to exclude goes to the bottom, marked, as does someone below the threshold, who is shown in no section after it. Rejected applicants are no longer shown to the reviewers. Selected and later are set on the mentorship board.'
      )
    );
    if (rejected.length) root.appendChild(rejectedTable(rejected));
  }

  // Where the pre-screening is: passed, excluded, left to do.
  function screeningLine() {
    var data = view.data;
    if (!data.prescreen || !data.prescreen.enabled) return null;
    var passed = 0;
    var out = 0;
    var todo = 0;
    data.people.forEach(function (p) {
      if (p.status === 'declined') return;
      if (!p.prescreen) todo++;
      else if (p.prescreen.decision === 'pass') passed++;
      else out++;
    });
    return h(
      'p',
      { class: 'rv-places' },
      h('strong', null, 'Pre-screening: '),
      passed + ' passed, ' + out + ' excluded, ' + todo + ' left to do'
    );
  }

  // What a share would leave out of these means (lowest first), as the
  // server counts it: the worst share rounded down, ties with the last one in passing.
  function cutOf(means, percent) {
    var k = Math.floor((means.length * percent) / 100);
    if (!k) return { cutoff: null, below: 0 };
    var cutoff = means[k];
    return {
      cutoff: cutoff,
      below: means.filter(function (m) {
        return m < cutoff;
      }).length,
    };
  }

  // The threshold: after which section, how much it leaves out, and where it stands.
  function gateLine() {
    var g = view.data.gate;
    var sections = view.data.sections;
    if (!g || sections.length < 2) return null;
    // What is typed and not saved yet stays while rows open and close.
    var draft = view.gateDraft;
    var from = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Threshold after' },
      h('option', { value: '' }, 'Off'),
      sections.slice(0, -1).map(function (s) {
        var o = h('option', { value: s.key }, 'After ' + s.label);
        o.selected = (draft ? draft.from : g.from || '') === s.key;
        return o;
      })
    );
    var percent = h('input', {
      type: 'number',
      class: 'form-input is-compact rv-gate-percent',
      min: '0',
      max: String(g.max),
      step: '1',
      value: draft ? draft.percent : String(g.percent),
      'aria-label': 'Share left out, in percent',
    });
    var note = h('span', { class: 'panel-note' });
    var save = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Save');

    function describe() {
      M.clear(note);
      var p = Number(percent.value);
      var changed = from.value !== (g.from || '') || p !== g.percent;
      view.gateDraft = changed ? { from: from.value, percent: percent.value } : null;
      save.disabled = !changed;
      if (!g.from) {
        note.appendChild(
          document.createTextNode(
            from.value
              ? 'Once saved, someone is ranked when every reviewer given ' +
                  from.options[from.selectedIndex].text.replace(/^After /, '') +
                  ' has scored them; until then they wait.'
              : ''
          )
        );
        return;
      }
      var c = g.counts;
      var waiting = c.waiting ? ', ' + c.waiting + ' waiting for every review' : '';
      if (from.value === g.from && changed && Number.isInteger(p) && p >= 0 && p <= g.max) {
        var preview = cutOf(g.means, p);
        note.appendChild(
          document.createTextNode(
            'Preview: ' +
              (g.means.length - preview.below) +
              ' would pass, ' +
              preview.below +
              ' below' +
              (preview.cutoff === null ? '' : ' (mean under ' + num(preview.cutoff) + ')') +
              waiting
          )
        );
        return;
      }
      note.appendChild(
        document.createTextNode(
          c.pass +
            ' pass, ' +
            c.below +
            ' below' +
            (g.cutoff === null ? '' : ' (mean under ' + num(g.cutoff) + ')') +
            waiting
        )
      );
    }

    from.onchange = describe;
    percent.oninput = describe;
    save.onclick = function () {
      var p = Number(percent.value);
      if (!Number.isInteger(p) || p < 0 || p > g.max) {
        M.toast('From 0% to ' + g.max + '%, in whole numbers', true);
        return;
      }
      save.disabled = true;
      M.api('PUT', API + '?action=gate', {
        from: from.value || null,
        percent: p,
        version: g.version,
      })
        .then(function () {
          return M.api('GET', API + '?action=summary');
        })
        .then(function (d) {
          view.data = d;
          view.gateDraft = null;
          M.toast(d.gate.from ? 'Threshold saved: the reviewers see it now' : 'Threshold off');
          render();
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
          save.disabled = false;
        });
    };
    describe();

    return h(
      'p',
      { class: 'rv-places rv-gate' },
      h('strong', null, 'Threshold: '),
      from,
      h('span', null, 'leave out the worst'),
      percent,
      h('span', null, '%'),
      save,
      note
    );
  }

  // Those the pre-screening excluded, apart: why, by whom, when.
  function rejectedTable(list) {
    var body = h(
      'tbody',
      null,
      list.map(function (p) {
        var back = h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              readmit(p, back);
            },
          },
          'Bring back'
        );
        return h(
          'tr',
          null,
          h(
            'td',
            { class: 'rv-who' },
            h('strong', null, who(p)),
            !view.blind && p.org ? h('small', null, p.org) : null
          ),
          h('td', null, p.prescreen.reasonLabels.join(', ') || '—'),
          h('td', null, p.prescreen.by),
          h('td', { class: 'rv-nowrap' }, M.fmtDateTime(p.prescreen.at)),
          h('td', null, statusSelect(p)),
          h('td', { class: 'rv-num' }, back)
        );
      })
    );
    return h(
      'section',
      { class: 'rv-rejected' },
      h('h2', null, 'Excluded at the pre-screening ', h('small', null, String(list.length))),
      h(
        'p',
        { class: 'panel-note' },
        'Shown in no section, so nobody scored them. Bring someone back to have them scored.'
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
              h('th', null, view.blind ? 'Code' : 'Applicant'),
              h('th', null, 'Why'),
              h('th', null, 'By'),
              h('th', null, 'When'),
              h('th', null, 'Status (board)'),
              h('th', null, '')
            )
          ),
          body
        )
      )
    );
  }
})();
