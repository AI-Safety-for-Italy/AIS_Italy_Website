/* The bar on top of the members board's tabs (Members, Working groups,
 * Discord): three questions, each with its count and one button.
 *   Discord accounts  who is who on Discord: the members not linked yet
 *                     are linked on the Discord tab
 *   Discord roles     the tags here are what Discord should have: "Give the
 *                     roles" brings the missing ones there (nothing else
 *                     changes Discord); roles there without a tag are
 *                     reviewed on the Discord tab
 *   Website           the public directory: "Update the website" puts the
 *                     list as it is now on the Community page
 * From /api/app/community?action=status. Meet.communityStatus.refresh()
 * after any change on the page. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var API = '/api/app/community';
  var bar = document.getElementById('membersStatus');
  var state = null;
  var giving = null; // { given, failed, remaining } while giving the roles
  var onDiscordTab = /\/app\/members\/discord\//.test(window.location.pathname);

  function when(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function refresh() {
    if (!bar) return Promise.resolve();
    return M.api('GET', API + '?action=status')
      .then(function (s) {
        state = s;
        draw();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        bar.hidden = true;
      });
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** One row: its title, what stands, and the action. */
  function row(title, done, text, action) {
    return h(
      'div',
      { class: 'ms-row' + (done ? ' is-done' : '') },
      h('span', { class: 'ms-mark', 'aria-hidden': 'true' }, done ? '✓' : '•'),
      h('strong', { class: 'ms-title' }, title),
      h('span', { class: 'ms-text' }, text),
      h('span', { class: 'ms-action' }, action)
    );
  }

  function toDiscordTab(label, anchor) {
    if (onDiscordTab) {
      return h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          onclick: function () {
            var el = document.getElementById(anchor);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        label
      );
    }
    return h(
      'a',
      { class: 'btn btn-outline btn-sm', href: '/app/members/discord/#' + anchor },
      label
    );
  }

  function accountsRow(a) {
    if (!a.toLink) {
      return row(
        'Discord accounts',
        true,
        'Everyone is linked' +
          (a.absent ? ' or checked (' + plural(a.absent, 'is', 'are') + ' not on Discord)' : '') +
          '.',
        null
      );
    }
    return row(
      'Discord accounts',
      false,
      a.linked +
        ' of ' +
        a.members +
        ' members linked' +
        (a.absent ? ', ' + a.absent + ' not on Discord' : '') +
        '.',
      toDiscordTab('Link the ' + a.toLink + ' →', 'link')
    );
  }

  /** "Give the roles": send-tags until none is left, with the progress. */
  function giveRoles(button) {
    if (
      !window.confirm(
        'Give on Discord the roles of their tags to the ' +
          plural(state.roles.missingMembers, 'member who misses them', 'members who miss them') +
          '? No role is taken away.'
      )
    )
      return;
    button.disabled = true;
    giving = { given: 0, failed: 0, remaining: state.roles.missing };
    draw();
    (function step() {
      M.api('POST', API + '?action=send-tags', {})
        .then(function (r) {
          giving.given += r.given;
          giving.failed += r.failed;
          giving.remaining = r.remaining;
          draw();
          if (r.remaining > 0 && r.given + r.failed > 0) return step();
          M.toast(
            plural(giving.given, 'role', 'roles') +
              ' given on Discord' +
              (giving.failed ? '; ' + giving.failed + ' did not go: try again later' : '')
          );
          giving = null;
          refresh();
          document.dispatchEvent(new CustomEvent('members-roles-given'));
        })
        .catch(function (err) {
          giving = null;
          refresh();
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
        });
    })();
  }

  function rolesRow(r) {
    if (!r.available) {
      return row('Discord roles', false, 'Not readable here: ' + r.problem + '.', null);
    }
    if (giving) {
      return row(
        'Discord roles',
        false,
        'Giving the roles… ' + giving.given + ' given, ' + giving.remaining + ' left.',
        null
      );
    }
    var also = [];
    if (r.extra) also.push(plural(r.extra, 'role', 'roles') + ' on Discord without a tag');
    if (r.gone) also.push(plural(r.gone, 'account', 'accounts') + ' no longer on the server');
    var review = also.length ? toDiscordTab('Review', 'roles') : null;
    if (!r.missing) {
      return row(
        'Discord roles',
        !also.length,
        'Everyone linked has the roles of their tags' +
          (also.length ? '; ' + also.join(', ') + '.' : '.'),
        review
      );
    }
    var give = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          giveRoles(give);
        },
      },
      'Give the roles'
    );
    return row(
      'Discord roles',
      false,
      plural(r.missingMembers, 'member misses', 'members miss') +
        ' the role of a tag (' +
        plural(r.missing, 'role', 'roles') +
        ')' +
        (also.length ? '; ' + also.join(', ') : '') +
        '.',
      [give, review]
    );
  }

  function siteRow(site) {
    var update = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          if (
            !window.confirm(
              'Update the Community page of the website with the list as it is now (who consented, and the working groups)? It changes in a few minutes.'
            )
          )
            return;
          update.disabled = true;
          M.api('POST', API + '?action=publish', {})
            .then(function (r) {
              M.toast(
                r.build && r.build.started
                  ? 'The website updates in a few minutes'
                  : 'Saved; the website updates at its next build (' +
                      ((r.build && r.build.detail) || 'no build started') +
                      ')'
              );
              refresh();
            })
            .catch(function (err) {
              update.disabled = false;
              M.appError(err);
            });
        },
      },
      'Update the website'
    );
    var back = site.live
      ? h(
          'button',
          {
            type: 'button',
            class: 'link-button ms-back',
            onclick: function () {
              if (
                !window.confirm('Take the website back to the old directory (data/members.yaml)?')
              )
                return;
              M.api('POST', API + '?action=unpublish', {})
                .then(function () {
                  M.toast('The website goes back to the old directory');
                  refresh();
                })
                .catch(M.appError);
            },
          },
          'Back to the old directory'
        )
      : null;
    if (!site.live) {
      return row(
        'Website',
        false,
        'The Community page still shows the old directory: updating puts this list there.',
        update
      );
    }
    if (!site.pending) {
      return row(
        'Website',
        true,
        'The Community page shows this list (updated ' + when(site.publishedAt) + ').',
        back
      );
    }
    return row(
      'Website',
      false,
      plural(site.changes, 'change', 'changes') +
        ' not on the Community page yet (last updated ' +
        when(site.publishedAt) +
        ').',
      [update, back]
    );
  }

  function draw() {
    if (!bar || !state) return;
    M.clear(bar);
    bar.hidden = false;
    bar.appendChild(accountsRow(state.accounts));
    bar.appendChild(rolesRow(state.roles));
    bar.appendChild(siteRow(state.site));
  }

  if (bar) {
    bar.appendChild(M.loading());
    M.me.then(refresh);
  }

  M.communityStatus = { refresh: refresh };
})();
