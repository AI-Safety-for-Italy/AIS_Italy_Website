/* Pages of the signed-in area (/app/): checks who is signed in, shows them in
 * the header with a sign-out button, and sends anyone signed out to the login.
 * The real protection is in the API; this only avoids showing an empty page. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  // The last signed-in user, so the next page can draw the header before the
  // session check answers (see meet-head.njk and meet-header.njk).
  var CACHE = 'ais-user';
  function remember(user) {
    try {
      if (user) {
        window.localStorage.setItem(
          CACHE,
          JSON.stringify({ name: user.name, avatarUrl: user.avatarUrl, kind: user.kind })
        );
      } else {
        window.localStorage.removeItem(CACHE);
      }
    } catch (e) {
      /* storage blocked: the header just appears a moment later */
    }
  }

  function toLogin() {
    remember(null);
    window.location.replace(
      '/app/login/?next=' + encodeURIComponent(window.location.pathname + window.location.search)
    );
    return new Promise(function () {});
  }

  function avatar(user, size) {
    return user.avatarUrl
      ? h('img', { class: 'app-avatar', src: user.avatarUrl, alt: '', width: size, height: size })
      : h('span', { class: 'app-avatar is-initial', 'aria-hidden': 'true' }, user.name.charAt(0));
  }

  /** The profile button in the header, opening Tools / Settings / Sign out. */
  function showUser(user) {
    var slot = document.getElementById('appUser');
    if (!slot) return;
    var menu = h(
      'div',
      { class: 'app-menu', id: 'appMenu', role: 'menu', hidden: true },
      h(
        'div',
        { class: 'app-menu-who' },
        avatar(user, 36),
        h(
          'div',
          null,
          h('strong', null, user.name),
          h('small', null, user.kind === 'admin' ? 'Admin account' : 'Signed in with Discord')
        )
      ),
      h('a', { href: '/app/', role: 'menuitem' }, 'Tools'),
      h('a', { href: '/app/settings/', role: 'menuitem' }, 'My settings'),
      user.kind === 'admin'
        ? h('a', { href: '/app/polls/settings/', role: 'menuitem' }, 'General settings')
        : null,
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onclick: function () {
            M.api('DELETE', '/api/auth').then(function () {
              remember(null);
              window.location.href = '/app/login/';
            });
          },
        },
        'Sign out'
      )
    );
    var button = h(
      'button',
      {
        type: 'button',
        class: 'app-user-button',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-controls': 'appMenu',
        'aria-label': 'Profile: ' + user.name,
      },
      avatar(user, 30),
      h('span', { class: 'app-user-name' }, user.name),
      h('span', { class: 'app-caret', 'aria-hidden': 'true' }, '▾')
    );

    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    }
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener('click', function (e) {
      if (!slot.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        button.focus();
      }
    });

    M.clear(slot);
    slot.appendChild(button);
    slot.appendChild(menu);
  }

  /** Resolves with the signed-in user ({ id, kind, name, avatarUrl }). */
  M.me = M.api('GET', '/api/auth').then(function (info) {
    if (!info.user) return toLogin();
    remember(info.user);
    showUser(info.user);
    // Admin-only items are shown by CSS once <html> has data-admin.
    if (info.user.kind === 'admin') document.documentElement.setAttribute('data-admin', '');
    else document.documentElement.removeAttribute('data-admin');
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
