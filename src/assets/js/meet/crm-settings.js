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
        importBtn.disabled = true;
        result.textContent = 'Importing…';
        send({}).then(function () {
          importBtn.disabled = !s.spreadsheetId;
        });
      });

      function post(body) {
        return M.api(
          'POST',
          '/api/app/crm/mentorship?action=import&source=' + encodeURIComponent(s.id),
          body
        );
      }

      /**
       * Imports this list ({} from the saved sheet, { csv } from a file) and
       * says how it went. When the list was already imported, replacing it
       * takes two confirmations and the admin password (askReplace).
       */
      function send(body) {
        result.textContent = 'Importing…';
        return post(body)
          .catch(function (err) {
            if (err.code !== 'confirm_overwrite') throw err;
            return askReplace(s, err.data.existing, function (password) {
              return post(Object.assign({}, body, { replace: true, adminPassword: password }));
            });
          })
          .then(function (r) {
            if (!r) {
              result.textContent = 'Not imported: the list is unchanged.';
              return;
            }
            result.textContent =
              (r.replaced ? 'Replaced ' + r.replaced + ' with ' : 'Imported ') +
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
          });
      }

      // Or the sheet downloaded as CSV (File → Download → CSV in Google Sheets):
      // the columns are found by their headers, as for the sheet itself.
      var file = h('input', {
        type: 'file',
        accept: '.csv,text/csv',
        hidden: true,
        'aria-label': 'CSV file for ' + s.label,
      });
      var csvBtn = h(
        'button',
        { type: 'button', class: 'btn btn-outline btn-sm' },
        'Import a CSV file'
      );
      csvBtn.addEventListener('click', function () {
        file.value = '';
        file.click();
      });
      file.addEventListener('change', function () {
        var picked = file.files && file.files[0];
        if (!picked) return;
        if (!window.confirm('Import “' + picked.name + '” into ' + s.label + '?')) return;
        csvBtn.disabled = true;
        picked
          .text()
          .then(function (text) {
            return send({ csv: text });
          })
          .then(function () {
            csvBtn.disabled = false;
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
          h('div', { class: 'wk-nav' }, importBtn, csvBtn, file),
          result
        )
      );
    });
  }

  // ── Replacing an import ──────────────────────────────────────────────────
  // First confirmation: a plain question. Second: the dialog, where the box
  // must be ticked and the admin password typed. `run(password)` sends the
  // import; a wrong password keeps the dialog open. Resolves with the
  // import's result, or null when cancelled.
  var replaceDialog = document.getElementById('replaceDialog');
  var rpForm = document.getElementById('replaceForm');
  var rpPassword = document.getElementById('rpPassword');
  var rpAck = document.getElementById('rpAck');
  var rpError = document.getElementById('rpError');
  var rpSubmit = document.getElementById('rpSubmit');

  function askReplace(source, existing, run) {
    var people = existing + (existing === 1 ? ' person' : ' people');
    if (
      !window.confirm(
        source.label +
          ' was already imported (' +
          people +
          '). Importing again deletes them and puts this import in their place. Go on?'
      )
    )
      return Promise.resolve(null);
    document.getElementById('rpText').textContent =
      'The ' +
      people +
      ' imported earlier into “' +
      source.label +
      '” will be deleted. People added on the board or by a form stay.';
    document.getElementById('rpAckText').textContent =
      'Yes, replace the ' + people + ' already imported';
    rpAck.checked = false;
    rpPassword.value = '';
    rpError.hidden = true;
    rpSubmit.disabled = false;
    replaceDialog.showModal();
    rpPassword.focus();

    return new Promise(function (resolve, reject) {
      function done() {
        rpForm.removeEventListener('submit', onSubmit);
        document.getElementById('rpCancel').removeEventListener('click', onCancel);
        replaceDialog.removeEventListener('cancel', onCancel);
        replaceDialog.close();
      }
      function onCancel(e) {
        if (e) e.preventDefault();
        done();
        resolve(null);
      }
      function onSubmit(e) {
        e.preventDefault();
        if (!rpAck.checked || !rpPassword.value) {
          rpError.textContent = 'Tick the box and type the admin password.';
          rpError.hidden = false;
          return;
        }
        rpSubmit.disabled = true;
        rpError.hidden = true;
        run(rpPassword.value).then(
          function (r) {
            done();
            resolve(r);
          },
          function (err) {
            rpSubmit.disabled = false;
            if (err.code === 'wrong_password' || err.status === 429) {
              rpError.textContent = err.message;
              rpError.hidden = false;
              rpPassword.select();
              return;
            }
            done();
            reject(err);
          }
        );
      }
      rpForm.addEventListener('submit', onSubmit);
      document.getElementById('rpCancel').addEventListener('click', onCancel);
      replaceDialog.addEventListener('cancel', onCancel);
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
