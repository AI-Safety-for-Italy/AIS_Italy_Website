/* Shared by the content tool's pages (/app/content/): the labels used across
 * the pages. The API enforces the permission rules. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  M.contentTypeLabel = { seminar: 'Seminar', event: 'Event' };

  M.actionLabel = {
    create: 'published',
    update: 'edited',
    delete: 'removed',
    restore: 'restored a version of',
    import: 'imported',
  };

  /** "12 Mar 2027" from 'YYYY-MM-DD'. */
  M.fmtDayIso = function (day) {
    return new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };

  /** "22 Oct, 14:05" for a timestamp. */
  M.fmtWhen = function (iso) {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  /** What happened after a save, for the toast and the page. */
  M.publishNote = function (publish) {
    if (!publish) return '';
    var parts = [];
    parts.push(
      publish.build && publish.build.started
        ? 'The site is updating: online in about 3 minutes.'
        : 'Saved, but the site rebuild did not start (' +
            ((publish.build && publish.build.detail) || 'unknown') +
            '). It will go online with the next update.'
    );
    if (publish.announcement && !publish.announcement.sent) {
      parts.push('The team channel was not told (' + publish.announcement.detail + ').');
    }
    return parts.join(' ');
  };

  M.activityItem = function (a, withTitle) {
    return h(
      'li',
      null,
      h('span', { class: 'activity-when' }, M.fmtWhen(a.createdAt)),
      h(
        'span',
        null,
        h('strong', null, a.userName),
        ' ' + (M.actionLabel[a.action] || a.action) + ' ',
        withTitle && a.itemId
          ? h('a', { href: '/app/content/edit/?id=' + encodeURIComponent(a.itemId) }, a.title)
          : null
      )
    );
  };
})();
