/* Pages of the signed-in area (/app/): checks who is signed in, shows them in
 * the sidebar with a sign-out menu, and sends anyone signed out to the login;
 * runs the frame of src/components/app.njk (which tools show, their to-do
 * counts, the menu on a phone, the Ctrl+K search).
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

  var auth = M.api('GET', '/api/auth');

  /** Resolves with what the user's Discord roles allow in the content tool
   * (keys from server/permissions.js; all of them for the admin). */
  M.permissions = auth.then(function (info) {
    return info.permissions || [];
  });

  /** Resolves with the tools the user's roles open: { content, crm, forms, members }. */
  M.areas = auth.then(function (info) {
    return info.areas || {};
  });

  /** Resolves with the signed-in user ({ id, kind, name, avatarUrl }). */
  M.me = auth.then(function (info) {
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

  // ── The frame (src/components/app.njk): tools, counts, menu, search ──────

  var AREAS_CACHE = 'ais-areas';
  var shell = document.getElementById('apShell');
  var registry = [];
  try {
    registry = JSON.parse((document.getElementById('apTools') || {}).textContent || '[]');
  } catch (e) {
    registry = [];
  }

  /** Shows the tools these areas open, and the tabs these permissions open. */
  function showAllowed(areas, perms, isAdmin) {
    document.querySelectorAll('[data-area]').forEach(function (el) {
      el.hidden = !areas[el.getAttribute('data-area')];
    });
    if (!perms) return;
    document.querySelectorAll('[data-needs]').forEach(function (el) {
      el.hidden = perms.indexOf(el.getAttribute('data-needs')) === -1;
    });
    if (isAdmin !== undefined) {
      document.querySelectorAll('.ap-tabs .admin-only').forEach(function (el) {
        el.hidden = !isAdmin;
      });
    }
  }

  if (shell) {
    // Last visit's tools at once, so the sidebar does not jump.
    try {
      var cached = JSON.parse(window.localStorage.getItem(AREAS_CACHE) || 'null');
      if (cached) showAllowed(cached);
    } catch (e) {
      /* nothing cached */
    }
    auth.then(function (info) {
      if (!info.user) return;
      var areas = info.areas || {};
      showAllowed(areas, info.permissions || [], info.user.kind === 'admin');
      try {
        window.localStorage.setItem(AREAS_CACHE, JSON.stringify(areas));
      } catch (e) {
        /* the sidebar just shows a moment later next time */
      }
    });
  }

  /** What waits for the member in each tool: { tools: { key: { count, label, url } } }. */
  M.overview = shell
    ? M.me
        .then(function () {
          return M.api('GET', '/api/app/overview');
        })
        .catch(function () {
          return { tools: {} };
        })
    : Promise.resolve({ tools: {} });

  M.overview.then(function (data) {
    Object.keys(data.tools || {}).forEach(function (key) {
      var todo = data.tools[key];
      document.querySelectorAll('[data-ap-count="' + key + '"]').forEach(function (el) {
        el.textContent = todo && todo.count ? String(todo.count) : '';
        el.hidden = !(todo && todo.count);
        if (todo && todo.label) el.title = todo.count + ' ' + todo.label;
      });
    });
  });

  // The menu on a narrow screen: the sidebar slides in.
  var nav = document.getElementById('apNav');
  var openMenu = document.getElementById('apMenu');
  var scrim = document.getElementById('apScrim');
  function setMenu(open) {
    if (!shell) return;
    shell.classList.toggle('is-menu-open', open);
    if (scrim) scrim.hidden = !open;
    if (openMenu) openMenu.setAttribute('aria-expanded', String(open));
    if (open && nav) {
      var first = nav.querySelector('a, button');
      if (first) first.focus();
    }
  }
  if (openMenu)
    openMenu.addEventListener('click', function () {
      setMenu(true);
    });
  if (scrim)
    scrim.addEventListener('click', function () {
      setMenu(false);
    });
  var closeMenu = document.getElementById('apNavClose');
  if (closeMenu)
    closeMenu.addEventListener('click', function () {
      setMenu(false);
      if (openMenu) openMenu.focus();
    });

  // ── Search (Ctrl+K): go to a tool, a tab or an action ───────────────────

  var palette = null;

  function entries(areas, perms, isAdmin) {
    var out = [{ label: 'Home', hint: 'Personal area', url: '/app/' }];
    registry.forEach(function (tool) {
      if (tool.area && !areas[tool.area]) return;
      out.push({ label: tool.title, hint: 'Tool', url: tool.url });
      (tool.tabs || []).forEach(function (tab) {
        if (tab.needs && perms.indexOf(tab.needs) === -1) return;
        if (tab.admin && !isAdmin) return;
        if (tab.url === tool.url) return;
        out.push({ label: tab.label, hint: tool.title, url: tab.url });
      });
      (tool.actions || []).forEach(function (action) {
        if (action.needs && perms.indexOf(action.needs) === -1) return;
        out.push({ label: action.label, hint: tool.title + ' · action', url: action.url });
      });
    });
    out.push({ label: 'My settings', hint: 'Notifications', url: '/app/settings/' });
    return out;
  }

  function openPalette() {
    if (palette) {
      palette.input.focus();
      return;
    }
    auth.then(function (info) {
      var all = entries(
        info.areas || {},
        info.permissions || [],
        info.user && info.user.kind === 'admin'
      );
      var active = 0;
      var shown = all;
      var input = h('input', {
        type: 'search',
        class: 'ap-palette-input',
        placeholder: 'Go to a tool or do something…',
        'aria-label': 'Search the personal area',
        'aria-controls': 'apPaletteList',
        autocomplete: 'off',
      });
      var list = h('ul', { class: 'ap-palette-list', id: 'apPaletteList', role: 'listbox' });
      var box = h(
        'div',
        { class: 'ap-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
        h(
          'div',
          { class: 'ap-palette-box' },
          h('div', { class: 'ap-palette-field' }, input, h('kbd', null, 'Esc')),
          list
        )
      );
      function draw() {
        var q = input.value.trim().toLowerCase();
        shown = all.filter(function (e) {
          return !q || (e.label + ' ' + e.hint).toLowerCase().indexOf(q) !== -1;
        });
        active = Math.min(active, Math.max(shown.length - 1, 0));
        M.clear(list);
        if (!shown.length)
          list.appendChild(h('li', { class: 'ap-palette-none' }, 'Nothing matches.'));
        shown.forEach(function (e, i) {
          list.appendChild(
            h(
              'li',
              {
                role: 'option',
                'aria-selected': String(i === active),
                class: 'ap-palette-item',
                onmousemove: function () {
                  if (active !== i) {
                    active = i;
                    draw();
                  }
                },
                onclick: function () {
                  go(e);
                },
              },
              h('span', null, e.label),
              h('small', null, e.hint)
            )
          );
        });
      }
      function go(e) {
        close();
        window.location.href = e.url;
      }
      function close() {
        box.remove();
        palette = null;
      }
      input.addEventListener('input', function () {
        active = 0;
        draw();
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          active = Math.min(active + 1, shown.length - 1);
          draw();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          active = Math.max(active - 1, 0);
          draw();
        } else if (ev.key === 'Enter' && shown[active]) {
          ev.preventDefault();
          go(shown[active]);
        } else if (ev.key === 'Escape') {
          close();
        }
      });
      box.addEventListener('click', function (ev) {
        if (ev.target === box) close();
      });
      document.body.appendChild(box);
      palette = { input: input, close: close };
      draw();
      input.focus();
    });
  }

  var searchButton = document.getElementById('apSearchOpen');
  if (searchButton) searchButton.addEventListener('click', openPalette);
  document.addEventListener('keydown', function (e) {
    if (!shell) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (palette) palette.close();
      else openPalette();
    } else if (e.key === 'Escape' && shell.classList.contains('is-menu-open')) {
      setMenu(false);
    }
  });

  M.statusBadge = function (status) {
    var label = { open: 'Open', closed: 'Closed', scheduled: 'Time chosen' }[status] || status;
    return h('span', { class: 'badge badge-' + status }, label);
  };
})();
