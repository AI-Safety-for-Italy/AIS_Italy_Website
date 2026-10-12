/* /admin/poll/?id=…: share link, answers, and picking the final time. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  var view = document.getElementById('pollView');
  var dialog = document.getElementById('finalizeDialog');
  var session = null;
  var poll = null;

  view.appendChild(M.loading());

  M.session
    .then(function (s) {
      session = s;
      return M.api('GET', '/api/admin/poll?id=' + encodeURIComponent(id || ''));
    })
    .then(function (data) {
      if (params.get('created')) {
        M.toast('Poll created');
        history.replaceState(null, '', '/admin/poll/?id=' + encodeURIComponent(id));
      }
      show(data);
    })
    .catch(function (err) {
      if (err.status === 401) return M.adminError(err);
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
          h('a', { class: 'btn btn-outline', href: '/admin/' }, 'Back to polls')
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

  function scheduledCard() {
    var slot = poll.slots.find(function (s) {
      return s.id === poll.finalSlotId;
    });
    return h(
      'div',
      { class: 'final-card', style: 'margin-bottom:1.25rem' },
      calendarIcon(slot.start, poll.timezone),
      h(
        'div',
        null,
        h('h2', null, 'Scheduled · ' + M.fmtDay(slot.start, poll.timezone)),
        h(
          'p',
          null,
          M.fmtTime(slot.start, poll.timezone) +
            '–' +
            M.fmtTime(slot.end, poll.timezone) +
            ' (' +
            M.tzLabel(poll.timezone) +
            ') · Invites sent'
        ),
        h(
          'div',
          { class: 'final-actions' },
          poll.calendarEventLink
            ? h(
                'a',
                {
                  class: 'btn btn-ghost btn-sm',
                  href: poll.calendarEventLink,
                  target: '_blank',
                  rel: 'noopener',
                },
                'Open in Google Calendar'
              )
            : null,
          poll.meetLink
            ? h(
                'a',
                {
                  class: 'btn btn-ghost btn-sm',
                  href: poll.meetLink,
                  target: '_blank',
                  rel: 'noopener',
                },
                'Google Meet link'
              )
            : null,
          h(
            'button',
            { type: 'button', class: 'btn btn-ghost btn-sm', onclick: unschedule },
            'Cancel meeting'
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
                'Pick'
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
    M.api('PATCH', '/api/admin/poll?id=' + encodeURIComponent(id), { status: status })
      .then(function (data) {
        show(data);
        M.toast(status === 'open' ? 'Voting reopened' : 'Voting closed');
      })
      .catch(M.adminError);
  }

  function deletePoll() {
    if (!window.confirm('Delete “' + poll.title + '” and all its answers? This cannot be undone.'))
      return;
    M.api('DELETE', '/api/admin/poll?id=' + encodeURIComponent(id))
      .then(function () {
        window.location.href = '/admin/';
      })
      .catch(M.adminError);
  }

  function deleteResponse(r) {
    if (
      !window.confirm('Remove ' + r.name + ' (' + r.email + ')? They can answer again afterwards.')
    ) {
      return;
    }
    M.api(
      'DELETE',
      '/api/admin/poll?id=' + encodeURIComponent(id) + '&response=' + encodeURIComponent(r.id)
    )
      .then(function (data) {
        show(data);
        M.toast(r.name + ' removed');
      })
      .catch(M.adminError);
  }

  function unschedule() {
    if (!window.confirm('Cancel this meeting? Everyone invited will be notified.')) {
      return;
    }
    M.api('POST', '/api/admin/poll?id=' + encodeURIComponent(id) + '&action=unschedule', {})
      .then(function (data) {
        show(data);
        M.toast('Meeting cancelled');
      })
      .catch(M.adminError);
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

    var list = M.clear(document.getElementById('inviteeList'));
    if (!poll.responses.length) {
      list.appendChild(
        h('p', { class: 'panel-note', style: 'padding:.5rem 0' }, 'No answers yet.')
      );
    }
    poll.responses.forEach(function (r) {
      var v = r.votes[slot.id] || 0;
      list.appendChild(
        h(
          'label',
          null,
          h('input', { type: 'checkbox', value: r.id, checked: true }),
          h('span', null, r.name, ' ', h('span', { class: 'panel-note' }, r.email)),
          h('small', null, ['can’t make it', 'if needed', 'available'][v])
        )
      );
    });

    document.getElementById('extraEmails').value = '';
    document.getElementById('createMeet').checked = !poll.location;
    var connected = session && session.calendarConnected;
    document.getElementById('finalizeCalendarNotice').hidden = connected;
    submit.disabled = !connected;
    dialog.showModal();
  }

  document.getElementById('finalizeForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var responseIds = Array.from(document.querySelectorAll('#inviteeList input:checked')).map(
      function (input) {
        return input.value;
      }
    );
    var extraEmails = document
      .getElementById('extraEmails')
      .value.split(/[\s,;]+/)
      .filter(Boolean);
    if (!responseIds.length && !extraEmails.length) {
      finalizeError.textContent = 'Choose at least one person to invite.';
      finalizeError.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    M.api('POST', '/api/admin/poll?id=' + encodeURIComponent(id) + '&action=finalize', {
      slotId: chosenSlot.id,
      responseIds: responseIds,
      extraEmails: extraEmails,
      createMeet: document.getElementById('createMeet').checked,
    })
      .then(function (data) {
        dialog.close();
        show(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        M.toast('Invitations sent');
      })
      .catch(function (err) {
        if (err.status === 401) return M.adminError(err);
        finalizeError.textContent = err.message;
        finalizeError.hidden = false;
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = 'Send calendar invite';
      });
  });
})();
