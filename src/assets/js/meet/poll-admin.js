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

  /**
   * Disables `button` and shows `label` on it while `promise` runs, so slow
   * actions (sending emails) are visibly in progress and cannot be repeated.
   */
  function busy(button, label, promise) {
    var before = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = label;
    }
    return promise.then(
      function (value) {
        if (button) {
          button.disabled = false;
          button.textContent = before;
        }
        return value;
      },
      function (err) {
        if (button) {
          button.disabled = false;
          button.textContent = before;
        }
        throw err;
      }
    );
  }

  M.api('GET', '/api/app/settings')
    .then(function (s) {
      mailReady = s.mail.configured;
    })
    .catch(function () {
      /* mail stays "not ready"; the poll's own request reports a sign-in problem */
    });
  Promise.all([M.me, M.api('GET', '/api/app/poll?id=' + encodeURIComponent(id || ''))])
    .then(function (r) {
      var data = r[1];
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
    var apTitle = document.getElementById('apTitle');
    if (apTitle) apTitle.textContent = poll.title;
    M.clear(document.getElementById('statusBadge')).appendChild(
      M.statusBadge(poll.status === 'open' && !poll.open ? 'closed' : poll.status)
    );
    M.clear(document.getElementById('pollMeta')).appendChild(
      h(
        'div',
        { style: 'display:contents' },
        h('span', null, M.icon('clock'), M.fmtDuration(poll.durationMinutes)),
        poll.recurrence
          ? h(
              'span',
              { class: 'repeat' },
              M.icon('repeat'),
              M.recurrenceText(poll.recurrence, chosenStart(), poll.timezone)
            )
          : null,
        poll.location ? h('span', null, M.icon('pin'), poll.location) : null,
        h('span', null, M.icon('globe'), M.tzLabel(poll.timezone)),
        poll.calendar
          ? h(
              'span',
              { class: 'poll-cal' },
              h('span', {
                class: 'poll-cal-dot',
                style: 'background:' + (poll.calendar.color || 'var(--accent)'),
                'aria-hidden': 'true',
              }),
              (poll.status === 'scheduled' ? 'In ' : 'Lands in ') + poll.calendar.name
            )
          : null,
        poll.deadline
          ? h(
              'span',
              null,
              M.icon('hourglass'),
              'Voting closes ' + M.fmtDateTime(poll.deadline, poll.timezone)
            )
          : null,
        poll.canManage
          ? h('button', { type: 'button', class: 'link-button', onclick: openEdit }, 'Edit details')
          : h('span', null, M.icon('users'), 'Shared by ' + (poll.ownerName || 'its owner'))
      )
    );

    M.clear(view);
    if (poll.status === 'scheduled') view.appendChild(scheduledCard());
    // Shared with this member: the poll and its answers, nothing to change.
    if (poll.canManage) {
      if (poll.inviteOnly) view.appendChild(guestsPanel());
      else if (poll.status !== 'scheduled') view.appendChild(sharePanel());
    }
    view.appendChild(resultsPanel());
    if (poll.canManage) view.appendChild(accessPanel());
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
                      onclick: function (e) {
                        guestAction(
                          'POST',
                          '&action=resend&invite=' + g.id,
                          {},
                          'Invite sent again',
                          e.currentTarget
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
                onclick: function (e) {
                  if (!input.value.trim()) return input.focus();
                  guestAction(
                    'POST',
                    '&action=invite',
                    { emails: input.value },
                    null,
                    e.currentTarget
                  );
                },
              },
              'Invite'
            )
          )
    );
  }

  function guestAction(method, query, body, done, button) {
    busy(
      button,
      'Sending…',
      M.api(method, '/api/app/poll?id=' + encodeURIComponent(id) + query, body)
    )
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

  // ── Who sees the poll (the owner only) ─────────────────────────────────
  // Discord roles and people by name see the poll and its answers (not the
  // voters' emails) and change nothing; each turns "Notify me" on for
  // themselves. Saved with its own button.
  function accessPanel() {
    var roles = (poll.shareRoles || []).slice();
    var people = (poll.sharePeople || []).slice();
    var roleBox = h('div', { class: 'fe-roles' }, M.loading());
    var chips = h('div', { class: 'fe-people' });
    var results = h('div', { class: 'fe-people-results', role: 'listbox', hidden: true });
    var search = h('input', {
      class: 'form-input is-compact',
      type: 'search',
      placeholder: 'Search a member of the Discord server…',
      'aria-label': 'Search a member of the Discord server',
      autocomplete: 'off',
    });
    var save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save sharing');
    var dirty = false;
    function changed() {
      dirty = true;
      save.disabled = false;
    }
    save.disabled = true;

    function drawPeople() {
      M.clear(chips);
      if (!people.length) {
        chips.appendChild(
          h('p', { class: 'form-note', style: 'margin:0' }, 'Nobody added by name.')
        );
      }
      people.forEach(function (p) {
        chips.appendChild(
          h(
            'span',
            { class: 'fe-person' },
            M.avatar({ name: p.name, avatarUrl: p.avatarUrl }, 22),
            h('span', null, p.name),
            h(
              'button',
              {
                type: 'button',
                class: 'fe-person-x',
                'aria-label': 'Remove ' + p.name,
                onclick: function () {
                  people.splice(people.indexOf(p), 1);
                  changed();
                  drawPeople();
                },
              },
              '×'
            )
          )
        );
      });
    }

    // The server's roles (the bot, or the local stand-ins), with those
    // already ticked that Discord no longer lists.
    M.api('GET', '/api/app/poll?id=' + encodeURIComponent(id) + '&roles=1')
      .then(function (r) {
        M.clear(roleBox);
        var all = r.roles.slice();
        roles.forEach(function (x) {
          if (
            !all.some(function (y) {
              return y.id === x.id;
            })
          )
            all.push({ id: x.id, name: x.name });
        });
        if (!all.length) {
          roleBox.appendChild(
            h(
              'p',
              { class: 'form-note' },
              'The Discord bot is not set up here, so the roles cannot be listed.'
            )
          );
        }
        all.forEach(function (role) {
          var input = h('input', { type: 'checkbox', value: role.id });
          input.checked = roles.some(function (x) {
            return x.id === role.id;
          });
          input.addEventListener('change', function () {
            roles = roles.filter(function (x) {
              return x.id !== role.id;
            });
            if (input.checked) roles.push({ id: role.id, name: role.name });
            changed();
          });
          roleBox.appendChild(
            h('label', { class: 'check-row' }, input, h('span', null, role.name))
          );
        });
      })
      .catch(function (err) {
        M.clear(roleBox).appendChild(h('p', { class: 'form-note' }, err.message));
      });

    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = search.value.trim();
        if (q.length < 2) {
          results.hidden = true;
          return;
        }
        M.api(
          'GET',
          '/api/app/poll?id=' + encodeURIComponent(id) + '&people=' + encodeURIComponent(q)
        )
          .then(function (data) {
            M.clear(results);
            var fresh = data.people.filter(function (p) {
              return !people.some(function (c) {
                return c.discordId === p.discordId;
              });
            });
            if (!fresh.length)
              results.appendChild(h('p', { class: 'fe-people-none' }, 'Nobody found'));
            fresh.forEach(function (p) {
              results.appendChild(
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'option',
                    class: 'fe-people-hit',
                    onclick: function () {
                      people.push(p);
                      search.value = '';
                      results.hidden = true;
                      changed();
                      drawPeople();
                    },
                  },
                  M.avatar(p, 24),
                  h('span', null, p.name)
                )
              );
            });
            results.hidden = false;
          })
          .catch(M.appError);
      }, 250);
    });

    save.addEventListener('click', function () {
      save.disabled = true;
      M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=share', {
        roles: roles,
        people: people.map(function (p) {
          return { discordId: p.discordId, name: p.name };
        }),
      })
        .then(function (data) {
          dirty = false;
          poll.shareRoles = data.shareRoles;
          poll.sharePeople = data.sharePeople;
          M.toast('Sharing saved');
        })
        .catch(function (err) {
          save.disabled = false;
          M.appError(err);
        });
    });
    // Drawn again with the page: only the panel on screen counts.
    M.unsaved(
      function () {
        return dirty && save.isConnected;
      },
      {
        buttons: function () {
          return [save];
        },
      }
    );

    drawPeople();
    return h(
      'div',
      { class: 'panel form-grid' },
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', null, 'Who sees the poll')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Besides you: the roles and people added here see the poll and its answers (not the voters’ emails), and change nothing. Seeing is not following: each turns on “Notify me” to hear about new answers.'
      ),
      h('h3', { class: 'fe-subhead' }, 'Roles'),
      roleBox,
      h('h3', { class: 'fe-subhead' }, 'People'),
      chips,
      h('div', { class: 'fe-people-search' }, search, results),
      h('div', null, save)
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
        h(
          'h2',
          null,
          poll.recurrence
            ? M.recurrenceText(poll.recurrence, slot.start, poll.timezone)
            : M.fmtDay(slot.start, poll.timezone)
        ),
        h(
          'p',
          null,
          (poll.recurrence ? 'From ' + M.fmtDay(slot.start, poll.timezone) + ' · ' : '') +
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
        poll.canManage ? calendarLine(slot) : null,
        !poll.canManage
          ? null
          : h(
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
                {
                  type: 'button',
                  class: 'btn btn-ghost btn-sm',
                  onclick: function () {
                    openFinalize(slot, true);
                  },
                },
                poll.invitedToMeeting.length ? 'Email the invite again' : 'Email the invite'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-ghost btn-sm',
                  onclick: function () {
                    // The other times, each with "Move here", are in the answers below.
                    var table = document.querySelector('.results-wrap');
                    if (table) table.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    M.toast('Pick “Move here” under another time');
                  },
                },
                'Move to another time'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-ghost btn-sm',
                  onclick: function (e) {
                    unschedule(e.currentTarget);
                  },
                },
                'Cancel the meeting'
              )
            )
      )
    );
  }

  // Where the meeting is in the calendar, and which calendar: changed here.
  function calendarLine(slot) {
    var pick = h('select', {
      class: 'form-input is-compact poll-cal-pick',
      'aria-label': 'Calendar of the meeting',
      onchange: function () {
        pick.disabled = true;
        M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=calendar', {
          calendarId: pick.value || null,
        })
          .then(function (data) {
            show(data);
            M.toast('Now in ' + (data.calendar ? data.calendar.name : 'My calendar'));
          })
          .catch(function (err) {
            pick.disabled = false;
            pick.value = poll.calendar ? poll.calendar.id : '';
            if (err.status === 401) return M.appError(err);
            M.toast(err.message, true);
          });
      },
    });
    pick.appendChild(h('option', { value: '' }, 'In My calendar (private)'));
    // My calendar is the "" choice: the meeting goes there when none is named.
    var named = poll.calendar && !poll.calendar.personal;
    if (named) {
      pick.appendChild(h('option', { value: poll.calendar.id }, 'In ' + poll.calendar.name));
      pick.value = poll.calendar.id;
    }
    // The others this member adds to, once known.
    calendarsList().then(function (list) {
      list.forEach(function (c) {
        if (c.personal || (named && c.id === poll.calendar.id)) return;
        pick.appendChild(h('option', { value: c.id }, 'In ' + c.name));
      });
    });
    var line = h(
      'div',
      { class: 'poll-cal-line' },
      pick,
      poll.calendar && poll.calendar.eventId
        ? h(
            'a',
            {
              class: 'btn btn-ghost btn-sm',
              href:
                '/app/calendar/?event=' +
                encodeURIComponent(poll.calendar.eventId) +
                '&at=' +
                encodeURIComponent(slot.start) +
                '&date=' +
                encodeURIComponent(slot.start.slice(0, 10)),
            },
            'Open in the calendar'
          )
        : null
    );
    return line;
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
    var canPick = poll.canManage && poll.status !== 'scheduled';
    var table = M.resultsTable(poll, {
      tz: poll.timezone,
      finalSlotId: poll.finalSlotId,
      rowExtra: !poll.canManage
        ? null
        : function (r) {
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
      footerExtra:
        poll.canManage && poll.status === 'scheduled'
          ? function (slot) {
              if (slot.id === poll.finalSlotId) return h('div', { class: 'panel-note' }, 'Chosen');
              return h(
                'div',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-outline pick-btn',
                    onclick: function () {
                      openMove(slot);
                    },
                  },
                  'Move here'
                )
              );
            }
          : canPick
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
    if (!poll.canManage) {
      // nothing to change: only this member's own "Notify me" below
    } else if (poll.status === 'open') {
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
    // This member's own switch: the owner's and each sharer's alike.
    var follow = M.followSwitch({
      on: poll.notifyMe,
      label: 'Notify me about new answers',
      save: function (on) {
        return M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=notify-me', {
          on: on,
        }).then(function (r) {
          poll.notifyMe = r.notifyMe;
          poll.notify = poll.canManage ? r.notifyMe : poll.notify;
          return r.notifyMe;
        });
      },
    });
    if (follow) actions.unshift(follow);
    if (!poll.canManage) {
      // no emails, no deleting
    } else if (poll.responses.length) {
      actions.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-outline btn-sm', onclick: copyEmails },
          'Copy emails'
        )
      );
    }
    if (poll.canManage) {
      actions.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-danger-outline btn-sm', onclick: deletePoll },
          'Delete poll'
        )
      );
    }

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
        M.leaveTo('/app/polls/');
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

  function unschedule(button) {
    var invited = poll.invitedToMeeting.length;
    var question = invited
      ? 'Cancel the meeting? The ' +
        invited +
        (invited === 1 ? ' person' : ' people') +
        ' who got the calendar invite will be sent a cancellation, and it leaves the calendar. To change its time instead, use “Move here” under another time.'
      : 'Cancel the meeting? It leaves the calendar, and you can pick a time again.';
    if (!window.confirm(question)) return;
    busy(
      button,
      invited ? 'Sending cancellations…' : 'Cancelling…',
      M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=unschedule', {})
    )
      .then(function (data) {
        show(data);
        M.toast(
          data.outcome && data.outcome.failed
            ? 'Meeting cancelled, but ' + data.outcome.failed + ' cancellation(s) could not be sent'
            : data.outcome
            ? 'Meeting cancelled and cancellation sent'
            : 'Meeting cancelled',
          Boolean(data.outcome && data.outcome.failed)
        );
      })
      .catch(M.appError);
  }

  // ── Finalize dialog ────────────────────────────────────────────────────────

  var chosenSlot = null;
  var sendOnly = false;
  var finalizeError = document.getElementById('finalizeError');
  var submit = document.getElementById('finalizeSubmit');

  /**
   * The dialog both for choosing a time (with the option of emailing the
   * invite) and, with `onlySend`, for emailing it later or again.
   */
  function openFinalize(slot, onlySend) {
    chosenSlot = slot;
    sendOnly = Boolean(onlySend);
    finalizeError.hidden = true;
    document.getElementById('finalizeLabel').textContent = sendOnly
      ? 'Email the calendar invite'
      : 'Choose this time';
    document.getElementById('finalizeIntro').hidden = sendOnly;
    document.getElementById('sendInviteRow').hidden = sendOnly;
    submit.textContent = sendOnly ? 'Send invite' : 'Choose this time';
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
    // Sending again: people who already have it start unticked, unless
    // everyone has it already (then it is a plain resend to all).
    var already = {};
    poll.invitedToMeeting.forEach(function (e) {
      already[e] = true;
    });
    var everyoneHasIt =
      poll.responses.length > 0 &&
      poll.responses.every(function (r) {
        return already[r.email.toLowerCase()];
      });
    var list = M.clear(document.getElementById('inviteeList'));
    var answered = {};
    poll.responses.forEach(function (r) {
      var email = r.email.toLowerCase();
      answered[email] = true;
      var v = r.votes[slot.id] || 0;
      list.appendChild(
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            value: r.email,
            checked: !sendOnly || everyoneHasIt || !already[email],
          }),
          h('span', null, r.name, ' ', h('span', { class: 'panel-note' }, r.email)),
          h(
            'small',
            null,
            sendOnly && already[email]
              ? 'already sent'
              : ['can’t make it', 'if needed', 'available'][v]
          )
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
    send.checked = mailReady || sendOnly;
    send.disabled = !mailReady;
    document.getElementById('sendInviteNote').textContent = mailReady
      ? 'From the team mailbox, with the event attached.'
      : 'Needs email sending, which the admin sets up in Settings → Mail settings.';
    document.getElementById('inviteFields').hidden = !send.checked;
    if (sendOnly && !mailReady) {
      finalizeError.textContent =
        'Email sending isn’t set up yet (admin → Settings → Mail settings).';
      finalizeError.hidden = false;
    }
    submit.disabled = sendOnly && !mailReady;
    calendarRow(!sendOnly);
    dialog.showModal();
  }

  // The calendars the owner adds to (server/calendars.js): the chosen time
  // can land in one of them. Hidden when there is none.
  var calendarsReq = null;
  function calendarsList() {
    if (!calendarsReq) {
      calendarsReq = M.api('GET', '/api/app/poll?id=' + encodeURIComponent(id) + '&calendars=1')
        .then(function (r) {
          return r.calendars;
        })
        .catch(function () {
          return [];
        });
    }
    return calendarsReq;
  }

  function calendarRow(show) {
    var row = document.getElementById('calendarRow');
    row.hidden = true;
    if (!show) return;
    calendarsList().then(function (list) {
      var select = document.getElementById('finalizeCalendar');
      if (!list.length) return;
      M.clear(select).appendChild(h('option', { value: '' }, 'My calendar (private)'));
      list.forEach(function (c) {
        if (!c.personal) select.appendChild(h('option', { value: c.id }, c.name));
      });
      select.value = poll.calendarId || '';
      row.hidden = false;
    });
  }

  document.getElementById('sendInvite').addEventListener('change', function (e) {
    document.getElementById('inviteFields').hidden = !e.target.checked;
  });

  document.getElementById('finalizeForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var sendInvite = sendOnly || document.getElementById('sendInvite').checked;
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
    var label = submit.textContent;
    submit.disabled = true;
    if (sendInvite) submit.textContent = 'Sending…';
    var request = sendOnly
      ? M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=send-meeting', {
          emails: emails,
          extraEmails: extraEmails,
        })
      : M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=finalize', {
          slotId: chosenSlot.id,
          // Only when the choice was offered: else the one set before stays.
          calendarId: document.getElementById('calendarRow').hidden
            ? undefined
            : document.getElementById('finalizeCalendar').value || null,
          sendInvite: sendInvite,
          emails: emails,
          extraEmails: extraEmails,
        });
    request
      .then(function (data) {
        dialog.close();
        show(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        var o = data.outcome;
        var people = o ? o.sent + (o.sent === 1 ? ' person' : ' people') : '';
        M.toast(
          o && o.failed
            ? o.failed + ' invite(s) could not be sent'
            : sendOnly
            ? 'Invite sent to ' + people
            : o
            ? 'Time chosen and invite sent to ' + people
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
        submit.textContent = label;
      });
  });

  // ── Moving the meeting ─────────────────────────────────────────────────────

  /** A toast for something saved, and maybe emailed: `outcome` from the server. */
  function sentText(o, done, sentTo) {
    if (!o) return done;
    if (o.failed) return done + ', but ' + o.failed + ' email(s) could not be sent';
    return sentTo + o.sent + (o.sent === 1 ? ' person' : ' people');
  }

  var moveDialog = document.getElementById('moveDialog');
  var moveError = document.getElementById('moveError');
  var moveTo = null;

  function openMove(slot) {
    moveTo = slot;
    moveError.hidden = true;
    document.getElementById('moveTitle').textContent = M.fmtDay(slot.start, poll.timezone);
    document.getElementById('moveWhen').textContent =
      M.fmtTime(slot.start, poll.timezone) +
      '–' +
      M.fmtTime(slot.end, poll.timezone) +
      ' · ' +
      M.tzLabel(poll.timezone) +
      ' · ' +
      (slot.yes || 0) +
      ' available' +
      (slot.maybe ? ', ' + slot.maybe + ' if needed' : '');
    var invited = poll.invitedToMeeting.length;
    document.getElementById('moveNotifyRow').hidden = !invited || !mailReady;
    document.getElementById('moveNotify').checked = true;
    document.getElementById('moveNotifyCount').textContent =
      invited + (invited === 1 ? ' person' : ' people');
    moveDialog.showModal();
  }

  document.getElementById('moveForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var notifyInvitees =
      !document.getElementById('moveNotifyRow').hidden &&
      document.getElementById('moveNotify').checked;
    busy(
      document.getElementById('moveSubmit'),
      notifyInvitees ? 'Moving and sending…' : 'Moving…',
      M.api('POST', '/api/app/poll?id=' + encodeURIComponent(id) + '&action=move', {
        slotId: moveTo.id,
        notifyInvitees: notifyInvitees,
      })
    )
      .then(function (data) {
        moveDialog.close();
        show(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        M.toast(
          sentText(data.outcome, 'Meeting moved', 'Meeting moved and new time sent to '),
          Boolean(data.outcome && data.outcome.failed)
        );
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        moveError.textContent = err.message;
        moveError.hidden = false;
      });
  });

  // ── Edit details ───────────────────────────────────────────────────────────

  var editDialog = document.getElementById('editDialog');
  var editError = document.getElementById('editError');

  var editRepeat = M.recurrenceFields('edit');

  /** Start of the chosen time, if any, so a series can name its weekday. */
  function chosenStart() {
    var slot = poll.slots.find(function (s) {
      return s.id === poll.finalSlotId;
    });
    return slot ? slot.start : null;
  }

  function openEdit() {
    editRepeat.set(poll.recurrence);
    document.getElementById('editPollTitle').value = poll.title;
    document.getElementById('editLocation').value = poll.location || '';
    document.getElementById('editDescription').value = poll.description || '';
    var invited = poll.status === 'scheduled' ? poll.invitedToMeeting.length : 0;
    document.getElementById('editNotifyRow').hidden = !invited || !mailReady;
    document.getElementById('editNotify').checked = true;
    document.getElementById('editNotifyCount').textContent =
      invited + (invited === 1 ? ' person' : ' people');
    editError.hidden = true;
    editDialog.showModal();
  }

  document.getElementById('editForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var button = e.submitter;
    busy(
      button,
      'Saving…',
      M.api('PATCH', '/api/app/poll?id=' + encodeURIComponent(id), {
        title: document.getElementById('editPollTitle').value,
        location: document.getElementById('editLocation').value,
        description: document.getElementById('editDescription').value,
        recurrence: editRepeat.get(),
        notifyInvitees:
          !document.getElementById('editNotifyRow').hidden &&
          document.getElementById('editNotify').checked,
      })
    )
      .then(function (data) {
        editDialog.close();
        show(data);
        M.toast(sentText(data.outcome, 'Saved', 'Saved and update sent to '));
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        editError.textContent = err.message;
        editError.hidden = false;
      });
  });
})();
