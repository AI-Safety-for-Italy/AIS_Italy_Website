/* /app/: greets the signed-in member above the list of tools, and shows the
 * content tool to those whose Discord roles allow publishing something, and
 * the applications board to those with `members`. */
(function () {
  'use strict';
  window.Meet.me.then(function (user) {
    document.getElementById('hello').textContent = 'Ciao, ' + user.name.split(' ')[0];
  });
  window.Meet.permissions.then(function (perms) {
    document.getElementById('contentTool').hidden = !perms.some(function (p) {
      return p !== 'members';
    });
    document.getElementById('membersTool').hidden = perms.indexOf('members') === -1;
  });
})();
