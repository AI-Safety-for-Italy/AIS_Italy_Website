/* /app/content/: the seminars and events on the site, coming ones first, and
 * the latest changes. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var list = document.getElementById('contentList');
  list.appendChild(M.loading());

  M.me
    .then(function () {
      return M.api('GET', '/api/app/content');
    })
    .then(function (data) {
      document.getElementById('notLive').hidden = data.live;
      M.clear(list);
      var today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
      var coming = data.items
        .filter(function (i) {
          return i.day >= today && !i.deleted;
        })
        .reverse();
      var past = data.items.filter(function (i) {
        return i.day < today && !i.deleted;
      });
      var removed = data.items.filter(function (i) {
        return i.deleted;
      });

      if (!data.items.length) {
        list.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'Nothing published from here yet'),
            h('p', null, 'Seminars and events published with this tool are listed here.')
          )
        );
      }
      section('Coming up', coming);
      section('Past', past);
      section('Removed from the site', removed);

      if (data.activity.length) {
        var ul = document.getElementById('activity');
        data.activity.forEach(function (a) {
          ul.appendChild(M.activityItem(a, true));
        });
        document.getElementById('activityPanel').hidden = false;
      }
    })
    .catch(function (err) {
      M.clear(list);
      if (err.status === 403) {
        list.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h(
              'p',
              null,
              err.message + '. Ask the Direttivo if you should publish seminars or events.'
            )
          )
        );
        return;
      }
      M.appError(err);
    });

  function section(title, items) {
    if (!items.length) return;
    list.appendChild(h('h3', { class: 'content-group-title label-mono' }, title));
    list.appendChild(h('div', { class: 'poll-list' }, items.map(row)));
  }

  function row(i) {
    var meta = [M.fmtDayIso(i.day), M.contentTypeLabel[i.type] || i.type];
    if (i.speaker) meta.push(i.speaker);
    var attrs = { class: 'poll-item' + (i.tbc ? ' is-tbc' : '') };
    var tag = i.canEdit ? 'a' : 'div';
    if (i.canEdit) attrs.href = '/app/content/edit/?id=' + encodeURIComponent(i.id);
    return h(
      tag,
      attrs,
      h(
        'div',
        null,
        h('h3', null, i.title),
        h(
          'div',
          { class: 'poll-item-meta' },
          meta.map(function (m) {
            return h('span', null, m);
          })
        )
      ),
      h(
        'div',
        { class: 'poll-item-side' },
        i.tbc ? h('span', { class: 'badge badge-closed' }, 'To be confirmed') : null,
        h(
          'span',
          { class: 'panel-note' },
          i.updatedBy ? 'Last edit: ' + i.updatedBy : i.createdBy ? 'By ' + i.createdBy : 'Imported'
        ),
        i.canEdit ? null : h('span', { class: 'panel-note' }, 'View only')
      )
    );
  }
})();
