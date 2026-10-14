/* /app/login/: Discord sign-in, the admin password, and (locally) a stand-in
 * for Discord. Already signed in? Straight on to where they were going. */
(function () {
  'use strict';
  var M = window.Meet;

  var ERRORS = {
    not_member: 'You need to be a member of the AI Safety for Italy Discord server.',
    missing_role:
      'Your Discord account doesn’t have access yet. Ask an organiser to give you the role.',
    denied: 'Sign-in was cancelled on Discord.',
    expired: 'The sign-in took too long or was started elsewhere. Please try again.',
    unavailable: 'Discord sign-in is not set up here.',
    failed: 'Discord sign-in didn’t work. Please try again.',
  };

  var params = new URLSearchParams(window.location.search);
  var next = params.get('next');
  if (!next || !/^\/app\/[\w/-]*(\?[\w=&%.-]*)?$/.test(next)) next = '/app/';

  var error = document.getElementById('loginError');
  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }
  if (params.get('error')) showError(ERRORS[params.get('error')] || ERRORS.failed);

  var discord = document.getElementById('discordLogin');
  discord.href = '/api/discord?next=' + encodeURIComponent(next);

  M.api('GET', '/api/auth').then(function (info) {
    if (info.user) {
      window.location.replace(next);
      return;
    }
    discord.hidden = !info.discord;
    document.getElementById('devLogin').hidden = !info.devLogin;
    if (!info.discord && !info.devLogin) document.querySelector('.admin-login').open = true;
  });

  function signIn(form, action, body) {
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    showError('');
    M.api('POST', '/api/auth?action=' + action, body)
      .then(function () {
        window.location.href = next;
      })
      .catch(function (err) {
        showError(err.message);
        button.disabled = false;
      });
  }

  document.getElementById('passwordLogin').addEventListener('submit', function (e) {
    e.preventDefault();
    signIn(e.target, 'password', { password: document.getElementById('password').value });
  });

  document.getElementById('devLogin').addEventListener('submit', function (e) {
    e.preventDefault();
    signIn(e.target, 'dev', { name: document.getElementById('devName').value });
  });
})();
