/* Admin pages: sign-out, and a session check that sends anyone not signed in
 * back to the login on /admin/. The real protection is in the API; this only
 * avoids showing an empty page. */
(function () {
  'use strict';
  var M = window.Meet;

  document.querySelectorAll('[data-sign-out]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      M.api('DELETE', '/api/admin/session').then(function () {
        window.location.href = '/admin/';
      });
    });
  });

  /** Resolves with the session ({ signedIn, calendarConnected }) when signed in. */
  M.session = M.api('GET', '/api/admin/session').then(function (session) {
    if (!session.signedIn && window.location.pathname !== '/admin/') {
      window.location.replace(
        '/admin/?next=' + encodeURIComponent(window.location.pathname + window.location.search)
      );
      return new Promise(function () {});
    }
    return session;
  });

  /** Shared handling for an API call that failed. */
  M.adminError = function (err) {
    if (err.status === 401) {
      window.location.replace('/admin/');
      return;
    }
    M.toast(err.message, true);
  };

  M.statusBadge = function (status) {
    var label = { open: 'Open', closed: 'Closed', scheduled: 'Scheduled' }[status] || status;
    return M.h('span', { class: 'badge badge-' + status }, label);
  };
})();
