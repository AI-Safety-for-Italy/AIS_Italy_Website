/* /app/members/: the registration form's submissions. Each row opens to the
 * answers; pending ones are approved with a role (which emails the join link)
 * or rejected. The API enforces who may do this. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var list = document.getElementById('memberList');
  var filters = document.getElementById('filters');
  var data = null;
  var filter = 'pending';
  var open = null;

  var FILTERS = [
    { key: 'pending', label: 'To review' },
    { key: 'invited', label: 'Invited' },
    { key: 'joined', label: 'On Discord' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'all', label: 'All' },
  ];

  function stage(a) {
    if (a.status === 'approved') return a.joinedAt ? 'joined' : 'invited';
    return a.status;
  }

  function when(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function roleLabel(key) {
    var role = (data.roles || []).filter(function (r) {
      return r.key === key;
    })[0];
    return role ? role.label : key || '—';
  }

  function load() {
    list.appendChild(M.loading());
    Promise.all([M.me, M.api('GET', '/api/app/members')])
      .then(function (r) {
        var d = r[1];
        data = d;
        var missing = [];
        if (!d.mailReady) missing.push('email sending (admin → Settings → Mail settings)');
        d.roles.forEach(function (r) {
          if (!r.ready) missing.push('the Discord id of the ' + r.label + ' role');
        });
        document.getElementById('setupNote').hidden = !missing.length;
        document.getElementById('setupText').textContent =
          'Approving needs ' + missing.join(' and ') + ', which is not set up yet.';
        follow(d.following);
        render();
      })
      .catch(function (err) {
        M.clear(list);
        if (err.status === 403) {
          list.appendChild(
            h(
              'div',
              { class: 'empty-state' },
              h('h3', null, 'No access'),
              h('p', null, err.message + '. Ask the Direttivo if you should review applications.')
            )
          );
          return;
        }
        M.appError(err);
      });
  }

  function render() {
    M.clear(filters);
    FILTERS.forEach(function (f) {
      var n = data.applications.filter(function (a) {
        return f.key === 'all' || stage(a) === f.key;
      }).length;
      var input = h('input', { type: 'radio', name: 'filter', value: f.key });
      input.checked = f.key === filter;
      input.addEventListener('change', function () {
        filter = f.key;
        render();
      });
      filters.appendChild(
        h('label', { class: 'choice' }, input, h('span', null, f.label + ' (' + n + ')'))
      );
    });

    M.clear(list);
    var shown = data.applications.filter(function (a) {
      return filter === 'all' || stage(a) === filter;
    });
    if (!shown.length) {
      list.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'Nothing here'),
          h('p', null, 'No applications in this list.')
        )
      );
      return;
    }
    list.appendChild(h('div', { class: 'poll-list' }, shown.map(row)));
  }

  function badge(a) {
    var s = stage(a);
    var cls = {
      pending: 'badge-open',
      invited: 'badge-scheduled',
      joined: 'badge-scheduled',
      rejected: 'badge-closed',
    }[s];
    var label = {
      pending: 'To review',
      invited: 'Invited',
      joined: 'On Discord',
      rejected: 'Rejected',
    }[s];
    return h('span', { class: 'badge ' + cls }, label);
  }

  function row(a) {
    var meta = [a.email, 'Applied ' + when(a.createdAt)];
    if (a.kind === 'upgrade')
      meta = ['On Discord as ' + (a.discordName || a.name), 'Asked ' + when(a.createdAt)];
    else if (a.requestedRole) meta.push('Asks: ' + roleLabel(a.requestedRole));
    var head = h(
      'button',
      {
        type: 'button',
        class: 'poll-item',
        style: 'width:100%;text-align:left',
        'aria-expanded': String(open === a.id),
        onclick: function () {
          open = open === a.id ? null : a.id;
          render();
        },
      },
      h(
        'div',
        null,
        h('strong', null, a.name),
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
        a.kind === 'upgrade'
          ? h(
              'span',
              {
                class: 'badge badge-upgrade',
                title: 'A participant asking to become an organizer',
              },
              'Upgrade'
            )
          : null,
        a.duplicates && a.kind !== 'upgrade'
          ? h('span', { class: 'panel-note' }, 'Applied ' + (a.duplicates + 1) + ' times')
          : null,
        badge(a)
      )
    );
    return h('div', null, head, open === a.id ? detail(a) : null);
  }

  function detail(a) {
    var box = h('div', { class: 'panel', style: 'margin:.5rem 0 1rem' });
    var dl = h('dl', { class: 'member-answers' });
    a.answers.forEach(function (q) {
      dl.appendChild(h('dt', { class: 'label-mono' }, q.label));
      dl.appendChild(h('dd', { style: 'margin:0 0 .75rem;white-space:pre-wrap' }, q.value || '—'));
    });
    box.appendChild(
      a.answers.length ? dl : h('p', { class: 'panel-note' }, 'The form sent no other answers.')
    );

    if (a.status !== 'pending') box.appendChild(outcome(a));
    // A rejection can be undone by approving.
    if (a.status !== 'approved') box.appendChild(decideForm(a));
    return box;
  }

  // The working groups as tags, under the role: each click puts the person
  // in the group or takes them out. Precompiled from the form; who
  // coordinates is chosen on Working groups. On Discord the groups become roles, never
  // permissions here.
  function tagPicker(start) {
    var tags = {};
    (start || []).forEach(function (t) {
      tags[t.group] = true;
    });
    var box = h('div', { class: 'tag-picker', role: 'group', 'aria-label': 'Working groups' });
    function draw() {
      M.clear(box);
      (data.groups || []).forEach(function (g) {
        var on = Boolean(tags[g.id]);
        box.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'tag-chip' + (on ? ' is-stable' : ''),
              'aria-pressed': String(on),
              onclick: function () {
                if (on) delete tags[g.id];
                else tags[g.id] = true;
                draw();
              },
            },
            g.title
          )
        );
      });
    }
    draw();
    return {
      node: box,
      value: function () {
        return Object.keys(tags).map(function (group) {
          return { group: group, level: 'stable' };
        });
      },
    };
  }

  function decideForm(a) {
    var tags = tagPicker(a.tags);
    var upgrade = a.kind === 'upgrade';
    var group = h('div', {
      class: 'choice-group',
      role: 'radiogroup',
      'aria-label': 'Discord role',
    });
    data.roles.forEach(function (r) {
      var input = h('input', { type: 'radio', name: 'role-' + a.id, value: r.key });
      input.checked = r.key === (a.requestedRole || 'participant');
      group.appendChild(h('label', { class: 'choice' }, input, h('span', null, r.label)));
    });
    var note = h('textarea', {
      class: 'form-input',
      rows: 2,
      maxlength: 2000,
      placeholder: 'Internal note (optional; not encrypted, so no personal data)',
    });
    var approve = h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm' },
      upgrade ? 'Approve: make them an organizer' : 'Approve and send the Discord link'
    );
    var reject = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Reject');

    function send(decision) {
      var picked = group.querySelector('input:checked');
      if (decision === 'reject' && !window.confirm('Reject ' + a.name + '? No email is sent.'))
        return;
      approve.disabled = reject.disabled = true;
      M.api('POST', '/api/app/members?action=decide&id=' + encodeURIComponent(a.id), {
        decision: decision,
        role: upgrade ? 'organizer' : picked && picked.value,
        tags: tags.value(),
        note: note.value,
      })
        .then(function (r) {
          replace(r.application);
          M.toast(
            decision === 'reject'
              ? 'Rejected.'
              : upgrade
              ? a.name + ' is now an organizer.'
              : r.invite.sent
              ? 'Approved: the link is on its way to ' + a.email + '.'
              : 'Approved, but the email was not sent (' +
                r.invite.detail +
                '). Use “Send the link again”.',
            decision === 'approve' && !upgrade && !r.invite.sent
          );
        })
        .catch(function (err) {
          approve.disabled = reject.disabled = false;
          M.appError(err);
        });
    }
    approve.addEventListener('click', function () {
      send('approve');
    });
    reject.addEventListener('click', function () {
      send('reject');
    });

    return h(
      'div',
      null,
      upgrade ? null : h('p', { class: 'form-label' }, 'Discord role'),
      upgrade ? null : group,
      h(
        'p',
        { class: 'form-label', style: 'margin-top:.9rem' },
        'Working groups',
        h('span', { class: 'panel-note' }, ' · tags on Discord, not permissions here')
      ),
      tags.node,
      h('div', { style: 'margin:.75rem 0' }, note),
      h('div', { class: 'wk-nav' }, approve, a.status === 'pending' ? reject : null)
    );
  }

  function outcome(a) {
    var lines = [];
    lines.push(
      (a.status === 'approved' ? 'Approved as ' + roleLabel(a.role) : 'Rejected') +
        (a.decidedBy ? ' by ' + a.decidedBy : '') +
        (a.decidedAt ? ', ' + when(a.decidedAt) : '') +
        '.'
    );
    if (a.note) lines.push('Note: ' + a.note);
    if (a.status === 'approved') {
      if (a.joinedAt)
        lines.push('Joined Discord as ' + a.discordName + ', ' + when(a.joinedAt) + '.');
      if (a.joinedAt && a.joinEmailMatch === false)
        lines.push(
          'Check this: the Discord account that used the link has a different email from the application. The link may have been forwarded.'
        );
      else if (a.inviteSentAt) {
        lines.push(
          'Link emailed ' + when(a.inviteSentAt) + '; valid until ' + when(a.joinExpiresAt) + '.'
        );
      }
      if (a.inviteError && !a.joinedAt) lines.push('The email failed: ' + a.inviteError);
      if (a.joinError && !a.joinedAt) lines.push('Joining failed: ' + a.joinError);
    }
    var box = h(
      'div',
      null,
      lines.map(function (l) {
        return h('p', { class: 'panel-note', style: 'margin:.25rem 0' }, l);
      })
    );
    if (a.status === 'approved' && !a.joinedAt) {
      var again = h(
        'button',
        { type: 'button', class: 'btn btn-outline btn-sm', style: 'margin-top:.75rem' },
        'Send the link again'
      );
      again.addEventListener('click', function () {
        again.disabled = true;
        M.api('POST', '/api/app/members?action=resend&id=' + encodeURIComponent(a.id), {})
          .then(function (r) {
            replace(r.application);
            M.toast(
              r.invite.sent
                ? 'A new link is on its way.'
                : 'The email was not sent (' + r.invite.detail + ').',
              !r.invite.sent
            );
          })
          .catch(function (err) {
            again.disabled = false;
            M.appError(err);
          });
      });
      box.appendChild(again);
    }
    return box;
  }

  function replace(app) {
    data.applications = data.applications.map(function (a) {
      return a.id === app.id ? app : a;
    });
    render();
  }

  load();
  // "Notify me": told about new applications (and counted on the home
  // page) only when following the board. Null: no channel of one's own.
  function follow(on) {
    var box = document.getElementById('followBoard');
    var input = document.getElementById('followInput');
    box.hidden = on === null || on === undefined;
    input.checked = Boolean(on);
    input.onchange = function () {
      input.disabled = true;
      M.api('POST', '/api/app/members?action=follow', { on: input.checked })
        .then(function (r) {
          M.toast(r.following ? 'You will hear about new applications' : 'Notifications off');
        })
        .catch(function (err) {
          input.checked = !input.checked;
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
        })
        .then(function () {
          input.disabled = false;
        });
    };
  }
})();
