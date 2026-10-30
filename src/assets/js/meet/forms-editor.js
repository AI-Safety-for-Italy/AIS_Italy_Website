/* /app/forms/edit/?id=…: the form editor.
 *   Questions  add from the left (or between two questions), drag to reorder
 *              in the middle, set the chosen question on the right; texts per
 *              language
 *   Preview    the form drawn by the public page's own code (forms-render.js),
 *              as on a computer or on a phone
 *   Settings   open/close, dates, link, one answer per email, keeping,
 *              which Discord roles read the answers
 *   Share      the public link
 *   Answers    the answers: a summary with charts, one by one, a table
 *              (forms-responses.js); the only tab for those who may read the
 *              answers but not change the form
 * The server checks everything again (server/forms/schema.js, forms.js). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var id = new URLSearchParams(window.location.search).get('id');
  var state = document.getElementById('feState');
  var canvas = document.getElementById('feCanvas');
  var pageJump = document.getElementById('fePages');
  var props = document.getElementById('feProps');
  var palette = document.getElementById('fePalette');
  var search = document.getElementById('feSearch');
  var saveBtn = document.getElementById('feSave');
  var dirtyEl = document.getElementById('feDirty');
  var savedEl = document.getElementById('feSaved');

  var form = null; // as the server last sent it
  var schema = null; // being edited
  var meta = null;
  var lang = 'it';
  var selected = '__form';
  var dirty = false;
  var tab = 'questions';

  // Icons: static strokes only, drawn inside a 24×24 box.
  var TYPE_ICONS = {
    short_text: '<path d="M4 7h16M4 12h10"/>',
    long_text: '<path d="M4 6h16M4 11h16M4 16h11"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    url: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    number: '<path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/>',
    date: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    single: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
    multi: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    dropdown: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M13.5 11l2 2 2-2"/>',
    scale: '<path d="M5 18v-6M10 18V8M15 18v-4M20 18V5"/>',
    yes_no: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>',
    section: '<path d="M4 6h16M4 18h16M8 12h8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    consent: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  };
  var TOOL_ICONS = {
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    remove: '<path d="M6 6l12 12M18 6L6 18"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  };
  var GRIP =
    '<svg viewBox="0 0 12 18" fill="currentColor"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="3" cy="15" r="1.5"/><circle cx="9" cy="15" r="1.5"/></svg>';

  var GROUPS = [
    {
      name: 'Text',
      tint: 'text',
      keys: ['short_text', 'long_text', 'email', 'url', 'number', 'date'],
    },
    { name: 'Choice', tint: 'choice', keys: ['single', 'multi', 'dropdown', 'scale', 'yes_no'] },
    { name: 'Structure', tint: 'structure', keys: ['section', 'info', 'consent'] },
  ];
  var CHOICE = ['single', 'multi', 'dropdown'];
  var STATUS = { draft: 'Draft', open: 'Open', closed: 'Closed' };
  var LANG_NAMES = { it: 'Italian', en: 'English' };

  function svg(paths, cls) {
    return h('span', {
      class: 'fe-svg' + (cls ? ' ' + cls : ''),
      'aria-hidden': 'true',
      html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        paths +
        '</svg>',
    });
  }

  function tintOf(type) {
    for (var i = 0; i < GROUPS.length; i++)
      if (GROUPS[i].keys.indexOf(type) !== -1) return GROUPS[i].tint;
    return 'text';
  }

  function typeIcon(type) {
    return h(
      'span',
      { class: 'fe-ticon fe-tint-' + tintOf(type) },
      svg(TYPE_ICONS[type] || TYPE_ICONS.short_text)
    );
  }

  function typeOf(key) {
    return (
      (meta &&
        meta.types.filter(function (t) {
          return t.key === key;
        })[0]) || { key: key, label: key }
    );
  }

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

  // Help texts on the canvas: plain words, without the markdown marks.
  function plain(text) {
    return String(text || '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
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
    savedEl.hidden = true;
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
    savedEl.hidden = false;
    M.clear(state);
    document.getElementById('feCrumb').textContent = form.title;
    document.getElementById('feCrumbs').hidden = true;
    document.getElementById('feTopbar').hidden = false;
    renderTop();
    if (!form.canManage) {
      // Reading the answers only: one tab, nothing to save.
      document.querySelectorAll('#feTabs a').forEach(function (a) {
        a.hidden = a.getAttribute('data-tab') !== 'responses';
      });
      saveBtn.hidden = true;
      savedEl.hidden = true;
      setTab('responses');
      return;
    }
    renderPalette();
    setTab(location.hash.slice(1) || 'questions');
  }

  function renderTop() {
    document.getElementById('feTitle').textContent = txOrMain(schema.title) || form.title;
    showCount(form.responses);
    var status = document.getElementById('feStatus');
    M.clear(status);
    status.appendChild(
      h(
        'span',
        { class: 'fe-status fe-status-' + form.status },
        h('i', { 'aria-hidden': 'true' }),
        STATUS[form.status]
      )
    );
    var langs = document.getElementById('feLang');
    langs.hidden = schema.languages.length < 2;
    langs.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
      b.hidden = schema.languages.indexOf(b.getAttribute('lang')) === -1;
      b.onclick = function () {
        switchLang(b.getAttribute('lang'));
      };
    });
  }

  function switchLang(code) {
    lang = code;
    renderTop();
    renderCanvas();
    renderProps();
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  var TABS = ['questions', 'preview', 'settings', 'share', 'responses'];
  var answers = null;

  function setTab(name) {
    tab = TABS.indexOf(name) === -1 ? 'questions' : name;
    if (!form.canManage) tab = 'responses';
    document.querySelectorAll('#feTabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    TABS.forEach(function (t) {
      document.getElementById('tab-' + t).hidden = t !== tab;
    });
    saveBtn.hidden = !form.canManage || (tab !== 'questions' && tab !== 'preview');
    savedEl.hidden = saveBtn.hidden || dirty;
    dirtyEl.hidden = saveBtn.hidden || !dirty;
    document.getElementById('feLang').hidden = tab !== 'questions' || schema.languages.length < 2;
    if (tab === 'questions') {
      renderCanvas();
      renderProps();
    } else if (tab === 'preview') renderPreview();
    else if (tab === 'settings') renderSettings();
    else if (tab === 'share') renderShare();
    else if (!answers) {
      answers = M.formResponses(document.getElementById('tab-responses'), {
        formId: id,
        onCount: showCount,
      });
    } else answers.reload();
  }
  window.addEventListener('hashchange', function () {
    if (form) setTab(location.hash.slice(1));
  });

  // The number of answers, on the tab and under the title; deleting one in the
  // Answers tab updates both.
  function showCount(n) {
    form.responses = n;
    document.getElementById('feCount').textContent = n ? String(n) : '';
    document.getElementById('feVersion').textContent =
      'Version ' + form.version + ' · ' + (n === 1 ? '1 answer' : (n || 0) + ' answers');
  }

  // ── Palette ──────────────────────────────────────────────────────────────

  function typeButtons(onPick, filter) {
    var groups = [];
    var known = {};
    ((meta && meta.types) || []).forEach(function (t) {
      known[t.key] = t;
    });
    GROUPS.forEach(function (g) {
      var buttons = g.keys
        .filter(function (k) {
          return known[k] && (!filter || known[k].label.toLowerCase().indexOf(filter) !== -1);
        })
        .map(function (k) {
          return h(
            'button',
            {
              type: 'button',
              class: 'fe-add',
              onclick: function () {
                onPick(k);
              },
            },
            typeIcon(k),
            h('span', null, known[k].label)
          );
        });
      if (buttons.length)
        groups.push(
          h('div', { class: 'fe-group' }, h('p', { class: 'fe-group-name' }, g.name), buttons)
        );
    });
    return groups;
  }

  function renderPalette() {
    M.clear(palette);
    var groups = typeButtons(function (k) {
      addItem(k);
    }, search.value.trim().toLowerCase());
    if (groups.length)
      groups.forEach(function (g) {
        palette.appendChild(g);
      });
    else palette.appendChild(h('p', { class: 'fe-none' }, 'No type matches.'));
  }
  search.addEventListener('input', renderPalette);

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

  // At a given place, or after the chosen question.
  function addItem(type, at) {
    var item = newItem(type);
    if (at === undefined) {
      var sel = find(selected);
      at = sel === -1 ? schema.items.length : sel + 1;
    }
    schema.items.splice(at, 0, item);
    selected = item.id;
    markDirty();
    renderCanvas();
    renderProps();
    var card = canvas.querySelector('[data-id="' + item.id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.focus({ preventScroll: true });
    }
  }

  // ── Canvas ───────────────────────────────────────────────────────────────

  function move(from, to) {
    if (to < 0 || to >= schema.items.length || from === to) return;
    var item = schema.items.splice(from, 1)[0];
    schema.items.splice(to, 0, item);
    markDirty();
    renderCanvas();
    var card = canvas.querySelector('[data-id="' + item.id + '"]');
    if (card) card.focus({ preventScroll: true });
  }

  // Pages as the public page makes them: a new one at each section.
  function pageInfo() {
    var pages = [];
    var first = schema.items[0];
    if (!first || first.type !== 'section') pages.push({ id: '__form', label: 'Start' });
    var bySection = {};
    schema.items.forEach(function (item) {
      if (item.type === 'section') {
        pages.push({ id: item.id, label: txOrMain(item.label) || 'Untitled page' });
        bySection[item.id] = pages.length;
      }
    });
    return { pages: pages, number: bySection };
  }

  function pageOfSelected(info) {
    var at = find(selected);
    var current = info.pages[0] ? info.pages[0].id : null;
    for (var i = 0; i <= at; i++)
      if (schema.items[i].type === 'section') current = schema.items[i].id;
    return current;
  }

  function renderPageJump(info) {
    M.clear(pageJump);
    pageJump.hidden = info.pages.length < 2;
    var current = pageOfSelected(info);
    info.pages.forEach(function (p, i) {
      pageJump.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'fe-jump',
            'aria-current': p.id === current ? 'true' : null,
            onclick: function () {
              var target =
                p.id === '__form'
                  ? canvas.querySelector('.fe-head')
                  : canvas.querySelector('[data-id="' + p.id + '"]');
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              select(p.id);
            },
          },
          h('span', { class: 'fe-jump-n' }, String(i + 1)),
          h('span', null, p.label)
        )
      );
    });
    pageJump.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'fe-jump fe-jump-add',
          title: 'Add a page at the end',
          'aria-label': 'Add a page at the end',
          onclick: function () {
            addItem('section', schema.items.length);
          },
        },
        svg(TOOL_ICONS.plus)
      )
    );
  }

  var pages = { pages: [], number: {} };

  function renderCanvas() {
    closeMenu();
    pages = pageInfo();
    M.clear(canvas);
    canvas.appendChild(formHead());
    if (!schema.items.length) {
      canvas.appendChild(
        h(
          'div',
          { class: 'fe-empty' },
          h('p', null, 'No questions yet. Pick one on the left, or add it here.'),
          inserter(0, true)
        )
      );
    } else {
      canvas.appendChild(inserter(0));
      schema.items.forEach(function (item, index) {
        canvas.appendChild(itemCard(item, index));
        canvas.appendChild(inserter(index + 1));
      });
    }
    renderPageJump(pages);
  }

  function blockAttrs(itemId, cls, label) {
    return {
      class: 'fe-block ' + cls + (selected === itemId ? ' is-selected' : ''),
      'data-id': itemId,
      tabindex: '0',
      role: 'button',
      'aria-label': label,
      'aria-pressed': String(selected === itemId),
      onclick: function () {
        select(itemId);
      },
      onkeydown: function (e) {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(itemId);
        }
      },
    };
  }

  function formHead() {
    var desc = txOrMain(schema.description);
    return h(
      'div',
      blockAttrs('__form', 'fe-head', 'Title and introduction'),
      h('p', { class: 'fe-kicker' }, 'The form'),
      h('h2', { class: 'fe-head-title' }, txOrMain(schema.title) || 'Untitled form'),
      desc
        ? h('p', { class: 'fe-head-desc' }, desc)
        : h(
            'p',
            { class: 'fe-hint' },
            'Click to write the title, the introduction and the closing message.'
          )
    );
  }

  function inserter(at, open) {
    var wrap = h('div', { class: 'fe-insert' + (open ? ' is-always' : '') });
    var btn = h(
      'button',
      {
        type: 'button',
        class: 'fe-insert-btn',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: function (e) {
          e.stopPropagation();
          if (menu && menu.parentNode === wrap) closeMenu();
          else openMenu(wrap, btn, at);
        },
      },
      svg(TOOL_ICONS.plus),
      h('span', null, 'Add here')
    );
    wrap.appendChild(h('span', { class: 'fe-insert-line', 'aria-hidden': 'true' }));
    wrap.appendChild(btn);
    wrap.appendChild(h('span', { class: 'fe-insert-line', 'aria-hidden': 'true' }));
    return wrap;
  }

  var menu = null;
  function openMenu(wrap, btn, at) {
    closeMenu();
    menu = h(
      'div',
      { class: 'fe-insert-menu', role: 'menu', 'aria-label': 'Question types' },
      typeButtons(function (k) {
        closeMenu();
        addItem(k, at);
      })
    );
    menu.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('role', 'menuitem');
    });
    wrap.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    wrap.appendChild(menu);
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  function closeMenu(refocus) {
    if (!menu) return;
    var wrap = menu.parentNode;
    menu.remove();
    menu = null;
    if (!wrap) return;
    wrap.classList.remove('is-open');
    var btn = wrap.querySelector('.fe-insert-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
  }

  document.addEventListener('click', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu) closeMenu(true);
  });

  function mock(item) {
    var main = txOrMain;
    if (['short_text', 'email', 'url', 'number', 'date'].indexOf(item.type) !== -1) {
      var hint = {
        short_text: 'Short answer',
        email: 'name@example.com',
        url: 'https://',
        number: 'A number',
        date: 'dd / mm / yyyy',
      }[item.type];
      return h('div', { class: 'fe-mock-line' }, hint);
    }
    if (item.type === 'long_text') return h('div', { class: 'fe-mock-box' }, 'Long answer');
    if (item.type === 'single' || item.type === 'multi') {
      var square = item.type === 'multi';
      return h(
        'div',
        { class: 'fe-mock-options' },
        item.options.slice(0, 6).map(function (o) {
          var text = tx(o.label);
          return h(
            'div',
            { class: 'fe-mock-option' + (text ? '' : ' is-missing') },
            h('span', { class: 'fe-mark' + (square ? ' is-square' : '') }),
            h('span', null, text || main(o.label) || '—')
          );
        }),
        item.options.length > 6
          ? h('div', { class: 'fe-mock-more' }, '+' + (item.options.length - 6) + ' more')
          : null,
        item.other
          ? h(
              'div',
              { class: 'fe-mock-option is-other' },
              h('span', { class: 'fe-mark' + (square ? ' is-square' : '') }),
              h('span', null, lang === 'it' ? 'Altro…' : 'Other…')
            )
          : null
      );
    }
    if (item.type === 'dropdown') {
      return h(
        'div',
        { class: 'fe-mock-line fe-mock-select' },
        h(
          'span',
          null,
          'Choose from ' +
            item.options.length +
            (item.options.length === 1 ? ' option' : ' options')
        ),
        svg('<path d="M6 9l6 6 6-6"/>')
      );
    }
    if (item.type === 'scale') {
      var steps = [];
      for (var n = item.min; n <= item.max; n++) steps.push(h('span', null, String(n)));
      return h(
        'div',
        null,
        h('div', { class: 'fe-mock-scale' }, steps),
        item.minLabel || item.maxLabel
          ? h(
              'div',
              { class: 'fe-mock-ends' },
              h('span', null, main(item.minLabel)),
              h('span', null, main(item.maxLabel))
            )
          : null
      );
    }
    if (item.type === 'yes_no') {
      return h(
        'div',
        { class: 'fe-mock-yesno' },
        h('span', null, lang === 'it' ? 'Sì' : 'Yes'),
        h('span', null, 'No')
      );
    }
    return null;
  }

  function itemCard(item, index) {
    var type = typeOf(item.type);
    var text = tx(item.label);
    var missing = !text && item.type !== 'section';
    var label = text || txOrMain(item.label);
    var isSel = selected === item.id;
    var attrs = blockAttrs(
      item.id,
      'fe-q fe-q-' + item.type,
      type.label + ': ' + (label || 'untitled')
    );
    attrs.draggable = 'true';
    var top = h(
      'div',
      { class: 'fe-q-top' },
      h('span', { class: 'fe-grip', 'aria-hidden': 'true', title: 'Drag to move', html: GRIP }),
      h(
        'span',
        { class: 'fe-pill fe-tint-' + tintOf(item.type) },
        svg(TYPE_ICONS[item.type] || ''),
        type.label
      ),
      item.required && item.type !== 'consent' ? h('span', { class: 'fe-req' }, 'Required') : null,
      missing ? h('span', { class: 'fe-missing' }, 'Not in ' + lang.toUpperCase() + ' yet') : null
    );
    var body;
    if (item.type === 'section') {
      body = [
        h('p', { class: 'fe-kicker' }, 'Page ' + (pages.number[item.id] || '')),
        h(
          'div',
          { class: 'fe-q-label fe-section-title' + (missing ? ' is-missing' : '') },
          label || 'Untitled page'
        ),
        item.help ? h('p', { class: 'fe-q-help' }, plain(txOrMain(item.help))) : null,
      ];
    } else if (item.type === 'consent') {
      body = [
        top,
        h(
          'div',
          { class: 'fe-mock-consent' + (missing ? ' is-missing' : '') },
          h('span', { class: 'fe-mark is-square' }),
          h('span', null, label)
        ),
        item.help ? h('p', { class: 'fe-q-help' }, plain(txOrMain(item.help))) : null,
      ];
    } else {
      body = [
        top,
        h(
          'div',
          { class: 'fe-q-label' + (missing ? ' is-missing' : '') },
          label || 'Untitled',
          item.required ? h('span', { class: 'fe-star', 'aria-hidden': 'true' }, ' *') : null
        ),
        item.help ? h('p', { class: 'fe-q-help' }, plain(txOrMain(item.help))) : null,
        mock(item),
      ];
    }
    var card = h('div', attrs, isSel ? toolbar(item, index) : null, body);
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

  function toolbar(item, index) {
    return h(
      'div',
      { class: 'fe-toolbar', role: 'toolbar', 'aria-label': 'Question actions' },
      tool('up', 'Move up', function () {
        move(index, index - 1);
      }),
      tool('down', 'Move down', function () {
        move(index, index + 1);
      }),
      tool('copy', 'Duplicate', function () {
        var copy = JSON.parse(JSON.stringify(item));
        copy.id = uid('q_', itemTaken);
        schema.items.splice(index + 1, 0, copy);
        selected = copy.id;
        markDirty();
        renderCanvas();
        renderProps();
      }),
      tool(
        'trash',
        'Delete',
        function () {
          if (!window.confirm('Delete this question?')) return;
          schema.items.splice(index, 1);
          if (selected === item.id) selected = '__form';
          markDirty();
          renderCanvas();
          renderProps();
        },
        'is-danger'
      )
    );
  }

  function tool(iconKey, title, fn, cls) {
    return h(
      'button',
      {
        type: 'button',
        class: 'fe-tool' + (cls ? ' ' + cls : ''),
        title: title,
        'aria-label': title,
        onclick: function (e) {
          e.stopPropagation();
          fn();
        },
      },
      svg(TOOL_ICONS[iconKey])
    );
  }

  // Draw again only the blocks that change, keeping the focus where it was.
  function redraw(itemId) {
    var old = canvas.querySelector('[data-id="' + itemId + '"]');
    if (!old) return;
    var hadFocus = old.contains(document.activeElement);
    var fresh;
    if (itemId === '__form') fresh = formHead();
    else {
      var at = find(itemId);
      if (at === -1) return;
      fresh = itemCard(schema.items[at], at);
    }
    old.replaceWith(fresh);
    if (hadFocus) fresh.focus({ preventScroll: true });
  }

  function select(itemId) {
    if (itemId === selected) return;
    var before = selected;
    selected = itemId;
    redraw(before);
    redraw(itemId);
    renderPageJump(pages);
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

  // An on/off setting, drawn as a switch.
  function toggle(label, checked, onChange) {
    var input = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
    input.checked = Boolean(checked);
    input.addEventListener('change', function () {
      onChange(input.checked);
      markDirty();
    });
    return h('label', { class: 'fe-switch' }, h('span', null, label), input);
  }

  function sec() {
    return h('div', { class: 'fe-props-sec' }, Array.prototype.slice.call(arguments));
  }

  function propsHead(kicker, title, type) {
    props.appendChild(
      h(
        'div',
        { class: 'fe-props-head' },
        type ? typeIcon(type) : null,
        h(
          'div',
          null,
          h('p', { class: 'fe-kicker' }, kicker),
          h('p', { class: 'fe-props-title' }, title)
        )
      )
    );
  }

  function refreshCard() {
    // Keep the property panel (and its focus) while the canvas follows.
    redraw(selected);
    if (selected === '__form' || (schema.items[find(selected)] || {}).type === 'section') {
      pages = pageInfo();
      renderPageJump(pages);
    }
    document.getElementById('feTitle').textContent = txOrMain(schema.title) || form.title;
  }

  // What the other language still lacks for this question.
  function untranslated(item, code) {
    var main = schema.languages[0];
    var out = [];
    function lacks(v) {
      return v && v[main] && !v[code];
    }
    if (lacks(item.label)) out.push(item.type === 'section' ? 'page title' : 'question');
    if (lacks(item.help)) out.push('help text');
    if (lacks(item.minLabel) || lacks(item.maxLabel)) out.push('scale labels');
    if (item.options) {
      var n = item.options.filter(function (o) {
        return lacks(o.label);
      }).length;
      if (n) out.push(n === 1 ? '1 option' : n + ' options');
    }
    return out;
  }

  function translationNote(item) {
    if (schema.languages.length < 2) return null;
    var main = schema.languages[0];
    var others = lang === main ? schema.languages.slice(1) : [lang];
    var notes = [];
    others.forEach(function (code) {
      var lacking = untranslated(item, code);
      if (!lacking.length) return;
      notes.push(
        h(
          'div',
          { class: 'fe-translate' },
          svg(TOOL_ICONS.warn),
          h(
            'div',
            null,
            h('p', null, 'Not in ' + LANG_NAMES[code] + ' yet: ' + lacking.join(', ') + '.'),
            code !== lang
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'fe-link',
                    onclick: function () {
                      switchLang(code);
                    },
                  },
                  'Write it in ' + code.toUpperCase()
                )
              : h(
                  'p',
                  { class: 'form-note' },
                  'Where it is missing, the ' + LANG_NAMES[main] + ' text is shown.'
                )
          )
        )
      );
    });
    return notes.length ? sec(notes) : null;
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
    var type = typeOf(item.type);
    var L = ' (' + lang.toUpperCase() + ')';
    propsHead(
      item.type === 'section'
        ? 'Selected page'
        : item.type === 'info'
        ? 'Selected text'
        : 'Selected question',
      type.label,
      item.type
    );

    var labelName =
      { section: 'Page title', info: 'Heading', consent: 'What they agree to' }[item.type] ||
      'Question';
    props.appendChild(
      sec(
        field(
          labelName + L,
          textArea(
            tx(item.label),
            function (v) {
              setText(item, 'label', v);
              refreshCard();
            },
            { rows: '2', maxlength: '500', placeholder: txOrMain(item.label) }
          )
        ),
        field(
          (item.type === 'info' ? 'Text' : 'Help text') + L,
          textArea(
            tx(item.help),
            function (v) {
              setText(item, 'help', v);
              refreshCard();
            },
            {
              rows: item.type === 'info' ? '6' : '2',
              maxlength: '3000',
              placeholder: txOrMain(item.help),
            }
          ),
          '**bold**, *italic* and [links](https://…) work here.'
        )
      )
    );

    var answerable = item.type !== 'info' && item.type !== 'section';
    var switches = [];
    if (answerable && item.type !== 'consent') {
      switches.push(
        toggle('Required', item.required, function (v) {
          item.required = v;
          refreshCard();
        })
      );
    }
    if (item.type === 'single' || item.type === 'multi') {
      switches.push(
        toggle('Offer “Other” with a text box', item.other, function (v) {
          if (v) item.other = true;
          else delete item.other;
          refreshCard();
        })
      );
    }
    if (switches.length) props.appendChild(sec(switches));
    if (item.type === 'consent')
      props.appendChild(
        sec(
          h(
            'p',
            { class: 'form-note' },
            'Always required. Each answer records which version of this text it agreed to.'
          )
        )
      );

    if (item.type === 'short_text' || item.type === 'long_text') {
      props.appendChild(
        sec(
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
        )
      );
    }
    if (item.type === 'number') {
      props.appendChild(
        sec(
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
      props.appendChild(
        sec(
          h('div', { class: 'fe-row' }, field('From', minSel), field('To', maxSel)),
          h(
            'div',
            { class: 'fe-row' },
            field(
              'Label at the start' + L,
              textInput(
                tx(item.minLabel),
                function (v) {
                  setText(item, 'minLabel', v);
                  refreshCard();
                },
                { maxlength: '200', placeholder: txOrMain(item.minLabel) || 'e.g. Not at all' }
              )
            ),
            field(
              'Label at the end' + L,
              textInput(
                tx(item.maxLabel),
                function (v) {
                  setText(item, 'maxLabel', v);
                  refreshCard();
                },
                { maxlength: '200', placeholder: txOrMain(item.maxLabel) || 'e.g. Very much' }
              )
            )
          )
        )
      );
    }
    if (CHOICE.indexOf(item.type) !== -1) optionsEditor(item);

    var note = translationNote(item);
    if (note) props.appendChild(note);

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
            h('span', {
              class: 'fe-mark' + (item.type === 'multi' ? ' is-square' : ''),
              'aria-hidden': 'true',
            }),
            input,
            tool('up', 'Move up', function () {
              if (i === 0) return;
              item.options.splice(i - 1, 0, item.options.splice(i, 1)[0]);
              markDirty();
              draw();
              refreshCard();
            }),
            tool('remove', 'Remove', function () {
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
    var extra = [];
    if (item.type === 'multi') {
      extra.push(
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
    props.appendChild(
      sec(
        h(
          'div',
          { class: 'fe-field' },
          h('span', { class: 'form-label' }, 'Options (' + lang.toUpperCase() + ')'),
          box
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'fe-link fe-add-option',
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
          svg(TOOL_ICONS.plus),
          'Add option'
        ),
        extra
      )
    );
  }

  function formProps() {
    var L = ' (' + lang.toUpperCase() + ')';
    propsHead('The form', 'Title and texts');
    props.appendChild(
      sec(
        field(
          'Title' + L,
          textInput(
            tx(schema.title),
            function (v) {
              setText(schema, 'title', v);
              refreshCard();
            },
            { maxlength: '200', placeholder: txOrMain(schema.title) }
          )
        ),
        field(
          'Introduction' + L,
          textArea(
            tx(schema.description),
            function (v) {
              setText(schema, 'description', v);
              refreshCard();
            },
            { rows: '5', maxlength: '6000', placeholder: txOrMain(schema.description) }
          ),
          '**bold**, *italic* and [links](https://…) work here.'
        ),
        field(
          'Message after sending' + L,
          textArea(
            tx(schema.confirmation),
            function (v) {
              setText(schema, 'confirmation', v);
            },
            { rows: '3', maxlength: '6000', placeholder: txOrMain(schema.confirmation) }
          )
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
        renderCanvas();
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
      sec(
        h('div', { class: 'fe-field' }, h('span', { class: 'form-label' }, 'Languages'), langBox),
        h(
          'p',
          { class: 'form-note' },
          'Write everything in the main language; a missing translation shows the main text. Switch the language at the top right.'
        )
      )
    );
    var lacking = [];
    if (schema.languages.length > 1) {
      schema.languages.slice(1).forEach(function (code) {
        var n = schema.items.filter(function (item) {
          return untranslated(item, code).length;
        }).length;
        if (n)
          lacking.push(
            n + (n === 1 ? ' block' : ' blocks') + ' not in ' + LANG_NAMES[code] + ' yet'
          );
      });
    }
    if (lacking.length)
      props.appendChild(
        sec(
          h(
            'div',
            { class: 'fe-translate' },
            svg(TOOL_ICONS.warn),
            h('p', null, lacking.join('; ') + '.')
          )
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
  var device = 'wide';
  document.querySelectorAll('#feDevice button').forEach(function (b) {
    b.addEventListener('click', function () {
      device = b.getAttribute('data-device');
      renderPreview();
    });
  });

  function renderPreview() {
    previewLang = schema.languages.indexOf(previewLang) !== -1 ? previewLang : lang;
    document.querySelectorAll('#feDevice button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-device') === device));
    });
    document.getElementById('feFrame').classList.toggle('is-phone', device === 'phone');
    M.formPage(document.getElementById('fePreviewForm'), schema, {
      lang: previewLang,
      preview: true,
      onLang: function (code) {
        previewLang = code;
      },
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
    var once = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
    once.checked = s.oneResponsePerEmail;
    var notify = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
    notify.checked = s.notifyOwner;

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

    var join = joinPanel();
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
          // Only the forms admins may change the link to the board.
          membership: join.editable() ? join.value() : undefined,
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
          h('label', { class: 'fe-switch' }, h('span', null, 'One answer per email address'), once),
          h('label', { class: 'fe-switch' }, h('span', null, 'Tell me about new answers'), notify)
        ),
        join.panel,
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
              )
        ),
        error,
        h('div', { class: 'action-bar' }, del, save)
      )
    );
  }

  // The registration form: each answer also goes to the member applications
  // board. Only the forms admins can change it; the others see what it does.
  function joinPanel() {
    var panel = h('div', { class: 'panel form-grid' });
    var link = form.settings.membership
      ? JSON.parse(JSON.stringify(form.settings.membership))
      : null;
    var admin = false;
    var saved = form.schema;
    var ofType = function (types) {
      return saved.items.filter(function (i) {
        return types.indexOf(i.type) !== -1;
      });
    };
    var name = function (item) {
      return (
        (item.label && (item.label[saved.languages[0]] || item.label.it || item.label.en)) ||
        item.id
      );
    };
    function pick(label, types, key, optional) {
      var select = h('select', { class: 'form-input is-compact', disabled: !admin ? true : null });
      if (optional) select.appendChild(h('option', { value: '' }, 'None'));
      ofType(types).forEach(function (item) {
        select.appendChild(h('option', { value: item.id }, name(item)));
      });
      select.value = (link && link[key]) || '';
      select.addEventListener('change', function () {
        link[key] = select.value || null;
        if (key === 'roleItem') link.roles = {};
        draw();
      });
      return field(label, select);
    }
    function draw() {
      M.clear(panel);
      panel.appendChild(h('h2', null, 'Community sign-up'));
      var on = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
      on.checked = Boolean(link);
      on.disabled = !admin;
      on.addEventListener('change', function () {
        if (!on.checked) link = null;
        else {
          var first = function (types) {
            var f = ofType(types)[0];
            return f ? f.id : null;
          };
          link = {
            nameItem: first(['short_text']),
            surnameItem: null,
            emailItem: first(['email']),
            roleItem: null,
            roles: {},
          };
        }
        draw();
      });
      panel.appendChild(
        h(
          'p',
          { class: 'panel-note', style: 'margin:0' },
          'Make this the form people use to join the community: each answer also reaches the Member applications board, where it is approved and the person is let into Discord.'
        )
      );
      panel.appendChild(
        h(
          'label',
          { class: 'fe-switch' },
          h('span', null, 'Send answers to the member applications'),
          on
        )
      );
      if (!admin)
        panel.appendChild(h('p', { class: 'form-note' }, 'Only the forms admins can change this.'));
      if (!link) return;
      panel.appendChild(
        h(
          'div',
          { class: 'fe-row' },
          pick('First name is', ['short_text'], 'nameItem', false),
          pick('Surname is', ['short_text'], 'surnameItem', true)
        )
      );
      panel.appendChild(pick('Email is', ['email'], 'emailItem', false));
      panel.appendChild(pick('Role asked for is', ['single', 'dropdown'], 'roleItem', true));
      var roleItem =
        link.roleItem &&
        saved.items.filter(function (i) {
          return i.id === link.roleItem;
        })[0];
      if (roleItem) {
        roleItem.options.forEach(function (o) {
          var sel = h(
            'select',
            { class: 'form-input is-compact', disabled: !admin ? true : null },
            h('option', { value: '' }, 'No role asked for'),
            h('option', { value: 'participant' }, 'Participant'),
            h('option', { value: 'organizer' }, 'Organizer')
          );
          sel.value = link.roles[o.id] || '';
          sel.addEventListener('change', function () {
            if (sel.value) link.roles[o.id] = sel.value;
            else delete link.roles[o.id];
          });
          panel.appendChild(field('“' + name(o) + '” asks to be', sel));
        });
        panel.appendChild(
          h(
            'p',
            { class: 'form-note' },
            'This only preselects the role: whoever approves can change it.'
          )
        );
      }
      if (form.responses)
        panel.appendChild(
          h(
            'p',
            { class: 'form-note' },
            'Only answers sent from now on go to the board. Questions are the ones already saved: save the questions first if you changed them.'
          )
        );
    }
    draw();
    M.permissions.then(function (perms) {
      admin = perms.indexOf('forms_admin') !== -1;
      draw();
    });
    return {
      panel: panel,
      editable: function () {
        return admin;
      },
      value: function () {
        return link;
      },
    };
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
