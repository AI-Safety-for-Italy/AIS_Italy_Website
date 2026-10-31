/* Shared helpers for the meeting-poll pages (admin and voting).
 *
 * Exposed as window.Meet. Everything is built with DOM nodes and textContent,
 * never innerHTML with data, because titles, names and descriptions are typed
 * by other people.
 */
(function () {
  'use strict';

  // ── DOM ───────────────────────────────────────────────────────────────────

  /** h('a', { href: '/', class: 'x', onclick: fn }, 'text', childNode, [more]) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
        else if (key === 'class') el.className = value;
        else if (key === 'html') el.innerHTML = value; // trusted, static markup only
        else el.setAttribute(key, value === true ? '' : value);
      });
    }
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }

  function append(el, children) {
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) append(el, child);
      else el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  var ICONS = {
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    globe:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    users:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>',
    repeat:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
    hourglass:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    right:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  };

  function icon(name) {
    return h('span', { class: 'meet-icon', 'aria-hidden': 'true', html: ICONS[name] });
  }

  /** Text with any http(s) URLs turned into links (e.g. a video-call link). */
  function linkify(text) {
    var frag = document.createDocumentFragment();
    var re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  var toastTimer;
  function toast(message, isError) {
    var el = document.querySelector('.toast');
    if (!el) {
      el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
    }, 2600);
  }

  function loading(label) {
    return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), label || 'Loading…');
  }

  function copy(text, done) {
    var finish = function () {
      toast(done || 'Copied');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(finish, function () {
        fallbackCopy(text);
        finish();
      });
    } else {
      fallbackCopy(text);
      finish();
    }
  }

  function fallbackCopy(text) {
    var ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* nothing else to try */
    }
    ta.remove();
  }

  // ── API ───────────────────────────────────────────────────────────────────

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Request failed (' + res.status + ')');
            err.status = res.status;
            err.field = data.field;
            err.code = data.code;
            // A form's answers: { questionId: message } (server/forms/schema.js).
            err.errors = data.errors;
            throw err;
          }
          return data;
        });
    });
  }

  // ── Time zones ────────────────────────────────────────────────────────────
  // Dates without a time are 'YYYY-MM-DD' strings; a time of day is minutes
  // after midnight. Instants travel as ISO strings in UTC.

  var partsCache = {};
  function partsFormatter(tz) {
    if (!partsCache[tz]) {
      partsCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    return partsCache[tz];
  }

  function wallParts(ms, tz) {
    var p = {};
    partsFormatter(tz)
      .formatToParts(new Date(ms))
      .forEach(function (x) {
        p[x.type] = x.value;
      });
    return {
      y: +p.year,
      m: +p.month,
      d: +p.day,
      h: +p.hour % 24,
      min: +p.minute,
      s: +p.second,
    };
  }

  function offsetMs(ms, tz) {
    var w = wallParts(ms, tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000;
  }

  /** Wall-clock date + minutes in `tz` -> UTC milliseconds. */
  function zonedToUtc(date, minutes, tz) {
    var ymd = date.split('-').map(Number);
    var guess = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], 0, minutes);
    var ms = guess - offsetMs(guess, tz);
    // Second pass settles times next to a DST change.
    return guess - offsetMs(ms, tz);
  }

  /** UTC instant -> { date: 'YYYY-MM-DD', minutes } on the wall clock in `tz`. */
  function utcToZoned(iso, tz) {
    var w = wallParts(new Date(iso).getTime(), tz);
    return { date: ymd(w.y, w.m, w.d), minutes: w.h * 60 + w.min };
  }

  function ymd(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function addDays(date, n) {
    var p = date.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  /** 0 = Monday … 6 = Sunday */
  function weekday(date) {
    var p = date.split('-').map(Number);
    return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7;
  }

  function today(tz) {
    return utcToZoned(new Date().toISOString(), tz).date;
  }

  function browserTz() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome';
    } catch (e) {
      return 'Europe/Rome';
    }
  }

  function hhmm(minutes) {
    return (
      String(Math.floor(minutes / 60) % 24).padStart(2, '0') +
      ':' +
      String(minutes % 60).padStart(2, '0')
    );
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  function locale() {
    return document.documentElement.lang === 'it' ? 'it-IT' : 'en-GB';
  }

  function fmt(iso, tz, options) {
    return new Intl.DateTimeFormat(locale(), Object.assign({ timeZone: tz }, options)).format(
      new Date(iso)
    );
  }

  function fmtTime(iso, tz) {
    return fmt(iso, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  function fmtDay(iso, tz) {
    return fmt(iso, tz, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function fmtShortDay(iso, tz) {
    return fmt(iso, tz, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function fmtDateTime(iso, tz) {
    return fmt(iso, tz, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  function fmtDuration(minutes) {
    var it = document.documentElement.lang === 'it';
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    var label = hours + (it ? (hours === 1 ? ' ora' : ' ore') : hours === 1 ? ' hour' : ' hours');
    return rest ? label + ' ' + rest + ' min' : label;
  }

  function tzLabel(tz) {
    return tz.replace(/_/g, ' ');
  }

  /** Slots grouped by their day in `tz`: [{ date, label, slots: [...] }] */
  function groupByDay(slots, tz) {
    var groups = [];
    slots.forEach(function (slot) {
      var date = utcToZoned(slot.start, tz).date;
      var last = groups[groups.length - 1];
      if (!last || last.date !== date) {
        last = { date: date, label: fmtDay(slot.start, tz), slots: [] };
        groups.push(last);
      }
      last.slots.push(slot);
    });
    return groups;
  }

  // ── Results table ─────────────────────────────────────────────────────────

  var MARK = { 2: '✓', 1: '(✓)', 0: '–' };

  function score(slot) {
    return (slot.yes || 0) + (slot.maybe || 0) * 0.5;
  }

  /** Ids of the slots with the highest score (none when nobody voted yet). */
  function bestSlots(slots) {
    var top = 0;
    slots.forEach(function (s) {
      top = Math.max(top, score(s));
    });
    if (!top) return {};
    var best = {};
    slots.forEach(function (s) {
      if (score(s) === top) best[s.id] = true;
    });
    return best;
  }

  /**
   * Doodle-style grid: a row per participant, a column per slot.
   * opts: { tz, labels: { name, total, maybe }, finalSlotId,
   *         rowExtra(response) -> node, footerExtra(slot) -> node }
   */
  function resultsTable(poll, opts) {
    var tz = opts.tz;
    var labels = opts.labels || {};
    var best = bestSlots(poll.slots);
    var groups = groupByDay(poll.slots, tz);
    var firstOfDay = {};
    groups.forEach(function (g) {
      firstOfDay[g.slots[0].id] = true;
    });

    function cellClass(slot) {
      var cls = [];
      if (firstOfDay[slot.id]) cls.push('first-of-day');
      if (slot.id === opts.finalSlotId) cls.push('is-final');
      else if (best[slot.id]) cls.push('is-best');
      return cls.join(' ');
    }

    var dateRow = h(
      'tr',
      { class: 'r-date' },
      h('th', { class: 'r-name', scope: 'col' }),
      groups.map(function (g) {
        return h(
          'th',
          { colspan: g.slots.length, scope: 'colgroup' },
          fmtShortDay(g.slots[0].start, tz)
        );
      })
    );
    var timeRow = h(
      'tr',
      { class: 'r-time' },
      h('th', { class: 'r-name', scope: 'col' }, labels.name || 'Participant'),
      poll.slots.map(function (slot) {
        return h(
          'th',
          { class: cellClass(slot), scope: 'col' },
          fmtTime(slot.start, tz),
          best[slot.id] && slot.id !== opts.finalSlotId
            ? h('span', { class: 'best-star', title: 'Most available' }, '★')
            : null
        );
      })
    );

    var rows = (poll.responses || []).map(function (r) {
      return h(
        'tr',
        { class: r.mine ? 'is-mine' : null },
        h(
          'td',
          { class: 'r-name' },
          h(
            'div',
            { class: 'r-name-inner' },
            h('div', { class: 'r-who' }, r.name, r.email ? h('small', null, r.email) : null),
            opts.rowExtra ? opts.rowExtra(r) : null
          )
        ),
        poll.slots.map(function (slot) {
          var v = r.votes[slot.id] || 0;
          return h(
            'td',
            { class: cellClass(slot) },
            h(
              'span',
              { class: 'vote-cell v' + v, 'aria-label': ['no', 'if needed', 'yes'][v] },
              MARK[v]
            )
          );
        })
      );
    });

    var foot = h(
      'tr',
      null,
      h('td', { class: 'r-name' }, labels.total || 'Available'),
      poll.slots.map(function (slot) {
        return h(
          'td',
          { class: cellClass(slot) },
          h(
            'span',
            { class: 'tally' },
            String(slot.yes || 0),
            slot.maybe
              ? h('small', null, '+' + slot.maybe + ' ' + (labels.maybe || 'if needed'))
              : null
          ),
          opts.footerExtra ? opts.footerExtra(slot) : null
        );
      })
    );

    return h(
      'div',
      { class: 'results-wrap' },
      h(
        'table',
        { class: 'results' },
        h('thead', null, dateRow, timeRow),
        h('tbody', null, rows),
        h('tfoot', null, foot)
      )
    );
  }

  // ── Recurring meetings ────────────────────────────────────────────────────

  var ORDINALS = {
    en: { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', '-1': 'last' },
    it: { 1: 'primo', 2: 'secondo', 3: 'terzo', 4: 'quarto', '-1': 'ultimo' },
  };

  /**
   * A recurrence in words, in the page's language: "Every week on Tuesday",
   * "Il secondo martedì di ogni mese"… Without `start` (no time chosen yet)
   * only the rhythm: "Every 2 weeks".
   */
  function recurrenceText(rec, start, tz) {
    if (!rec) return '';
    var it = document.documentElement.lang === 'it';
    var n = rec.interval || 1;
    var day = start ? fmt(start, tz, { weekday: 'long' }) : '';
    var text;
    if (rec.freq === 'weekly') {
      if (it) {
        text = n === 1 ? (day ? 'Ogni ' + day : 'Ogni settimana') : 'Ogni ' + n + ' settimane';
        if (day && n > 1) text += ', il ' + day;
      } else {
        text = (n === 1 ? 'Every week' : 'Every ' + n + ' weeks') + (day ? ' on ' + day : '');
      }
    } else {
      var which = '';
      if (day) {
        var d = Number(utcToZoned(start, tz).date.slice(8));
        var k = Math.ceil(d / 7) === 5 ? -1 : Math.ceil(d / 7);
        which = it
          ? (k === -1 ? 'L’' : 'Il ') + ORDINALS.it[k] + ' ' + day
          : 'the ' + ORDINALS.en[k] + ' ' + day;
      }
      if (it) {
        text = which
          ? which + (n === 1 ? ' di ogni mese' : ', ogni ' + n + ' mesi')
          : n === 1
          ? 'Ogni mese'
          : 'Ogni ' + n + ' mesi';
      } else {
        text = (n === 1 ? 'Every month' : 'Every ' + n + ' months') + (which ? ' on ' + which : '');
      }
    }
    if (rec.until) {
      var end = fmt(rec.until + 'T12:00:00Z', 'UTC', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      text += it ? ', fino al ' + end : ', until ' + end;
    } else if (rec.count) {
      text += it ? ', per ' + rec.count + ' volte' : ', ' + rec.count + ' times';
    }
    return text;
  }

  /**
   * The fields of components/recurrence-fields.njk with id prefix `prefix`:
   * { get() -> recurrence or null, set(recurrence) }.
   */
  function recurrenceFields(prefix) {
    var el = function (name) {
      return document.getElementById(prefix + name);
    };
    var root = el('Recurrence');
    var part = function (name) {
      return root.querySelector('[data-part="' + name + '"]');
    };
    function refresh() {
      var repeat = el('Repeat').value;
      part('custom').hidden = repeat !== 'custom';
      part('end').hidden = repeat === 'none';
      var monthly =
        repeat === 'monthly-1' || (repeat === 'custom' && el('Unit').value === 'monthly');
      part('note').hidden = !monthly;
      el('Until').hidden = el('End').value !== 'until';
      el('Count').hidden = el('End').value !== 'count';
    }
    ['Repeat', 'Unit', 'End'].forEach(function (name) {
      el(name).addEventListener('change', refresh);
    });
    refresh();
    return {
      get: function () {
        var repeat = el('Repeat').value;
        if (repeat === 'none') return null;
        var rec =
          repeat === 'custom'
            ? { freq: el('Unit').value, interval: Number(el('Interval').value) }
            : { freq: repeat.split('-')[0], interval: Number(repeat.split('-')[1]) };
        if (el('End').value === 'until') rec.until = el('Until').value || null;
        if (el('End').value === 'count') rec.count = Number(el('Count').value);
        return rec;
      },
      set: function (rec) {
        var preset = rec && rec.freq + '-' + rec.interval;
        if (!rec) el('Repeat').value = 'none';
        else if (['weekly-1', 'weekly-2', 'monthly-1'].indexOf(preset) !== -1) {
          el('Repeat').value = preset;
        } else {
          el('Repeat').value = 'custom';
          el('Interval').value = rec.interval;
          el('Unit').value = rec.freq;
        }
        el('End').value = rec && rec.until ? 'until' : rec && rec.count ? 'count' : 'never';
        if (rec && rec.until) el('Until').value = rec.until;
        if (rec && rec.count) el('Count').value = rec.count;
        refresh();
      },
    };
  }

  // The one email rule; the server twin is server/email.js.
  var EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
  function isEmail(text) {
    return typeof text === 'string' && text.length <= 254 && EMAIL.test(text);
  }

  window.Meet = {
    isEmail: isEmail,
    recurrenceText: recurrenceText,
    recurrenceFields: recurrenceFields,
    h: h,
    clear: clear,
    icon: icon,
    linkify: linkify,
    toast: toast,
    loading: loading,
    copy: copy,
    api: api,
    zonedToUtc: zonedToUtc,
    utcToZoned: utcToZoned,
    addDays: addDays,
    weekday: weekday,
    today: today,
    browserTz: browserTz,
    hhmm: hhmm,
    fmt: fmt,
    fmtTime: fmtTime,
    fmtDay: fmtDay,
    fmtShortDay: fmtShortDay,
    fmtDateTime: fmtDateTime,
    fmtDuration: fmtDuration,
    tzLabel: tzLabel,
    groupByDay: groupByDay,
    bestSlots: bestSlots,
    resultsTable: resultsTable,
  };
})();
