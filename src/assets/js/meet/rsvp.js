/* /rsvp/: the answer links of an invite or reminder email.
 *   ?t=<signed token>   which person and which event (or occurrence)
 *   &a=yes|maybe|no     the answer clicked in the email
 * Shows the event, records the answer (a POST from here, so mail scanners
 * that open every link answer nothing) and lets the person change it. Who
 * else comes is shown as their invite or the calendar lets them see it. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/calendar';
  var params = new URLSearchParams(window.location.search);
  var token = params.get('t') || '';
  var asked = params.get('a');
  var view = document.getElementById('rsvpView');
  var titleEl = document.getElementById('rsvpTitle');
  var metaEl = document.getElementById('rsvpMeta');

  var ANSWERS = [
    ['yes', 'Ci sarò', 'Going'],
    ['maybe', 'Forse', 'Maybe'],
    ['no', 'Non ci sarò', 'Can’t go'],
  ];
  var tz = M.browserTz();

  function fail(err) {
    M.clear(titleEl).appendChild(document.createTextNode('Link non valido · Link not working'));
    M.clear(view).appendChild(
      h('div', { class: 'empty-state' }, h('p', null, (err && err.message) || ''))
    );
  }

  function when(d) {
    if (d.allDay) return M.fmtDay(d.start, 'UTC');
    return M.fmtDay(d.start, tz) + ', ' + M.fmtTime(d.start, tz) + '–' + M.fmtTime(d.end, tz);
  }

  function draw(d, justSaved) {
    M.clear(titleEl).appendChild(document.createTextNode(d.title));
    M.clear(metaEl).appendChild(
      h(
        'div',
        { style: 'display:contents' },
        h('span', null, M.icon('clock'), when(d)),
        d.location ? h('span', null, M.icon('pin'), d.location) : null,
        d.calendar ? h('span', null, M.icon('globe'), d.calendar) : null
      )
    );
    var r = d.rsvp;
    var buttons = h(
      'div',
      { class: 'rsvp-buttons', role: 'group', 'aria-label': 'Your answer' },
      ANSWERS.map(function (a) {
        return h(
          'button',
          {
            type: 'button',
            class: 'rsvp-btn is-' + a[0],
            'aria-pressed': String(r.mine === a[0]),
            onclick: function () {
              answer(a[0]);
            },
          },
          h('strong', null, a[1]),
          h('small', null, a[2])
        );
      })
    );
    var c = r.counts;
    var counts = h(
      'p',
      { class: 'rsvp-counts' },
      c.yes + ' ci saranno · going',
      c.maybe ? ' · ' + c.maybe + ' forse · maybe' : '',
      c.no ? ' · ' + c.no + ' no' : '',
      c.waiting ? ' · ' + c.waiting + ' senza risposta · no answer yet' : ''
    );
    var people = r.people
      ? h(
          'ul',
          { class: 'rsvp-people' },
          r.people.map(function (p) {
            var label = { yes: '✓', maybe: '?', no: '✕' }[p.answer] || '…';
            return h(
              'li',
              { class: 'is-' + (p.answer || 'waiting') },
              h('span', { class: 'rsvp-mark', 'aria-hidden': 'true' }, label),
              p.name
            );
          })
        )
      : null;
    M.clear(view).appendChild(
      h(
        'div',
        { class: 'panel rsvp-panel' },
        justSaved && r.mine
          ? h(
              'p',
              { class: 'notice rsvp-saved' },
              h('span', null, '✓'),
              h(
                'span',
                null,
                'Risposta salvata · Answer saved. ',
                d.scope === 'event' && d.recurring
                  ? 'Vale per tutta la serie · It counts for the whole series.'
                  : ''
              )
            )
          : null,
        h('h2', null, 'Ci sarai? · Will you be there?'),
        buttons,
        counts,
        people,
        d.video
          ? h(
              'p',
              null,
              h(
                'a',
                {
                  class: 'btn btn-outline btn-sm',
                  href: d.video,
                  rel: 'noopener',
                  target: '_blank',
                },
                'Link della riunione · Meeting link'
              )
            )
          : null
      )
    );
  }

  function answer(a) {
    M.api('POST', API, { rsvp: token, answer: a })
      .then(function (d) {
        draw(d, true);
      })
      .catch(function (err) {
        M.toast(err.message, true);
      });
  }

  if (!token) return fail({ message: 'Manca il codice del link · The link is incomplete.' });
  M.api('GET', API + '?rsvp=' + encodeURIComponent(token))
    .then(function (d) {
      // The answer clicked in the email, unless it is already the one given.
      if (asked && ['yes', 'maybe', 'no'].indexOf(asked) !== -1 && d.rsvp.mine !== asked) {
        answer(asked);
        // Drop it from the address, so a reload does not answer again.
        history.replaceState(null, '', location.pathname + '?t=' + encodeURIComponent(token));
      } else {
        draw(d, Boolean(asked));
      }
    })
    .catch(fail);
})();
