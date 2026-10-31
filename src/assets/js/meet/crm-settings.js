/* /app/crm/settings/: which Google spreadsheet and tab each source of the
 * mentorship board is imported from, and the import itself
 * (/api/app/crm/mentorship?action=sources and action=import). */
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
      var result = h('p', { class: 'form-note', role: 'status', style: 'margin:0' });
      var importBtn = h(
        'button',
        { type: 'button', class: 'btn btn-outline btn-sm', disabled: !s.spreadsheetId },
        'Import now'
      );
      importBtn.addEventListener('click', function () {
        var typed = document.getElementById('sheet-' + s.id).value.trim();
        var tab = document.getElementById('tab-' + s.id).value.trim();
        if (typed !== s.spreadsheetId || tab !== s.tab) {
          result.textContent = 'Save the changes first: the import uses the saved address and tab.';
          return;
        }
        if (!window.confirm('This replaces the previous import of this list. Go on?')) return;
        importBtn.disabled = true;
        result.textContent = 'Importing…';
        M.api('POST', '/api/app/crm/mentorship?action=import&source=' + encodeURIComponent(s.id))
          .then(function (r) {
            result.textContent =
              'Imported ' +
              r.imported +
              (r.imported === 1 ? ' person' : ' people') +
              (r.withoutEmail ? ', ' + r.withoutEmail + ' without email (not on the board)' : '') +
              '.' +
              (r.missing && r.missing.length
                ? ' Columns not found: ' + r.missing.join(', ') + '.'
                : '');
          })
          .catch(function (err) {
            if (err.status === 401) return M.appError(err);
            result.textContent = err.message;
          })
          .then(function () {
            importBtn.disabled = !s.spreadsheetId;
          });
      });
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
          ),
          h('div', null, importBtn),
          result
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
