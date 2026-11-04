/* /calendar/ (and /it/calendar/): the public calendars of the personal area's
 * calendar (server/calendars.js), read from /api/calendar when the page
 * opens: the next three months of events, a filter per calendar, and the
 * buttons to follow each one in Google Calendar, Outlook or Apple Calendar.
 * Built with DOM nodes and textContent only: titles are typed by people. */
(function () {
  'use strict';
  var root = document.getElementById('publicCalendar');
  if (!root) return;
  var it = document.documentElement.lang === 'it';
  var locale = it ? 'it-IT' : 'en-GB';
  var tz = 'Europe/Rome';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch (e) {
    /* Rome it is */
  }
  var DAYS = 92;
  var T = {
    loading: it ? 'Caricamento…' : 'Loading…',
    none: it ? 'Nessun evento nei prossimi tre mesi.' : 'No events in the next three months.',
    failed: it
      ? 'Il calendario non si è caricato. Riprova tra poco.'
      : 'The calendar did not load. Try again in a moment.',
    all: it ? 'Tutti' : 'All',
    allDay: it ? 'Tutto il giorno' : 'All day',
    google: 'Google Calendar',
    outlook: 'Outlook',
    other: it ? 'Apple e altri' : 'Apple & others',
    copy: it ? 'Copia il link' : 'Copy the link',
    copied: it ? 'Link copiato' : 'Link copied',
    join: it ? 'Partecipa' : 'Join',
    noPublic: it ? 'Nessun calendario pubblico, per ora.' : 'No public calendar yet.',
    times: it ? 'Orari nel fuso ' : 'Times in ',
  };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function fmt(iso, opts, zone) {
    return new Intl.DateTimeFormat(locale, Object.assign({ timeZone: zone || tz }, opts)).format(
      new Date(iso)
    );
  }

  function dayKey(ev) {
    if (ev.allDay) return ev.start.slice(0, 10);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ev.start));
  }

  var subsEl = document.getElementById('pcSubs');
  var filtersEl = document.getElementById('pcFilters');
  var listEl = document.getElementById('pcList');
  var calendars = [];
  var events = [];
  var shown = null; // slug, or null for all

  function feedUrl(slug) {
    return window.location.origin + '/calendar/' + slug + '.ics';
  }

  function drawSubs() {
    while (subsEl.firstChild) subsEl.removeChild(subsEl.firstChild);
    if (!calendars.length) subsEl.appendChild(h('p', { class: 'pc-note' }, T.noPublic));
    calendars.forEach(function (c) {
      var url = feedUrl(c.slug);
      var webcal = url.replace(/^https?:\/\//, 'webcal://');
      subsEl.appendChild(
        h(
          'div',
          { class: 'pc-sub', style: '--pc-color:' + c.color },
          h(
            'p',
            { class: 'pc-sub-name' },
            h('span', { class: 'pc-dot', 'aria-hidden': 'true' }),
            c.name
          ),
          c.description ? h('p', { class: 'pc-sub-desc' }, c.description) : null,
          h(
            'div',
            { class: 'pc-sub-buttons' },
            h(
              'a',
              {
                class: 'pc-btn',
                href: 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal),
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              T.google
            ),
            h(
              'a',
              {
                class: 'pc-btn',
                href:
                  'https://outlook.live.com/calendar/0/addfromweb?url=' +
                  encodeURIComponent(url) +
                  '&name=' +
                  encodeURIComponent(c.name),
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              T.outlook
            ),
            h('a', { class: 'pc-btn', href: webcal }, T.other),
            h(
              'button',
              {
                type: 'button',
                class: 'pc-btn is-quiet',
                onclick: function (e) {
                  var b = e.currentTarget;
                  var done = function () {
                    b.textContent = T.copied;
                    setTimeout(function () {
                      b.textContent = T.copy;
                    }, 1800);
                  };
                  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
                  else done();
                },
              },
              T.copy
            )
          )
        )
      );
    });
  }

  function drawFilters() {
    while (filtersEl.firstChild) filtersEl.removeChild(filtersEl.firstChild);
    if (calendars.length < 2) return;
    [{ slug: null, name: T.all, color: null }].concat(calendars).forEach(function (c) {
      filtersEl.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'pc-filter' + (shown === c.slug ? ' is-on' : ''),
            'aria-pressed': shown === c.slug ? 'true' : 'false',
            style: c.color ? '--pc-color:' + c.color : null,
            onclick: function () {
              shown = c.slug;
              drawFilters();
              drawList();
            },
          },
          c.color ? h('span', { class: 'pc-dot', 'aria-hidden': 'true' }) : null,
          c.name
        )
      );
    });
  }

  function drawList() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    var byCal = {};
    calendars.forEach(function (c) {
      byCal[c.slug] = c;
    });
    var list = events.filter(function (e) {
      return !shown || e.calendar === shown;
    });
    if (!list.length) {
      listEl.appendChild(h('p', { class: 'pc-empty' }, T.none));
      return;
    }
    listEl.appendChild(h('p', { class: 'pc-note' }, T.times + tz.replace(/_/g, ' ')));
    var lastDay = null;
    var group = null;
    list.forEach(function (ev) {
      var key = dayKey(ev);
      if (key !== lastDay) {
        lastDay = key;
        var at = key + 'T12:00:00Z';
        group = h('ul', { class: 'pc-day-list' });
        listEl.appendChild(
          h(
            'section',
            { class: 'pc-day' },
            h(
              'h3',
              { class: 'pc-date' },
              h('span', { class: 'pc-date-num' }, fmt(at, { day: 'numeric' }, 'UTC')),
              h(
                'span',
                null,
                h('strong', null, fmt(at, { weekday: 'long' }, 'UTC')),
                h('small', null, fmt(at, { month: 'long', year: 'numeric' }, 'UTC'))
              )
            ),
            group
          )
        );
      }
      var cal = byCal[ev.calendar] || {};
      var time = ev.allDay
        ? T.allDay
        : fmt(ev.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) +
          '–' +
          fmt(ev.end, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      var details = h('details', {
        class: 'pc-event',
        style: '--pc-color:' + (cal.color || '#00703a'),
      });
      details.appendChild(
        h(
          'summary',
          null,
          h('span', { class: 'pc-time' }, time),
          h('span', { class: 'pc-bar', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'pc-what' },
            h('strong', null, ev.title),
            h('small', null, [cal.name, ev.location].filter(Boolean).join(' · '))
          )
        )
      );
      var body = h('div', { class: 'pc-event-body' });
      if (ev.description) body.appendChild(linkify(ev.description));
      if (ev.video && ev.video.url) {
        body.appendChild(
          h(
            'p',
            null,
            h(
              'a',
              { class: 'pc-btn', href: ev.video.url, target: '_blank', rel: 'noopener noreferrer' },
              T.join
            )
          )
        );
      }
      if (body.childNodes.length) details.appendChild(body);
      else details.classList.add('is-plain');
      group.appendChild(h('li', null, details));
    });
  }

  function linkify(text) {
    var p = h('p', { class: 'pc-desc' });
    var re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      p.appendChild(document.createTextNode(text.slice(last, m.index)));
      p.appendChild(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      last = m.index + m[0].length;
    }
    p.appendChild(document.createTextNode(text.slice(last)));
    return p;
  }

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  listEl.appendChild(h('p', { class: 'pc-note' }, T.loading));
  var from = new Date();
  from.setHours(0, 0, 0, 0);
  var to = new Date(from.getTime() + DAYS * 86400000);
  Promise.all([
    get('/api/calendar?list=1'),
    get(
      '/api/calendar?from=' +
        encodeURIComponent(from.toISOString()) +
        '&to=' +
        encodeURIComponent(to.toISOString())
    ),
  ])
    .then(function (r) {
      calendars = r[0].calendars;
      events = r[1].events;
      drawSubs();
      drawFilters();
      drawList();
    })
    .catch(function () {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      listEl.appendChild(h('p', { class: 'pc-empty' }, T.failed));
    });
})();
