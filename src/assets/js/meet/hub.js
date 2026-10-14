/* /app/: greets the signed-in member above the list of tools. */
(function () {
  'use strict';
  window.Meet.me.then(function (user) {
    document.getElementById('hello').textContent = 'Ciao, ' + user.name.split(' ')[0];
  });
})();
