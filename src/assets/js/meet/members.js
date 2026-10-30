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
    M.me
      .then(function () {
        return M.api('GET', '/api/app/members');
      })
      .then(function (d) {
        data = d;
        var missing = [];
        if (!d.mailReady) missing.push('email sending (admin → General settings)');
        d.roles.forEach(function (r) {
          if (!r.ready) missing.push('the Discord id of the ' + r.label + ' role');
        });
        document.getElementById('setupNote').hidden = !missing.length;
        document.getElementById('setupText').textContent =
          'Approving needs ' + missing.join(' and ') + ', which is not set up yet.';
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
    if (a.requestedRole) meta.push('Asks: ' + roleLabel(a.requestedRole));
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
        a.duplicates
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

  function decideForm(a) {
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
      placeholder: 'Internal note (optional)',
    });
    var approve = h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm' },
      'Approve and send the Discord link'
    );
    var reject = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, 'Reject');

    function send(decision) {
      var picked = group.querySelector('input:checked');
      if (decision === 'reject' && !window.confirm('Reject ' + a.name + '? No email is sent.'))
        return;
      approve.disabled = reject.disabled = true;
      M.api('POST', '/api/app/members?action=decide&id=' + encodeURIComponent(a.id), {
        decision: decision,
        role: picked && picked.value,
        note: note.value,
      })
        .then(function (r) {
          replace(r.application);
          M.toast(
            decision === 'reject'
              ? 'Rejected.'
              : r.invite.sent
              ? 'Approved: the link is on its way to ' + a.email + '.'
              : 'Approved, but the email was not sent (' +
                r.invite.detail +
                '). Use “Send the link again”.',
            decision === 'approve' && !r.invite.sent
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
      h('p', { class: 'form-label' }, 'Discord role'),
      group,
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
})();
