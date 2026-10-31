/* /app/content/edit/: the form for one seminar or event.
 *   ?type=seminar|event  a new one
 *   ?id=…                an existing one, with its history
 * The preview asks the server for the entry the fields make (the same code
 * that publishes it), so the date lines and any mistake show as you type. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var form = document.getElementById('contentForm');
  var state = document.getElementById('formState');
  var detailsBox = document.getElementById('details');
  var previewBox = document.getElementById('preview');
  var previewError = document.getElementById('previewError');
  var formError = document.getElementById('formError');
  var saveBtn = document.getElementById('saveBtn');
  var deleteBtn = document.getElementById('deleteBtn');

  var params = new URLSearchParams(window.location.search);
  var itemId = params.get('id');
  var previewLang = 'en';
  var lastEntry = null;
  var dirty = false;

  var TEXT_FIELDS = [
    'day',
    'time',
    'end_time',
    'speaker',
    'speaker_affiliation',
    'speaker_link',
    'title',
    'title_it',
    'description_md',
    'description_md_it',
    'description_past_md',
    'description_past_md_it',
    'register_link',
    'register_text',
    'register_text_it',
  ];

  var PRESETS = {
    where: {
      label: 'Where',
      label_it: 'Dove',
      value: 'Online, on Zoom (link sent after registration)',
      value_it: 'Online, su Zoom (link inviato dopo la registrazione)',
    },
  };

  state.appendChild(M.loading());

  Promise.all([M.me, M.permissions])
    .then(function (r) {
      var perms = r[1];
      if (itemId) {
        return M.api('GET', '/api/app/content?id=' + encodeURIComponent(itemId)).then(function (
          item
        ) {
          start(perms, item);
        });
      }
      start(perms, null);
    })
    .catch(function (err) {
      M.clear(state);
      if (err.status === 403 || err.status === 404) {
        state.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, err.status === 404 ? 'Not found' : 'No access'),
            h('p', null, err.message)
          )
        );
        return;
      }
      M.appError(err);
    });

  // ── Filling the form ──────────────────────────────────────────────────────

  function start(perms, item) {
    M.clear(state);
    var allowed = ['seminar', 'event'].filter(function (t) {
      return perms.indexOf(t) !== -1;
    });
    if (!allowed.length || (item && !item.canEdit)) {
      state.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'No access'),
          h(
            'p',
            null,
            item
              ? 'Your Discord roles do not allow editing this.'
              : 'Your Discord roles do not allow publishing seminars or events.'
          )
        )
      );
      return;
    }

    form.querySelectorAll('input[name="type"]').forEach(function (radio) {
      var current = item && item.type === radio.value;
      radio.disabled = allowed.indexOf(radio.value) === -1 && !current;
    });

    if (item) {
      fill(item.form);
      setTitle(item.title);
      document.title = 'Edit: ' + item.title + ' | AI Safety for Italy';
      document.getElementById('deletedNotice').hidden = !item.deleted;
      deleteBtn.hidden = item.deleted;
      saveBtn.textContent = item.deleted ? 'Publish again' : 'Save changes';
      document.querySelectorAll('.ap-tabs a[aria-current]').forEach(function (a) {
        a.removeAttribute('aria-current');
      });
      showHistory(item);
    } else {
      var type = allowed.indexOf(params.get('type')) !== -1 ? params.get('type') : allowed[0];
      fill({
        type: type,
        time: '18:30',
        details: [PRESETS.where],
      });
      setTitle(type === 'event' ? 'New event' : 'New seminar');
    }
    form.hidden = false;
    dirty = false;
    updatePreview();
  }

  function setTitle(text) {
    var h = document.getElementById('apTitle');
    if (h) h.textContent = text;
  }

  function fill(f) {
    form.querySelectorAll('input[name="type"]').forEach(function (radio) {
      radio.checked = radio.value === f.type;
    });
    TEXT_FIELDS.forEach(function (name) {
      document.getElementById(name).value = f[name] || '';
    });
    document.getElementById('tbc').checked = Boolean(f.tbc);
    document.getElementById('pastFields').open = Boolean(f.description_past_md);
    M.clear(detailsBox);
    (f.details || []).forEach(addDetail);
  }

  function collect() {
    var body = {};
    var type = form.querySelector('input[name="type"]:checked');
    body.type = type ? type.value : '';
    TEXT_FIELDS.forEach(function (name) {
      body[name] = document.getElementById(name).value;
    });
    body.tbc = document.getElementById('tbc').checked;
    body.details = Array.prototype.map.call(detailsBox.children, function (row) {
      var d = {};
      row.querySelectorAll('[data-key]').forEach(function (input) {
        d[input.getAttribute('data-key')] = input.value;
      });
      return d;
    });
    return body;
  }

  // ── Details ───────────────────────────────────────────────────────────────

  function addDetail(d) {
    d = d || {};
    function input(key, placeholder, extra) {
      return h(
        'input',
        Object.assign(
          {
            class: 'form-input is-compact',
            'data-key': key,
            value: d[key] || '',
            placeholder: placeholder,
            'aria-label': placeholder,
          },
          extra || {}
        )
      );
    }
    var row = h(
      'div',
      { class: 'detail-row' },
      input('label', 'Label, e.g. Speaker', { maxlength: 80 }),
      input('label_it', 'Label in Italian, e.g. Relatore', { maxlength: 80 }),
      input('value', 'Text', { maxlength: 300 }),
      input('value_it', 'Text in Italian', { maxlength: 300 }),
      input('link', 'Link (optional), https://…', { maxlength: 500, type: 'url' }),
      h(
        'button',
        {
          type: 'button',
          class: 'remove-btn',
          'aria-label': 'Remove this detail',
          onclick: function () {
            row.remove();
            changed();
          },
        },
        '×'
      )
    );
    detailsBox.appendChild(row);
    return row;
  }

  document.querySelectorAll('[data-preset]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = addDetail(PRESETS[btn.getAttribute('data-preset')] || {});
      var empty = Array.prototype.find.call(row.querySelectorAll('input'), function (i) {
        return !i.value;
      });
      (empty || row.querySelector('input')).focus();
      changed();
    });
  });

  // ── Markdown buttons ──────────────────────────────────────────────────────

  document.querySelectorAll('.md-input').forEach(function (ta) {
    function wrap(before, after, placeholder) {
      var s = ta.selectionStart;
      var e = ta.selectionEnd;
      var chosen = ta.value.slice(s, e) || placeholder;
      ta.setRangeText(before + chosen + after, s, e, 'end');
      ta.setSelectionRange(s + before.length, s + before.length + chosen.length);
      ta.focus();
      changed();
    }
    var bar = h(
      'div',
      { class: 'md-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
      h(
        'button',
        {
          type: 'button',
          title: 'Bold',
          onclick: function () {
            wrap('**', '**', 'bold text');
          },
        },
        h('strong', null, 'B')
      ),
      h(
        'button',
        {
          type: 'button',
          title: 'Italic',
          onclick: function () {
            wrap('*', '*', 'italic text');
          },
        },
        h('em', null, 'I')
      ),
      h(
        'button',
        {
          type: 'button',
          title: 'Link',
          onclick: function () {
            var url = window.prompt('Link address (https://…)', 'https://');
            if (url && url !== 'https://') wrap('[', '](' + url.trim() + ')', 'link text');
          },
        },
        'Link'
      ),
      h(
        'button',
        {
          type: 'button',
          title: 'List item',
          onclick: function () {
            wrap('\n- ', '', 'item');
          },
        },
        '• List'
      )
    );
    ta.parentNode.insertBefore(bar, ta);
  });

  // ── Preview ───────────────────────────────────────────────────────────────

  var timer = null;
  function changed() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(updatePreview, 450);
  }
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);

  window.addEventListener('beforeunload', function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.querySelectorAll('.lang-toggle button').forEach(function (b) {
    b.addEventListener('click', function () {
      previewLang = b.getAttribute('data-lang');
      document.querySelectorAll('.lang-toggle button').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o === b));
      });
      renderPreview();
    });
  });

  var previewSeq = 0;
  function updatePreview() {
    var seq = ++previewSeq;
    M.api('POST', '/api/app/content?action=preview', collect())
      .then(function (data) {
        if (seq !== previewSeq) return;
        lastEntry = data.entry;
        previewError.hidden = true;
        renderPreview();
      })
      .catch(function (err) {
        if (seq !== previewSeq) return;
        if (err.status === 401) return M.appError(err);
        previewError.textContent = err.message;
        previewError.hidden = false;
      });
  }

  function pick(entry, key) {
    return previewLang === 'it' && entry[key + '_it'] ? entry[key + '_it'] : entry[key];
  }

  function renderPreview() {
    M.clear(previewBox);
    var e = lastEntry;
    if (!e) return;
    var it = previewLang === 'it';
    var description = h('div', { class: 'program-description' });
    // Server-made HTML: markdown-lite escapes everything but its own tags.
    description.innerHTML = pick(e, 'description') || '';
    var card = h(
      'div',
      { class: 'card program-card' },
      h('span', { class: 'chip red' }, it ? 'In programma' : 'Upcoming'),
      h('h3', { class: e.tbc ? 'is-tbc' : null }, pick(e, 'title')),
      h('p', { class: 'content-preview-date' }, pick(e, 'date')),
      description,
      e.format_info
        ? h(
            'ul',
            { class: 'program-meta' },
            e.format_info.map(function (f) {
              var value = pick(f, 'value');
              return h(
                'li',
                null,
                h('strong', null, pick(f, 'label')),
                f.link
                  ? h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer' }, value)
                  : h('span', null, value)
              );
            })
          )
        : null,
      e.register_link
        ? h(
            'p',
            { style: 'margin:1.5rem 0 0' },
            h('span', { class: 'btn btn-outline' }, pick(e, 'register_text'))
          )
        : null
    );
    previewBox.appendChild(card);
    if (e.description_past) {
      var past = h('div', { class: 'program-description' });
      past.innerHTML = pick(e, 'description_past');
      previewBox.appendChild(
        h(
          'details',
          { class: 'past-preview' },
          h('summary', null, it ? 'Dopo l’evento' : 'After the event'),
          past
        )
      );
    }
  }

  // ── History ───────────────────────────────────────────────────────────────

  function showHistory(item) {
    var ul = document.getElementById('history');
    M.clear(ul);
    item.versions.forEach(function (v, index) {
      var li = M.activityItem(v, false);
      if (index > 0) {
        li.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                if (
                  !window.confirm(
                    'Put this item back as it was at ' +
                      M.fmtWhen(v.createdAt) +
                      '? It goes online on the site.'
                  )
                )
                  return;
                run(
                  M.api(
                    'POST',
                    '/api/app/content?action=restore&id=' +
                      encodeURIComponent(item.id) +
                      '&version=' +
                      encodeURIComponent(v.id),
                    {}
                  )
                );
              },
            },
            'Restore'
          )
        );
      }
      ul.appendChild(li);
    });
    document.getElementById('historyPanel').hidden = !item.versions.length;
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  function run(request) {
    formError.hidden = true;
    saveBtn.disabled = true;
    deleteBtn.disabled = true;
    return request
      .then(function (data) {
        dirty = false;
        M.toast(M.publishNote(data.publish));
        itemId = data.id;
        window.history.replaceState(
          null,
          '',
          '/app/content/edit/?id=' + encodeURIComponent(data.id)
        );
        return M.api('GET', '/api/app/content?id=' + encodeURIComponent(data.id)).then(function (
          item
        ) {
          return M.permissions.then(function (perms) {
            start(perms, item);
          });
        });
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        formError.textContent = err.message;
        formError.hidden = false;
        focusField(err.field);
      })
      .then(function () {
        saveBtn.disabled = false;
        deleteBtn.disabled = false;
      });
  }

  function focusField(field) {
    if (!field) return;
    var m = /^details\.(\d+)$/.exec(field);
    var el = m
      ? detailsBox.children[Number(m[1])] &&
        detailsBox.children[Number(m[1])].querySelector('input')
      : document.getElementById(field);
    if (field.indexOf('description_past') === 0) document.getElementById('pastFields').open = true;
    if (el) el.focus();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = collect();
    run(
      itemId
        ? M.api('PUT', '/api/app/content?id=' + encodeURIComponent(itemId), body)
        : M.api('POST', '/api/app/content', body)
    );
  });

  deleteBtn.addEventListener('click', function () {
    if (!window.confirm('Remove this from the site? It can be put back from its history.')) return;
    run(M.api('DELETE', '/api/app/content?id=' + encodeURIComponent(itemId)));
  });
})();
