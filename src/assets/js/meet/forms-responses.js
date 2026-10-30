/* The answers of one form: the Answers tab of the editor (forms-editor.js).
 *
 *   Summary     every question at a glance, as a chart you can switch (bars,
 *               columns, donut) and sort; a click on a bar keeps only the
 *               answers that chose it, everywhere on the page
 *   Individual  one answer at a time, with its status, previous / next
 *               (arrow keys too) and, for the form's managers, delete
 *   Table       all of them in rows, one column per question
 *
 *   Meet.formResponses(root, { formId, onCount(n) })
 *
 * The answers come decrypted from /api/app/forms?id=…&view=responses, and
 * every look is on the audit trail; the counting is done here. Answers are
 * put on the page as text, never as HTML. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var C = M.charts;

  var STATUS_LABEL = {
    new: 'New',
    reviewing: 'Reviewing',
    accepted: 'Accepted',
    rejected: 'Rejected',
  };
  var RANGES = [
    ['all', 'All time'],
    ['7', 'Last 7 days'],
    ['30', 'Last 30 days'],
    ['90', 'Last 90 days'],
  ];
  var VIEWS = [
    ['summary', 'Summary'],
    ['individual', 'Individual'],
    ['table', 'Table'],
  ];
  var CHOICE = ['single', 'multi', 'dropdown'];
  var TEXT = ['short_text', 'long_text', 'email', 'url'];
  // Which charts each kind of question can be shown as; the first is the default.
  var CHART_KINDS = {
    single: ['bars', 'donut', 'columns'],
    dropdown: ['bars', 'donut', 'columns'],
    yes_no: ['donut', 'bars'],
    multi: ['bars', 'columns'],
    scale: ['columns', 'bars'],
    text: ['list', 'common'],
  };
  var CHART_NAMES = {
    bars: 'Bars',
    donut: 'Donut',
    columns: 'Columns',
    list: 'Answers',
    common: 'Most common',
  };
  var ICONS = {
    bars: '<path d="M4 6h10M4 12h16M4 18h7"/>',
    columns: '<path d="M6 20V10M12 20V4M18 20v-7"/>',
    donut: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 4v4.5"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    common: '<path d="M4 18h4V9H4zM10 18h4V5h-4zM16 18h4v-6h-4z"/>',
    sort: '<path d="M7 4v16M3 16l4 4 4-4M14 6h7M14 12h5M14 18h3"/>',
    prev: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  };

  function icon(name) {
    return h('span', {
      class: 'fr-icon',
      'aria-hidden': 'true',
      html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        ICONS[name] +
        '</svg>',
    });
  }

  function remember(key, value) {
    try {
      if (value === undefined) return JSON.parse(window.localStorage.getItem(key) || 'null');
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* no storage: the choice lasts this visit */
    }
    return null;
  }

  var DAY = 86400000;
  function dayKey(d) {
    var x = new Date(d);
    return (
      x.getFullYear() +
      '-' +
      String(x.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(x.getDate()).padStart(2, '0')
    );
  }
  function when(d) {
    return new Date(d).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  function ago(d) {
    var s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < DAY / 1000) return Math.floor(s / 3600) + ' h ago';
    if (s < (7 * DAY) / 1000) return Math.floor(s / (DAY / 1000)) + ' days ago';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  M.formResponses = function (root, opts) {
    var formId = opts.formId;
    var data = null;
    var lang = 'it';
    var questions = []; // every answerable question of any version, current ones first
    var byId = {};
    var numberOf = {}; // response id -> #n, oldest first
    var state = {
      view: remember('fr-view') || 'summary',
      status: 'all',
      range: 'all',
      q: '',
      cross: [], // [{ item, key, label }]
      selected: null,
      showAll: {},
    };
    var chartChoice = remember('fr-charts:' + formId) || {};
    var sorted = remember('fr-sorted:' + formId) || {};

    function t(value) {
      if (!value) return '';
      return value[lang] || value.it || value.en || '';
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    function load() {
      M.clear(root);
      root.appendChild(M.loading());
      M.api('GET', '/api/app/forms?id=' + encodeURIComponent(formId) + '&view=responses')
        .then(function (d) {
          data = d;
          prepare();
          if (opts.onCount) opts.onCount(data.responses.length);
          render();
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          M.clear(root);
          root.appendChild(
            h(
              'div',
              { class: 'empty-state' },
              h('h3', null, 'The answers could not be loaded'),
              h('p', null, err.message)
            )
          );
        });
    }

    function prepare() {
      var current = data.versions[data.currentVersion];
      lang = current.languages[0];
      questions = [];
      byId = {};
      var versions = Object.keys(data.versions)
        .map(Number)
        .sort(function (a, b) {
          return b - a;
        });
      versions.forEach(function (v) {
        data.versions[v].items.forEach(function (item) {
          if (item.type === 'section' || item.type === 'info') return;
          if (byId[item.id]) {
            // Options a later version dropped still count for older answers.
            if (item.options) {
              item.options.forEach(function (o) {
                if (
                  !byId[item.id].options.some(function (x) {
                    return x.id === o.id;
                  })
                )
                  byId[item.id].options.push(o);
              });
            }
            return;
          }
          var q = {
            id: item.id,
            type: item.type,
            label: t(item.label) || item.id,
            options: (item.options || []).slice(),
            other: item.other,
            min: item.min,
            max: item.max,
            minLabel: t(item.minLabel),
            maxLabel: t(item.maxLabel),
            removed: v !== data.currentVersion,
          };
          byId[item.id] = q;
          questions.push(q);
        });
      });
      questions.forEach(function (q, i) {
        q.n = i + 1 < 10 ? '0' + (i + 1) : String(i + 1);
      });
      data.responses
        .slice()
        .sort(function (a, b) {
          return new Date(a.submittedAt) - new Date(b.submittedAt);
        })
        .forEach(function (r, i) {
          numberOf[r.id] = i + 1;
        });
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    function picked(r, itemId, key) {
      var v = r.answers[itemId];
      if (v === undefined || v === null) return false;
      var q = byId[itemId];
      if (CHOICE.indexOf(q.type) !== -1)
        return key === '__other' ? Boolean(v.other) : (v.selected || []).indexOf(key) !== -1;
      return String(v) === key;
    }

    function optionLabel(q, id) {
      var o = q.options.filter(function (x) {
        return x.id === id;
      })[0];
      return o ? t(o.label) || id : id;
    }

    function text(q, v) {
      if (v === undefined || v === null) return '';
      if (CHOICE.indexOf(q.type) !== -1) {
        var labels = (v.selected || []).map(function (id) {
          return optionLabel(q, id);
        });
        if (v.other) labels.push('Other: ' + v.other);
        return labels.join(', ');
      }
      if (q.type === 'yes_no') return v === 'yes' ? 'Yes' : 'No';
      if (q.type === 'consent') return 'Accepted';
      if (q.type === 'scale') return v + ' / ' + q.max;
      return String(v);
    }

    function searchText(r) {
      if (r._text === undefined) {
        r._text = questions
          .map(function (q) {
            return text(q, r.answers[q.id]);
          })
          .join(' ')
          .toLowerCase();
      }
      return r._text;
    }

    /** The answers the filters keep; `except` leaves out the click-filter of one question. */
    function filtered(except, withSearch) {
      var days = state.range === 'all' ? 0 : Number(state.range);
      var since = days ? Date.now() - days * DAY : 0;
      var q = withSearch ? state.q.trim().toLowerCase() : '';
      return data.responses.filter(function (r) {
        if (r.answers.unreadable) return state.status === 'all' && !q && !state.cross.length;
        if (state.status !== 'all' && r.status !== state.status) return false;
        if (since && new Date(r.submittedAt).getTime() < since) return false;
        for (var i = 0; i < state.cross.length; i++) {
          var f = state.cross[i];
          if (f.item !== except && !picked(r, f.item, f.key)) return false;
        }
        if (q && searchText(r).indexOf(q) === -1) return false;
        return true;
      });
    }

    function toggleCross(q, key, label) {
      var at = -1;
      state.cross.forEach(function (f, i) {
        if (f.item === q.id && f.key === key) at = i;
      });
      if (at !== -1) state.cross.splice(at, 1);
      else {
        state.cross = state.cross.filter(function (f) {
          return f.item !== q.id;
        });
        state.cross.push({ item: q.id, key: key, label: q.label + ': ' + label });
      }
      render();
    }

    // ── Frame: views, filters ───────────────────────────────────────────────

    function render() {
      C.hideTip();
      M.clear(root);
      root.appendChild(toolbar());
      root.appendChild(filters());
      if (!data.responses.length) {
        root.appendChild(
          h(
            'div',
            { class: 'fr-empty' },
            icon('list'),
            h('h3', null, 'No answers yet'),
            h(
              'p',
              null,
              'Share the form’s link: answers show up here as they arrive, and the charts with them.'
            )
          )
        );
        return;
      }
      if (state.view === 'individual') root.appendChild(individual());
      else if (state.view === 'table') root.appendChild(table());
      else root.appendChild(summary());
    }

    function toolbar() {
      var views = h('div', {
        class: 'fr-views',
        role: 'tablist',
        'aria-label': 'How to see the answers',
      });
      VIEWS.forEach(function (v) {
        views.appendChild(
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(state.view === v[0]),
              onclick: function () {
                state.view = v[0];
                remember('fr-view', v[0]);
                render();
              },
            },
            v[1]
          )
        );
      });
      return h(
        'div',
        { class: 'fr-toolbar' },
        h(
          'div',
          { class: 'fr-heading' },
          h('h2', null, 'Answers'),
          h('span', { class: 'fr-total' }, String(data.responses.length))
        ),
        views,
        h(
          'div',
          { class: 'fr-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'fr-ghost',
              title: 'Load again',
              'aria-label': 'Load the answers again',
              onclick: load,
            },
            icon('refresh')
          ),
          data.canManage && data.responses.length
            ? h(
                'a',
                {
                  class: 'btn btn-outline btn-sm fr-export',
                  href: '/api/app/forms?id=' + encodeURIComponent(formId) + '&view=export',
                  download: '',
                },
                icon('download'),
                'Export CSV'
              )
            : null
        )
      );
    }

    function filters() {
      var counts = { all: 0 };
      data.responses.forEach(function (r) {
        counts.all++;
        counts[r.status] = (counts[r.status] || 0) + 1;
      });
      var chips = h('div', { class: 'fr-chips', role: 'group', 'aria-label': 'Status' });
      ['all'].concat(data.statuses).forEach(function (s) {
        chips.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'fr-chip' + (s !== 'all' ? ' fr-status-' + s : ''),
              'aria-pressed': String(state.status === s),
              onclick: function () {
                state.status = s;
                render();
              },
            },
            s !== 'all' ? h('i', { class: 'fr-dot', 'aria-hidden': 'true' }) : null,
            s === 'all' ? 'All' : STATUS_LABEL[s],
            h('span', { class: 'fr-chip-n' }, String(counts[s] || 0))
          )
        );
      });
      var range = h('select', {
        class: 'fr-select',
        'aria-label': 'When',
        onchange: function () {
          state.range = range.value;
          render();
        },
      });
      RANGES.forEach(function (r) {
        var o = h('option', { value: r[0] }, r[1]);
        if (state.range === r[0]) o.selected = true;
        range.appendChild(o);
      });
      var search = null;
      if (state.view !== 'summary') {
        var input = h('input', {
          type: 'search',
          placeholder: 'Search the answers',
          'aria-label': 'Search the answers',
          value: state.q,
        });
        var timer = null;
        input.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            state.q = input.value;
            var pos = input.selectionStart;
            render();
            var again = root.querySelector('.fr-search input');
            if (again) {
              again.focus();
              again.setSelectionRange(pos, pos);
            }
          }, 180);
        });
        search = h('label', { class: 'fr-search' }, icon('search'), input);
      }
      var active = state.cross.map(function (f) {
        return h(
          'button',
          {
            type: 'button',
            class: 'fr-filter',
            title: 'Remove this filter',
            onclick: function () {
              state.cross = state.cross.filter(function (x) {
                return x !== f;
              });
              render();
            },
          },
          h('span', null, f.label),
          icon('close')
        );
      });
      return h(
        'div',
        { class: 'fr-filters' },
        chips,
        range,
        search,
        active.length ? h('div', { class: 'fr-active' }, active) : null
      );
    }

    // ── Summary ─────────────────────────────────────────────────────────────

    function summary() {
      var rows = filtered(null, false);
      var box = h('div', { class: 'fr-summary' });
      box.appendChild(kpis(rows));
      box.appendChild(timeline(rows));
      var grid = h('div', { class: 'fr-grid' });
      questions.forEach(function (q) {
        grid.appendChild(card(q));
      });
      box.appendChild(grid);
      return box;
    }

    function kpis(rows) {
      var now = Date.now();
      var week = data.responses.filter(function (r) {
        return now - new Date(r.submittedAt).getTime() < 7 * DAY;
      }).length;
      var before = data.responses.filter(function (r) {
        var age = now - new Date(r.submittedAt).getTime();
        return age >= 7 * DAY && age < 14 * DAY;
      }).length;
      var reviewed = rows.filter(function (r) {
        return r.status && r.status !== 'new';
      }).length;
      var latest = data.responses.reduce(function (m, r) {
        return !m || new Date(r.submittedAt) > new Date(m) ? r.submittedAt : m;
      }, null);
      var delta = week - before;
      return h(
        'div',
        { class: 'fr-kpis' },
        h(
          'div',
          { class: 'fr-kpi is-hero' },
          h(
            'span',
            { class: 'fr-kpi-label' },
            state.cross.length || state.status !== 'all' || state.range !== 'all'
              ? 'Answers shown'
              : 'Answers'
          ),
          h('span', { class: 'fr-kpi-value' }, C.compact(rows.length)),
          rows.length !== data.responses.length
            ? h('span', { class: 'fr-kpi-note' }, 'of ' + data.responses.length)
            : null
        ),
        h(
          'div',
          { class: 'fr-kpi' },
          h('span', { class: 'fr-kpi-label' }, 'Last 7 days'),
          h('span', { class: 'fr-kpi-value' }, String(week)),
          h(
            'span',
            { class: 'fr-kpi-note' + (delta > 0 ? ' is-up' : '') },
            delta === 0
              ? 'same as the week before'
              : (delta > 0 ? '+' : '') + delta + ' on the week before'
          )
        ),
        h(
          'div',
          { class: 'fr-kpi' },
          h('span', { class: 'fr-kpi-label' }, 'Reviewed'),
          h('span', { class: 'fr-kpi-value' }, rows.length ? C.pct(reviewed / rows.length) : '–'),
          h('span', { class: 'fr-kpi-note' }, reviewed + ' not new any more')
        ),
        h(
          'div',
          { class: 'fr-kpi' },
          h('span', { class: 'fr-kpi-label' }, 'Latest answer'),
          h('span', { class: 'fr-kpi-value is-small' }, latest ? ago(latest) : '–'),
          h('span', { class: 'fr-kpi-note' }, latest ? when(latest) : '')
        )
      );
    }

    function timeline(rows) {
      if (!rows.length) return h('div');
      var times = rows.map(function (r) {
        return new Date(r.submittedAt).getTime();
      });
      var first = Math.min.apply(null, times);
      var days =
        state.range === 'all' ? Math.ceil((Date.now() - first) / DAY) + 1 : Number(state.range);
      days = Math.max(days, 7);
      var weekly = days > 92;
      var buckets = [];
      var start = new Date();
      start.setHours(0, 0, 0, 0);
      var step = weekly ? 7 : 1;
      var count = Math.ceil(days / step);
      for (var i = count - 1; i >= 0; i--) {
        var from = start.getTime() - i * step * DAY;
        buckets.push({ from: from, to: from + step * DAY, count: 0 });
      }
      times.forEach(function (tm) {
        for (var j = 0; j < buckets.length; j++) {
          if (tm >= buckets[j].from && tm < buckets[j].to) {
            buckets[j].count++;
            return;
          }
        }
        if (tm < buckets[0].from) buckets[0].count++;
      });
      var data2 = buckets.map(function (b) {
        var d = new Date(b.from);
        var label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return {
          key: dayKey(b.from),
          label: (weekly ? 'Week of ' : '') + label,
          short: label,
          count: b.count,
          share: rows.length ? b.count / rows.length : 0,
        };
      });
      return h(
        'section',
        { class: 'fr-card fr-timeline' },
        h(
          'header',
          { class: 'fr-card-head' },
          h(
            'div',
            null,
            h('h3', null, 'Answers over time'),
            h('p', { class: 'fr-card-meta' }, weekly ? 'Per week' : 'Per day')
          )
        ),
        C.columns(data2, { height: 170, label: 'Answers per ' + (weekly ? 'week' : 'day') })
      );
    }

    function kindOf(q) {
      if (TEXT.indexOf(q.type) !== -1) return 'text';
      return q.type;
    }

    function chartFor(q) {
      var kinds = CHART_KINDS[kindOf(q)];
      if (!kinds) return null;
      var chosen = chartChoice[q.id];
      return kinds.indexOf(chosen) !== -1 ? chosen : kinds[0];
    }

    function card(q) {
      var rows = filtered(q.id, false);
      var answered = rows.filter(function (r) {
        var v = r.answers[q.id];
        return v !== undefined && v !== null && v !== '';
      });
      var kinds = CHART_KINDS[kindOf(q)];
      var chosen = chartFor(q);
      var controls = h('div', { class: 'fr-card-controls' });
      if (kinds && kinds.length > 1) {
        var seg = h('div', { class: 'fr-seg', role: 'group', 'aria-label': 'Show as' });
        kinds.forEach(function (k) {
          seg.appendChild(
            h(
              'button',
              {
                type: 'button',
                title: CHART_NAMES[k],
                'aria-label': CHART_NAMES[k],
                'aria-pressed': String(chosen === k),
                onclick: function () {
                  chartChoice[q.id] = k;
                  remember('fr-charts:' + formId, chartChoice);
                  render();
                },
              },
              icon(k)
            )
          );
        });
        controls.appendChild(seg);
      }
      if (CHOICE.indexOf(q.type) !== -1 && chosen !== 'donut') {
        controls.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'fr-ghost',
              title: sorted[q.id] ? 'Show in the form’s order' : 'Sort by count',
              'aria-label': sorted[q.id] ? 'Show in the form’s order' : 'Sort by count',
              'aria-pressed': String(Boolean(sorted[q.id])),
              onclick: function () {
                sorted[q.id] = !sorted[q.id];
                remember('fr-sorted:' + formId, sorted);
                render();
              },
            },
            icon('sort')
          )
        );
      }
      var head = h(
        'header',
        { class: 'fr-card-head' },
        h('span', { class: 'fr-num', 'aria-hidden': 'true' }, q.n),
        h(
          'div',
          { class: 'fr-card-title' },
          h('h3', null, q.label),
          h(
            'p',
            { class: 'fr-card-meta' },
            answered.length +
              (answered.length === 1 ? ' answer' : ' answers') +
              (rows.length !== answered.length
                ? ' · ' + (rows.length - answered.length) + ' skipped'
                : '') +
              (q.type === 'multi' ? ' · more than one could be chosen' : '') +
              (q.removed ? ' · no longer in the form' : '')
          )
        ),
        controls
      );
      return h(
        'section',
        { class: 'fr-card' + (TEXT.indexOf(q.type) !== -1 && chosen === 'list' ? ' is-text' : '') },
        head,
        body(q, answered, chosen)
      );
    }

    function counted(q, answered) {
      var selectedKey = null;
      state.cross.forEach(function (f) {
        if (f.item === q.id) selectedKey = f.key;
      });
      var list = [];
      if (CHOICE.indexOf(q.type) !== -1) {
        list = q.options.map(function (o) {
          return { key: o.id, label: t(o.label) || o.id };
        });
        if (q.other) list.push({ key: '__other', label: 'Other' });
      } else if (q.type === 'yes_no') {
        list = [
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ];
      } else if (q.type === 'scale') {
        for (var n = q.min; n <= q.max; n++) {
          var end = n === q.min ? q.minLabel : n === q.max ? q.maxLabel : '';
          list.push({
            key: String(n),
            label: String(n) + (end ? ' · ' + end : ''),
            short: String(n),
          });
        }
      }
      list.forEach(function (row) {
        row.count = answered.filter(function (r) {
          return picked(r, q.id, row.key);
        }).length;
        row.share = answered.length ? row.count / answered.length : 0;
        row.selected = row.key === selectedKey;
      });
      if (sorted[q.id] && CHOICE.indexOf(q.type) !== -1) {
        list.sort(function (a, b) {
          return b.count - a.count;
        });
      }
      return list;
    }

    function body(q, answered, chosen) {
      if (!answered.length)
        return h('p', { class: 'fr-none' }, 'No answers to this question with these filters.');
      var pick = function (key) {
        var row = counted(q, answered).filter(function (r) {
          return r.key === key;
        })[0];
        toggleCross(q, key, row ? row.label : key);
      };
      if (CHOICE.indexOf(q.type) !== -1 || q.type === 'yes_no') {
        var rows = counted(q, answered);
        var chart =
          chosen === 'donut'
            ? C.donut(rows, { onPick: pick, label: q.label })
            : chosen === 'columns'
            ? C.columns(rows, { onPick: pick, label: q.label })
            : C.bars(rows, { onPick: pick });
        var others = answered
          .map(function (r) {
            return r.answers[q.id] && r.answers[q.id].other;
          })
          .filter(Boolean);
        return h(
          'div',
          null,
          chart,
          others.length ? textList(q, others, 'Written in “Other”') : null
        );
      }
      if (q.type === 'scale') {
        var values = answered.map(function (r) {
          return Number(r.answers[q.id]);
        });
        var srows = counted(q, answered);
        return h(
          'div',
          null,
          stats(values, [
            ['Average', mean(values)],
            ['Median', median(values)],
          ]),
          chosen === 'bars'
            ? C.bars(srows, { onPick: pick })
            : C.columns(srows, { onPick: pick, label: q.label }),
          q.minLabel || q.maxLabel
            ? h(
                'div',
                { class: 'fr-ends' },
                h('span', null, q.min + ' · ' + q.minLabel),
                h('span', null, q.max + ' · ' + q.maxLabel)
              )
            : null
        );
      }
      if (q.type === 'number') {
        var nums = answered
          .map(function (r) {
            return Number(r.answers[q.id]);
          })
          .filter(function (n) {
            return isFinite(n);
          });
        return h(
          'div',
          null,
          stats(nums, [
            ['Lowest', Math.min.apply(null, nums)],
            ['Median', median(nums)],
            ['Average', mean(nums)],
            ['Highest', Math.max.apply(null, nums)],
          ]),
          C.columns(histogram(nums), { label: q.label })
        );
      }
      if (q.type === 'date') {
        var months = {};
        answered.forEach(function (r) {
          var key = String(r.answers[q.id]).slice(0, 7);
          months[key] = (months[key] || 0) + 1;
        });
        var mrows = Object.keys(months)
          .sort()
          .map(function (k) {
            var d = new Date(k + '-01T12:00:00');
            var label = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
            return {
              key: k,
              label: label,
              short: label,
              count: months[k],
              share: months[k] / answered.length,
            };
          });
        return C.columns(mrows, { label: q.label });
      }
      if (q.type === 'consent') {
        return h(
          'div',
          { class: 'fr-consent' },
          h('span', { class: 'fr-kpi-value' }, String(answered.length)),
          h('span', null, 'accepted, out of ' + filtered(q.id, false).length + ' answers shown')
        );
      }
      // Text, email, link
      var texts = answered.map(function (r) {
        return { text: String(r.answers[q.id]), r: r };
      });
      if (chosen === 'common') return common(texts);
      return textList(q, texts, null);
    }

    function textList(q, items, title) {
      var key = q.id + (title ? ':other' : '');
      var all = state.showAll[key];
      var shown = all ? items : items.slice(0, 6);
      var list = h('ul', { class: 'fr-texts' });
      shown.forEach(function (item) {
        var value = typeof item === 'string' ? item : item.text;
        var r = typeof item === 'string' ? null : item.r;
        var content =
          q.type === 'url' && /^https:\/\//i.test(value)
            ? h('a', { href: value, target: '_blank', rel: 'noopener noreferrer nofollow' }, value)
            : h('span', null, value);
        list.appendChild(
          h(
            'li',
            null,
            content,
            r
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'fr-open',
                    title: 'Open this answer',
                    onclick: function () {
                      open(r.id);
                    },
                  },
                  '#' + numberOf[r.id]
                )
              : null
          )
        );
      });
      return h(
        'div',
        null,
        title ? h('p', { class: 'fr-subtitle' }, title) : null,
        list,
        items.length > 6
          ? h(
              'button',
              {
                type: 'button',
                class: 'fr-more',
                onclick: function () {
                  state.showAll[key] = !all;
                  render();
                },
              },
              all ? 'Show fewer' : 'Show all ' + items.length
            )
          : null
      );
    }

    function common(texts) {
      var counts = {};
      var labels = {};
      texts.forEach(function (x) {
        var k = x.text.trim().toLowerCase().replace(/\s+/g, ' ');
        counts[k] = (counts[k] || 0) + 1;
        labels[k] = labels[k] || x.text.trim();
      });
      var rows = Object.keys(counts)
        .map(function (k) {
          return { key: k, label: labels[k], count: counts[k], share: counts[k] / texts.length };
        })
        .sort(function (a, b) {
          return b.count - a.count;
        })
        .slice(0, 10);
      var note =
        rows[0] && rows[0].count === 1
          ? h('p', { class: 'fr-none' }, 'No answer repeats: every one is different.')
          : null;
      return h('div', null, note, C.bars(rows, {}));
    }

    function mean(list) {
      if (!list.length) return '–';
      var m =
        list.reduce(function (a, b) {
          return a + b;
        }, 0) / list.length;
      return Math.round(m * 10) / 10;
    }

    function median(list) {
      if (!list.length) return '–';
      var s = list.slice().sort(function (a, b) {
        return a - b;
      });
      var mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
    }

    function histogram(nums) {
      if (!nums.length) return [];
      var lo = Math.min.apply(null, nums);
      var hi = Math.max.apply(null, nums);
      var distinct = {};
      nums.forEach(function (n) {
        distinct[n] = (distinct[n] || 0) + 1;
      });
      var keys = Object.keys(distinct)
        .map(Number)
        .sort(function (a, b) {
          return a - b;
        });
      // Few distinct values: one column each. Otherwise even bins (Sturges, at most 12).
      if (keys.length <= 12) {
        return keys.map(function (k) {
          return {
            key: String(k),
            label: String(k),
            count: distinct[k],
            share: distinct[k] / nums.length,
          };
        });
      }
      var bins = Math.min(12, Math.ceil(Math.log2(nums.length) + 1));
      var whole = nums.every(function (n) {
        return n === Math.floor(n);
      });
      var width = whole ? Math.ceil((hi - lo + 1) / bins) : (hi - lo) / bins;
      if (whole) bins = Math.ceil((hi - lo + 1) / width);
      var out = [];
      for (var i = 0; i < bins; i++) {
        var from = lo + i * width;
        var to = whole ? Math.min(hi, from + width - 1) : i === bins - 1 ? hi : from + width;
        var round = function (x) {
          return Math.round(x * 10) / 10;
        };
        var label = from === to ? String(round(from)) : round(from) + '–' + round(to);
        out.push({ key: String(i), label: label, short: label, count: 0, share: 0 });
      }
      nums.forEach(function (n) {
        var i = Math.min(bins - 1, Math.floor((n - lo) / width));
        out[i].count++;
      });
      out.forEach(function (b) {
        b.share = b.count / nums.length;
      });
      return out;
    }

    function stats(values, pairs) {
      return h(
        'dl',
        { class: 'fr-stats' },
        pairs.map(function (p) {
          return h(
            'div',
            null,
            h('dt', null, p[0]),
            h('dd', null, values.length ? String(p[1]) : '–')
          );
        })
      );
    }

    // ── Individual ──────────────────────────────────────────────────────────

    function open(id) {
      state.selected = id;
      state.view = 'individual';
      remember('fr-view', 'individual');
      render();
    }

    function ordered(list) {
      return list.slice().sort(function (a, b) {
        return new Date(b.submittedAt) - new Date(a.submittedAt);
      });
    }

    function preview(r) {
      if (r.answers.unreadable) return 'Cannot be opened with the current key';
      for (var i = 0; i < questions.length; i++) {
        var q = questions[i];
        if ((q.type === 'short_text' || q.type === 'email') && r.answers[q.id])
          return String(r.answers[q.id]);
      }
      return 'Answer #' + numberOf[r.id];
    }

    function individual() {
      var list = ordered(filtered(null, true));
      if (
        !list.some(function (r) {
          return r.id === state.selected;
        })
      )
        state.selected = list[0] ? list[0].id : null;
      var side = h('nav', { class: 'fr-list', 'aria-label': 'Answers' });
      if (!list.length)
        side.appendChild(h('p', { class: 'fr-none' }, 'No answer matches these filters.'));
      list.forEach(function (r) {
        side.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'fr-item',
              'aria-current': r.id === state.selected ? 'true' : null,
              onclick: function () {
                state.selected = r.id;
                render();
              },
            },
            h(
              'span',
              { class: 'fr-item-top' },
              h('span', { class: 'fr-item-n' }, '#' + numberOf[r.id]),
              h('span', { class: 'fr-item-when' }, ago(r.submittedAt))
            ),
            h('span', { class: 'fr-item-name' }, preview(r)),
            statusPill(r.status)
          )
        );
      });
      var current = list.filter(function (r) {
        return r.id === state.selected;
      })[0];
      return h(
        'div',
        { class: 'fr-split' },
        side,
        current ? detail(current, list) : h('div', { class: 'fr-detail' })
      );
    }

    function statusPill(status) {
      return h(
        'span',
        { class: 'fr-pill fr-status-' + status },
        h('i', { class: 'fr-dot', 'aria-hidden': 'true' }),
        STATUS_LABEL[status] || status
      );
    }

    function step(delta) {
      var list = ordered(filtered(null, true));
      var at = -1;
      list.forEach(function (r, i) {
        if (r.id === state.selected) at = i;
      });
      var next = list[at + delta];
      if (next) {
        state.selected = next.id;
        render();
        var sel = root.querySelector('.fr-item[aria-current="true"]');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
    }

    function detail(r, list) {
      var at = list.indexOf(r);
      var schema = data.versions[r.version] || data.versions[data.currentVersion];
      var seg = h('div', { class: 'fr-status-seg', role: 'group', 'aria-label': 'Status' });
      data.statuses.forEach(function (s) {
        seg.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'fr-status-' + s,
              'aria-pressed': String(r.status === s),
              onclick: function () {
                if (r.status === s) return;
                setStatus(r, s);
              },
            },
            h('i', { class: 'fr-dot', 'aria-hidden': 'true' }),
            STATUS_LABEL[s]
          )
        );
      });
      var head = h(
        'header',
        { class: 'fr-detail-head' },
        h(
          'div',
          { class: 'fr-detail-title' },
          h('h3', null, 'Answer #' + numberOf[r.id]),
          h(
            'p',
            null,
            when(r.submittedAt) +
              ' · ' +
              ago(r.submittedAt) +
              (r.version !== data.currentVersion
                ? ' · given to version ' + r.version + ' of the questions'
                : '')
          )
        ),
        h(
          'div',
          { class: 'fr-detail-nav' },
          h('span', { class: 'fr-count' }, at + 1 + ' of ' + list.length),
          h(
            'button',
            {
              type: 'button',
              class: 'fr-ghost',
              title: 'Newer (←)',
              'aria-label': 'Newer answer',
              disabled: at <= 0,
              onclick: function () {
                step(-1);
              },
            },
            icon('prev')
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'fr-ghost',
              title: 'Older (→)',
              'aria-label': 'Older answer',
              disabled: at >= list.length - 1,
              onclick: function () {
                step(1);
              },
            },
            icon('next')
          )
        )
      );
      var bar = h(
        'div',
        { class: 'fr-detail-bar' },
        seg,
        data.canManage
          ? h(
              'button',
              {
                type: 'button',
                class: 'fr-delete',
                onclick: function () {
                  remove(r);
                },
              },
              icon('trash'),
              'Delete'
            )
          : null
      );
      var answers = h('div', { class: 'fr-answers' });
      if (r.answers.unreadable) {
        answers.appendChild(
          h(
            'p',
            { class: 'fr-none' },
            'This answer cannot be opened with the current encryption key.'
          )
        );
      } else {
        var n = 0;
        schema.items.forEach(function (item) {
          if (item.type === 'info') return;
          if (item.type === 'section') {
            answers.appendChild(h('h4', { class: 'fr-section' }, t(item.label)));
            return;
          }
          n++;
          var q = byId[item.id];
          var v = r.answers[item.id];
          answers.appendChild(
            h(
              'div',
              { class: 'fr-answer' },
              h('span', { class: 'fr-num', 'aria-hidden': 'true' }, n < 10 ? '0' + n : String(n)),
              h('div', null, h('p', { class: 'fr-q' }, t(item.label) || item.id), value(q, v))
            )
          );
        });
      }
      return h('article', { class: 'fr-detail' }, head, bar, answers);
    }

    function value(q, v) {
      if (v === undefined || v === null || v === '')
        return h('p', { class: 'fr-a is-empty' }, 'No answer');
      if (CHOICE.indexOf(q.type) !== -1) {
        var tags = (v.selected || []).map(function (id) {
          return h('span', { class: 'fr-tag' }, optionLabel(q, id));
        });
        if (v.other) tags.push(h('span', { class: 'fr-tag is-other' }, 'Other: ' + v.other));
        return h('div', { class: 'fr-tags' }, tags);
      }
      if (q.type === 'url' && /^https:\/\//i.test(String(v)))
        return h(
          'p',
          { class: 'fr-a' },
          h(
            'a',
            { href: String(v), target: '_blank', rel: 'noopener noreferrer nofollow' },
            String(v)
          )
        );
      if (q.type === 'email')
        return h('p', { class: 'fr-a' }, h('a', { href: 'mailto:' + String(v) }, String(v)));
      if (q.type === 'consent')
        return h(
          'p',
          { class: 'fr-a' },
          'Accepted' + (v.version ? ' (text version ' + v.version + ')' : '')
        );
      if (q.type === 'scale')
        return h(
          'p',
          { class: 'fr-a' },
          h('strong', null, String(v)),
          ' / ' +
            q.max +
            (Number(v) === q.min && q.minLabel
              ? ' · ' + q.minLabel
              : Number(v) === q.max && q.maxLabel
              ? ' · ' + q.maxLabel
              : '')
        );
      if (q.type === 'date')
        return h(
          'p',
          { class: 'fr-a' },
          new Date(v + 'T12:00:00').toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        );
      return h('p', { class: 'fr-a' + (q.type === 'long_text' ? ' is-long' : '') }, text(q, v));
    }

    function setStatus(r, s) {
      var before = r.status;
      r.status = s;
      render();
      M.api(
        'PUT',
        '/api/app/forms?id=' +
          encodeURIComponent(formId) +
          '&part=response&response=' +
          encodeURIComponent(r.id),
        { status: s }
      )
        .then(function () {
          M.toast('Marked ' + STATUS_LABEL[s].toLowerCase());
        })
        .catch(function (err) {
          r.status = before;
          render();
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
        });
    }

    function remove(r) {
      if (
        !window.confirm(
          'Delete answer #' + numberOf[r.id] + ' for good? It cannot be brought back.'
        )
      )
        return;
      M.api(
        'DELETE',
        '/api/app/forms?id=' + encodeURIComponent(formId) + '&response=' + encodeURIComponent(r.id)
      )
        .then(function () {
          var list = ordered(filtered(null, true));
          var at = list.indexOf(r);
          var next = list[at + 1] || list[at - 1];
          data.responses = data.responses.filter(function (x) {
            return x !== r;
          });
          state.selected = next ? next.id : null;
          if (opts.onCount) opts.onCount(data.responses.length);
          M.toast('Answer deleted');
          render();
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
        });
    }

    document.addEventListener('keydown', function (e) {
      if (state.view !== 'individual' || !root.isConnected || root.offsetParent === null) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        step(1);
      }
    });

    // ── Table ───────────────────────────────────────────────────────────────

    function table() {
      var list = ordered(filtered(null, true));
      if (!list.length) return h('p', { class: 'fr-none' }, 'No answer matches these filters.');
      var head = h(
        'tr',
        null,
        h('th', { scope: 'col', class: 'fr-sticky' }, '#'),
        h('th', { scope: 'col' }, 'Sent'),
        h('th', { scope: 'col' }, 'Status'),
        questions.map(function (q) {
          return h('th', { scope: 'col', title: q.label }, q.label);
        })
      );
      var body = h('tbody');
      list.forEach(function (r) {
        body.appendChild(
          h(
            'tr',
            {
              tabindex: '0',
              title: 'Open answer #' + numberOf[r.id],
              onclick: function () {
                open(r.id);
              },
              onkeydown: function (e) {
                if (e.key === 'Enter') open(r.id);
              },
            },
            h('th', { scope: 'row', class: 'fr-sticky' }, '#' + numberOf[r.id]),
            h('td', { class: 'fr-nowrap' }, when(r.submittedAt)),
            h('td', null, statusPill(r.status)),
            questions.map(function (q) {
              var s = r.answers.unreadable ? '–' : text(q, r.answers[q.id]);
              return h('td', { title: s }, s);
            })
          )
        );
      });
      return h(
        'div',
        { class: 'fr-table-wrap' },
        h('table', { class: 'fr-table' }, h('thead', null, head), body)
      );
    }

    load();
    return { reload: load };
  };
})();
