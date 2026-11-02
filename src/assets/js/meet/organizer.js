/* /app/organizer/: a participant asks to become an organizer, answering the
 * organizers' part of the sign-up form (GET/POST /api/app/members?upgrade,
 * server/members.js). The request reaches the board flagged as an upgrade. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var view = document.getElementById('organizerView');

  function notice(title, text) {
    M.clear(view).appendChild(
      h('div', { class: 'empty-state' }, h('h3', null, title), h('p', null, text))
    );
  }

  view.appendChild(M.loading());
  Promise.all([M.me, M.api('GET', '/api/app/members?upgrade=1')])
    .then(function (r) {
      var d = r[1];
      if (d.pending)
        return notice(
          'Your request is with the team',
          'You will hear from us once it is reviewed.'
        );
      if (!d.can)
        return notice(
          'Only for participants',
          'This is for members with the Participant role on Discord who are not organizers yet.'
        );
      M.clear(view);
      M.formRender(view, d.schema, {
        lang: /^it\b/i.test(navigator.language || '') ? 'it' : 'en',
        draftKey: 'organizer-draft',
        onSubmit: function (answers) {
          return M.api('POST', '/api/app/members?action=upgrade', { answers: answers });
        },
      });
    })
    .catch(M.appError);
})();
