/* /app/polls/poll/?id=…: share link, answers, and picking the final time. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  var view = document.getElementById('pollView');
  var dialog = document.getElementById('finalizeDialog');
  var poll = null;

  view.appendChild(M.loading());

  M.me
    .then(function () {
      return M.api('GET', '/api/app/poll?id=' + encodeURIComponent(id || ''));
    })
    .then(function (data) {
      if (params.get('created')) {
        M.toast('Poll created');
        history.replaceState(null, '', '/app/polls/poll/?id=' + encodeURIComponent(id));
      }
      show(data);
    })
    .catch(function (err) {
      if (err.status === 401) return M.appError(err);
      M.clear(view).appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h(
            'h3',
            null,
            err.status === 404 || err.status === 400 ? 'Poll not found' : 'Something went wrong'
          ),
          h('p', null, err.message),
          h('a', { class: 'btn btn-outline', href: '/app/polls/' }, 'Back to polls')
        )
      );
    });

  // One link for everyone: the page itself picks Italian or English.
  function voteLink() {
    return window.location.origin + '/meet/?p=' + poll.token;
  }

  function show(data) {
    poll = data;
    document.title = poll.title + ' | Admin';
    document.getElementById('pollTitle').textContent = poll.title;
    M.clear(document.getElementById('statusBadge')).appendChild(
      M.statusBadge(poll.status === 'open' && !poll.open ? 'closed' : poll.status)
    );
    M.clear(document.getElementById('pollMeta')).appendChild(
      h(
        'div',
        { style: 'display:contents' },
        h('span', null, M.icon('clock'), M.fmtDuration(poll.durationMinutes)),
        poll.location ? h('span', null, M.icon('pin'), poll.location) : null,
        h('span', null, M.icon('globe'), M.tzLabel(poll.timezone)),
        poll.deadline
          ? h(
              'span',
              null,
              M.icon('hourglass'),
              'Voting closes ' + M.fmtDateTime(poll.deadline, poll.timezone)
            )
          : null
      )
    );

    M.clear(view);
    if (poll.status === 'scheduled') view.appendChild(scheduledCard());
    else view.appendChild(sharePanel());
    view.appendChild(resultsPanel());
    if (poll.description) {
      view.appendChild(
        h(
          'div',
          { class: 'panel' },
          h('span', { class: 'label-mono' }, 'Description'),
          h(
            'p',
            { class: 'meet-description', style: 'margin-top:.5rem' },
            M.linkify(poll.description)
          )
        )
      );
    }
  }

  // ── Panels ─────────────────────────────────────────────────────────────────

  function copyRow() {
    var url = voteLink();
    var input = h('input', {
      class: 'form-input is-compact',
      readonly: true,
      value: url,
      'aria-label': 'Poll link',
    });
    input.addEventListener('focus', function () {
      input.select();
    });
    return h(
      'div',
      { class: 'copy-field' },
      input,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          onclick: function () {
            M.copy(url, 'Link copied');
          },
        },
        'Copy'
      ),
      h(
        'a',
        { class: 'btn btn-outline btn-sm', href: url, target: '_blank', rel: 'noopener' },
        'Open'
      )
    );
  }

  function sharePanel() {
    return h(
      'div',
      { class: 'panel share-box' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Share the poll')),
      copyRow()
    );
  }

  function finalSlot() {
    return poll.slots.find(function (s) {
      return s.id === poll.finalSlotId;
    });
  }

  function emails() {
    return poll.responses.map(function (r) {
      return r.email;
    });
  }

  function copyEmails() {
    M.copy(emails().join(', '), emails().length + ' emails copied');
  }

  function scheduledCard() {
    var slot = finalSlot();
    return h(
      'div',
      { class: 'final-card', style: 'margin-bottom:1.25rem' },
      calendarIcon(slot.start, poll.timezone),
      h(
        'div',
        null,
        h('h2', null, M.fmtDay(slot.start, poll.timezone)),
        h(
          'p',
          null,
          M.fmtTime(slot.start, poll.timezone) +
            '–' +
            M.fmtTime(slot.end, poll.timezone) +
            ' (' +
            M.tzLabel(poll.timezone) +
            ')'
        ),
        h(
          'div',
          { class: 'final-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-sm',
              onclick: function () {
                M.downloadIcs(poll, slot);
              },
            },
            'Download calendar event'
          ),
          poll.responses.length
            ? h(
                'button',
                { type: 'button', class: 'btn btn-ghost btn-sm', onclick: copyEmails },
                'Copy emails (' + poll.responses.length + ')'
              )
            : null,
          h(
            'button',
            { type: 'button', class: 'btn btn-ghost btn-sm', onclick: unschedule },
            'Change time'
          )
        )
      )
    );
  }

  function calendarIcon(iso, tz) {
    return h(
      'div',
      { class: 'cal', 'aria-hidden': 'true' },
      h('span', { class: 'm' }, M.fmt(iso, tz, { month: 'short' })),
      h('span', { class: 'd' }, M.fmt(iso, tz, { day: 'numeric' }))
    );
  }

  function resultsPanel() {
    var canPick = poll.status !== 'scheduled';
    var table = M.resultsTable(poll, {
      tz: poll.timezone,
      finalSlotId: poll.finalSlotId,
      rowExtra: function (r) {
        return h(
          'button',
          {
            type: 'button',
            class: 'remove-btn',
            title: 'Remove ' + r.name + ' so they can answer again',
            'aria-label': 'Remove ' + r.name,
            onclick: function () {
              deleteResponse(r);
            },
          },
          'Remove'
        );
      },
      footerExtra: canPick
        ? function (slot) {
            return h(
              'div',
              null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline pick-btn',
                  onclick: function () {
                    openFinalize(slot);
                  },
                },
                'Choose'
              )
            );
          }
        : null,
    });

    var actions = [];
    if (poll.status === 'open') {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              setStatus('closed');
            },
          },
          'Close voting'
        )
      );
    } else if (poll.status === 'closed') {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              setStatus('open');
            },
          },
          'Reopen voting'
        )
      );
    }
    if (poll.responses.length) {
      actions.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-outline btn-sm', onclick: copyEmails },
          'Copy emails'
        )
      );
    }
    actions.push(
      h(
        'button',
        { type: 'button', class: 'btn btn-danger-outline btn-sm', onclick: deletePoll },
        'Delete poll'
      )
    );

    return h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', null, h('h2', null, 'Answers (' + poll.responses.length + ')')),
        h('div', { class: 'wk-nav' }, actions)
      ),
      poll.responses.length
        ? null
        : h('p', { class: 'panel-note', style: 'margin-bottom:1rem' }, 'No answers yet.'),
      table,
      poll.hideResponses
        ? h(
            'p',
            { class: 'panel-note', style: 'margin-top:.75rem' },
            'Answers are hidden from participants.'
          )
        : null
    );
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function setStatus(status) {
    M.api('PATCH', '/api/app/poll?id=' + encodeURIComponent(id), { status: status })
      .then(function (data) {
        show(data);
        M.toast(status === 'open' ? 'Voting reopened' : 'Voting closed');
      })
      .catch(M.appError);
  }

  function deletePoll() {
    if (!window.confirm('Delete “' + poll.title + '” and all its answers? This cannot be undone.'))
      return;
    M.api('DELETE', '/api/app/poll?id=' + encodeURIComponent(id))
      .then(function () {
        window.location.href = '/app/polls/';
      })
      .catch(M.appError);
  }

  function deleteResponse(r) {
    if (
      !window.confirm('Remove ' + r.name + ' (' + r.email + ')? They can answer again afterwards.')
    ) {
      return;
    }
    M.api(
      'DELETE',
      '/api/app/poll?id=' + encodeURIComponent(id) + '&response=' + encodeURIComponent(r.id)
    )
      .then(function (data) {
        show(data);
        M.toast(r.name + ' removed');
      })
      .catch(M.appError);
  }

  function unschedule() {
    if (!window.confirm('Clear the chosen time? You can then pick another one.')) return;
    M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=unschedule', {})
      .then(function (data) {
        show(data);
        M.toast('Time cleared');
      })
      .catch(M.appError);
  }

  // ── Finalize dialog ────────────────────────────────────────────────────────

  var chosenSlot = null;
  var finalizeError = document.getElementById('finalizeError');
  var submit = document.getElementById('finalizeSubmit');

  function openFinalize(slot) {
    chosenSlot = slot;
    finalizeError.hidden = true;
    document.getElementById('finalizeTitle').textContent = M.fmtDay(slot.start, poll.timezone);
    document.getElementById('finalizeWhen').textContent =
      M.fmtTime(slot.start, poll.timezone) +
      '–' +
      M.fmtTime(slot.end, poll.timezone) +
      ' · ' +
      M.tzLabel(poll.timezone) +
      ' · ' +
      (slot.yes || 0) +
      ' available' +
      (slot.maybe ? ', ' + slot.maybe + ' if needed' : '');

    dialog.showModal();
  }

  document.getElementById('finalizeForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    submit.disabled = true;
    M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=finalize', {
      slotId: chosenSlot.id,
    })
      .then(function (data) {
        dialog.close();
        show(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        M.toast('Time chosen');
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        finalizeError.textContent = err.message;
        finalizeError.hidden = false;
      })
      .then(function () {
        submit.disabled = false;
      });
  });
})();
