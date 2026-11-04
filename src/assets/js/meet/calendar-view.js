/* /app/calendar/: the calendar. Month, week, day and agenda views of the
 * calendars this member shows (the checkboxes on the left), in the time zone
 * of their browser; the card of an event, with who comes; the editor of an
 * event, along the right edge. Drag on the week or day grid to create one.
 * The API (/api/app/calendar, server/calendars.js) checks every change.
 *
 * The view and the day travel in the address (?view=week&date=2026-11-04),
 * so a link or a reload lands on the same page; ?event=…&at=… opens an
 * event's card (the reminders link there), ?new=1 the editor. */
(function () {
  'use strict';
  var M = window.Meet;
  var Cal = window.Cal;
  var h = M.h;

  var TZ = M.browserTz();
  var HOUR_PX = 48;
  var VIEWS = ['month', 'week', 'day', 'agenda'];
  var AGENDA_DAYS = 60;
  var LAST_CAL = 'ais-calendar-last';

  var body = document.getElementById('calBody');
  var titleEl = document.getElementById('calTitle');
  var listEl = document.getElementById('calList');
  var miniEl = document.getElementById('calMini');
  var card = document.getElementById('calCard');
  var editor = document.getElementById('calEditor');
  var scopeDialog = document.getElementById('calScope');

  var params = new URLSearchParams(window.location.search);
  var state = {
    view:
      VIEWS.indexOf(params.get('view')) !== -1
        ? params.get('view')
        : window.matchMedia('(max-width: 640px)').matches
        ? 'agenda'
        : 'week',
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : M.today(TZ),
    miniMonth: null,
  };
  var calendars = []; // listCalendars: the ones this member sees
  var byId = {};
  var prefs = null; // the Subscribe page's choices: which show here
  var events = [];
  var loadToken = 0;

  document.getElementById('calTz').textContent = 'Times in ' + M.tzLabel(TZ);
  document.getElementById('calPrev').appendChild(M.icon('left'));
  document.getElementById('calNext').appendChild(M.icon('right'));

  // ── Dates ───────────────────────────────────────────────────────────────

  function monthStart(date) {
    return date.slice(0, 8) + '01';
  }

  function addMonths(date, n) {
    var p = date.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    return d.toISOString().slice(0, 10);
  }

  function mondayOf(date) {
    return M.addDays(date, -M.weekday(date));
  }

  function dayLabel(date, opts) {
    return M.fmt(date + 'T12:00:00Z', 'UTC', opts);
  }

  /** The days the current view shows: [first, last] ('YYYY-MM-DD'). */
  function span() {
    if (state.view === 'month') {
      var first = mondayOf(monthStart(state.date));
      return [first, M.addDays(first, 41)];
    }
    if (state.view === 'week') {
      var monday = mondayOf(state.date);
      return [monday, M.addDays(monday, 6)];
    }
    if (state.view === 'day') return [state.date, state.date];
    return [state.date, M.addDays(state.date, AGENDA_DAYS - 1)];
  }

  function step(n) {
    if (state.view === 'month') state.date = addMonths(state.date, n);
    else if (state.view === 'week') state.date = M.addDays(state.date, 7 * n);
    else if (state.view === 'day') state.date = M.addDays(state.date, n);
    else state.date = M.addDays(state.date, AGENDA_DAYS * n);
    state.miniMonth = null;
    go();
  }

  /** The days an event covers here, and its minutes on its first and last. */
  function placeOf(ev) {
    if (ev.allDay) {
      var last = M.addDays(ev.end.slice(0, 10), -1);
      return { first: ev.start.slice(0, 10), last: last, allDay: true };
    }
    var s = M.utcToZoned(ev.start, TZ);
    var e = M.utcToZoned(ev.end, TZ);
    var lastDay = e.minutes === 0 && e.date > s.date ? M.addDays(e.date, -1) : e.date;
    var endMin = e.minutes === 0 && e.date > s.date ? 1440 : e.minutes;
    // A day or more long: shown with the all-day events.
    var long = new Date(ev.end) - new Date(ev.start) >= 86400000;
    return { first: s.date, last: lastDay, startMin: s.minutes, endMin: endMin, allDay: long };
  }

  function on(ev, date) {
    var p = ev._place;
    return date >= p.first && date <= p.last;
  }

  function colorOf(ev) {
    var c = byId[ev.calendarId];
    return (c && c.color) || '#00703a';
  }

  function timeRange(ev) {
    if (ev.allDay) return 'All day';
    return M.fmtTime(ev.start, TZ) + '–' + M.fmtTime(ev.end, TZ);
  }

  /** "Tuesday 4 November, 18:30–20:00", or the days of an all-day one. */
  function whenText(ev) {
    var p = ev._place || placeOf(ev);
    if (ev.allDay) {
      var a = dayLabel(p.first, { weekday: 'long', day: 'numeric', month: 'long' });
      return p.first === p.last
        ? a + ' · all day'
        : a + ' – ' + dayLabel(p.last, { weekday: 'long', day: 'numeric', month: 'long' });
    }
    if (p.first !== p.last) return M.fmtDateTime(ev.start, TZ) + ' – ' + M.fmtDateTime(ev.end, TZ);
    return M.fmtDay(ev.start, TZ) + ', ' + timeRange(ev);
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  function syncUrl() {
    var q = new URLSearchParams(window.location.search);
    q.set('view', state.view);
    q.set('date', state.date);
    ['new', 'event', 'at'].forEach(function (k) {
      q.delete(k);
    });
    window.history.replaceState(null, '', window.location.pathname + '?' + q.toString());
  }

  function go() {
    syncUrl();
    drawTitle();
    drawViews();
    drawMini();
    var token = ++loadToken;
    var s = span();
    var from = new Date(M.zonedToUtc(M.addDays(s[0], -1), 0, TZ)).toISOString();
    var to = new Date(M.zonedToUtc(M.addDays(s[1], 2), 0, TZ)).toISOString();
    if (!events.length) M.clear(body).appendChild(M.loading());
    return M.api(
      'GET',
      Cal.API + '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)
    )
      .then(function (data) {
        if (token !== loadToken) return;
        events = data.events.map(function (ev) {
          ev._place = placeOf(ev);
          return ev;
        });
        draw();
      })
      .catch(function (err) {
        if (token !== loadToken) return;
        M.clear(body).appendChild(h('div', { class: 'empty-state' }, h('p', null, err.message)));
        M.appError(err);
      });
  }

  function draw() {
    M.clear(body);
    body.className = 'cal-body is-' + state.view;
    if (state.view === 'month') body.appendChild(monthView());
    else if (state.view === 'agenda') body.appendChild(agendaView());
    else body.appendChild(gridView(state.view === 'week' ? 7 : 1));
  }

  function drawTitle() {
    var s = span();
    var text;
    if (state.view === 'month')
      text = dayLabel(monthStart(state.date), { month: 'long', year: 'numeric' });
    else if (state.view === 'day')
      text = dayLabel(state.date, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    else {
      var sameMonth = s[0].slice(0, 7) === s[1].slice(0, 7);
      text =
        dayLabel(s[0], sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' }) +
        ' – ' +
        dayLabel(s[1], { day: 'numeric', month: 'short', year: 'numeric' });
    }
    titleEl.textContent = text;
  }

  function drawViews() {
    document.querySelectorAll('.cal-views [data-view]').forEach(function (b) {
      var current = b.getAttribute('data-view') === state.view;
      b.setAttribute('aria-selected', current ? 'true' : 'false');
      b.classList.toggle('is-current', current);
    });
  }

  // ── Sidebar: the small month and the calendars ─────────────────────────

  function drawMini() {
    var month = state.miniMonth || monthStart(state.date);
    var first = mondayOf(month);
    var today = M.today(TZ);
    var s = span();
    var grid = h('div', { class: 'cal-mini-grid', role: 'grid' });
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (d) {
      grid.appendChild(h('span', { class: 'cal-mini-dow', 'aria-hidden': 'true' }, d));
    });
    for (var i = 0; i < 42; i++) {
      (function (date) {
        var inRange =
          state.view !== 'agenda' && state.view !== 'month' && date >= s[0] && date <= s[1];
        grid.appendChild(
          h(
            'button',
            {
              type: 'button',
              class:
                'cal-mini-day' +
                (date.slice(0, 7) !== month.slice(0, 7) ? ' is-out' : '') +
                (date === today ? ' is-today' : '') +
                (date === state.date ? ' is-selected' : '') +
                (inRange ? ' is-range' : ''),
              'aria-label': dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' }),
              onclick: function () {
                state.date = date;
                state.miniMonth = null;
                go();
              },
            },
            String(Number(date.slice(8)))
          )
        );
      })(M.addDays(first, i));
    }
    M.clear(miniEl).appendChild(
      h(
        'div',
        { class: 'cal-mini-head' },
        h('span', null, dayLabel(month, { month: 'long', year: 'numeric' })),
        h(
          'span',
          { class: 'cal-mini-nav' },
          h(
            'button',
            {
              type: 'button',
              'aria-label': 'Previous month',
              onclick: function () {
                state.miniMonth = addMonths(month, -1);
                drawMini();
              },
            },
            M.icon('left')
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': 'Next month',
              onclick: function () {
                state.miniMonth = addMonths(month, 1);
                drawMini();
              },
            },
            M.icon('right')
          )
        )
      )
    );
    miniEl.appendChild(grid);
  }

  function drawList() {
    M.clear(listEl);
    var list = (prefs && prefs.calendars) || [];
    if (!list.length) {
      listEl.appendChild(h('p', { class: 'form-note' }, 'No calendar is shared with you yet.'));
      return;
    }
    list.forEach(function (c) {
      var input = h('input', { type: 'checkbox', class: 'cal-check-input' });
      input.checked = c.choice.dashboard;
      input.style.setProperty('--cal-color', c.color);
      input.addEventListener('change', function () {
        input.disabled = true;
        M.api('POST', Cal.API + '?action=show&id=' + encodeURIComponent(c.id), {
          on: input.checked,
        })
          .then(function () {
            c.choice.dashboard = input.checked;
            return go();
          })
          .catch(function (err) {
            input.checked = !input.checked;
            M.appError(err);
          })
          .then(function () {
            input.disabled = false;
          });
      });
      listEl.appendChild(
        h(
          'label',
          { class: 'cal-check' },
          input,
          h('span', { class: 'cal-check-name' }, c.name),
          c.level === 'view' || c.level === 'public' ? null : Cal.levelBadge(c.level)
        )
      );
    });
  }

  // ── Month ───────────────────────────────────────────────────────────────

  function chip(ev, opts) {
    var o = opts || {};
    var p = ev._place;
    var timed = !p.allDay;
    return h(
      'button',
      {
        type: 'button',
        class: 'cal-chip-ev' + (timed ? ' is-timed' : ' is-allday'),
        style: '--cal-color:' + colorOf(ev),
        title: ev.title + ' · ' + timeRange(ev),
        onclick: function (e) {
          e.stopPropagation();
          openCard(ev);
        },
      },
      timed ? h('span', { class: 'cal-chip-dot', 'aria-hidden': 'true' }) : null,
      timed && !o.noTime ? h('span', { class: 'cal-chip-time' }, M.fmtTime(ev.start, TZ)) : null,
      h('span', { class: 'cal-chip-title' }, ev.title)
    );
  }

  function sortDay(list) {
    return list.slice().sort(function (a, b) {
      if (a._place.allDay !== b._place.allDay) return a._place.allDay ? -1 : 1;
      return new Date(a.start) - new Date(b.start);
    });
  }

  function monthView() {
    var first = mondayOf(monthStart(state.date));
    var month = state.date.slice(0, 7);
    var today = M.today(TZ);
    var max = window.matchMedia('(max-width: 640px)').matches ? 2 : 3;
    var grid = h('div', { class: 'cal-month', role: 'grid' });
    var head = h('div', { class: 'cal-month-head', role: 'row' });
    for (var d = 0; d < 7; d++) {
      head.appendChild(
        h('span', { role: 'columnheader' }, dayLabel(M.addDays(first, d), { weekday: 'short' }))
      );
    }
    grid.appendChild(head);
    var weeks = h('div', { class: 'cal-month-weeks' });
    for (var i = 0; i < 42; i++) {
      (function (date) {
        var mine = sortDay(
          events.filter(function (ev) {
            return on(ev, date);
          })
        );
        var cell = h(
          'div',
          {
            class:
              'cal-month-day' +
              (date.slice(0, 7) !== month ? ' is-out' : '') +
              (date === today ? ' is-today' : '') +
              (M.weekday(date) >= 5 ? ' is-weekend' : ''),
            role: 'gridcell',
            onclick: function () {
              newEvent({ date: date, startMin: 9 * 60, endMin: 10 * 60 });
            },
          },
          h(
            'button',
            {
              type: 'button',
              class: 'cal-month-num',
              'aria-label': dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' }),
              onclick: function (e) {
                e.stopPropagation();
                state.date = date;
                state.view = 'day';
                go();
              },
            },
            String(Number(date.slice(8)))
          )
        );
        var list = h('div', { class: 'cal-month-list' });
        mine.slice(0, mine.length > max ? max - 1 : max).forEach(function (ev) {
          list.appendChild(chip(ev));
        });
        if (mine.length > max) {
          list.appendChild(
            h(
              'button',
              {
                type: 'button',
                class: 'cal-more',
                onclick: function (e) {
                  e.stopPropagation();
                  state.date = date;
                  state.view = 'day';
                  go();
                },
              },
              '+' + (mine.length - max + 1) + ' more'
            )
          );
        }
        cell.appendChild(list);
        weeks.appendChild(cell);
      })(M.addDays(first, i));
    }
    grid.appendChild(weeks);
    return grid;
  }

  // ── Week and day ────────────────────────────────────────────────────────

  /** Side-by-side columns for overlapping events: sets _col and _cols. */
  function layout(items) {
    items.sort(function (a, b) {
      return a.startMin - b.startMin || b.endMin - a.endMin;
    });
    var cluster = [];
    var clusterEnd = -1;
    function close() {
      var cols = 0;
      cluster.forEach(function (it) {
        cols = Math.max(cols, it._col + 1);
      });
      cluster.forEach(function (it) {
        it._cols = cols;
      });
      cluster = [];
    }
    var columns = [];
    items.forEach(function (it) {
      if (it.startMin >= clusterEnd) {
        close();
        columns = [];
        clusterEnd = -1;
      }
      var c = 0;
      while (columns[c] !== undefined && columns[c] > it.startMin) c++;
      columns[c] = Math.max(it.endMin, it.startMin + 20);
      it._col = c;
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, columns[c]);
    });
    close();
    return items;
  }

  function gridView(days) {
    var first = days === 7 ? mondayOf(state.date) : state.date;
    var dates = [];
    for (var i = 0; i < days; i++) dates.push(M.addDays(first, i));
    var today = M.today(TZ);
    var wrap = h('div', {
      class: 'cal-grid',
      style: '--cal-days:' + days + ';--cal-hour:' + HOUR_PX + 'px',
    });

    // The day names, and the row of all-day events.
    var head = h('div', { class: 'cal-grid-head' }, h('span', { class: 'cal-gutter' }));
    var allRow = h(
      'div',
      { class: 'cal-grid-allday' },
      h('span', { class: 'cal-gutter' }, 'all day')
    );
    dates.forEach(function (date) {
      head.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'cal-grid-day' + (date === today ? ' is-today' : ''),
            onclick: function () {
              state.date = date;
              state.view = 'day';
              go();
            },
          },
          h('span', { class: 'cal-grid-dow' }, dayLabel(date, { weekday: 'short' })),
          h('span', { class: 'cal-grid-num' }, String(Number(date.slice(8))))
        )
      );
      var cell = h('div', { class: 'cal-allday-cell' });
      events
        .filter(function (ev) {
          return ev._place.allDay && on(ev, date);
        })
        .forEach(function (ev) {
          cell.appendChild(chip(ev, { noTime: true }));
        });
      allRow.appendChild(cell);
    });
    wrap.appendChild(head);
    wrap.appendChild(allRow);

    // The hours.
    var scroller = h('div', { class: 'cal-grid-scroll' });
    var hours = h('div', { class: 'cal-grid-hours' });
    var gutter = h('div', { class: 'cal-gutter cal-hour-labels' });
    for (var hr = 0; hr < 24; hr++) {
      gutter.appendChild(
        h('span', { style: 'top:' + hr * HOUR_PX + 'px' }, hr ? M.hhmm(hr * 60) : '')
      );
    }
    hours.appendChild(gutter);
    dates.forEach(function (date) {
      hours.appendChild(dayColumn(date, date === today));
    });
    scroller.appendChild(hours);
    wrap.appendChild(scroller);
    // Start the day at 8:00, or at the first event before then.
    requestAnimationFrame(function () {
      var earliest = 8 * 60;
      events.forEach(function (ev) {
        if (!ev._place.allDay && dates.indexOf(ev._place.first) !== -1)
          earliest = Math.min(earliest, ev._place.startMin);
      });
      scroller.scrollTop = Math.max(0, (earliest / 60) * HOUR_PX - 12);
    });
    return wrap;
  }

  function dayColumn(date, isToday) {
    var col = h('div', {
      class: 'cal-col' + (isToday ? ' is-today' : '') + (M.weekday(date) >= 5 ? ' is-weekend' : ''),
      'data-date': date,
    });
    var items = events
      .filter(function (ev) {
        return !ev._place.allDay && on(ev, date);
      })
      .map(function (ev) {
        var p = ev._place;
        return {
          ev: ev,
          startMin: date === p.first ? p.startMin : 0,
          endMin: date === p.last ? p.endMin : 1440,
        };
      });
    layout(items).forEach(function (it) {
      var top = (it.startMin / 60) * HOUR_PX;
      var height = Math.max(18, ((it.endMin - it.startMin) / 60) * HOUR_PX - 2);
      var short = height < 34;
      col.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'cal-block' + (short ? ' is-short' : ''),
            style:
              '--cal-color:' +
              colorOf(it.ev) +
              ';top:' +
              top +
              'px;height:' +
              height +
              'px;left:calc(' +
              (it._col / it._cols) * 100 +
              '% + 2px);width:calc(' +
              100 / it._cols +
              '% - 4px)',
            title: it.ev.title + ' · ' + timeRange(it.ev),
            onclick: function (e) {
              e.stopPropagation();
              openCard(it.ev);
            },
          },
          h('span', { class: 'cal-block-title' }, it.ev.title),
          h(
            'span',
            { class: 'cal-block-time' },
            timeRange(it.ev) + (it.ev.recurring ? ' ' : ''),
            it.ev.recurring ? M.icon('repeat') : null,
            it.ev.video
              ? h(
                  'span',
                  { class: 'cal-block-video', 'aria-label': 'with a video call' },
                  ' · call'
                )
              : null
          )
        )
      );
    });
    if (isToday) col.appendChild(nowLine());
    dragToCreate(col, date);
    return col;
  }

  function nowLine() {
    var line = h('div', { class: 'cal-now', 'aria-hidden': 'true' });
    function place() {
      var now = M.utcToZoned(new Date().toISOString(), TZ);
      line.style.top = (now.minutes / 60) * HOUR_PX + 'px';
    }
    place();
    var timer = setInterval(function () {
      if (!line.isConnected) clearInterval(timer);
      else place();
    }, 60000);
    return line;
  }

  /** Click or drag on an empty part of a day: a new event at that time. */
  function dragToCreate(col, date) {
    var ghost = null;
    var startMin = 0;
    var canCreate = writable().length > 0;
    if (!canCreate) return;
    function minuteAt(e) {
      var rect = col.getBoundingClientRect();
      var m = ((e.clientY - rect.top) / HOUR_PX) * 60;
      return Math.max(0, Math.min(1440, Math.round(m / 15) * 15));
    }
    function draw(a, b) {
      var lo = Math.min(a, b);
      var hi = Math.max(a, b, lo + 15);
      ghost.style.top = (lo / 60) * HOUR_PX + 'px';
      ghost.style.height = ((hi - lo) / 60) * HOUR_PX + 'px';
      ghost.textContent = M.hhmm(lo) + '–' + M.hhmm(hi);
    }
    col.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target !== col) return;
      e.preventDefault();
      startMin = Math.floor(minuteAt(e) / 30) * 30;
      ghost = h('div', { class: 'cal-ghost' });
      col.appendChild(ghost);
      draw(startMin, startMin + 30);
      col.setPointerCapture(e.pointerId);
    });
    col.addEventListener('pointermove', function (e) {
      if (!ghost) return;
      draw(startMin, minuteAt(e));
    });
    function finish(e) {
      if (!ghost) return;
      var end = minuteAt(e);
      var lo = Math.min(startMin, end);
      var hi = Math.max(startMin, end);
      if (hi - lo < 30) hi = Math.min(1440, lo + 60);
      ghost.remove();
      ghost = null;
      newEvent({ date: date, startMin: lo, endMin: hi });
    }
    col.addEventListener('pointerup', finish);
    col.addEventListener('pointercancel', function () {
      if (ghost) ghost.remove();
      ghost = null;
    });
  }

  // ── Agenda ──────────────────────────────────────────────────────────────

  function agendaView() {
    var s = span();
    var today = M.today(TZ);
    var wrap = h('div', { class: 'cal-agenda' });
    var any = false;
    for (var date = s[0]; date <= s[1]; date = M.addDays(date, 1)) {
      var mine = sortDay(
        events.filter(function (ev) {
          return on(ev, date);
        })
      );
      if (!mine.length) continue;
      any = true;
      var day = h(
        'section',
        { class: 'cal-agenda-day' + (date === today ? ' is-today' : '') },
        h(
          'h3',
          { class: 'cal-agenda-date' },
          h('span', { class: 'cal-agenda-num' }, String(Number(date.slice(8)))),
          h(
            'span',
            null,
            h('strong', null, dayLabel(date, { weekday: 'long' })),
            h('small', null, dayLabel(date, { month: 'long', year: 'numeric' }))
          ),
          date === today ? h('span', { class: 'cal-today-pill' }, 'Today') : null
        )
      );
      var list = h('ul', { class: 'cal-agenda-list' });
      mine.forEach(function (ev) {
        var cal = byId[ev.calendarId];
        list.appendChild(
          h(
            'li',
            null,
            h(
              'button',
              {
                type: 'button',
                class: 'cal-agenda-item',
                style: '--cal-color:' + colorOf(ev),
                onclick: function () {
                  openCard(ev);
                },
              },
              h('span', { class: 'cal-agenda-time' }, ev._place.allDay ? 'All day' : timeRange(ev)),
              h('span', { class: 'cal-agenda-bar', 'aria-hidden': 'true' }),
              h(
                'span',
                { class: 'cal-agenda-main' },
                h('strong', null, ev.title),
                h(
                  'small',
                  null,
                  [
                    cal ? cal.name : null,
                    ev.location || null,
                    ev.video ? Cal.platform(ev.video.url) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                )
              ),
              ev.recurring
                ? h('span', { class: 'cal-agenda-repeat', title: 'Repeats' }, M.icon('repeat'))
                : null
            )
          )
        );
      });
      day.appendChild(list);
      wrap.appendChild(day);
    }
    if (!any) {
      wrap.appendChild(
        h(
          'div',
          { class: 'empty-state cal-empty' },
          Cal.svg(
            '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'
          ),
          h('h3', null, 'Nothing in the next ' + AGENDA_DAYS + ' days'),
          h(
            'p',
            null,
            writable().length
              ? 'Create an event, or show more calendars on the left.'
              : 'Show more calendars on the left, or ask a team to share theirs.'
          )
        )
      );
    }
    wrap.appendChild(
      h(
        'div',
        { class: 'cal-agenda-more' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              step(1);
            },
          },
          'The next ' + AGENDA_DAYS + ' days'
        )
      )
    );
    return wrap;
  }

  // ── The card of an event ────────────────────────────────────────────────

  function rsvpBox(detail) {
    var labels = { yes: 'Going', maybe: 'Maybe', no: 'Can’t go' };
    var box = h('div', { class: 'cal-rsvp' });
    if (!detail.canAnswer) return null;
    var buttons = h('div', {
      class: 'cal-rsvp-buttons',
      role: 'group',
      'aria-label': 'Are you coming?',
    });
    ['yes', 'maybe', 'no'].forEach(function (a) {
      var mine = detail.rsvp.mine === a;
      buttons.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'cal-rsvp-btn is-' + a + (mine ? ' is-on' : ''),
            'aria-pressed': mine ? 'true' : 'false',
            onclick: function (e) {
              e.currentTarget.disabled = true;
              M.api(
                'POST',
                Cal.API +
                  '?action=rsvp&id=' +
                  encodeURIComponent(detail.id) +
                  '&at=' +
                  encodeURIComponent(detail.occurrence),
                { answer: mine ? null : a }
              )
                .then(function (fresh) {
                  drawCard(fresh, true);
                  M.toast(mine ? 'Answer taken back' : 'Answer saved: ' + labels[a].toLowerCase());
                })
                .catch(M.appError);
            },
          },
          labels[a],
          detail.rsvp.counts[a]
            ? h('span', { class: 'cal-rsvp-n' }, String(detail.rsvp.counts[a]))
            : null
        )
      );
    });
    box.appendChild(h('p', { class: 'cal-card-label' }, 'Are you coming?'));
    box.appendChild(buttons);
    var coming = detail.rsvp.people.filter(function (p) {
      return p.answer !== 'no';
    });
    if (coming.length) {
      box.appendChild(
        M.accessFaces(
          coming.map(function (p) {
            return {
              kind: 'person',
              name: p.name,
              avatarUrl: p.avatarUrl,
              what: p.answer === 'yes' ? 'Going' : 'Maybe',
            };
          })
        )
      );
    }
    return box;
  }

  function openCard(ev) {
    drawCard(ev, false);
    if (!card.open) card.showModal();
    M.api(
      'GET',
      Cal.API + '?event=' + encodeURIComponent(ev.id) + '&at=' + encodeURIComponent(ev.occurrence)
    )
      .then(function (detail) {
        if (card.open) drawCard(detail, true);
      })
      .catch(function (err) {
        card.close();
        M.appError(err);
      });
  }

  function row(iconName, content) {
    return h(
      'div',
      { class: 'cal-card-row' },
      h('span', { class: 'cal-card-ico' }, iconName),
      content
    );
  }

  function drawCard(ev, full) {
    ev._place = ev._place || placeOf(ev);
    var cal = byId[ev.calendarId] || ev.calendar || {};
    var closeBtn = h('button', {
      type: 'button',
      class: 'ap-icon-button',
      'aria-label': 'Close',
      onclick: function () {
        card.close();
      },
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    });
    var actions = h('div', { class: 'cal-card-actions' });
    if (full && ev.canEdit) {
      actions.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              card.close();
              editEvent(ev);
            },
          },
          'Edit'
        )
      );
      actions.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              removeEvent(ev);
            },
          },
          'Delete'
        )
      );
    }
    if (full && ev.source) {
      actions.appendChild(
        h('a', { class: 'btn btn-outline btn-sm', href: ev.source.url }, ev.source.label)
      );
    }
    var reminders =
      full && ev.reminders && ev.reminders.length
        ? ev.reminders
            .map(function (r) {
              return Cal.leadLabel(r.minutes).toLowerCase();
            })
            .join(', ')
        : '';
    M.clear(card).appendChild(
      h(
        'div',
        { class: 'cal-card-inner', style: '--cal-color:' + (cal.color || colorOf(ev)) },
        h(
          'div',
          { class: 'cal-card-head' },
          h('span', { class: 'cal-card-swatch', 'aria-hidden': 'true' }),
          h(
            'div',
            { class: 'cal-card-heading' },
            h('h2', { id: 'calCardTitle' }, ev.title),
            h('p', { class: 'cal-card-when' }, whenText(ev)),
            ev.recurring && ev.recurrence
              ? h(
                  'p',
                  { class: 'cal-card-repeat' },
                  M.icon('repeat'),
                  ' ',
                  M.recurrenceText(ev.recurrence, ev.start, ev.timezone)
                )
              : ev.changedAlone
              ? h(
                  'p',
                  { class: 'cal-card-repeat' },
                  M.icon('repeat'),
                  ' Changed on its own, from a repeating event'
                )
              : null
          ),
          closeBtn
        ),
        h(
          'div',
          { class: 'cal-card-body' },
          ev.video ? h('div', { class: 'cal-card-join' }, Cal.joinButton(ev.video)) : null,
          ev.location ? row(M.icon('pin'), h('span', null, ev.location)) : null,
          row(
            h('span', { class: 'cal-dot', style: 'background:' + (cal.color || colorOf(ev)) }),
            h(
              'span',
              null,
              cal.name || '',
              full && ev.createdBy ? h('small', null, ' · by ' + ev.createdBy) : null
            )
          ),
          reminders ? row(M.icon('clock'), h('span', null, 'Reminders ' + reminders)) : null,
          ev.description ? h('div', { class: 'cal-card-desc' }, M.linkify(ev.description)) : null,
          full ? rsvpBox(ev) : h('div', { class: 'cal-card-loading' }, M.loading())
        ),
        actions.childNodes.length ? actions : null
      )
    );
  }

  card.addEventListener('click', function (e) {
    // A click on the backdrop closes it.
    if (e.target === card) card.close();
  });

  // ── Scope of a change to a repeating event ──────────────────────────────

  function askScope(title, verb) {
    return new Promise(function (resolve) {
      document.getElementById('calScopeTitle').textContent = title;
      document.getElementById('calScopeOk').textContent = verb;
      scopeDialog.querySelector('input[value="this"]').checked = true;
      scopeDialog.onclose = function () {
        scopeDialog.onclose = null;
        if (scopeDialog.returnValue !== 'ok') return resolve(null);
        resolve(scopeDialog.querySelector('input[name="scope"]:checked').value);
      };
      scopeDialog.returnValue = '';
      scopeDialog.showModal();
    });
  }

  function removeEvent(ev) {
    var ask = ev.recurring
      ? askScope('Delete a repeating event', 'Delete')
      : Promise.resolve(window.confirm('Delete “' + ev.title + '”?') ? 'all' : null);
    ask.then(function (scope) {
      if (!scope) return;
      M.api(
        'POST',
        Cal.API +
          '?action=delete-event&id=' +
          encodeURIComponent(ev.id) +
          '&scope=' +
          scope +
          '&at=' +
          encodeURIComponent(ev.occurrence),
        {}
      )
        .then(function () {
          if (card.open) card.close();
          if (editor.open) editor.close();
          M.toast('Event deleted');
          go();
        })
        .catch(M.appError);
    });
  }

  // ── The editor ──────────────────────────────────────────────────────────

  var form = document.getElementById('calForm');
  var f = {
    title: document.getElementById('evTitle'),
    calendar: document.getElementById('evCalendar'),
    dot: document.getElementById('evCalendarDot'),
    allDay: document.getElementById('evAllDay'),
    startDate: document.getElementById('evStartDate'),
    startTime: document.getElementById('evStartTime'),
    endDate: document.getElementById('evEndDate'),
    endTime: document.getElementById('evEndTime'),
    tz: document.getElementById('evTz'),
    tzRow: document.getElementById('evTzRow'),
    location: document.getElementById('evLocation'),
    videoUrl: document.getElementById('evVideoUrl'),
    voice: document.getElementById('evVoice'),
    platform: document.getElementById('evPlatform'),
    description: document.getElementById('evDescription'),
    reminders: document.getElementById('evReminders'),
    announceOwn: document.getElementById('evAnnounceOwn'),
    announceInherit: document.getElementById('evAnnounceInherit'),
    error: document.getElementById('evError'),
    del: document.getElementById('evDelete'),
    save: document.getElementById('evSave'),
  };
  var repeat = M.recurrenceFields('ev');
  var editing = null; // the occurrence being changed, null for a new event
  var reminderList = [];
  var announce = null;
  var dirty = false;

  function writable() {
    return calendars.filter(function (c) {
      return c.canEdit && !c.archived;
    });
  }

  var ZONES = [
    'Europe/Rome',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Lisbon',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Australia/Sydney',
    'UTC',
  ];

  function fillZones(current) {
    var list = ZONES.slice();
    [TZ, current].forEach(function (z) {
      if (z && list.indexOf(z) === -1) list.unshift(z);
    });
    M.clear(f.tz);
    list.forEach(function (z) {
      f.tz.appendChild(h('option', { value: z }, M.tzLabel(z)));
    });
    f.tz.value = current || TZ;
  }

  function fillCalendars(current) {
    M.clear(f.calendar);
    var list = writable();
    var source = byId[current];
    // Editing an event of a calendar one no longer edits: it stays listed.
    if (source && list.indexOf(source) === -1) list = [source].concat(list);
    list.forEach(function (c) {
      f.calendar.appendChild(h('option', { value: c.id }, c.name));
    });
    var last = null;
    try {
      last = window.localStorage.getItem(LAST_CAL);
    } catch (e) {
      /* no storage: the first calendar */
    }
    f.calendar.value =
      current ||
      (list.some(function (c) {
        return c.id === last;
      })
        ? last
        : list[0] && list[0].id);
    calendarChanged();
  }

  function calendarChanged() {
    var c = byId[f.calendar.value];
    f.dot.style.background = c ? c.color : 'transparent';
    f.announceInherit.textContent =
      'As the calendar' + (c ? ' (' + Cal.announceSummary(c.announce) + ')' : '');
  }
  f.calendar.addEventListener('change', calendarChanged);

  function videoMode() {
    var checked = form.querySelector('input[name="evVideo"]:checked');
    return checked ? checked.value : '';
  }

  function setVideoMode(mode) {
    form.querySelector('input[name="evVideo"][value="' + (mode || '') + '"]').checked = true;
    document.getElementById('evVideoLink').hidden = mode !== 'link';
    document.getElementById('evVideoDiscord').hidden = mode !== 'discord';
    if (mode === 'discord') fillVoice(f.voice.value);
  }
  form.querySelectorAll('input[name="evVideo"]').forEach(function (r) {
    r.addEventListener('change', function () {
      setVideoMode(videoMode());
    });
  });
  f.videoUrl.addEventListener('input', function () {
    var p = Cal.platform(f.videoUrl.value);
    f.platform.textContent = p ? p + ' link' : '';
  });

  function fillVoice(current, name) {
    Cal.channels()
      .then(function (c) {
        M.clear(f.voice);
        var list = c.voice.slice();
        if (
          current &&
          !list.some(function (v) {
            return v.id === current;
          })
        )
          list.unshift({ id: current, name: name || current });
        if (!list.length) f.voice.appendChild(h('option', { value: '' }, 'No voice channel found'));
        Cal.channelOptions(f.voice, list, current, '🔊 ');
        if (current) f.voice.value = current;
      })
      .catch(function () {
        M.clear(f.voice).appendChild(h('option', { value: '' }, 'Discord did not answer'));
      });
  }

  function announceMode() {
    return form.querySelector('input[name="evAnnounce"]:checked').value;
  }
  function setAnnounceMode(mode) {
    form.querySelector('input[name="evAnnounce"][value="' + mode + '"]').checked = true;
    f.announceOwn.hidden = mode !== 'own';
  }
  form.querySelectorAll('input[name="evAnnounce"]').forEach(function (r) {
    r.addEventListener('change', function () {
      setAnnounceMode(announceMode());
      if (announceMode() === 'own' && !announce.get().length) announce.add();
    });
  });
  document.getElementById('evAddChannel').addEventListener('click', function () {
    announce.add();
  });

  function drawReminders() {
    M.clear(f.reminders);
    if (!reminderList.length) {
      f.reminders.appendChild(h('p', { class: 'cal-rows-none' }, 'No reminder.'));
    }
    reminderList.forEach(function (r) {
      var select = h('select', { class: 'form-input is-compact', 'aria-label': 'When' });
      Cal.LEAD_TIMES.forEach(function (m) {
        var o = h('option', { value: String(m) }, Cal.leadLabel(m));
        if (m === r.minutes) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener('change', function () {
        r.minutes = Number(select.value);
        dirty = true;
      });
      var toggles = h('div', { class: 'cal-leads' });
      [
        ['discord', 'Discord'],
        ['email', 'Email'],
      ].forEach(function (c) {
        var onNow = r.channels.indexOf(c[0]) !== -1;
        toggles.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'cal-lead' + (onNow ? ' is-on' : ''),
              'aria-pressed': onNow ? 'true' : 'false',
              onclick: function () {
                var i = r.channels.indexOf(c[0]);
                if (i === -1) r.channels.push(c[0]);
                else if (r.channels.length > 1) r.channels.splice(i, 1);
                dirty = true;
                drawReminders();
              },
            },
            c[1]
          )
        );
      });
      f.reminders.appendChild(
        h(
          'div',
          { class: 'cal-row' },
          h('div', { class: 'cal-row-main' }, select, toggles),
          h(
            'button',
            {
              type: 'button',
              class: 'cal-row-x',
              'aria-label': 'Remove this reminder',
              onclick: function () {
                reminderList.splice(reminderList.indexOf(r), 1);
                dirty = true;
                drawReminders();
              },
            },
            '×'
          )
        )
      );
    });
  }
  document.getElementById('evAddReminder').addEventListener('click', function () {
    if (reminderList.length >= 4) return M.toast('At most 4 reminders', true);
    var used = reminderList.map(function (r) {
      return r.minutes;
    });
    var next = [1440, 60, 15, 10080, 0].find(function (m) {
      return used.indexOf(m) === -1;
    });
    reminderList.push({ minutes: next === undefined ? 30 : next, channels: ['discord'] });
    dirty = true;
    drawReminders();
  });

  function setAllDay(allDay) {
    f.allDay.checked = allDay;
    f.startTime.hidden = allDay;
    f.endTime.hidden = allDay;
    f.tzRow.hidden = allDay;
  }
  f.allDay.addEventListener('change', function () {
    setAllDay(f.allDay.checked);
  });

  // Moving the start keeps the length; an end before the start follows it.
  var lengthMin = 60;
  function startMs() {
    return M.zonedToUtc(f.startDate.value, minutesOf(f.startTime.value), f.tz.value);
  }
  function endMs() {
    return M.zonedToUtc(f.endDate.value, minutesOf(f.endTime.value), f.tz.value);
  }
  function minutesOf(hm) {
    var p = String(hm || '00:00')
      .split(':')
      .map(Number);
    return p[0] * 60 + (p[1] || 0);
  }
  function rememberLength() {
    if (!f.startDate.value || !f.endDate.value) return;
    var len = (endMs() - startMs()) / 60000;
    if (len > 0) lengthMin = len;
  }
  function followStart() {
    if (!f.startDate.value) return;
    if (f.allDay.checked) {
      if (!f.endDate.value || f.endDate.value < f.startDate.value)
        f.endDate.value = f.startDate.value;
      return;
    }
    var end = M.utcToZoned(new Date(startMs() + lengthMin * 60000).toISOString(), f.tz.value);
    f.endDate.value = end.date;
    f.endTime.value = M.hhmm(end.minutes);
  }
  [f.endDate, f.endTime].forEach(function (el) {
    el.addEventListener('change', rememberLength);
  });
  [f.startDate, f.startTime].forEach(function (el) {
    el.addEventListener('change', followStart);
  });

  function showError(message) {
    f.error.textContent = message;
    f.error.hidden = !message;
  }

  /** Opens the editor: `occ` an occurrence to change (with its details), else `preset`. */
  function openEditor(occ, preset) {
    editing = occ;
    dirty = false;
    showError('');
    document.getElementById('calEditorTitle').textContent = occ ? 'Edit event' : 'New event';
    f.del.hidden = !occ;
    var tz = occ ? (occ.allDay ? TZ : occ.timezone || TZ) : TZ;
    fillZones(tz);
    fillCalendars(occ ? occ.calendarId : null);
    f.title.value = occ ? occ.title : '';
    f.location.value = occ ? occ.location || '' : '';
    f.description.value = occ ? occ.description || '' : '';
    var allDay = occ ? occ.allDay : Boolean(preset && preset.allDay);
    setAllDay(allDay);
    if (occ) {
      if (occ.allDay) {
        f.startDate.value = occ.start.slice(0, 10);
        f.endDate.value = M.addDays(occ.end.slice(0, 10), -1);
        f.startTime.value = '09:00';
        f.endTime.value = '10:00';
      } else {
        var s = M.utcToZoned(occ.start, tz);
        var e = M.utcToZoned(occ.end, tz);
        f.startDate.value = s.date;
        f.startTime.value = M.hhmm(s.minutes);
        f.endDate.value = e.date;
        f.endTime.value = M.hhmm(e.minutes);
      }
    } else {
      var p = preset || {};
      var date = p.date || state.date;
      var startMin = p.startMin === undefined ? nextHalfHour(date) : p.startMin;
      var endMin = p.endMin === undefined ? startMin + 60 : p.endMin;
      f.startDate.value = date;
      f.startTime.value = M.hhmm(Math.min(startMin, 1435));
      f.endDate.value = endMin >= 1440 ? M.addDays(date, 1) : date;
      f.endTime.value = M.hhmm(endMin % 1440);
    }
    rememberLength();
    repeat.set(occ && occ.recurring ? occ.recurrence : null);
    var video = occ && occ.video;
    f.videoUrl.value = video && video.kind === 'link' ? video.url : '';
    f.platform.textContent =
      video && video.kind === 'link' ? Cal.platform(video.url) + ' link' : '';
    if (video && video.kind === 'discord') fillVoice(video.channelId, video.name);
    setVideoMode(video ? video.kind : '');
    reminderList = ((occ && occ.reminders) || []).map(function (r) {
      return { minutes: r.minutes, channels: r.channels.slice() };
    });
    drawReminders();
    var own = occ ? occ.announce : null;
    announce = Cal.announceRows({
      value: own || [],
      onChange: function () {
        dirty = true;
      },
    });
    M.clear(document.getElementById('evAnnounceList')).appendChild(announce.el);
    setAnnounceMode(own === null || own === undefined ? 'inherit' : own.length ? 'own' : 'none');
    if (!editor.open) editor.showModal();
    setTimeout(function () {
      if (!occ) f.title.focus();
    }, 30);
  }

  function nextHalfHour(date) {
    if (date !== M.today(TZ)) return 9 * 60;
    var now = M.utcToZoned(new Date().toISOString(), TZ).minutes;
    return Math.min(23 * 60, Math.ceil((now + 1) / 30) * 30);
  }

  function newEvent(preset) {
    if (!writable().length) return;
    openEditor(null, preset);
  }

  function editEvent(ev) {
    var go2 = ev.reminders
      ? Promise.resolve(ev)
      : M.api(
          'GET',
          Cal.API +
            '?event=' +
            encodeURIComponent(ev.id) +
            '&at=' +
            encodeURIComponent(ev.occurrence)
        );
    go2
      .then(function (detail) {
        openEditor(detail);
      })
      .catch(M.appError);
  }

  function bodyOf() {
    var mode = videoMode();
    var b = {
      calendarId: f.calendar.value,
      title: f.title.value,
      description: f.description.value,
      location: f.location.value,
      allDay: f.allDay.checked,
      timezone: f.tz.value,
      recurrence: repeat.get(),
      reminders: reminderList,
      announce:
        announceMode() === 'inherit' ? null : announceMode() === 'none' ? [] : announce.get(),
      video:
        mode === 'link'
          ? { kind: 'link', url: f.videoUrl.value.trim() }
          : mode === 'discord' && f.voice.value
          ? {
              kind: 'discord',
              channelId: f.voice.value,
              name: f.voice.options[f.voice.selectedIndex].text.replace(/^🔊 /, ''),
            }
          : null,
    };
    if (b.allDay) {
      b.startDate = f.startDate.value;
      b.endDate = f.endDate.value;
    } else {
      b.start = new Date(startMs()).toISOString();
      b.end = new Date(endMs()).toISOString();
    }
    return b;
  }

  form.addEventListener('input', function () {
    dirty = true;
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    if (!f.title.value.trim()) {
      showError('Give the event a title');
      f.title.focus();
      return;
    }
    var b = bodyOf();
    if (b.video && b.video.kind === 'link' && !/^https:\/\//i.test(b.video.url)) {
      showError('The video call link must start with https://');
      f.videoUrl.focus();
      return;
    }
    var ask =
      editing && editing.recurring
        ? askScope('Change a repeating event', 'Save')
        : Promise.resolve('all');
    ask.then(function (scope) {
      if (!scope) return;
      f.save.disabled = true;
      var url = editing
        ? Cal.API +
          '?action=update-event&id=' +
          encodeURIComponent(editing.id) +
          '&scope=' +
          scope +
          '&at=' +
          encodeURIComponent(editing.occurrence)
        : Cal.API + '?action=create-event';
      M.api('POST', url, b)
        .then(function () {
          try {
            window.localStorage.setItem(LAST_CAL, b.calendarId);
          } catch (err) {
            /* not remembered */
          }
          dirty = false;
          editor.close();
          M.toast(editing ? 'Event saved' : 'Event created');
          // Show the day of a new event, in a calendar maybe hidden so far.
          if (!editing) {
            var c = (prefs.calendars || []).find(function (x) {
              return x.id === b.calendarId;
            });
            if (c && !c.choice.dashboard) {
              c.choice.dashboard = true;
              drawList();
              M.api('POST', Cal.API + '?action=show&id=' + encodeURIComponent(c.id), {
                on: true,
              }).then(go);
              return;
            }
          }
          go();
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          showError(err.message);
        })
        .then(function () {
          f.save.disabled = false;
        });
    });
  });

  function closeEditor() {
    if (dirty && !window.confirm('Leave without saving the changes?')) return;
    dirty = false;
    editor.close();
  }
  document.getElementById('evCancel').addEventListener('click', closeEditor);
  document.getElementById('calEditorClose').addEventListener('click', closeEditor);
  editor.addEventListener('cancel', function (e) {
    if (dirty) {
      e.preventDefault();
      closeEditor();
    }
  });
  f.del.addEventListener('click', function () {
    if (editing) removeEvent(editing);
  });

  // ── Controls ────────────────────────────────────────────────────────────

  document.getElementById('calToday').addEventListener('click', function () {
    state.date = M.today(TZ);
    state.miniMonth = null;
    go();
  });
  document.getElementById('calPrev').addEventListener('click', function () {
    step(-1);
  });
  document.getElementById('calNext').addEventListener('click', function () {
    step(1);
  });
  document.querySelectorAll('.cal-views [data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.getAttribute('data-view');
      go();
    });
  });
  ['calNew', 'calNewTop'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function () {
      newEvent({});
    });
  });

  // Keys, as in the usual calendars: t today, m w d a the views, ← → move.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (card.open || editor.open || scopeDialog.open) return;
    var views = { m: 'month', w: 'week', d: 'day', a: 'agenda' };
    if (e.key === 't') {
      state.date = M.today(TZ);
      go();
    } else if (views[e.key]) {
      state.view = views[e.key];
      go();
    } else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'c' && writable().length) newEvent({});
    else return;
    e.preventDefault();
  });

  // ── Start ───────────────────────────────────────────────────────────────

  drawTitle();
  drawViews();
  drawMini();
  M.clear(body).appendChild(M.loading());
  Promise.all([M.me, M.api('GET', Cal.API + '?calendars=1'), M.api('GET', Cal.API + '?prefs=1')])
    .then(function (r) {
      calendars = r[1].calendars;
      byId = {};
      calendars.forEach(function (c) {
        byId[c.id] = c;
      });
      prefs = r[2];
      drawList();
      var canWrite = writable().length > 0;
      document.getElementById('calNew').hidden = !canWrite;
      document.getElementById('calNewTop').hidden = !canWrite;
      return go().then(function () {
        if (params.get('new') && canWrite) newEvent({});
        if (params.get('event')) {
          openCard({
            id: params.get('event'),
            occurrence: params.get('at') || '',
            title: 'Loading…',
            start: params.get('at') || new Date().toISOString(),
            end: params.get('at') || new Date().toISOString(),
            calendarId: null,
          });
        }
      });
    })
    .catch(M.appError);
})();
