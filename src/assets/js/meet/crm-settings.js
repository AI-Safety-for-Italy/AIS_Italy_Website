/* /app/crm/settings/: which Google spreadsheet and tab each source of the
 * mentorship board reads (/api/app/crm/mentorship?action=sources). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var form = document.getElementById('sheetsForm');
  var rows = document.getElementById('sheetRows');
  var error = form.querySelector('.form-error');
  var sources = [];

  function showError(message) {
    error.textContent = message || '';
    error.hidden = !message;
  }

  function draw(data) {
    sources = data.sources;
    var note = document.getElementById('shareNote');
    note.hidden = false;
    note.textContent = data.serviceAccount
      ? 'Share each spreadsheet, as Viewer, with ' +
        data.serviceAccount +
        ' (Share button in Google Sheets).'
      : 'Google Sheets is not set up here yet: the service account key is missing on the server.';
    M.clear(rows);
    sources.forEach(function (s) {
      rows.appendChild(
        h(
          'fieldset',
          { class: 'form-grid', style: 'border:0;padding:0;margin:0 0 1rem' },
          h('legend', { class: 'form-label' }, s.label),
          h(
            'div',
            { class: 'form-row' },
            h(
              'div',
              null,
              h(
                'label',
                { class: 'form-label', for: 'sheet-' + s.id },
                'Spreadsheet address or id'
              ),
              h('input', {
                class: 'form-input is-compact',
                id: 'sheet-' + s.id,
                value: s.spreadsheetId,
                autocomplete: 'off',
                placeholder: 'https://docs.google.com/spreadsheets/d/…',
              })
            ),
            h(
              'div',
              null,
              h('label', { class: 'form-label', for: 'tab-' + s.id }, 'Tab'),
              h('input', {
                class: 'form-input is-compact',
                id: 'tab-' + s.id,
                value: s.tab,
                autocomplete: 'off',
              })
            )
          )
        )
      );
    });
  }

  M.me
    .then(function () {
      return M.api('GET', '/api/app/crm/mentorship?action=sources');
    })
    .then(draw)
    .catch(function (err) {
      if (err.status === 403) {
        M.clear(form);
        form.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h('p', null, 'Only people with “CRM: settings” can change this.')
          )
        );
        return;
      }
      M.appError(err);
    });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError();
    var body = {};
    sources.forEach(function (s) {
      body[s.id] = {
        spreadsheetId: document.getElementById('sheet-' + s.id).value,
        tab: document.getElementById('tab-' + s.id).value,
      };
    });
    M.api('PUT', '/api/app/crm/mentorship?action=sources', body)
      .then(function (data) {
        draw(data);
        M.toast('Saved');
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        showError(err.message);
      });
  });
})();
