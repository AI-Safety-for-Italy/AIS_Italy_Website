/* /app/: greets the signed-in member above the list of tools, and shows the
 * content tool to those whose Discord roles allow publishing something. */
(function () {
  'use strict';
  window.Meet.me.then(function (user) {
    document.getElementById('hello').textContent = 'Ciao, ' + user.name.split(' ')[0];
  });
  window.Meet.areas.then(function (areas) {
    document.getElementById('contentTool').hidden = !areas.content;
    document.getElementById('crmTool').hidden = !areas.crm;
    document.getElementById('formsTool').hidden = !areas.forms;
  });
})();
