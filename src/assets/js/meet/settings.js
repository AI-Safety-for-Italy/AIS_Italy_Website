/* /app/settings/: everyone's notification choices; the admin also sets up
 * the mailbox emails are sent from. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var notifyForm = document.getElementById('notifyForm');
  var smtpForm = document.getElementById('smtpForm');
  var data = null;

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
    note.textContent = !p.discordLinked
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

  M.me
    .then(function () {
      return M.api('GET', '/api/app/settings');
    })
    .then(function (d) {
      data = d;
      var p = d.profile;
      notifyForm.querySelector('input[value="' + p.notifyChannel + '"]').checked = true;
      var email = document.getElementById('notifyEmail');
      email.value = p.notifyEmail || '';
      email.placeholder = p.discordEmail || 'name@example.org';
      refreshNotify();
      if (d.mail.smtp !== undefined) {
        smtpForm.hidden = false;
        fillSmtp(d.mail.smtp);
      }
    })
    .catch(M.appError);

  notifyForm.addEventListener('change', refreshNotify);

  notifyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox(notifyForm);
    M.api('PATCH', '/api/app/settings', {
      notifyChannel: channel(),
      notifyEmail: document.getElementById('notifyEmail').value,
    })
      .then(function (res) {
        data.profile = res.profile;
        M.toast('Saved');
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        errorBox(notifyForm, err.message);
      });
  });

  smtpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox(smtpForm);
    M.api('PUT', '/api/app/settings', {
      host: document.getElementById('smtpHost').value,
      port: Number(document.getElementById('smtpPort').value),
      fromEmail: document.getElementById('fromEmail').value,
      fromName: document.getElementById('fromName').value,
      user: document.getElementById('smtpUser').value,
      password: document.getElementById('smtpPassword').value,
    })
      .then(function (res) {
        data.mail.configured = Boolean(res.smtp && res.smtp.hasPassword);
        fillSmtp(res.smtp);
        M.toast('Saved');
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        errorBox(smtpForm, err.message);
      });
  });

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
