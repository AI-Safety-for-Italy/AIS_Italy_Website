/* Pages of the signed-in area (/app/): checks who is signed in, shows them in
 * the header with a sign-out button, and sends anyone signed out to the login.
 * The real protection is in the API; this only avoids showing an empty page. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  function toLogin() {
    window.location.replace(
      '/app/login/?next=' + encodeURIComponent(window.location.pathname + window.location.search)
    );
    return new Promise(function () {});
  }

  function showUser(user) {
    var slot = document.getElementById('appUser');
    if (!slot) return;
    slot.appendChild(
      h(
        'div',
        { class: 'app-user-inner' },
        user.avatarUrl
          ? h('img', { class: 'app-avatar', src: user.avatarUrl, alt: '', width: 28, height: 28 })
          : h(
              'span',
              { class: 'app-avatar is-initial', 'aria-hidden': 'true' },
              user.name.charAt(0)
            ),
        h('span', { class: 'app-user-name' }, user.name),
        h('a', { class: 'link-button', href: '/app/settings/' }, 'Settings'),
        h(
          'button',
          {
            type: 'button',
            class: 'link-button',
            onclick: function () {
              M.api('DELETE', '/api/auth').then(function () {
                window.location.href = '/app/login/';
              });
            },
          },
          'Sign out'
        )
      )
    );
    slot.hidden = false;
  }

  /** Resolves with the signed-in user ({ id, kind, name, avatarUrl }). */
  M.me = M.api('GET', '/api/auth').then(function (info) {
    if (!info.user) return toLogin();
    showUser(info.user);
    return info.user;
  });

  /** Shared handling for an API call that failed. */
  M.appError = function (err) {
    if (err.status === 401) return toLogin();
    M.toast(err.message, true);
  };

  M.statusBadge = function (status) {
    var label = { open: 'Open', closed: 'Closed', scheduled: 'Time chosen' }[status] || status;
    return h('span', { class: 'badge badge-' + status }, label);
  };
})();
