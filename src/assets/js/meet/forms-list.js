/* /app/forms/: the forms this member may manage or read, and new ones. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var list = document.getElementById('formList');
  var newBtn = document.getElementById('newForm');
  var dialog = document.getElementById('newDialog');
  var STATUS = { draft: 'Draft', open: 'Open', closed: 'Closed' };

  list.appendChild(M.loading());

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    M.clear(list);
    list.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        h('h3', null, err.status === 503 ? 'Not set up yet' : 'Something went wrong'),
        h('p', null, err.message)
      )
    );
  }

  function badge(f) {
    var key = f.status === 'open' && !f.open ? 'closed' : f.status;
    var label = f.status === 'open' && !f.open ? 'Not open now' : STATUS[f.status];
    return h('span', { class: 'badge fe-badge fe-badge-' + key }, label);
  }

  function card(f) {
    var edit = '/app/forms/edit/?id=' + encodeURIComponent(f.id);
    // The card opens the form (its questions, or its answers for those who
    // only read them); the count opens the answers straight away.
    return h(
      'div',
      { class: 'poll-item fl-card' },
      h(
        'div',
        null,
        h(
          'h3',
          null,
          h('a', { class: 'fl-open', href: f.canManage ? edit : edit + '#responses' }, f.title)
        ),
        h(
          'div',
          { class: 'poll-item-meta' },
          h('span', null, '/form/?f=' + f.slug),
          f.lastResponseAt
            ? h('span', null, 'Last answer ' + M.fmtDateTime(f.lastResponseAt, 'Europe/Rome'))
            : null,
          f.canManage ? null : h('span', null, 'Answers only')
        )
      ),
      h(
        'div',
        { class: 'poll-item-side' },
        badge(f),
        h(
          'a',
          {
            class: 'poll-count fl-answers',
            href: edit + '#responses',
            title: 'See the answers',
          },
          h('strong', null, String(f.responses)),
          h('span', null, (f.responses === 1 ? 'answer' : 'answers') + ' →')
        )
      )
    );
  }

  Promise.all([M.me, M.areas])
    .then(function (r) {
      newBtn.hidden = !r[1].forms;
      return M.api('GET', '/api/app/forms');
    })
    .then(function (data) {
      M.clear(list);
      if (!data.forms.length) {
        list.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No forms yet'),
            h(
              'p',
              null,
              newBtn.hidden
                ? 'Forms you are given access to will show here.'
                : 'Make the first one: start from a blank form or a template.'
            )
          )
        );
        return;
      }
      list.appendChild(h('div', { class: 'poll-list' }, data.forms.map(card)));
    })
    .catch(fail);

  // ── New form ─────────────────────────────────────────────────────────────

  var templatesLoaded = false;
  newBtn.addEventListener('click', function () {
    document.getElementById('nfError').hidden = true;
    dialog.showModal();
    document.getElementById('nfTitle').focus();
    if (templatesLoaded) return;
    M.api('GET', '/api/app/forms?meta=1')
      .then(function (meta) {
        templatesLoaded = true;
        var box = document.getElementById('nfTemplates');
        M.clear(box);
        meta.templates.forEach(function (t, i) {
          var input = h('input', { type: 'radio', name: 'template', value: t.key });
          input.checked = i === 0;
          box.appendChild(h('label', { class: 'fe-template' }, input, h('span', null, t.label)));
        });
      })
      .catch(fail);
  });
  document.getElementById('nfCancel').addEventListener('click', function () {
    dialog.close();
  });
  document.getElementById('newFormForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = document.getElementById('nfTitle').value.trim();
    var picked = dialog.querySelector('input[name="template"]:checked');
    var error = document.getElementById('nfError');
    if (!title) {
      error.textContent = 'Give the form a title.';
      error.hidden = false;
      return;
    }
    var btn = document.getElementById('nfCreate');
    btn.disabled = true;
    M.api('POST', '/api/app/forms', { title: title, template: picked ? picked.value : 'blank' })
      .then(function (r) {
        window.location.href = '/app/forms/edit/?id=' + encodeURIComponent(r.id);
      })
      .catch(function (err) {
        btn.disabled = false;
        if (err.status === 401) return M.appError(err);
        error.textContent = err.message;
        error.hidden = false;
      });
  });

  // ?new=1 (a link to start a new form) opens the dialog once the button is shown.
  if (new URLSearchParams(window.location.search).get('new') === '1') {
    M.areas.then(function (areas) {
      if (areas.forms) newBtn.click();
    });
  }
})();
