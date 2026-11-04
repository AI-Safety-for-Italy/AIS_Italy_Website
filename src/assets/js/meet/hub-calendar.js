/* The calendar at a glance, on the home page (/app/): the month, with a dot
 * on the days that have something; today's events; and what comes next.
 * The calendars are those the member shows on the calendar page
 * (/api/app/calendar, server/calendars.js); a day opens it on that day, an
 * event opens its card there. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var box = document.getElementById('hubCalBody');
  if (!box) return;
  var TZ = M.browserTz();
  var UPCOMING = 4;
  var AHEAD_DAYS = 45;
  var today = M.today(TZ);
  var month = today.slice(0, 8) + '01';
  var events = []; // the shown month
  var soon = []; // today and the weeks after, for the lists

  function mondayOf(date) {
    return M.addDays(date, -M.weekday(date));
  }

  function addMonths(date, n) {
    var p = date.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1 + n, 1)).toISOString().slice(0, 10);
  }

  function dayLabel(date, opts) {
    return M.fmt(date + 'T12:00:00Z', 'UTC', opts);
  }

  /** The days an event covers, in the member's zone: [first, last]. */
  function daysOf(ev) {
    if (ev.allDay) return [ev.start.slice(0, 10), M.addDays(ev.end.slice(0, 10), -1)];
    var s = M.utcToZoned(ev.start, TZ);
    var e = M.utcToZoned(ev.end, TZ);
    return [s.date, e.minutes === 0 && e.date > s.date ? M.addDays(e.date, -1) : e.date];
  }

  function on(ev, date) {
    return date >= ev._days[0] && date <= ev._days[1];
  }

  function eventUrl(ev) {
    return (
      '/app/calendar/?event=' +
      encodeURIComponent(ev.id) +
      '&at=' +
      encodeURIComponent(ev.occurrence)
    );
  }

  function timeOf(ev) {
    if (ev.allDay) return 'All day';
    if (ev._days[0] !== ev._days[1]) return M.fmtShortDay(ev.start, TZ);
    return M.fmtTime(ev.start, TZ);
  }

  function row(ev, withDay) {
    return h(
      'li',
      null,
      h(
        'a',
        {
          class: 'hub-cal-ev',
          href: eventUrl(ev),
          style: '--cal-color:' + (ev.color || '#00703a'),
        },
        h('span', { class: 'hub-cal-bar', 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'hub-cal-what' },
          h('strong', null, ev.title),
          h(
            'small',
            null,
            (withDay
              ? dayLabel(ev._days[0], { weekday: 'short', day: 'numeric', month: 'short' }) + ' · '
              : '') +
              timeOf(ev) +
              (ev.video ? ' · call' : '')
          )
        )
      )
    );
  }

  function monthGrid() {
    var first = mondayOf(month);
    var grid = h('div', { class: 'hub-cal-grid', role: 'grid' });
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (d) {
      grid.appendChild(h('span', { class: 'hub-cal-dow', 'aria-hidden': 'true' }, d));
    });
    var weeks = Math.ceil((M.weekday(month) + daysIn(month)) / 7);
    for (var i = 0; i < weeks * 7; i++) {
      (function (date) {
        var mine = events.filter(function (ev) {
          return on(ev, date);
        });
        var colors = mine
          .map(function (ev) {
            return ev.color;
          })
          .filter(function (c, k, all) {
            return all.indexOf(c) === k;
          })
          .slice(0, 3);
        grid.appendChild(
          h(
            'a',
            {
              class:
                'hub-cal-day' +
                (date.slice(0, 7) !== month.slice(0, 7) ? ' is-out' : '') +
                (date === today ? ' is-today' : '') +
                (mine.length ? ' has-events' : ''),
              href: '/app/calendar/?view=day&date=' + date,
              'aria-label':
                dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' }) +
                (mine.length
                  ? ', ' + mine.length + (mine.length === 1 ? ' event' : ' events')
                  : ''),
            },
            h('span', null, String(Number(date.slice(8)))),
            colors.length
              ? h(
                  'span',
                  { class: 'hub-cal-dots', 'aria-hidden': 'true' },
                  colors.map(function (c) {
                    return h('i', { style: 'background:' + c });
                  })
                )
              : null
          )
        );
      })(M.addDays(first, i));
    }
    return grid;
  }

  function daysIn(date) {
    var p = date.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
  }

  function draw() {
    M.clear(box);
    box.appendChild(
      h(
        'div',
        { class: 'hub-cal-month' },
        h('span', null, dayLabel(month, { month: 'long', year: 'numeric' })),
        h(
          'span',
          { class: 'hub-cal-nav' },
          h(
            'button',
            {
              type: 'button',
              'aria-label': 'Previous month',
              onclick: function () {
                month = addMonths(month, -1);
                load();
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
                month = addMonths(month, 1);
                load();
              },
            },
            M.icon('right')
          )
        )
      )
    );
    box.appendChild(monthGrid());

    var todays = soon.filter(function (ev) {
      return on(ev, today);
    });
    var now = Date.now();
    var next = soon
      .filter(function (ev) {
        return ev._days[0] > today && new Date(ev.start).getTime() > now;
      })
      .slice(0, UPCOMING);

    box.appendChild(h('p', { class: 'hub-cal-label' }, 'Today'));
    box.appendChild(
      todays.length
        ? h(
            'ul',
            { class: 'hub-cal-list' },
            todays.map(function (ev) {
              return row(ev, false);
            })
          )
        : h('p', { class: 'hub-cal-none' }, 'Nothing today.')
    );
    box.appendChild(h('p', { class: 'hub-cal-label' }, 'Coming up'));
    box.appendChild(
      next.length
        ? h(
            'ul',
            { class: 'hub-cal-list' },
            next.map(function (ev) {
              return row(ev, true);
            })
          )
        : h('p', { class: 'hub-cal-none' }, 'Nothing in the next weeks.')
    );
  }

  function range(from, to) {
    return M.api(
      'GET',
      '/api/app/calendar?from=' +
        encodeURIComponent(new Date(M.zonedToUtc(from, 0, TZ)).toISOString()) +
        '&to=' +
        encodeURIComponent(new Date(M.zonedToUtc(to, 0, TZ)).toISOString())
    ).then(function (data) {
      return data.events.map(function (ev) {
        ev._days = daysOf(ev);
        return ev;
      });
    });
  }

  function failed(err) {
    if (err.status === 401) return M.appError(err);
    M.clear(box).appendChild(h('p', { class: 'hub-cal-none' }, 'The calendar did not load.'));
  }

  var loadToken = 0;
  /** The weeks the month grid shows. */
  function load() {
    var token = ++loadToken;
    var first = mondayOf(month);
    return range(first, M.addDays(first, 42))
      .then(function (list) {
        if (token !== loadToken) return;
        events = list;
        draw();
      })
      .catch(failed);
  }

  // Today and what comes next, once; then the month around them.
  M.me
    .then(function () {
      return range(today, M.addDays(today, AHEAD_DAYS));
    })
    .then(function (list) {
      soon = list;
      return load();
    })
    .catch(failed);
})();
