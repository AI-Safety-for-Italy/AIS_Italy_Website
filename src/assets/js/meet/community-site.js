/* Members board → Website (/app/members/site/): what the Community page of
 * the website shows against the board (server/community.js, siteState).
 * Nothing on the board reaches the website until "Update the website": it
 * stores what may be shown (who consented, with their public fields, and
 * the working groups) and starts a build, online in about ten minutes.
 * Here: what the next update changes, name by name, and the last one's
 * build. From the sync bar's status (Meet.board). */
(function () {
  'use strict';
  var M = window.Meet;
  var B = M.board;
  var h = M.h;
  var API = B.API;
  var view = document.getElementById('siteView');
  var publishing = false;

  view.appendChild(M.loading());
  B.onStatus(render);

  function list(title, names, tone) {
    if (!names.length) return null;
    return h(
      'div',
      { class: 'mb-diff-block is-' + tone },
      h('h4', null, title, h('span', { class: 'crm-count' }, ' ' + names.length)),
      h(
        'ul',
        { class: 'mb-diff-list' },
        names.map(function (n) {
          return typeof n === 'string'
            ? h('li', null, n)
            : h('li', null, n.title, h('span', { class: 'mb-sub' }, ' — ' + n.fields.join(', ')));
        })
      )
    );
  }

  function render(state) {
    var site = state.site;
    var build = B.buildState(site);
    var built = B.built();
    M.clear(view);

    // Where the website stands.
    var tone, title, text;
    if (build === 'building') {
      tone = 'busy';
      title = 'Updating the website';
      text =
        'Published ' +
        B.when(site.publishedAt) +
        ': online in a few minutes. This page looks again every half minute.';
    } else if (build === 'late') {
      tone = 'todo';
      title = 'The last update may have failed';
      text =
        'Published ' +
        B.when(site.publishedAt) +
        ', but the website still shows ' +
        (built && built.publishedAt
          ? 'the update of ' + B.when(built.publishedAt)
          : 'the old directory') +
        '. Update again.';
    } else if (!site.live) {
      tone = 'todo';
      title = 'The website still shows the old directory';
      text =
        'The Community page reads data/members.yaml. Updating puts the board’s list there instead.';
    } else if (site.pending) {
      tone = 'todo';
      title = B.plural(site.changes, 'change') + ' not online';
      text = 'The Community page shows the update of ' + B.when(site.publishedAt) + '.';
    } else {
      tone = 'ok';
      title = 'The website is up to date';
      text =
        'The Community page shows the board as it is (updated ' + B.when(site.publishedAt) + ').';
    }

    var publish = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: publishing || (site.live && !site.pending && build !== 'late'),
        onclick: function () {
          B.confirm({
            title: 'Update the website?',
            effects: [
              {
                where: 'site',
                text:
                  'The Community page shows ' +
                  B.plural(site.draft.members, 'member') +
                  ' (those who consented) and ' +
                  B.plural(site.draft.groups, 'working group') +
                  ', online in about ten minutes.',
              },
              { where: 'db', text: 'Nothing changes.' },
              { where: 'discord', text: 'Nothing changes.' },
            ],
            ok: 'Update the website',
          }).then(function (yes) {
            if (!yes) return;
            publishing = true;
            publish.disabled = true;
            M.api('POST', API + '?action=publish', {})
              .then(function (r) {
                M.toast(
                  r.build && r.build.started
                    ? 'The website updates in a few minutes'
                    : 'Saved; the website updates at its next build (' +
                        ((r.build && r.build.detail) || 'no build started') +
                        ')'
                );
              })
              .catch(M.appError)
              .then(function () {
                publishing = false;
                B.refresh();
              });
          });
        },
      },
      'Update the website'
    );

    view.appendChild(
      h(
        'section',
        { class: 'panel mb-site-hero is-' + tone },
        h('span', { class: 'mb-sync-dot', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'mb-site-hero-text' },
          h('h3', null, title),
          h('p', { class: 'mb-sub' }, text)
        ),
        publish
      )
    );

    // What the next update changes.
    var d = site.diff || {
      members: { added: [], removed: [], changed: [] },
      groups: { added: [], removed: [], changed: [] },
    };
    var any =
      d.members.added.length +
      d.members.removed.length +
      d.members.changed.length +
      d.groups.added.length +
      d.groups.removed.length +
      d.groups.changed.length;
    view.appendChild(
      h(
        'section',
        { class: 'panel mb-card' },
        h(
          'div',
          { class: 'mb-card-head' },
          h('h3', null, 'What the next update changes'),
          h('span', { class: 'mb-sub' }, site.live ? 'Against what is online' : 'Everything is new')
        ),
        any
          ? h(
              'div',
              { class: 'mb-diff' },
              list('People added', d.members.added, 'add'),
              list('People changed', d.members.changed, 'change'),
              list('People removed', d.members.removed, 'remove'),
              list('Working groups added', d.groups.added, 'add'),
              list('Working groups changed', d.groups.changed, 'change'),
              list('Working groups removed', d.groups.removed, 'remove')
            )
          : h(
              'p',
              { class: 'panel-note mb-none' },
              'Nothing: the website shows the board as it is.'
            )
      )
    );

    // In numbers, and the way back.
    view.appendChild(
      h(
        'section',
        { class: 'panel mb-card' },
        h('div', { class: 'mb-card-head' }, h('h3', null, 'On the Community page')),
        h(
          'div',
          { class: 'mb-site-numbers' },
          number(site.members, 'people online'),
          number(site.groups, 'working groups online'),
          number(site.draft.members, 'people after the update'),
          number(site.draft.groups, 'groups after the update')
        ),
        h(
          'p',
          { class: 'panel-note' },
          'Only those who consented are shown, with their name, place, areas, profile link and groups. Who is shown is set on each member’s page.'
        ),
        site.live
          ? h(
              'details',
              { class: 'mb-advanced' },
              h('summary', null, 'Advanced'),
              h(
                'p',
                { class: 'panel-note' },
                'Take the Community page back to the old directory (data/members.yaml), as before the board. The board keeps everything.'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm',
                  onclick: function () {
                    B.confirm({
                      title: 'Back to the old directory?',
                      effects: [
                        {
                          where: 'site',
                          text: 'The Community page shows data/members.yaml again, in about ten minutes.',
                        },
                      ],
                      ok: 'Go back',
                      danger: true,
                    }).then(function (yes) {
                      if (!yes) return;
                      M.api('POST', API + '?action=unpublish', {})
                        .then(function () {
                          M.toast('The website goes back to the old directory');
                          B.refresh();
                        })
                        .catch(M.appError);
                    });
                  },
                },
                'Back to the old directory'
              )
            )
          : null
      )
    );
  }

  function number(n, label) {
    return h('div', { class: 'mb-number' }, h('strong', null, String(n)), h('span', null, label));
  }
})();
