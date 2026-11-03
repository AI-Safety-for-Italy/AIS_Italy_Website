/* Both settings pages:
 *   /app/settings/        a member's own notification choices;
 *   /app/settings/mail/  general settings (the sending mailbox), admin only.
 * Each page carries only its own form. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var notifyForm = document.getElementById('notifyForm');
  var smtpForm = document.getElementById('smtpForm');
  var data = null;
  var notifyFields = null; // saved against typed (M.watchFields)
  var smtpFields = null;

  function errorBox(form, message) {
    var box = form.querySelector('.form-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function channel() {
    var picked = notifyForm.querySelector('input[name=channel]:checked');
    return picked ? picked.value : 'email';
  }

  function refreshNotify() {
    var c = channel();
    document.getElementById('notifyEmailRow').hidden = c === 'none' || c === 'discord';
    var note = document.getElementById('discordNote');
    var wantsDiscord = c === 'discord' || c === 'both';
    var p = data.profile;
    note.hidden = !wantsDiscord || (p.discordLinked && data.discordBot);
    document.getElementById('discordNoteText').textContent = !p.discordLinked
      ? 'This account isn’t linked to Discord, so messages will go by email.'
      : 'Discord messages aren’t set up on the site yet, so these will go by email for now.';
    if (wantsDiscord && note.hidden === false)
      document.getElementById('notifyEmailRow').hidden = false;
  }

  function fillSmtp(smtp) {
    smtp = smtp || {};
    document.getElementById('smtpHost').value = smtp.host || '';
    document.getElementById('smtpPort').value = smtp.port || 465;
    document.getElementById('fromEmail').value = smtp.fromEmail || '';
    document.getElementById('fromName').value = smtp.fromName || '';
    document.getElementById('formsEmail').value = smtp.formsEmail || '';
    document.getElementById('smtpUser').value = smtp.user || '';
    var pw = document.getElementById('smtpPassword');
    pw.value = '';
    pw.placeholder = smtp.hasPassword ? 'Saved (leave empty to keep it)' : '';
    M.clear(document.getElementById('mailStatus')).appendChild(
      h(
        'span',
        { class: 'badge ' + (data.mail.configured ? 'badge-open' : 'badge-closed') },
        data.mail.configured ? 'Ready' : 'Not set up'
      )
    );
  }

  Promise.all([M.me, M.api('GET', '/api/app/settings')])
    .then(function (r) {
      var d = r[1];
      data = d;
      if (notifyForm) {
        var p = d.profile;
        notifyForm.querySelector('input[value="' + p.notifyChannel + '"]').checked = true;
        var email = document.getElementById('notifyEmail');
        email.value = p.notifyEmail || '';
        email.placeholder = p.discordEmail || 'name@example.org';
        document.getElementById('notifyEmailHint').textContent = p.discordEmail
          ? 'Leave it empty to use your Discord email, ' + p.discordEmail + '.'
          : '';
        refreshNotify();
        notifyFields = M.watchFields(notifyForm);
        drawFollows(d.follows);
      }
      if (smtpForm) {
        if (d.mail.smtp !== undefined) {
          smtpForm.hidden = false;
          fillSmtp(d.mail.smtp);
          smtpFields = M.watchFields(smtpForm);
        } else {
          document.getElementById('adminOnly').hidden = false;
        }
      }
    })
    .catch(M.appError);

  if (notifyForm) notifyForm.addEventListener('change', refreshNotify);

  // What this member follows: one switch each, saved at once (the same as
  // on the form's card and on the member applications page).
  function drawFollows(f) {
    var panel = document.getElementById('followPanel');
    var list = document.getElementById('followList');
    if (!panel || !f) return;
    M.clear(list);
    var rows = [];
    if (f.members && f.members.canFollow) {
      rows.push({
        title: 'Member applications',
        what: 'When someone asks to join',
        on: f.members.following,
        save: function (on) {
          return M.api('POST', '/api/app/members?action=follow', { on: on });
        },
      });
    }
    (f.forms || []).forEach(function (form) {
      if (form.notifyMe === null) return;
      rows.push({
        title: form.title,
        what: 'Form · new answers',
        on: form.notifyMe,
        save: function (on) {
          return M.api(
            'PUT',
            '/api/app/forms?id=' + encodeURIComponent(form.id) + '&part=notify-me',
            { on: on }
          );
        },
      });
    });
    (f.polls || []).forEach(function (poll) {
      rows.push({
        title: poll.title,
        what: 'Meeting poll · new answers',
        on: poll.notifyMe,
        save: function (on) {
          return M.api(
            'POST',
            '/api/app/poll?id=' + encodeURIComponent(poll.id) + '&action=notify-me',
            { on: on }
          );
        },
      });
    });
    rows.forEach(function (row) {
      var input = h('input', {
        type: 'checkbox',
        role: 'switch',
        class: 'fe-switch-input',
        'aria-label': 'Follow ' + row.title,
        onchange: function () {
          input.disabled = true;
          row
            .save(input.checked)
            .then(function () {
              row.on = input.checked;
              M.toast(input.checked ? 'Following ' + row.title : 'Not following ' + row.title);
            })
            .catch(function (err) {
              input.checked = row.on;
              M.appError(err);
            })
            .then(function () {
              input.disabled = false;
            });
        },
      });
      input.checked = row.on;
      list.appendChild(
        h(
          'label',
          { class: 'follow-row' },
          h(
            'span',
            { class: 'follow-text' },
            h('strong', null, row.title),
            h('small', null, row.what)
          ),
          input
        )
      );
    });
    if (!rows.length) {
      list.appendChild(
        h('p', { class: 'form-note', style: 'margin:0' }, 'Nothing you can follow yet.')
      );
    }
    panel.hidden = false;
  }

  if (notifyForm)
    notifyForm.addEventListener('submit', function (e) {
      e.preventDefault();
      errorBox(notifyForm);
      M.api('PATCH', '/api/app/settings', {
        notifyChannel: channel(),
        notifyEmail: document.getElementById('notifyEmail').value,
      })
        .then(function (res) {
          data.profile = res.profile;
          notifyFields.saved();
          M.toast('Saved');
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          errorBox(notifyForm, err.message);
        });
    });

  if (smtpForm)
    smtpForm.addEventListener('submit', function (e) {
      e.preventDefault();
      errorBox(smtpForm);
      M.api('PUT', '/api/app/settings', {
        host: document.getElementById('smtpHost').value,
        port: Number(document.getElementById('smtpPort').value),
        fromEmail: document.getElementById('fromEmail').value,
        fromName: document.getElementById('fromName').value,
        formsEmail: document.getElementById('formsEmail').value,
        user: document.getElementById('smtpUser').value,
        password: document.getElementById('smtpPassword').value,
      })
        .then(function (res) {
          data.mail.configured = Boolean(res.smtp && res.smtp.hasPassword);
          fillSmtp(res.smtp);
          smtpFields.saved();
          M.toast('Saved');
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          errorBox(smtpForm, err.message);
        });
    });

  if (smtpForm)
    document.getElementById('testMail').addEventListener('click', function () {
      var to = window.prompt('Send a test email to:', document.getElementById('fromEmail').value);
      if (!to) return;
      errorBox(smtpForm);
      var button = this;
      button.disabled = true;
      M.api('POST', '/api/app/settings?action=test', { to: to })
        .then(function () {
          M.toast('Test email sent to ' + to);
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          errorBox(smtpForm, err.message);
        })
        .then(function () {
          button.disabled = false;
        });
    });
})();
