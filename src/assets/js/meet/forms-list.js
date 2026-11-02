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

  // Copies the public link without opening the form. A draft's link answers
  // "not found" until the form is opened, so the toast says so.
  function copyButton(f) {
    var link = location.origin + '/form/?f=' + encodeURIComponent(f.slug);
    return h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm fl-copy',
        title: link,
        'aria-label': 'Copy the public link of ' + f.title,
        onclick: function () {
          M.copy(
            link,
            f.status === 'draft' ? 'Link copied: it works once the form is open' : 'Link copied'
          );
        },
      },
      'Copy link'
    );
  }

  // This member's own switch: hear about the form's new answers or not
  // (owner, readers by name or by role, forms admins). Null: no channel.
  function notifySwitch(f) {
    if (f.notifyMe === null || f.notifyMe === undefined) return null;
    var input = h('input', {
      type: 'checkbox',
      role: 'switch',
      class: 'fe-switch-input',
      'aria-label': 'Notify me about answers to ' + f.title,
      onchange: function () {
        input.disabled = true;
        M.api('PUT', '/api/app/forms?id=' + encodeURIComponent(f.id) + '&part=notify-me', {
          on: input.checked,
        })
          .then(function (r) {
            f.notifyMe = r.notifyMe;
            M.toast(
              r.notifyMe ? 'You will hear about new answers' : 'Notifications off for this form'
            );
          })
          .catch(function (err) {
            input.checked = f.notifyMe;
            if (err.status === 401) return M.appError(err);
            M.toast(err.message, true);
          })
          .then(function () {
            input.disabled = false;
          });
      },
    });
    input.checked = f.notifyMe;
    return h(
      'label',
      { class: 'fl-notify', title: 'Hear about new answers, on your channel from Settings' },
      h('span', null, 'Notify me'),
      input
    );
  }

  // Who can see the answers: a face (or a role's initial) each, the name and
  // why on hover. A few, then "+n".
  function faces(f) {
    var who = f.access || [];
    if (!who.length) return h('span');
    var shown = who.slice(0, 6);
    var row = h('div', { class: 'fl-faces', 'aria-label': 'Who can see the answers' });
    shown.forEach(function (a) {
      var label = a.name + ' — ' + a.what;
      row.appendChild(
        h(
          'span',
          {
            class: 'fl-face' + (a.kind === 'role' ? ' is-role' : ''),
            title: label,
            tabindex: '0',
            'aria-label': label,
          },
          a.kind === 'role'
            ? h('span', { class: 'app-avatar is-initial' }, a.name.charAt(0).toUpperCase())
            : M.avatar({ name: a.name, avatarUrl: a.avatarUrl }, 26)
        )
      );
    });
    if (who.length > shown.length) {
      var rest = who.slice(shown.length);
      row.appendChild(
        h(
          'span',
          {
            class: 'fl-face fl-more',
            tabindex: '0',
            title: rest
              .map(function (a) {
                return a.name + ' — ' + a.what;
              })
              .join('\n'),
          },
          '+' + rest.length
        )
      );
    }
    return row;
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
        copyButton(f),
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
      ),
      h('div', { class: 'fl-foot' }, faces(f), notifySwitch(f))
    );
  }

  Promise.all([M.me, M.permissions])
    .then(function (r) {
      // Making forms needs a forms permission; reading some answers does not.
      newBtn.hidden = r[1].indexOf('forms') === -1 && r[1].indexOf('forms_admin') === -1;
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
