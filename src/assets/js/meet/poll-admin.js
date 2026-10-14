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

  var mailReady = false;

  M.me
    .then(function () {
      M.api('GET', '/api/app/settings').then(function (s) {
        mailReady = s.mail.configured;
      });
      return M.api('GET', '/api/app/poll?id=' + encodeURIComponent(id || ''));
    })
    .then(function (data) {
      if (params.get('created')) {
        var failed = Number(params.get('failed') || 0);
        M.toast(
          failed
            ? 'Poll created, but ' + failed + ' invite(s) could not be sent'
            : params.get('sent')
            ? 'Poll created and ' + params.get('sent') + ' invites sent'
            : 'Poll created',
          Boolean(failed)
        );
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
    if (poll.inviteOnly) view.appendChild(guestsPanel());
    else if (poll.status !== 'scheduled') view.appendChild(sharePanel());
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

  // ── Guests (invite-only polls) ─────────────────────────────────────────────

  function guestStatus(g) {
    if (g.answered) return h('span', { class: 'badge badge-open' }, 'Answered');
    if (!g.sentAt) {
      return h('span', { class: 'badge badge-scheduled', title: g.sendError || '' }, 'Not sent');
    }
    return h('span', { class: 'badge badge-closed' }, 'Waiting');
  }

  function guestsPanel() {
    var answered = poll.invites.filter(function (g) {
      return g.answered;
    }).length;
    var input = h('textarea', {
      class: 'form-input is-compact is-short',
      placeholder: 'More emails, separated by commas',
      'aria-label': 'Invite more people',
    });
    return h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, 'Guests (' + answered + '/' + poll.invites.length + ' answered)')
      ),
      h(
        'ul',
        { class: 'guest-list' },
        poll.invites.map(function (g) {
          return h(
            'li',
            null,
            h('span', { class: 'guest-email' }, g.email),
            guestStatus(g),
            h(
              'span',
              { class: 'guest-actions' },
              g.answered
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      class: 'link-button',
                      onclick: function () {
                        guestAction(
                          'POST',
                          '&action=resend&invite=' + g.id,
                          {},
                          'Invite sent again'
                        );
                      },
                    },
                    g.sentAt ? 'Resend' : 'Send'
                  ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'remove-btn',
                  onclick: function () {
                    if (
                      !window.confirm(
                        'Remove ' + g.email + (g.answered ? ' and their answer?' : '?')
                      )
                    ) {
                      return;
                    }
                    guestAction('DELETE', '&invite=' + g.id, null, g.email + ' removed');
                  },
                },
                'Remove'
              )
            )
          );
        })
      ),
      poll.status === 'scheduled'
        ? null
        : h(
            'div',
            { class: 'guest-add' },
            input,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  if (!input.value.trim()) return input.focus();
                  guestAction('POST', '&action=invite', { emails: input.value }, null);
                },
              },
              'Invite'
            )
          )
    );
  }

  function guestAction(method, query, body, done) {
    M.api(method, '/api/app/poll?id=' + encodeURIComponent(id) + query, body)
      .then(function (data) {
        show(data);
        var outcome = data.outcome;
        if (outcome && outcome.failed)
          M.toast(outcome.failed + ' invite(s) could not be sent', true);
        else if (outcome)
          M.toast(outcome.sent === 1 ? 'Invite sent' : outcome.sent + ' invites sent');
        else if (done) M.toast(done);
      })
      .catch(M.appError);
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
            ')' +
            (poll.invitedToMeeting.length
              ? ' · Invite emailed to ' +
                poll.invitedToMeeting.length +
                (poll.invitedToMeeting.length === 1 ? ' person' : ' people')
              : '')
        ),
        h(
          'div',
          { class: 'final-actions' },
          h(
            'a',
            {
              class: 'btn btn-ghost btn-sm',
              href: '/api/app/poll?id=' + encodeURIComponent(poll.id) + '&format=ics',
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
    var notifyToggle = h('input', {
      type: 'checkbox',
      checked: poll.notify,
      onchange: function (e) {
        M.api('PATCH', '/api/app/poll?id=' + encodeURIComponent(id), { notify: e.target.checked })
          .then(function (data) {
            poll = data;
            M.toast(
              data.notify ? 'You’ll be notified of new answers' : 'Notifications off for this poll'
            );
          })
          .catch(M.appError);
      },
    });
    actions.unshift(
      h('label', { class: 'check-row notify-toggle' }, notifyToggle, h('span', null, 'Notify me'))
    );
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
    var invited = poll.invitedToMeeting.length;
    var question = invited
      ? 'Clear the chosen time? The ' +
        invited +
        (invited === 1 ? ' person' : ' people') +
        ' who got the calendar invite will be sent a cancellation.'
      : 'Clear the chosen time? You can then pick another one.';
    if (!window.confirm(question)) return;
    M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=unschedule', {})
      .then(function (data) {
        show(data);
        M.toast(
          data.outcome && data.outcome.failed
            ? 'Time cleared, but ' + data.outcome.failed + ' cancellation(s) could not be sent'
            : data.outcome
            ? 'Time cleared and cancellation sent'
            : 'Time cleared',
          Boolean(data.outcome && data.outcome.failed)
        );
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

    // Everyone who answered, ticked; on an invite-only poll, guests who did
    // not answer are offered too, unticked.
    var list = M.clear(document.getElementById('inviteeList'));
    var answered = {};
    poll.responses.forEach(function (r) {
      answered[r.email.toLowerCase()] = true;
      var v = r.votes[slot.id] || 0;
      list.appendChild(
        h(
          'label',
          null,
          h('input', { type: 'checkbox', value: r.email, checked: true }),
          h('span', null, r.name, ' ', h('span', { class: 'panel-note' }, r.email)),
          h('small', null, ['can’t make it', 'if needed', 'available'][v])
        )
      );
    });
    poll.invites.forEach(function (g) {
      if (answered[g.email.toLowerCase()]) return;
      list.appendChild(
        h(
          'label',
          null,
          h('input', { type: 'checkbox', value: g.email }),
          h('span', null, g.email),
          h('small', null, 'didn’t answer')
        )
      );
    });
    if (!list.children.length) {
      list.appendChild(
        h('p', { class: 'panel-note', style: 'padding:.5rem 0' }, 'No answers yet.')
      );
    }
    document.getElementById('extraEmails').value = '';
    var send = document.getElementById('sendInvite');
    send.checked = mailReady;
    send.disabled = !mailReady;
    document.getElementById('sendInviteNote').textContent = mailReady
      ? 'From the team mailbox, with the event attached.'
      : 'Needs email sending, which the admin sets up in Settings.';
    document.getElementById('inviteFields').hidden = !send.checked;
    dialog.showModal();
  }

  document.getElementById('sendInvite').addEventListener('change', function (e) {
    document.getElementById('inviteFields').hidden = !e.target.checked;
  });

  document.getElementById('finalizeForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var sendInvite = document.getElementById('sendInvite').checked;
    var emails = Array.from(document.querySelectorAll('#inviteeList input:checked')).map(function (
      input
    ) {
      return input.value;
    });
    var extraEmails = document.getElementById('extraEmails').value;
    if (sendInvite && !emails.length && !extraEmails.trim()) {
      finalizeError.textContent = 'Choose at least one person to send the invite to.';
      finalizeError.hidden = false;
      return;
    }
    submit.disabled = true;
    M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=finalize', {
      slotId: chosenSlot.id,
      sendInvite: sendInvite,
      emails: emails,
      extraEmails: extraEmails,
    })
      .then(function (data) {
        dialog.close();
        show(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        var o = data.outcome;
        M.toast(
          o && o.failed
            ? 'Time chosen, but ' + o.failed + ' invite(s) could not be sent'
            : o
            ? 'Time chosen and invite sent to ' + o.sent + (o.sent === 1 ? ' person' : ' people')
            : 'Time chosen',
          Boolean(o && o.failed)
        );
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
