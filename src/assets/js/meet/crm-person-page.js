/* /app/crm/person/?key=…&kind=…: one mentor or mentee on a page of their own
 * (the drawing is shared with the board's panel: crm-person.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/mentorship';
  var params = new URLSearchParams(window.location.search);
  var key = params.get('key');
  var kind = params.get('kind');
  var out = document.getElementById('crmPerson');

  function message(title, text) {
    M.clear(out).appendChild(
      h(
        'div',
        { class: 'empty-state' },
        h('h3', null, title),
        h('p', null, text),
        h('a', { href: '/app/crm/' }, 'Back to the board')
      )
    );
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403) return message('No access', err.message);
    if (err.status === 503) return message('Not set up yet', err.message);
    if (err.status === 404 || err.status === 400) return message('Not on the board', err.message);
    M.appError(err);
  }

  if (!key || (kind !== 'mentor' && kind !== 'mentee')) {
    message('Nobody chosen', 'Open a person from the board.');
    return;
  }

  out.appendChild(M.loading());
  M.me
    .then(function (me) {
      return M.api(
        'GET',
        API + '?key=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind)
      ).then(function (p) {
        document.title = p.name + ' | Mentorship board';
        window.CrmPerson.render(p, out, {
          layout: 'page',
          me: me.id,
          onRemoved: function () {
            window.location.href = '/app/crm/#' + kind + 's';
          },
        });
      });
    })
    .catch(fail);
})();
