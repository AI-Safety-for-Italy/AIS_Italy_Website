/* /admin/: sign-in form, then the list of polls. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var views = {};
  document.querySelectorAll('[data-view]').forEach(function (el) {
    views[el.getAttribute('data-view')] = el;
  });
  views.loading.appendChild(M.loading());

  function show(name) {
    Object.keys(views).forEach(function (key) {
      views[key].hidden = key !== name;
    });
  }

  M.session.then(
    function (session) {
      if (session.signedIn) showDashboard(session);
      else show('login');
    },
    function () {
      clearLoading('The admin service is not reachable right now.');
    }
  );

  function clearLoading(message) {
    M.clear(views.loading).appendChild(h('div', { class: 'empty-state' }, h('p', null, message)));
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  var form = document.getElementById('loginForm');
  var error = document.getElementById('loginError');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    error.hidden = true;
    M.api('POST', '/api/admin/session', { password: form.password.value })
      .then(function () {
        var next = new URLSearchParams(window.location.search).get('next');
        // Only ever continue to another admin page on this site.
        if (next && /^\/admin\/[\w/-]*(\?[\w=&%-]*)?$/.test(next)) window.location.href = next;
        else return M.api('GET', '/api/admin/session').then(showDashboard);
      })
      .catch(function (err) {
        error.textContent = err.message;
        error.hidden = false;
        form.password.select();
      })
      .then(function () {
        button.disabled = false;
      });
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────

  function showDashboard(session) {
    show('dashboard');
    document.getElementById('calendarNotice').hidden = session.calendarConnected;
    var list = document.getElementById('pollList');
    M.clear(list).appendChild(M.loading());
    M.api('GET', '/api/admin/polls')
      .then(function (data) {
        M.clear(list);
        if (!data.polls.length) {
          list.appendChild(
            h(
              'div',
              { class: 'empty-state' },
              h('h3', { style: 'margin-bottom:1.25rem' }, 'No polls yet'),
              h('a', { class: 'btn btn-primary', href: '/admin/new/' }, 'Create your first poll')
            )
          );
          return;
        }
        list.appendChild(h('div', { class: 'poll-list' }, data.polls.map(pollItem)));
      })
      .catch(M.adminError);
  }

  function pollItem(p) {
    var when;
    if (p.status === 'scheduled' && p.finalStart) {
      when = 'Scheduled for ' + M.fmtDateTime(p.finalStart, p.timezone);
    } else if (p.firstSlot) {
      var first = M.fmtShortDay(p.firstSlot, p.timezone);
      var last = M.fmtShortDay(p.lastSlot, p.timezone);
      when = first === last ? first : first + ' – ' + last;
      when += ' · ' + p.slotCount + (p.slotCount === 1 ? ' option' : ' options');
    }
    return h(
      'a',
      { class: 'poll-item', href: '/admin/poll/?id=' + encodeURIComponent(p.id) },
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
