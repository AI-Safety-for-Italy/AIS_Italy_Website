/* /app/polls/new/: the poll form and the week calendar used to pick times.
 *
 * Slots are kept as UTC milliseconds; the grid shows them on the wall clock of
 * the chosen time zone. Pointer interaction on the grid:
 *   - click            one slot of the chosen duration
 *   - drag vertically  the range cut into back-to-back slots
 *   - drag sideways    the same range repeated on each day crossed
 *   - click a slot     removes it
 * On touch screens a drag scrolls the grid instead, so only taps add slots.
 */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var SNAP = 15;

  var form = document.getElementById('pollForm');
  var wk = document.getElementById('wk');
  var tzSelect = document.getElementById('timezone');
  var summary = document.getElementById('slotSummary');
  var countLabel = document.getElementById('slotCount');
  var formError = document.getElementById('formError');

  var state = {
    tz: 'Europe/Rome',
    duration: 60,
    days: 7,
    start: null,
    slots: new Set(),
  };

  document.getElementById('wkPrev').appendChild(M.icon('left'));
  document.getElementById('wkNext').appendChild(M.icon('right'));

  // ── Time zone list ─────────────────────────────────────────────────────────

  (function fillZones() {
    var zones;
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch (e) {
      zones = ['Europe/Rome', 'Europe/London', 'America/New_York', 'UTC'];
    }
    var preferred = ['Europe/Rome', M.browserTz()];
    preferred
      .concat(
        zones.filter(function (z) {
          return preferred.indexOf(z) === -1;
        })
      )
      .forEach(function (z, i, all) {
        if (all.indexOf(z) !== i) return;
        tzSelect.appendChild(h('option', { value: z }, M.tzLabel(z)));
      });
    tzSelect.value = state.tz;
    tzSelect.addEventListener('change', function () {
      state.tz = tzSelect.value;
      render();
    });
  })();

  // ── Duration ───────────────────────────────────────────────────────────────

  var chips = document.querySelectorAll('#durationChips .chip');
  var custom = document.getElementById('durationCustom');

  function setDuration(minutes, fromCustom) {
    state.duration = minutes;
    chips.forEach(function (c) {
      c.setAttribute('aria-pressed', String(Number(c.dataset.minutes) === minutes && !fromCustom));
    });
    if (!fromCustom) custom.value = '';
    render();
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      setDuration(Number(c.dataset.minutes));
    });
  });
  custom.addEventListener('input', function () {
    var v = Math.round(Number(custom.value));
    if (v >= 5 && v <= 1440) setDuration(v, true);
  });

  // ── Visible range ──────────────────────────────────────────────────────────

  function mondayOf(date) {
    return M.addDays(date, -M.weekday(date));
  }

  function fitDays() {
    var days = wk.clientWidth && wk.clientWidth < 620 ? 3 : 7;
    if (days !== state.days || !state.start) {
      state.days = days;
      var base = state.start || M.today(state.tz);
      state.start = days === 7 ? mondayOf(base) : base;
    }
  }

  function visibleDates() {
    var out = [];
    for (var i = 0; i < state.days; i++) out.push(M.addDays(state.start, i));
    return out;
  }

  document.getElementById('wkPrev').addEventListener('click', function () {
    state.start = M.addDays(state.start, -state.days);
    render();
  });
  document.getElementById('wkNext').addEventListener('click', function () {
    state.start = M.addDays(state.start, state.days);
    render();
  });
  document.getElementById('wkToday').addEventListener('click', function () {
    var t = M.today(state.tz);
    state.start = state.days === 7 ? mondayOf(t) : t;
    render();
    scrollToHour(new Date().getHours() - 1);
  });

  // Formats a plain 'YYYY-MM-DD' (not an instant), so in UTC.
  function dateFmt(date, options) {
    return M.fmt(date + 'T12:00:00Z', 'UTC', options);
  }

  // ── Slots ──────────────────────────────────────────────────────────────────

  function slotsOn(date) {
    var out = [];
    state.slots.forEach(function (ms) {
      var z = M.utcToZoned(new Date(ms).toISOString(), state.tz);
      if (z.date === date) out.push({ ms: ms, minutes: z.minutes });
    });
    return out.sort(function (a, b) {
      return a.minutes - b.minutes;
    });
  }

  function overlaps(ms) {
    var span = state.duration * 60000;
    var hit = false;
    state.slots.forEach(function (other) {
      if (Math.abs(other - ms) < span) hit = true;
    });
    return hit;
  }

  /** Start minutes for a selected range [lo, hi), cut by the duration. */
  function startsFor(lo, hi, isClick) {
    if (isClick || hi - lo < state.duration) return [lo];
    var out = [];
    for (var t = lo; t + state.duration <= hi; t += state.duration) out.push(t);
    return out;
  }

  function addRange(dates, starts) {
    var now = Date.now();
    var added = 0;
    dates.forEach(function (date) {
      starts.forEach(function (minutes) {
        if (minutes >= 1440) return;
        var ms = M.zonedToUtc(date, minutes, state.tz);
        if (ms < now || overlaps(ms)) return;
        state.slots.add(ms);
        added++;
      });
    });
    if (!added) M.toast('Those times are taken or in the past');
    render();
  }

  // Overlapping slots (possible after the duration grows) sit side by side.
  function layoutLanes(list) {
    var clusters = [];
    var current = null;
    var end = -1;
    list.forEach(function (s) {
      if (!current || s.minutes >= end) {
        current = [];
        clusters.push(current);
        end = -1;
      }
      current.push(s);
      end = Math.max(end, s.minutes + state.duration);
    });
    clusters.forEach(function (cluster) {
      var laneEnds = [];
      cluster.forEach(function (s) {
        var lane = laneEnds.findIndex(function (e) {
          return e <= s.minutes;
        });
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = s.minutes + state.duration;
        s.lane = lane;
      });
      cluster.forEach(function (s) {
        s.lanes = laneEnds.length;
      });
    });
    return list;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  var body;
  var scroller;

  function minutesToPx(m) {
    return (m / 60) * hourPx();
  }

  function hourPx() {
    return body ? body.getBoundingClientRect().height / 24 : 44;
  }

  function render() {
    fitDays();
    var dates = visibleDates();
    var todayDate = M.today(state.tz);
    var keepScroll = scroller ? scroller.scrollTop : null;

    document.getElementById('wkRange').textContent =
      dateFmt(dates[0], { day: 'numeric', month: 'short' }) +
      ' – ' +
      dateFmt(dates[dates.length - 1], { day: 'numeric', month: 'short', year: 'numeric' });

    wk.style.setProperty('--wk-days', state.days);
    M.clear(wk);

    wk.appendChild(
      h(
        'div',
        { class: 'wk-head' },
        h('div'),
        dates.map(function (date) {
          var n = slotsOn(date).length;
          return h(
            'div',
            {
              class:
                'wk-head-day' +
                (date === todayDate ? ' is-today' : '') +
                (date < todayDate ? ' is-past' : ''),
            },
            h('span', { class: 'wd' }, dateFmt(date, { weekday: 'short' })),
            h('span', { class: 'dn' }, dateFmt(date, { day: 'numeric' })),
            h('span', { class: 'count' }, n ? n + (n === 1 ? ' slot' : ' slots') : '')
          );
        })
      )
    );

    var gutter = h('div', { class: 'wk-gutter', 'aria-hidden': 'true' });
    for (var hr = 1; hr < 24; hr++) {
      gutter.appendChild(h('span', { style: 'top:' + (hr / 24) * 100 + '%' }, M.hhmm(hr * 60)));
    }

    body = h('div', { class: 'wk-body' }, gutter);
    dates.forEach(function (date, index) {
      var col = h('div', {
        class:
          'wk-day' + (date < todayDate ? ' is-past' : '') + (date === todayDate ? ' is-today' : ''),
        'data-index': index,
      });
      layoutLanes(slotsOn(date)).forEach(function (s) {
        col.appendChild(slotBlock(s));
      });
      body.appendChild(col);
    });

    scroller = h('div', { class: 'wk-scroll' }, body);
    wk.appendChild(scroller);

    var todayIndex = dates.indexOf(todayDate);
    if (todayIndex !== -1) {
      var nowMin = M.utcToZoned(new Date().toISOString(), state.tz).minutes;
      body.children[todayIndex + 1].appendChild(
        h('div', { class: 'wk-now', style: 'top:' + (nowMin / 1440) * 100 + '%' })
      );
    }

    if (keepScroll !== null) scroller.scrollTop = keepScroll;
    else scrollToHour(8);

    renderSummary();
  }

  function slotBlock(s) {
    var width = 100 / s.lanes;
    var block = h(
      'button',
      {
        type: 'button',
        class: 'wk-slot',
        style:
          'top:' +
          (s.minutes / 1440) * 100 +
          '%;height:calc(' +
          (state.duration / 1440) * 100 +
          '% - 2px);' +
          (s.lanes > 1
            ? 'left:calc(' + s.lane * width + '% + 2px);right:auto;width:calc(' + width + '% - 4px)'
            : ''),
        'aria-label': 'Remove ' + M.hhmm(s.minutes),
        onpointerdown: function (e) {
          e.stopPropagation();
        },
        onclick: function () {
          state.slots.delete(s.ms);
          render();
        },
      },
      M.hhmm(s.minutes) + '–' + M.hhmm(s.minutes + state.duration),
      h('span', { class: 'x', 'aria-hidden': 'true' }, '×')
    );
    return block;
  }

  function scrollToHour(hour) {
    if (scroller) scroller.scrollTop = Math.max(0, hour) * hourPx();
  }

  function renderSummary() {
    var all = Array.from(state.slots).sort(function (a, b) {
      return a - b;
    });
    countLabel.textContent = '';
    if (!all.length) {
      countLabel.appendChild(document.createTextNode('No times yet'));
      M.clear(summary);
      return;
    }
    countLabel.appendChild(h('strong', null, all.length + (all.length === 1 ? ' time' : ' times')));
    countLabel.appendChild(
      document.createTextNode(' · ' + M.fmtDuration(state.duration) + ' each')
    );

    var groups = M.groupByDay(
      all.map(function (ms) {
        return { start: new Date(ms).toISOString(), ms: ms };
      }),
      state.tz
    );
    M.clear(summary).appendChild(
      h(
        'div',
        null,
        h('span', { class: 'label-mono' }, 'Proposed times'),
        groups.map(function (g) {
          return h(
            'div',
            { class: 'slot-summary-day' },
            h('strong', null, M.fmtShortDay(g.slots[0].start, state.tz)),
            h(
              'div',
              null,
              g.slots.map(function (s) {
                var end = new Date(s.ms + state.duration * 60000).toISOString();
                return h(
                  'span',
                  { class: 'slot-chip' },
                  M.fmtTime(s.start, state.tz) + '–' + M.fmtTime(end, state.tz),
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-label': 'Remove',
                      onclick: function () {
                        state.slots.delete(s.ms);
                        render();
                      },
                    },
                    '×'
                  )
                );
              })
            )
          );
        })
      )
    );
  }

  // ── Pointer selection ──────────────────────────────────────────────────────

  var drag = null;

  function pointAt(e) {
    var cols = body.querySelectorAll('.wk-day');
    var index = 0;
    cols.forEach(function (col, i) {
      if (e.clientX >= col.getBoundingClientRect().left) index = i;
    });
    var y = e.clientY - body.getBoundingClientRect().top;
    var minutes = Math.floor(y / minutesToPx(SNAP)) * SNAP;
    return { index: index, minutes: Math.max(0, Math.min(1440 - SNAP, minutes)) };
  }

  function selection() {
    var lo = Math.min(drag.from.minutes, drag.to.minutes);
    var hi = Math.max(drag.from.minutes, drag.to.minutes) + SNAP;
    var isClick = !drag.moved;
    var starts = startsFor(isClick ? drag.from.minutes : lo, hi, isClick);
    var dates = visibleDates();
    var a = Math.min(drag.from.index, drag.to.index);
    var b = Math.max(drag.from.index, drag.to.index);
    var todayDate = M.today(state.tz);
    return {
      dates: dates.slice(a, b + 1).filter(function (d) {
        return d >= todayDate;
      }),
      indexes: [a, b],
      starts: starts,
    };
  }

  function clearGhost() {
    body.querySelectorAll('.wk-ghost').forEach(function (g) {
      g.remove();
    });
  }

  function drawGhost() {
    clearGhost();
    var sel = selection();
    var cols = body.querySelectorAll('.wk-day');
    for (var i = sel.indexes[0]; i <= sel.indexes[1]; i++) {
      if (cols[i].classList.contains('is-past')) continue;
      sel.starts.forEach(function (m) {
        cols[i].appendChild(
          h(
            'div',
            {
              class: 'wk-ghost',
              style:
                'top:' +
                (m / 1440) * 100 +
                '%;height:calc(' +
                (state.duration / 1440) * 100 +
                '% - 2px)',
            },
            M.hhmm(m)
          )
        );
      });
    }
  }

  wk.addEventListener('pointerdown', function (e) {
    var col = e.target.closest('.wk-day');
    if (!col || e.button !== 0 || col.classList.contains('is-past')) return;
    drag = { from: pointAt(e), moved: false, touch: e.pointerType === 'touch', id: e.pointerId };
    drag.to = drag.from;
    if (!drag.touch) {
      e.preventDefault();
      body.setPointerCapture(e.pointerId);
      drawGhost();
    }
  });

  wk.addEventListener('pointermove', function (e) {
    if (!drag || drag.touch || e.pointerId !== drag.id) return;
    var p = pointAt(e);
    if (p.index !== drag.to.index || p.minutes !== drag.to.minutes) {
      drag.to = p;
      drag.moved = drag.moved || p.index !== drag.from.index || p.minutes !== drag.from.minutes;
      drawGhost();
    }
  });

  wk.addEventListener('pointerup', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var sel = selection();
    drag = null;
    addRange(sel.dates, sel.starts);
  });

  // A touch that turns into a scroll is not a tap.
  wk.addEventListener('pointercancel', function () {
    drag = null;
    clearGhost();
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var before = state.days;
      fitDays();
      if (state.days !== before) render();
    }, 150);
  });

  // ── Submit ─────────────────────────────────────────────────────────────────

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formError.hidden = true;
    var problem = !form.title.value.trim()
      ? 'Give the poll a title.'
      : !state.slots.size
      ? 'Add at least one time on the calendar.'
      : null;
    if (problem) {
      formError.textContent = problem;
      formError.hidden = false;
      if (!form.title.value.trim()) form.title.focus();
      return;
    }
    var button = document.getElementById('createBtn');
    button.disabled = true;
    M.api('POST', '/api/app/polls', {
      title: form.title.value,
      description: form.description.value,
      location: form.location.value,
      durationMinutes: state.duration,
      timezone: state.tz,
      deadline: form.deadline.value ? new Date(form.deadline.value).toISOString() : null,
      hideResponses: form.hideResponses.checked,
      slots: Array.from(state.slots).map(function (ms) {
        return new Date(ms).toISOString();
      }),
    })
      .then(function (created) {
        window.location.href =
          '/app/polls/poll/?id=' + encodeURIComponent(created.id) + '&created=1';
      })
      .catch(function (err) {
        button.disabled = false;
        if (err.status === 401) return M.appError(err);
        formError.textContent = err.message;
        formError.hidden = false;
      });
  });

  // Keep the past-day boundary and the "now" line honest if left open.
  setInterval(function () {
    if (!drag) render();
  }, 5 * 60 * 1000);

  M.me.then(function () {
    setDuration(60);
  });
})();
