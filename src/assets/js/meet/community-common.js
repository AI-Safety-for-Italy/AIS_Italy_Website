/* What every page of the members board shares (Members, a member's page,
 * Working groups, Discord, Website), as Meet.board:
 *
 *   - The sync bar on top: where the three places stand, always in the same
 *     order and the same words.
 *       Database  every change on the board is saved there at once
 *       Discord   changes waiting to be applied there, and what Discord has
 *                 that the board does not say (the Discord tab)
 *       Website   changes not online yet (the Website tab), and whether the
 *                 last update is built
 *     From /api/app/community?action=status and the site's own
 *     /community/version.json. board.refresh() after any change.
 *   - confirm(): the one dialog before anything that leaves the database:
 *     it lists what changes, and where (Database, Discord, Website).
 *   - Small pieces: role names as on Discord, badges, dates, the batched
 *     apply loop.
 * Everything typed by people goes on the page as text (h() makes text nodes). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var API = '/api/app/community';
  var bar = document.getElementById('boardSync');
  var state = null;
  var built; // /community/version.json: { publishedAt, members, groups }; null if unknown
  var recheck = null;
  var listeners = [];
  // A build takes about ten minutes: past this the update most likely failed.
  var BUILD_MINUTES = 30;
  var here = window.location.pathname;

  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function day(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }

  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  /** The publish the website's build shows, or null when it cannot tell. */
  function siteVersion() {
    if (!window.fetch) return Promise.resolve(null);
    return fetch('/community/version.json', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Whether the website's build shows the last update: building | late | null. */
  function buildState(site) {
    if (!site || !site.live || !built || built.publishedAt === site.publishedAt) return null;
    var late = Date.now() - new Date(site.publishedAt).getTime() > BUILD_MINUTES * 60000;
    return late ? 'late' : 'building';
  }

  // ── The sync bar ─────────────────────────────────────────────────────────

  function refresh() {
    return Promise.all([M.api('GET', API + '?action=status'), siteVersion()])
      .then(function (r) {
        state = r[0];
        built = r[1];
        draw();
        listeners.forEach(function (fn) {
          fn(state);
        });
        return state;
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        if (bar) bar.hidden = true;
      });
  }

  /** One place: its name, where it stands, and where to go. */
  function place(key, tone, title, text, link) {
    var inner = [
      h('span', { class: 'mb-sync-dot', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'mb-sync-text' },
        h('span', { class: 'mb-sync-name' }, title),
        h('span', { class: 'mb-sync-state' }, text)
      ),
    ];
    var attrs = { class: 'mb-sync-place is-' + tone, 'data-place': key };
    if (link && here.indexOf(link) !== 0) {
      attrs.href = link;
      inner.push(h('span', { class: 'mb-sync-go', 'aria-hidden': 'true' }, '→'));
      return h('a', attrs, inner);
    }
    if (link) attrs['aria-current'] = 'page';
    return h('div', attrs, inner);
  }

  function discordPlace(d, accounts) {
    if (!d.available)
      return place(
        'discord',
        'muted',
        'Discord',
        'Not readable here: ' + d.problem,
        '/app/members/discord/'
      );
    var parts = [];
    if (d.toApply) parts.push(plural(d.toApply, 'change') + ' to apply');
    if (d.toDecide) parts.push(d.toDecide + ' to decide');
    if (d.gone) parts.push(d.gone + ' left the server');
    if (d.noRole) parts.push(d.noRole + ' with no role');
    if (accounts.toLink) parts.push(accounts.toLink + ' to link');
    if (!parts.length)
      return place('discord', 'ok', 'Discord', 'In step with the board', '/app/members/discord/');
    return place(
      'discord',
      d.toApply ? 'todo' : 'ask',
      'Discord',
      parts.join(' · '),
      '/app/members/discord/'
    );
  }

  function sitePlace(site) {
    var b = buildState(site);
    if (b === 'building')
      return place(
        'site',
        'busy',
        'Website',
        'Updating: online in a few minutes',
        '/app/members/site/'
      );
    if (b === 'late')
      return place(
        'site',
        'todo',
        'Website',
        'The last update may have failed',
        '/app/members/site/'
      );
    if (!site.live)
      return place('site', 'todo', 'Website', 'Still the old directory', '/app/members/site/');
    if (site.pending)
      return place(
        'site',
        'todo',
        'Website',
        plural(site.changes, 'change') + ' not online',
        '/app/members/site/'
      );
    return place(
      'site',
      'ok',
      'Website',
      'Up to date · ' + day(site.publishedAt),
      '/app/members/site/'
    );
  }

  function draw() {
    if (!bar || !state) return;
    M.clear(bar);
    bar.hidden = false;
    bar.appendChild(place('db', 'ok', 'Database', 'Every change saved at once', null));
    bar.appendChild(h('span', { class: 'mb-sync-arrow', 'aria-hidden': 'true' }));
    bar.appendChild(discordPlace(state.discord, state.accounts));
    bar.appendChild(sitePlace(state.site));
    // While the website is being rebuilt, look again every half minute.
    if (buildState(state.site) === 'building' && !recheck) {
      recheck = setTimeout(function () {
        recheck = null;
        refresh();
      }, 30000);
    }
  }

  // ── The confirm dialog ───────────────────────────────────────────────────

  var dialog = null;

  /**
   * Asks before something: opts { title, text?, effects: [{ where: 'db' |
   * 'discord' | 'site', text }], ok, danger? }. Resolves true or false.
   */
  function confirm(opts) {
    if (!dialog) {
      dialog = h('dialog', {
        class: 'meet-dialog mb-confirm',
        'aria-labelledby': 'mbConfirmTitle',
      });
      document.body.appendChild(dialog);
    }
    M.clear(dialog);
    return new Promise(function (resolve) {
      var done = function (v) {
        dialog.close();
        resolve(v);
      };
      var ok = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
          onclick: function () {
            done(true);
          },
        },
        opts.ok || 'Confirm'
      );
      dialog.appendChild(
        h(
          'div',
          { class: 'dialog-body' },
          h('h2', { id: 'mbConfirmTitle' }, opts.title),
          opts.text ? h('p', { class: 'mb-confirm-text' }, opts.text) : null,
          opts.effects && opts.effects.length
            ? h(
                'ul',
                { class: 'mb-effects' },
                opts.effects.map(function (e) {
                  return h(
                    'li',
                    { class: 'mb-effect is-' + e.where },
                    h('span', { class: 'mb-effect-where' }, WHERE[e.where] || e.where),
                    h('span', null, e.text)
                  );
                })
              )
            : null
        )
      );
      dialog.appendChild(
        h(
          'div',
          { class: 'dialog-foot' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                done(false);
              },
            },
            'Cancel'
          ),
          ok
        )
      );
      dialog.onclose = function () {
        resolve(false);
      };
      dialog.showModal();
      ok.focus();
    });
  }

  var WHERE = { db: 'Database', discord: 'Discord', site: 'Website' };

  /**
   * Applies Discord changes (ids from the plan), 15 at a time as the server
   * takes them, telling `progress(done, total)`. Resolves { done, failed }.
   */
  function applyAll(items, opts) {
    opts = opts || {};
    var total = items.length;
    var out = { done: 0, failed: 0 };
    function step() {
      return M.api('POST', API + '?action=apply', { items: items, member: opts.member }).then(
        function (r) {
          out.done += r.done;
          out.failed += r.failed;
          if (opts.progress) opts.progress(out.done + out.failed, total);
          if (r.remaining > 0 && r.done + r.failed > 0) return step();
          return out;
        }
      );
    }
    return step();
  }

  // ── Small pieces ─────────────────────────────────────────────────────────

  /** The name of the member's role as on Discord, from the list's `roles`. */
  function roleName(roles, key) {
    var r = (roles || []).filter(function (x) {
      return x.key === key;
    })[0];
    return r ? r.name : key === 'organizer' ? 'Organizzatore' : 'Partecipante';
  }

  function roleChip(roles, key) {
    return h('span', { class: 'mb-role is-' + key }, roleName(roles, key));
  }

  var SITE = {
    online: { label: 'Online', tone: 'ok' },
    changed: { label: 'Changed', tone: 'todo' },
    waiting: { label: 'Not online yet', tone: 'todo' },
    hidden: { label: 'Hidden', tone: 'muted' },
  };

  function pill(tone, text, title) {
    return h('span', { class: 'mb-pill is-' + tone, title: title || null }, text);
  }

  function sitePill(status) {
    var s = SITE[status] || SITE.hidden;
    return pill(
      s.tone,
      s.label,
      status === 'hidden' ? 'Not on the website: no consent to show them' : null
    );
  }

  function avatar(person, size) {
    if (person && person.avatarUrl)
      return h('img', {
        class: 'mb-avatar',
        src: person.avatarUrl,
        alt: '',
        width: size || 28,
        height: size || 28,
        loading: 'lazy',
      });
    var name = (person && (person.displayName || person.name || person.username)) || '?';
    return h(
      'span',
      { class: 'mb-avatar is-initial', 'aria-hidden': 'true' },
      name.charAt(0).toUpperCase()
    );
  }

  function empty(title, text, extra) {
    return h(
      'div',
      { class: 'empty-state' },
      h('h3', null, title),
      h('p', null, text),
      extra || null
    );
  }

  function fail(view) {
    return function (err) {
      if (err.status === 401) return M.appError(err);
      if (err.status === 403 || err.status === 503) {
        M.clear(view);
        if (bar) bar.hidden = true;
        view.appendChild(empty(err.status === 403 ? 'No access' : 'Not set up yet', err.message));
        return;
      }
      M.appError(err);
    };
  }

  // ── Discord changes, in words ────────────────────────────────────────────

  /** A change waiting on Discord: { verb: 'Give' | 'Take off', role, why }. */
  function itemText(i) {
    var why = {
      group: 'in the group here',
      role: i.op === 'add' ? 'their role here' : 'no longer their role here',
      untagged: 'taken out of the group here',
      retired: 'the group ' + (i.groupTitle || '') + ' was removed or given another role',
      archived: 'they were offboarded',
    }[i.reason];
    if (i.op === 'add' && i.main === 'differs')
      why = 'their role here (they have the other one there)';
    return { verb: i.op === 'add' ? 'Give' : 'Take off', role: i.roleName, why: why || '' };
  }

  /** What Discord has that the board does not say. */
  function decideText(i) {
    return i.kind === 'main'
      ? 'Has ' + i.roleName + ' on Discord, but is a participant here'
      : 'Has ' + i.roleName + ' on Discord, but is not in the group here';
  }

  /** The choices for an item, as [{ choice, label, tone }]. */
  function choicesFor(i) {
    if (i.op === 'add') {
      var out = [];
      if (i.group) out.push({ choice: 'untag', label: 'Take the tag off here' });
      if (i.main === 'differs') out.push({ choice: 'here', label: 'Make them a participant here' });
      out.push({ choice: 'ignore', label: 'Leave it missing' });
      return out;
    }
    if (i.op === 'remove')
      return i.reason === 'retired'
        ? [{ choice: 'forget', label: 'Stop listing this role' }]
        : [{ choice: 'keep', label: 'Keep it on Discord' }];
    if (i.kind)
      return [
        {
          choice: 'tag',
          label: i.kind === 'main' ? 'Make them an organizer here' : 'Put them in the group here',
        },
        { choice: 'remove', label: 'Take it off Discord' },
        { choice: 'ignore', label: 'Leave it' },
      ];
    return [];
  }

  /** Settles items here (decideDiscord). */
  function decide(ids, choice) {
    return M.api('POST', API + '?action=decide', { items: ids, choice: choice });
  }

  // ── Linking a member to their Discord account ────────────────────────────

  /**
   * Who a member not linked yet may be on Discord: the accounts suggested by
   * their name, a search of the server, and "Not on Discord". Linking says
   * who they are, nothing changes on Discord. opts { member, done(member),
   * compact }.
   */
  function linker(opts) {
    var m = opts.member;
    var box = h('div', { class: 'mb-linker' });
    var list = h('div', { class: 'mb-link-list' }, M.loading('Looking on Discord…'));
    var results = h('div', { class: 'mb-link-list', hidden: true });
    var timer = null;
    var search = h('input', {
      type: 'search',
      class: 'form-input is-compact',
      placeholder: 'Search the server by name…',
      'aria-label': 'Search Discord for ' + m.name,
      'data-unsaved-ignore': '',
      oninput: function () {
        clearTimeout(timer);
        var q = search.value.trim();
        if (q.length < 2) {
          results.hidden = true;
          return;
        }
        timer = setTimeout(function () {
          M.api('GET', API + '?people=' + encodeURIComponent(q))
            .then(function (d) {
              M.clear(results);
              results.hidden = false;
              if (!d.people.length)
                results.appendChild(h('p', { class: 'panel-note' }, 'Nobody found.'));
              d.people.forEach(function (p) {
                results.appendChild(
                  account({ discordId: p.discordId, displayName: p.name, avatarUrl: p.avatarUrl })
                );
              });
            })
            .catch(M.appError);
        }, 250);
      },
    });

    function account(p) {
      return h(
        'div',
        { class: 'mb-account' },
        avatar(p, 28),
        h(
          'span',
          { class: 'mb-account-name' },
          h('strong', null, p.displayName || p.username),
          p.username ? h('span', { class: 'mb-sub' }, '@' + p.username) : null
        ),
        p.score === 3 ? pill('ok', 'Same name') : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function (e) {
              e.target.disabled = true;
              M.api('POST', API + '?action=link', { member: m.id, discordId: p.discordId })
                .then(function (r) {
                  M.toast(m.name + ' linked. Their roles wait on the Discord tab.', false, {
                    label: 'Undo',
                    run: function () {
                      M.api('POST', API + '?action=link', { member: m.id, discordId: null })
                        .then(function (u) {
                          refresh();
                          opts.done(u.member);
                        })
                        .catch(M.appError);
                    },
                  });
                  refresh();
                  opts.done(r.member);
                })
                .catch(function (err) {
                  e.target.disabled = false;
                  M.appError(err);
                });
            },
          },
          'That’s them'
        )
      );
    }

    M.api('GET', API + '?suggest=' + encodeURIComponent(m.id))
      .then(function (r) {
        M.clear(list);
        if (r.bot === false) {
          list.appendChild(
            h(
              'p',
              { class: 'panel-note' },
              'The Discord bot is not set up here: search by name below.'
            )
          );
          return;
        }
        if (!r.suggestions.length)
          list.appendChild(
            h('p', { class: 'panel-note' }, 'No account on the server with their name.')
          );
        r.suggestions.forEach(function (s) {
          list.appendChild(account(s));
        });
      })
      .catch(function () {
        M.clear(list);
      });

    var absent = h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        onclick: function () {
          var note = h('input', {
            class: 'form-input is-compact',
            maxlength: 300,
            placeholder: 'A note, e.g. “asked by email, not on Discord”',
            'aria-label': 'Note',
          });
          var row = h(
            'div',
            { class: 'mb-absent-form' },
            note,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  M.api('POST', API + '?action=absent', {
                    member: m.id,
                    absent: true,
                    note: note.value,
                  })
                    .then(function (r) {
                      M.toast(m.name + ': checked, not on Discord');
                      refresh();
                      opts.done(r.member);
                    })
                    .catch(M.appError);
                },
              },
              'Mark as not on Discord'
            )
          );
          absent.replaceWith(row);
          note.focus();
        },
      },
      'They are not on Discord'
    );
    box.appendChild(list);
    box.appendChild(search);
    box.appendChild(results);
    box.appendChild(absent);
    return box;
  }

  /**
   * Draws `view` anew without the page jumping: its height is held while it
   * is emptied and filled again, and the scroll put back where it was.
   */
  function redraw(view, draw) {
    var y = window.scrollY;
    view.style.minHeight = view.offsetHeight + 'px';
    try {
      draw();
    } finally {
      view.style.minHeight = '';
      if (window.scrollY !== y) window.scrollTo(0, y);
    }
  }

  if (bar) {
    bar.appendChild(M.loading());
    M.me.then(refresh);
  }

  M.board = {
    API: API,
    refresh: refresh,
    onStatus: function (fn) {
      listeners.push(fn);
      if (state) fn(state);
    },
    state: function () {
      return state;
    },
    built: function () {
      return built;
    },
    buildState: buildState,
    confirm: confirm,
    applyAll: applyAll,
    linker: linker,
    redraw: redraw,
    itemText: itemText,
    decideText: decideText,
    choicesFor: choicesFor,
    decide: decide,
    roleName: roleName,
    roleChip: roleChip,
    sitePill: sitePill,
    pill: pill,
    avatar: avatar,
    empty: empty,
    fail: fail,
    when: when,
    day: day,
    plural: plural,
    fold: fold,
  };
})();
