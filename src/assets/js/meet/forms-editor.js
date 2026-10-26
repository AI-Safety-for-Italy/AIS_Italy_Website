/* /app/forms/edit/?id=…: the form editor.
 *   Questions  add from the left, drag to reorder in the middle, set the
 *              chosen question on the right; texts per language
 *   Preview    the form drawn by the public page's own code (forms-render.js)
 *   Settings   open/close, dates, link, one answer per email, keeping,
 *              which Discord roles read the answers
 *   Share      the public link
 * The server checks everything again (server/forms/schema.js, forms.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var id = new URLSearchParams(window.location.search).get('id');
  var state = document.getElementById('feState');
  var canvas = document.getElementById('feCanvas');
  var props = document.getElementById('feProps');
  var palette = document.getElementById('fePalette');
  var saveBtn = document.getElementById('feSave');
  var dirtyEl = document.getElementById('feDirty');

  var form = null; // as the server last sent it
  var schema = null; // being edited
  var meta = null;
  var lang = 'it';
  var selected = '__form';
  var dirty = false;
  var tab = 'questions';

  var ICONS = {
    short_text: 'Aa',
    long_text: '¶',
    email: '@',
    url: '🔗',
    number: '#',
    single: '◉',
    multi: '☑',
    dropdown: '▾',
    scale: '1–5',
    date: '📅',
    yes_no: 'Y/N',
    consent: '✓',
    info: 'i',
    section: '⎯',
  };
  var CHOICE = ['single', 'multi', 'dropdown'];
  var STATUS = { draft: 'Draft', open: 'Open', closed: 'Closed' };

  function uid(prefix, taken) {
    var out;
    do {
      out = prefix + Math.random().toString(36).slice(2, 7);
    } while (taken && taken(out));
    return out;
  }

  function itemTaken(candidate) {
    return schema.items.some(function (i) {
      return i.id === candidate;
    });
  }

  function find(itemId) {
    for (var i = 0; i < schema.items.length; i++) if (schema.items[i].id === itemId) return i;
    return -1;
  }

  function tx(value) {
    return (value && value[lang]) || '';
  }

  function txOrMain(value) {
    return (value && (value[lang] || value[schema.languages[0]])) || '';
  }

  function setText(obj, key, value) {
    if (!obj[key]) obj[key] = {};
    if (value) obj[key][lang] = value;
    else delete obj[key][lang];
  }

  function markDirty() {
    dirty = true;
    dirtyEl.hidden = false;
  }

  window.addEventListener('beforeunload', function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Loading ──────────────────────────────────────────────────────────────

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    M.clear(state);
    state.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        h('h3', null, err.status === 404 ? 'Form not found' : 'Something went wrong'),
        h('p', null, err.message)
      )
    );
  }

  state.appendChild(M.loading());
  M.me
    .then(function () {
      return Promise.all([
        M.api('GET', '/api/app/forms?id=' + encodeURIComponent(id)),
        M.api('GET', '/api/app/forms?meta=1').catch(function () {
          return null;
        }),
      ]);
    })
    .then(function (r) {
      meta = r[1];
      loaded(r[0]);
    })
    .catch(fail);

  function loaded(data) {
    form = data;
    schema = JSON.parse(JSON.stringify(data.schema));
    if (schema.languages.indexOf(lang) === -1) lang = schema.languages[0];
    dirty = false;
    dirtyEl.hidden = true;
    M.clear(state);
    if (!form.canManage) {
      state.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'You can read this form’s answers'),
          h(
            'p',
            null,
            'Only its owner and the forms admins can change it. The answers page comes next.'
          )
        )
      );
      document.getElementById('feCrumb').textContent = form.title;
      return;
    }
    document.getElementById('feTabs').hidden = false;
    document.getElementById('feTopbar').hidden = false;
    renderTop();
    renderPalette();
    setTab(location.hash.slice(1) || 'questions');
  }

  function renderTop() {
    document.getElementById('feCrumb').textContent = form.title;
    document.getElementById('feTitle').textContent = txOrMain(schema.title) || form.title;
    var status = document.getElementById('feStatus');
    M.clear(status);
    status.appendChild(
      h('span', { class: 'badge fe-badge fe-badge-' + form.status }, STATUS[form.status])
    );
    document.getElementById('feVersion').textContent =
      'Version ' +
      form.version +
      (form.responses
        ? ' · ' + form.responses + (form.responses === 1 ? ' answer' : ' answers')
        : '');
    var langs = document.getElementById('feLang');
    langs.hidden = schema.languages.length < 2;
    langs.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
      b.hidden = schema.languages.indexOf(b.getAttribute('lang')) === -1;
      b.onclick = function () {
        lang = b.getAttribute('lang');
        renderTop();
        renderCanvas();
        renderProps();
      };
    });
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  function setTab(name) {
    tab = ['questions', 'preview', 'settings', 'share'].indexOf(name) === -1 ? 'questions' : name;
    document.querySelectorAll('#feTabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    ['questions', 'preview', 'settings', 'share'].forEach(function (t) {
      document.getElementById('tab-' + t).hidden = t !== tab;
    });
    document.getElementById('feSave').hidden = tab !== 'questions' && tab !== 'preview';
    if (tab === 'questions') {
      renderCanvas();
      renderProps();
    } else if (tab === 'preview') renderPreview();
    else if (tab === 'settings') renderSettings();
    else renderShare();
  }
  window.addEventListener('hashchange', function () {
    if (form && form.canManage) setTab(location.hash.slice(1));
  });

  // ── Palette ──────────────────────────────────────────────────────────────

  function renderPalette() {
    M.clear(palette);
    var types = (meta && meta.types) || [];
    types.forEach(function (t) {
      palette.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'fe-add',
            onclick: function () {
              addItem(t.key);
            },
          },
          h('span', { class: 'fe-icon', 'aria-hidden': 'true' }, ICONS[t.key] || '?'),
          h('span', null, t.label)
        )
      );
    });
  }

  function newItem(type) {
    var item = { id: uid('q_', itemTaken), type: type, label: {} };
    var main = schema.languages[0];
    var DEFAULTS = {
      it: {
        short_text: 'Nuova domanda',
        long_text: 'Nuova domanda',
        email: 'Email',
        url: 'Link',
        number: 'Quanti?',
        single: 'Scegli una risposta',
        multi: 'Scegli una o più risposte',
        dropdown: 'Scegli dall’elenco',
        scale: 'Quanto?',
        date: 'Data',
        yes_no: 'Sì o no?',
        consent: 'Acconsento al trattamento dei miei dati personali.',
        info: 'Un testo',
        section: 'Nuova pagina',
        option: 'Opzione',
      },
      en: {
        short_text: 'New question',
        long_text: 'New question',
        email: 'Email',
        url: 'Link',
        number: 'How many?',
        single: 'Choose one',
        multi: 'Choose any',
        dropdown: 'Choose from the list',
        scale: 'How much?',
        date: 'Date',
        yes_no: 'Yes or no?',
        consent: 'I agree to the processing of my personal data.',
        info: 'Some text',
        section: 'New page',
        option: 'Option',
      },
    }[main];
    item.label[main] = DEFAULTS[type];
    if (CHOICE.indexOf(type) !== -1) {
      item.options = [1, 2].map(function (n) {
        var o = { id: uid('o_'), label: {} };
        o.label[main] = DEFAULTS.option + ' ' + n;
        return o;
      });
    }
    if (type === 'scale') {
      item.min = 1;
      item.max = 5;
    }
    if (type === 'consent') item.required = true;
    return item;
  }

  function addItem(type) {
    var item = newItem(type);
    var at = find(selected);
    schema.items.splice(at === -1 ? schema.items.length : at + 1, 0, item);
    selected = item.id;
    markDirty();
    renderCanvas();
    renderProps();
    var card = canvas.querySelector('[data-id="' + item.id + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Canvas ───────────────────────────────────────────────────────────────

  function move(from, to) {
    if (to < 0 || to >= schema.items.length || from === to) return;
    var item = schema.items.splice(from, 1)[0];
    schema.items.splice(to, 0, item);
    markDirty();
    renderCanvas();
  }

  function renderCanvas() {
    M.clear(canvas);
    var head = h(
      'button',
      {
        type: 'button',
        class: 'fe-card fe-form-card' + (selected === '__form' ? ' is-selected' : ''),
        onclick: function () {
          select('__form');
        },
      },
      h('strong', { class: 'fe-form-title' }, txOrMain(schema.title) || 'Untitled form'),
      txOrMain(schema.description)
        ? h('span', { class: 'fe-form-desc' }, txOrMain(schema.description))
        : h(
            'span',
            { class: 'panel-note' },
            'Click to set the title, description and closing message'
          )
    );
    canvas.appendChild(head);
    if (!schema.items.length) {
      canvas.appendChild(h('p', { class: 'fe-empty' }, 'Add a question from the left.'));
    }
    schema.items.forEach(function (item, index) {
      canvas.appendChild(itemCard(item, index));
    });
  }

  function itemCard(item, index) {
    var missing = !tx(item.label) && item.type !== 'section';
    var preview = null;
    if (CHOICE.indexOf(item.type) !== -1) {
      preview = h(
        'ul',
        { class: 'fe-options-preview' },
        item.options.slice(0, 6).map(function (o) {
          return h('li', null, txOrMain(o.label));
        }),
        item.options.length > 6 ? h('li', null, '+' + (item.options.length - 6) + ' more') : null,
        item.other ? h('li', { class: 'panel-note' }, 'Other…') : null
      );
    } else if (item.type === 'scale') {
      preview = h('span', { class: 'panel-note' }, item.min + ' to ' + item.max);
    }
    var type = (meta &&
      meta.types.filter(function (t) {
        return t.key === item.type;
      })[0]) || { label: item.type };
    var card = h(
      'div',
      {
        class: 'fe-card fe-q fe-q-' + item.type + (selected === item.id ? ' is-selected' : ''),
        'data-id': item.id,
        draggable: 'true',
        tabindex: '0',
        role: 'button',
        'aria-label': type.label + ': ' + (txOrMain(item.label) || 'untitled'),
        onclick: function () {
          select(item.id);
        },
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(item.id);
          }
        },
      },
      h(
        'div',
        { class: 'fe-q-top' },
        h('span', { class: 'fe-handle', 'aria-hidden': 'true', title: 'Drag to move' }, '⠿'),
        h(
          'span',
          { class: 'fe-type' },
          h('span', { class: 'fe-icon', 'aria-hidden': 'true' }, ICONS[item.type]),
          type.label
        ),
        item.required && item.type !== 'consent'
          ? h('span', { class: 'fe-required' }, 'Required')
          : null,
        h(
          'span',
          { class: 'fe-q-actions' },
          tool('↑', 'Move up', function () {
            move(index, index - 1);
          }),
          tool('↓', 'Move down', function () {
            move(index, index + 1);
          }),
          tool('⧉', 'Duplicate', function () {
            var copy = JSON.parse(JSON.stringify(item));
            copy.id = uid('q_', itemTaken);
            schema.items.splice(index + 1, 0, copy);
            selected = copy.id;
            markDirty();
            renderCanvas();
            renderProps();
          }),
          tool('✕', 'Delete', function () {
            if (!window.confirm('Delete this question?')) return;
            schema.items.splice(index, 1);
            if (selected === item.id) selected = '__form';
            markDirty();
            renderCanvas();
            renderProps();
          })
        )
      ),
      h(
        'div',
        { class: 'fe-q-label' + (missing ? ' is-missing' : '') },
        tx(item.label) ||
          (missing ? '(not written in ' + lang.toUpperCase() + ' yet) ' + txOrMain(item.label) : '')
      ),
      preview
    );
    card.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('application/x-fe', String(index));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragend', function () {
      card.classList.remove('is-dragging');
    });
    card.addEventListener('dragover', function (e) {
      e.preventDefault();
      card.classList.add('is-over');
    });
    card.addEventListener('dragleave', function () {
      card.classList.remove('is-over');
    });
    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('is-over');
      var from = Number(e.dataTransfer.getData('application/x-fe'));
      if (!isNaN(from)) move(from, index);
    });
    return card;
  }

  function tool(label, title, fn) {
    return h(
      'button',
      {
        type: 'button',
        class: 'fe-tool',
        title: title,
        'aria-label': title,
        onclick: function (e) {
          e.stopPropagation();
          fn();
        },
      },
      label
    );
  }

  function select(itemId) {
    selected = itemId;
    canvas.querySelectorAll('.fe-card').forEach(function (c) {
      var isIt =
        itemId === '__form'
          ? c.classList.contains('fe-form-card')
          : c.getAttribute('data-id') === itemId;
      c.classList.toggle('is-selected', isIt);
    });
    renderProps();
  }

  // ── Properties ───────────────────────────────────────────────────────────

  function field(label, control, note) {
    // A <label> only around a single input: around a group of buttons, a click
    // on the text would press the first one.
    var single = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
    return h(
      'div',
      { class: 'fe-field' },
      single
        ? h('label', { class: 'form-label' }, label, control)
        : h(
            'div',
            { role: 'group', 'aria-label': label },
            h('span', { class: 'form-label' }, label),
            control
          ),
      note ? h('p', { class: 'form-note' }, note) : null
    );
  }

  function textInput(value, onInput, attrs) {
    var input = h(
      'input',
      Object.assign({ class: 'form-input is-compact', value: value || '' }, attrs || {})
    );
    input.addEventListener('input', function () {
      onInput(input.value);
      markDirty();
    });
    return input;
  }

  function textArea(value, onInput, attrs) {
    var ta = h(
      'textarea',
      Object.assign({ class: 'form-input is-compact', rows: '3' }, attrs || {})
    );
    ta.value = value || '';
    ta.addEventListener('input', function () {
      onInput(ta.value);
      markDirty();
    });
    return ta;
  }

  function checkbox(label, checked, onChange) {
    var input = h('input', { type: 'checkbox' });
    input.checked = Boolean(checked);
    input.addEventListener('change', function () {
      onChange(input.checked);
      markDirty();
    });
    return h('label', { class: 'check-row' }, input, h('span', null, label));
  }

  function refreshCard() {
    // Keep the property panel (and its focus) while the canvas follows.
    var at = find(selected);
    if (selected === '__form') {
      var old = canvas.querySelector('.fe-form-card');
      renderCanvas();
      return old;
    }
    if (at === -1) return;
    var current = canvas.querySelector('[data-id="' + selected + '"]');
    if (current) current.replaceWith(itemCard(schema.items[at], at));
    document.getElementById('feTitle').textContent = txOrMain(schema.title) || form.title;
  }

  function renderProps() {
    M.clear(props);
    if (selected === '__form') return formProps();
    var at = find(selected);
    if (at === -1) {
      selected = '__form';
      return formProps();
    }
    var item = schema.items[at];
    var type = (meta &&
      meta.types.filter(function (t) {
        return t.key === item.type;
      })[0]) || { label: item.type };
    props.appendChild(h('h2', { class: 'label-mono' }, type.label));

    var labelName =
      { section: 'Page title', info: 'Heading', consent: 'What they agree to' }[item.type] ||
      'Question';
    props.appendChild(
      field(
        labelName + ' (' + lang.toUpperCase() + ')',
        textArea(
          tx(item.label),
          function (v) {
            setText(item, 'label', v);
            refreshCard();
          },
          { rows: '2', maxlength: '500' }
        )
      )
    );
    props.appendChild(
      field(
        (item.type === 'info' ? 'Text' : 'Help text') + ' (' + lang.toUpperCase() + ')',
        textArea(
          tx(item.help),
          function (v) {
            setText(item, 'help', v);
          },
          { rows: item.type === 'info' ? '6' : '2', maxlength: '3000' }
        ),
        '**bold**, *italic* and [links](https://…) work here.'
      )
    );

    var answerable = item.type !== 'info' && item.type !== 'section';
    if (answerable && item.type !== 'consent') {
      props.appendChild(
        checkbox('Required', item.required, function (v) {
          item.required = v;
          refreshCard();
        })
      );
    }
    if (item.type === 'consent')
      props.appendChild(
        h(
          'p',
          { class: 'form-note' },
          'Always required. Each answer records which version of this text it agreed to.'
        )
      );

    if (item.type === 'short_text' || item.type === 'long_text') {
      props.appendChild(
        h(
          'div',
          { class: 'fe-row' },
          field(
            'Min characters',
            textInput(
              item.minLength,
              function (v) {
                if (v) item.minLength = Number(v);
                else delete item.minLength;
              },
              { type: 'number', min: '0' }
            )
          ),
          field(
            'Max characters',
            textInput(
              item.maxLength,
              function (v) {
                if (v) item.maxLength = Number(v);
                else delete item.maxLength;
              },
              { type: 'number', min: '1', max: item.type === 'short_text' ? '300' : '8000' }
            )
          )
        )
      );
    }
    if (item.type === 'number') {
      props.appendChild(
        h(
          'div',
          { class: 'fe-row' },
          field(
            'Minimum',
            textInput(
              item.min,
              function (v) {
                if (v !== '') item.min = Number(v);
                else delete item.min;
              },
              { type: 'number', step: 'any' }
            )
          ),
          field(
            'Maximum',
            textInput(
              item.max,
              function (v) {
                if (v !== '') item.max = Number(v);
                else delete item.max;
              },
              { type: 'number', step: 'any' }
            )
          )
        )
      );
    }
    if (item.type === 'scale') {
      var minSel = h(
        'select',
        { class: 'form-input is-compact' },
        [0, 1].map(function (n) {
          var o = h('option', { value: String(n) }, String(n));
          if (item.min === n) o.selected = true;
          return o;
        })
      );
      minSel.addEventListener('change', function () {
        item.min = Number(minSel.value);
        markDirty();
        refreshCard();
      });
      var maxSel = h(
        'select',
        { class: 'form-input is-compact' },
        [2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) {
          var o = h('option', { value: String(n) }, String(n));
          if (item.max === n) o.selected = true;
          return o;
        })
      );
      maxSel.addEventListener('change', function () {
        item.max = Number(maxSel.value);
        markDirty();
        refreshCard();
      });
      props.appendChild(h('div', { class: 'fe-row' }, field('From', minSel), field('To', maxSel)));
      props.appendChild(
        h(
          'div',
          { class: 'fe-row' },
          field(
            'Label at the start',
            textInput(
              tx(item.minLabel),
              function (v) {
                setText(item, 'minLabel', v);
              },
              { maxlength: '200', placeholder: 'e.g. Not at all' }
            )
          ),
          field(
            'Label at the end',
            textInput(
              tx(item.maxLabel),
              function (v) {
                setText(item, 'maxLabel', v);
              },
              { maxlength: '200', placeholder: 'e.g. Very much' }
            )
          )
        )
      );
    }
    if (CHOICE.indexOf(item.type) !== -1) optionsEditor(item);

    props.appendChild(h('p', { class: 'fe-id' }, 'Question id: ', h('code', null, item.id)));
  }

  function optionsEditor(item) {
    var box = h('div', { class: 'fe-options' });
    function draw() {
      M.clear(box);
      item.options.forEach(function (o, i) {
        var input = textInput(
          tx(o.label),
          function (v) {
            setText(o, 'label', v);
            refreshCard();
          },
          {
            maxlength: '200',
            placeholder: txOrMain(o.label) || 'Option ' + (i + 1),
            'aria-label': 'Option ' + (i + 1),
          }
        );
        box.appendChild(
          h(
            'div',
            { class: 'fe-option' },
            h(
              'span',
              { class: 'fe-option-mark', 'aria-hidden': 'true' },
              item.type === 'multi' ? '☐' : '○'
            ),
            input,
            tool('↑', 'Move up', function () {
              if (i === 0) return;
              item.options.splice(i - 1, 0, item.options.splice(i, 1)[0]);
              markDirty();
              draw();
              refreshCard();
            }),
            tool('✕', 'Remove', function () {
              if (item.options.length === 1)
                return M.toast('A choice needs at least one option', true);
              item.options.splice(i, 1);
              markDirty();
              draw();
              refreshCard();
            })
          )
        );
      });
    }
    draw();
    props.appendChild(
      h(
        'div',
        { class: 'fe-field' },
        h('span', { class: 'form-label' }, 'Options (' + lang.toUpperCase() + ')'),
        box
      )
    );
    props.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          onclick: function () {
            var o = { id: uid('o_'), label: {} };
            o.label[lang] = (lang === 'it' ? 'Opzione ' : 'Option ') + (item.options.length + 1);
            item.options.push(o);
            markDirty();
            draw();
            refreshCard();
            var inputs = box.querySelectorAll('input');
            inputs[inputs.length - 1].focus();
            inputs[inputs.length - 1].select();
          },
        },
        '+ Add option'
      )
    );
    if (item.type !== 'dropdown') {
      props.appendChild(
        checkbox('Offer “Other” with a text box', item.other, function (v) {
          if (v) item.other = true;
          else delete item.other;
          refreshCard();
        })
      );
    }
    if (item.type === 'multi') {
      props.appendChild(
        field(
          'At most how many?',
          textInput(
            item.maxChoices,
            function (v) {
              if (v) item.maxChoices = Number(v);
              else delete item.maxChoices;
            },
            { type: 'number', min: '1', max: String(item.options.length), placeholder: 'No limit' }
          )
        )
      );
    }
  }

  function formProps() {
    props.appendChild(h('h2', { class: 'label-mono' }, 'The form'));
    props.appendChild(
      field(
        'Title (' + lang.toUpperCase() + ')',
        textInput(
          tx(schema.title),
          function (v) {
            setText(schema, 'title', v);
            refreshCard();
          },
          { maxlength: '200' }
        )
      )
    );
    props.appendChild(
      field(
        'Introduction (' + lang.toUpperCase() + ')',
        textArea(
          tx(schema.description),
          function (v) {
            setText(schema, 'description', v);
            refreshCard();
          },
          { rows: '5', maxlength: '6000' }
        ),
        '**bold**, *italic* and [links](https://…) work here.'
      )
    );
    props.appendChild(
      field(
        'Message after sending (' + lang.toUpperCase() + ')',
        textArea(
          tx(schema.confirmation),
          function (v) {
            setText(schema, 'confirmation', v);
          },
          { rows: '3', maxlength: '6000' }
        )
      )
    );
    // Languages
    var main = schema.languages[0];
    var langBox = h('div', { class: 'fe-langs' });
    [
      ['it', 'Italian'],
      ['en', 'English'],
    ].forEach(function (pair) {
      var input = h('input', { type: 'checkbox' });
      input.checked = schema.languages.indexOf(pair[0]) !== -1;
      input.disabled = pair[0] === main;
      input.addEventListener('change', function () {
        if (input.checked) schema.languages.push(pair[0]);
        else
          schema.languages = schema.languages.filter(function (l) {
            return l !== pair[0];
          });
        if (schema.languages.indexOf(lang) === -1) lang = schema.languages[0];
        markDirty();
        renderTop();
        renderProps();
      });
      langBox.appendChild(
        h(
          'label',
          { class: 'check-row' },
          input,
          h('span', null, pair[1] + (pair[0] === main ? ' (main)' : ''))
        )
      );
    });
    props.appendChild(
      h('div', { class: 'fe-field' }, h('span', { class: 'form-label' }, 'Languages'), langBox)
    );
    props.appendChild(
      h(
        'p',
        { class: 'form-note' },
        'Write everything in the main language; a missing translation shows the main text. Switch the language at the top right.'
      )
    );
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    var willBump = form.responses > 0;
    M.api('PUT', '/api/app/forms?id=' + encodeURIComponent(id) + '&part=schema', { schema: schema })
      .then(function (r) {
        M.toast(
          willBump && r.version !== form.version
            ? 'Saved as version ' + r.version + ': earlier answers keep their questions'
            : 'Saved'
        );
        return M.api('GET', '/api/app/forms?id=' + encodeURIComponent(id));
      })
      .then(function (data) {
        var keep = selected;
        loaded(data);
        selected = find(keep) === -1 ? '__form' : keep;
        if (tab === 'questions') {
          renderCanvas();
          renderProps();
        }
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
        if (err.field && find(err.field) !== -1) {
          setTab('questions');
          select(err.field);
        }
      })
      .then(function () {
        saveBtn.disabled = false;
      });
  });

  // ── Preview ──────────────────────────────────────────────────────────────

  var previewLang = null;
  function renderPreview() {
    var langs = document.getElementById('fePreviewLang');
    previewLang = schema.languages.indexOf(previewLang) !== -1 ? previewLang : lang;
    langs.hidden = schema.languages.length < 2;
    langs.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('lang') === previewLang));
      b.onclick = function () {
        previewLang = b.getAttribute('lang');
        renderPreview();
      };
    });
    var pick = function (v) {
      return (v && (v[previewLang] || v[schema.languages[0]])) || '';
    };
    document.getElementById('fePreviewTitle').textContent = pick(schema.title);
    document.getElementById('fePreviewDesc').innerHTML = M.md.toHtml(pick(schema.description));
    M.formRender(document.getElementById('fePreviewForm'), schema, {
      lang: previewLang,
      preview: true,
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function localInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      'T' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function renderSettings() {
    var box = document.getElementById('tab-settings');
    M.clear(box);
    var s = form.settings;
    var status = form.status;
    var seg = h('div', { class: 'seg fe-seg', role: 'radiogroup', 'aria-label': 'Status' });
    ['draft', 'open', 'closed'].forEach(function (key) {
      var b = h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(key === status),
          onclick: function () {
            status = key;
            seg.querySelectorAll('button').forEach(function (x) {
              x.setAttribute('aria-pressed', String(x === b));
            });
          },
        },
        STATUS[key]
      );
      seg.appendChild(b);
    });
    var opens = h('input', {
      class: 'form-input is-compact',
      type: 'datetime-local',
      value: localInput(form.opensAt),
    });
    var closes = h('input', {
      class: 'form-input is-compact',
      type: 'datetime-local',
      value: localInput(form.closesAt),
    });
    var slug = h('input', {
      class: 'form-input is-compact',
      value: form.slug,
      maxlength: '60',
      pattern: '[a-z0-9-]+',
    });
    slug.disabled = form.responses > 0;
    var once = h('input', { type: 'checkbox' });
    once.checked = s.oneResponsePerEmail;
    var notify = h('input', { type: 'checkbox' });
    notify.checked = s.notifyOwner;
    var keep = h('input', {
      class: 'form-input is-compact',
      type: 'number',
      min: '1',
      max: '120',
      value: String(s.retentionMonths),
    });

    var roles = (meta && meta.roles) || [];
    var roleBox = h('div', { class: 'fe-roles' });
    roles.forEach(function (r) {
      var input = h('input', { type: 'checkbox', value: r.id });
      input.checked = form.accessRoles.indexOf(r.id) !== -1;
      roleBox.appendChild(h('label', { class: 'check-row' }, input, h('span', null, r.name)));
    });
    // Roles already on the form that the server list did not return.
    form.accessRoles.forEach(function (rid) {
      if (
        roles.some(function (r) {
          return r.id === rid;
        })
      )
        return;
      var input = h('input', { type: 'checkbox', value: rid });
      input.checked = true;
      roleBox.appendChild(
        h(
          'label',
          { class: 'check-row' },
          input,
          h('span', null, rid + ' (not on Discord any more)')
        )
      );
    });

    var error = h('p', { class: 'form-error', hidden: true });
    var save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save settings');
    save.addEventListener('click', function () {
      error.hidden = true;
      save.disabled = true;
      var body = {
        status: status,
        opensAt: opens.value ? new Date(opens.value).toISOString() : null,
        closesAt: closes.value ? new Date(closes.value).toISOString() : null,
        settings: {
          oneResponsePerEmail: once.checked,
          notifyOwner: notify.checked,
          retentionMonths: Number(keep.value),
        },
        accessRoles: Array.prototype.map.call(
          roleBox.querySelectorAll('input:checked'),
          function (i) {
            return i.value;
          }
        ),
      };
      if (!slug.disabled && slug.value !== form.slug) body.slug = slug.value.trim();
      M.api('PUT', '/api/app/forms?id=' + encodeURIComponent(id) + '&part=settings', body)
        .then(function (data) {
          M.toast('Settings saved');
          var keepDirty = dirty;
          var keepSchema = schema;
          loaded(data);
          if (keepDirty) {
            schema = keepSchema;
            markDirty();
          }
          setTab('settings');
        })
        .catch(function (err) {
          if (err.status === 401) return M.appError(err);
          error.textContent = err.message;
          error.hidden = false;
        })
        .then(function () {
          save.disabled = false;
        });
    });

    var del = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-danger-outline btn-sm',
        onclick: function () {
          var warn = form.responses
            ? 'Delete this form AND its ' + form.responses + ' answers? This cannot be undone.'
            : 'Delete this form?';
          if (!window.confirm(warn)) return;
          M.api('DELETE', '/api/app/forms?id=' + encodeURIComponent(id))
            .then(function () {
              dirty = false;
              window.location.href = '/app/forms/';
            })
            .catch(function (err) {
              M.toast(err.message, true);
            });
        },
      },
      'Delete form'
    );

    box.appendChild(
      h(
        'div',
        { class: 'fe-settings' },
        h(
          'div',
          { class: 'panel form-grid' },
          h('h2', null, 'Taking answers'),
          field(
            'Status',
            seg,
            'Draft: nobody can open it. Open: anyone with the link can answer. Closed: the link says it is closed.'
          ),
          h(
            'div',
            { class: 'fe-row' },
            field('Opens on (optional)', opens),
            field('Closes on (optional)', closes)
          ),
          h('label', { class: 'check-row' }, once, h('span', null, 'One answer per email address')),
          h('label', { class: 'check-row' }, notify, h('span', null, 'Tell me about new answers'))
        ),
        h(
          'div',
          { class: 'panel form-grid' },
          h('h2', null, 'Link'),
          field(
            'Address',
            h(
              'div',
              { class: 'fe-slug' },
              h('span', { class: 'panel-note' }, location.origin + '/form/?f='),
              slug
            ),
            form.responses
              ? 'The link cannot change once the form has answers.'
              : 'Lower-case letters, digits and dashes.'
          )
        ),
        h(
          'div',
          { class: 'panel form-grid' },
          h('h2', null, 'Who reads the answers'),
          h(
            'p',
            { class: 'panel-note', style: 'margin:0' },
            'You and the forms admins always can. Add the Discord roles of the team that reviews them: they can read the answers, not change the form.'
          ),
          roles.length || form.accessRoles.length
            ? roleBox
            : h(
                'p',
                { class: 'form-note' },
                'The Discord bot is not set up here, so the roles cannot be listed.'
              ),
          field(
            'Keep the answers for (months)',
            keep,
            'After this, answers are deleted. Personal data should not be kept longer than needed.'
          )
        ),
        error,
        h('div', { class: 'action-bar' }, del, save)
      )
    );
  }

  // ── Share ────────────────────────────────────────────────────────────────

  function renderShare() {
    var box = document.getElementById('tab-share');
    M.clear(box);
    var link = location.origin + '/form/?f=' + encodeURIComponent(form.slug);
    var input = h('input', { class: 'form-input', readonly: true, value: link });
    var note =
      form.status === 'draft'
        ? 'The form is a draft: the link shows “not found” until you open it in Settings.'
        : form.status === 'closed'
        ? 'The form is closed: the link says so.'
        : form.open
        ? 'Anyone with this link can answer.'
        : 'The form is open but outside its dates: the link says it is closed.';
    box.appendChild(
      h(
        'div',
        { class: 'panel form-grid fe-share' },
        h('h2', null, 'Public link'),
        h(
          'div',
          { class: 'copy-field' },
          input,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                M.copy(link, function () {
                  M.toast('Link copied');
                });
              },
            },
            'Copy'
          ),
          h(
            'a',
            { class: 'btn btn-outline btn-sm', href: link, target: '_blank', rel: 'noopener' },
            'Open'
          )
        ),
        h('p', { class: 'form-note' }, note)
      )
    );
  }
})();
