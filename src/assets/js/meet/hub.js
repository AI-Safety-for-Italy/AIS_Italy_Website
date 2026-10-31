/* /app/: greets the signed-in member and shows what waits for them in each
 * tool (the counts of /api/app/overview, see server/overview.js). Which tools
 * and actions show is decided by app-common.js from the member's areas. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var registry = [];
  try {
    registry = JSON.parse(document.getElementById('apTools').textContent || '[]');
  } catch (e) {
    registry = [];
  }

  document.getElementById('hubDate').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  M.me.then(function (user) {
    document.getElementById('hello').textContent = 'Ciao, ' + user.name.split(' ')[0];
  });

  M.overview.then(function (data) {
    var box = document.getElementById('hubTodo');
    M.clear(box);
    var waiting = registry.filter(function (tool) {
      var todo = data.tools[tool.key];
      return todo && todo.count;
    });
    if (!waiting.length) {
      box.appendChild(
        h(
          'div',
          { class: 'hub-clear' },
          h('strong', null, 'All clear'),
          h('span', null, 'Nothing waits for you right now.')
        )
      );
      return;
    }
    waiting.forEach(function (tool) {
      var todo = data.tools[tool.key];
      box.appendChild(
        h(
          'a',
          { class: 'hub-todo-card', href: todo.url || tool.url },
          h(
            'span',
            { class: 'hub-todo-top' },
            h('span', {
              class: 'hub-tool-icon',
              'aria-hidden': 'true',
              html:
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                tool.icon +
                '</svg>',
            }),
            h('span', { class: 'hub-todo-count' }, String(todo.count))
          ),
          h('strong', null, todo.label.charAt(0).toUpperCase() + todo.label.slice(1)),
          h('span', null, tool.title)
        )
      );
    });
  });
})();
