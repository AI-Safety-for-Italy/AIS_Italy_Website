/* The bar on Members and Working groups: what the site shows, whether the
 * list has changed since, and the button that publishes it (nothing reaches
 * the site otherwise). Meet.communitySite.draw(site) with the `site` of
 * /api/app/community: { live, publishedAt, pending }. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var bar = document.getElementById('siteBar');
  var state = null;

  function when(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function draw(site) {
    if (!bar || !site) return;
    state = site;
    M.clear(bar);
    bar.hidden = false;
    var text = !site.live
      ? 'The site still shows the old directory (data/members.yaml). Publishing puts this list on it instead.'
      : site.pending
      ? 'Changes since the site was last updated, on ' + when(site.publishedAt) + '.'
      : 'The site shows this list, published on ' + when(site.publishedAt) + '.';
    var publish = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm ' + (site.pending || !site.live ? 'btn-primary' : 'btn-outline'),
        onclick: function () {
          if (
            !window.confirm(
              'Publish the directory and the working groups to the site as they are now? The site rebuilds in a few minutes.'
            )
          )
            return;
          publish.disabled = true;
          M.api('POST', '/api/app/community?action=publish', {})
            .then(function (r) {
              M.toast(
                r.build && r.build.started
                  ? 'Published: the site updates in a few minutes'
                  : 'Published; the site updates at its next build (' +
                      ((r.build && r.build.detail) || 'no build started') +
                      ')'
              );
              draw({ live: true, publishedAt: r.publishedAt, pending: false });
            })
            .catch(function (err) {
              publish.disabled = false;
              M.appError(err);
            });
        },
      },
      'Publish to the site'
    );
    bar.appendChild(
      h(
        'div',
        { class: 'site-bar-text' },
        h(
          'span',
          { class: 'badge ' + (site.live && !site.pending ? 'badge-open' : 'badge-closed') },
          !site.live ? 'Not on the site' : site.pending ? 'Not published' : 'Up to date'
        ),
        h('span', null, text)
      )
    );
    bar.appendChild(
      h(
        'div',
        { class: 'site-bar-actions' },
        site.live
          ? h(
              'button',
              {
                type: 'button',
                class: 'link-button',
                onclick: function () {
                  if (
                    !window.confirm('Take the site back to the old directory (data/members.yaml)?')
                  )
                    return;
                  M.api('POST', '/api/app/community?action=unpublish', {})
                    .then(function () {
                      M.toast('The site goes back to the old directory');
                      draw({ live: false, publishedAt: null, pending: true });
                    })
                    .catch(M.appError);
                },
              },
              'Back to the old directory'
            )
          : null,
        publish
      )
    );
  }

  /** After a change here: the bar says there is something to publish. */
  function changed() {
    if (state) draw({ live: state.live, publishedAt: state.publishedAt, pending: true });
  }

  M.communitySite = { draw: draw, changed: changed };
})();
