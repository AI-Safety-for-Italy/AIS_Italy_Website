/* /app/crm/order/: the order of the mentors on /mentorship/, a team (people
 * who share a project) per row (/api/app/crm/mentorship?action=site-order).
 * Dragged or moved with the arrows, as a ranking question (forms-render.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var API = '/api/app/crm/mentorship?action=site-order';
  var UP = 'M6 15l6-6 6 6';
  var DOWN = 'M6 9l6 6 6-6';

  var form = document.getElementById('orderForm');
  var list = document.getElementById('orderList');
  var error = form.querySelector('.form-error');
  var saveBtn = form.querySelector('button[type="submit"]');
  var teams = [];
  var saved = '[]';

  function ids() {
    return teams.reduce(function (all, team) {
      return all.concat(
        team.map(function (m) {
          return m.id;
        })
      );
    }, []);
  }

  M.unsaved(
    function () {
      return JSON.stringify(ids()) !== saved;
    },
    {
      buttons: function () {
        return [saveBtn];
      },
    }
  );

  function tracksOf(team) {
    var tracks = team[0].tracks;
    if (!tracks.length) return 'No track yet: shown under Projects';
    return tracks
      .map(function (t) {
        return t === 'orientation' ? 'Advising' : 'Projects';
      })
      .join(', ');
  }

  function arrow(label, path, onclick) {
    return h('button', {
      type: 'button',
      class: 'fm-rank-move',
      title: label,
      'aria-label': label,
      html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' +
        path +
        '"/></svg>',
      onclick: onclick,
    });
  }

  function move(from, to, direction) {
    teams.splice(to, 0, teams.splice(from, 1)[0]);
    draw();
    var row = list.children[to];
    var b = row.querySelector('[data-move="' + direction + '"]:not([disabled])');
    (b || row.querySelector('button:not([disabled])')).focus();
  }

  function draw() {
    M.clear(list);
    teams.forEach(function (team, i) {
      var names = team
        .map(function (m) {
          return m.name;
        })
        .join(' + ');
      var up = arrow('Move up: ' + names, UP, function () {
        move(i, i - 1, 'up');
      });
      var down = arrow('Move down: ' + names, DOWN, function () {
        move(i, i + 1, 'down');
      });
      up.disabled = i === 0;
      down.disabled = i === teams.length - 1;
      up.setAttribute('data-move', 'up');
      down.setAttribute('data-move', 'down');
      var row = h(
        'li',
        { class: 'fm-rank-row', 'data-team': String(i) },
        h('span', { class: 'fm-rank-grip', 'aria-hidden': 'true' }),
        h('span', { class: 'fm-rank-num', 'aria-hidden': 'true' }, String(i + 1)),
        h(
          'span',
          { class: 'fm-rank-text' },
          names,
          h('small', { style: 'display:block;font-weight:400' }, tracksOf(team))
        ),
        h('span', { class: 'fm-rank-moves' }, up, down)
      );
      row.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('button')) return;
        // A finger drags from the handle only; elsewhere it scrolls the page.
        if (e.pointerType !== 'mouse' && !e.target.closest('.fm-rank-grip')) return;
        startDrag(row, e);
      });
      row.addEventListener('pointermove', onMove);
      row.addEventListener('pointerup', endDrag);
      row.addEventListener('pointercancel', endDrag);
      list.appendChild(row);
    });
  }

  var dragging = null;
  function startDrag(row, e) {
    e.preventDefault();
    dragging = { row: row, id: e.pointerId };
    row.classList.add('is-dragging');
    try {
      row.setPointerCapture(e.pointerId);
    } catch (err) {
      /* the drag still follows the pointer inside the list */
    }
  }
  function onMove(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    var row = dragging.row;
    var before = null;
    [].some.call(list.children, function (other) {
      if (other === row) return false;
      var box = other.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) {
        before = other;
        return true;
      }
      return false;
    });
    if (before !== row.nextElementSibling) list.insertBefore(row, before);
  }
  function endDrag(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging.row.classList.remove('is-dragging');
    dragging = null;
    teams = [].map.call(list.children, function (row) {
      return teams[Number(row.getAttribute('data-team'))];
    });
    draw();
  }

  function show(data) {
    teams = data.groups;
    saved = JSON.stringify(ids());
    draw();
  }

  Promise.all([M.me, M.api('GET', API)])
    .then(function (r) {
      show(r[1]);
    })
    .catch(function (err) {
      if (err.status === 403) {
        M.clear(form);
        form.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h('p', null, 'Only people with “CRM: mentorship” can change this.')
          )
        );
        return;
      }
      M.appError(err);
    });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    error.hidden = true;
    M.api('POST', API, { ids: ids() })
      .then(function (data) {
        show(data);
        M.toast(
          data.build.started
            ? 'Saved: on the site in about 3 minutes'
            : 'Saved: on the site with the next build'
        );
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        error.textContent = err.message;
        error.hidden = false;
      });
  });
})();
