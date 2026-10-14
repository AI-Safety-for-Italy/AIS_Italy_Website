/* /app/polls/: the signed-in member's polls. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var list = document.getElementById('pollList');
  list.appendChild(M.loading());

  M.me
    .then(function () {
      return M.api('GET', '/api/app/polls');
    })
    .then(function (data) {
      M.clear(list);
      if (!data.polls.length) {
        list.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', { style: 'margin-bottom:1.25rem' }, 'No polls yet'),
            h('a', { class: 'btn btn-primary', href: '/app/polls/new/' }, 'Create your first poll')
          )
        );
        return;
      }
      list.appendChild(h('div', { class: 'poll-list' }, data.polls.map(pollItem)));
    })
    .catch(M.appError);

  function pollItem(p) {
    var when;
    if (p.status === 'scheduled' && p.finalStart) {
      when = 'Time chosen: ' + M.fmtDateTime(p.finalStart, p.timezone);
    } else if (p.firstSlot) {
      var first = M.fmtShortDay(p.firstSlot, p.timezone);
      var last = M.fmtShortDay(p.lastSlot, p.timezone);
      when = first === last ? first : first + ' – ' + last;
      when += ' · ' + p.slotCount + (p.slotCount === 1 ? ' option' : ' options');
    }
    return h(
      'a',
      { class: 'poll-item', href: '/app/polls/poll/?id=' + encodeURIComponent(p.id) },
      h(
        'div',
        null,
        h('h3', null, p.title),
        h(
          'div',
          { class: 'poll-item-meta' },
          h('span', null, when),
          h('span', null, M.fmtDuration(p.durationMinutes)),
          p.deadline && p.status === 'open'
            ? h('span', null, 'Closes ' + M.fmtDateTime(p.deadline, p.timezone))
            : null
        )
      ),
      h(
        'div',
        { class: 'poll-item-side' },
        M.statusBadge(p.status === 'open' && !p.open ? 'closed' : p.status),
        h(
          'div',
          { class: 'poll-count' },
          h('strong', null, String(p.responseCount)),
          h('span', null, p.responseCount === 1 ? 'answer' : 'answers')
        )
      )
    );
  }
})();
