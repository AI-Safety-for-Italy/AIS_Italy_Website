/* Draws a form (a schema from server/forms/schema.js) and collects its answers.
 * The same code draws the public page (/form/) and the editor's preview, so
 * what the editor shows is what people get.
 *
 *   Meet.formPage(root, schema, {      the whole page: the green panel with
 *     lang,                             the title and the parts, the form
 *     preview,                          beside it
 *     closesAt,                         ISO date shown under the title
 *     onLang(code),                     after the reader switches language
 *     …and everything formRender takes
 *   })
 *
 *   Meet.formRender(root, schema, {    the questions alone
 *     lang,                 'it' | 'en'
 *     preview,              true: no honeypot, sending only shows the end screen
 *     draftKey,             keep answers in this browser while filling in
 *     onSubmit(answers),    -> Promise of { confirmation }; a rejection with
 *                              err.errors ({ id: message }) marks the questions
 *     onPage(index), onDone()
 *   })
 *
 *   Meet.formNotice(root, title, text)  the page's frame around a message
 *
 * Checks here are only to help people: the server checks everything again.
 * Labels go on the page as text; descriptions and help are markdown-lite,
 * which escapes everything but its own few tags. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var STRINGS = {
    en: {
      required: 'This question is required',
      email: 'Enter a valid email',
      url: 'Enter a link starting with https://',
      number: 'Enter a number',
      atLeast: function (n) {
        return 'At least ' + n;
      },
      atMost: function (n) {
        return 'At most ' + n;
      },
      chars: function (n, max) {
        return n + ' / ' + max;
      },
      tooLong: function (n) {
        return 'At most ' + n + ' characters';
      },
      tooShort: function (n) {
        return 'At least ' + n + ' characters';
      },
      chooseAtMost: function (n) {
        return 'Choose at most ' + n;
      },
      consent: 'Please accept to continue',
      other: 'Other',
      otherPlaceholder: 'Write here…',
      yes: 'Yes',
      no: 'No',
      choose: 'Choose…',
      back: 'Back',
      next: 'Next',
      nextTo: function (part) {
        return 'Next: ' + part;
      },
      send: 'Send',
      sending: 'Sending…',
      step: function (i, n) {
        return 'Part ' + i + ' of ' + n;
      },
      fix: 'Some answers need a look.',
      thanks: 'Thank you!',
      sentTitle: 'Sent',
      sent: 'Your answers have been sent.',
      previewSent: 'Preview: nothing was sent.',
      previewNote: 'Preview: nothing is sent',
      again: 'Fill in again',
      requiredMark: 'Required',
      draftKept: 'Draft kept in this browser',
      firstPart: 'To begin',
      parts: 'Parts of the form',
      current: 'now',
      questions: function (n) {
        return n === 1 ? '1 question' : n + ' questions';
      },
      privacy: 'Answers are stored encrypted and read only by the people running this form.',
      closesOn: 'Open until ',
      language: 'Language',
      goBack: function (part) {
        return 'Back to ' + part;
      },
    },
    it: {
      required: 'Questa domanda è obbligatoria',
      email: 'Inserisci un’email valida',
      url: 'Inserisci un link che inizi con https://',
      number: 'Inserisci un numero',
      atLeast: function (n) {
        return 'Almeno ' + n;
      },
      atMost: function (n) {
        return 'Al massimo ' + n;
      },
      chars: function (n, max) {
        return n + ' / ' + max;
      },
      tooLong: function (n) {
        return 'Al massimo ' + n + ' caratteri';
      },
      tooShort: function (n) {
        return 'Almeno ' + n + ' caratteri';
      },
      chooseAtMost: function (n) {
        return 'Scegline al massimo ' + n;
      },
      consent: 'Per continuare devi accettare',
      other: 'Altro',
      otherPlaceholder: 'Scrivi qui…',
      yes: 'Sì',
      no: 'No',
      choose: 'Scegli…',
      back: 'Indietro',
      next: 'Avanti',
      nextTo: function (part) {
        return 'Continua: ' + part;
      },
      send: 'Invia',
      sending: 'Invio…',
      step: function (i, n) {
        return 'Parte ' + i + ' di ' + n;
      },
      fix: 'Alcune risposte vanno controllate.',
      thanks: 'Grazie!',
      sentTitle: 'Inviato',
      sent: 'Le tue risposte sono state inviate.',
      previewSent: 'Anteprima: non è stato inviato nulla.',
      previewNote: 'Anteprima: non si invia nulla',
      again: 'Compila di nuovo',
      requiredMark: 'Obbligatoria',
      draftKept: 'Bozza salvata in questo browser',
      firstPart: 'Per iniziare',
      parts: 'Parti del modulo',
      current: 'in corso',
      questions: function (n) {
        return n === 1 ? '1 domanda' : n + ' domande';
      },
      privacy: 'Le risposte sono conservate cifrate e lette solo da chi gestisce questo modulo.',
      closesOn: 'Aperto fino al ',
      language: 'Lingua',
      goBack: function (part) {
        return 'Torna a ' + part;
      },
    },
  };

  // Static markup only: icons drawn with strokes, no text from anywhere else.
  var SVG = {
    arrowRight:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    arrowLeft:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };

  function icon(name, cls) {
    return h('span', {
      class: 'fm-icon' + (cls ? ' ' + cls : ''),
      'aria-hidden': 'true',
      html: SVG[name],
    });
  }

  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  function roman(n) {
    return ROMAN[n - 1] || String(n);
  }

  var HTTPS = /^https:\/\/[^\s<>"]{3,}$/i;

  function md(text, cls) {
    var el = h('div', { class: 'fm-md' + (cls ? ' ' + cls : '') });
    // markdown-lite escapes everything except its own tags.
    el.innerHTML = M.md.toHtml(text || '');
    return el;
  }

  function store(key, value) {
    if (!key) return;
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* no storage: the draft is simply not kept */
    }
  }

  function restore(key) {
    if (!key) return {};
    try {
      return JSON.parse(window.localStorage.getItem(key) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function pickLang(schema, wanted) {
    return schema.languages.indexOf(wanted) !== -1 ? wanted : schema.languages[0];
  }

  function texter(schema, lang) {
    return function (value) {
      return (value && (value[lang] || value[schema.languages[0]])) || '';
    };
  }

  // Pages: a new one at each section; the first holds what comes before.
  function pagesOf(schema) {
    var pages = [{ section: null, items: [] }];
    schema.items.forEach(function (item) {
      if (item.type === 'section') pages.push({ section: item, items: [] });
      else pages[pages.length - 1].items.push(item);
    });
    if (!pages[0].items.length && pages.length > 1) pages.shift();
    return pages;
  }

  function isQuestion(item) {
    return item.type !== 'info' && item.type !== 'section';
  }

  // "Show only if", the same rules as visibleIds() in server/forms/schema.js
  // (which is what counts): a section's condition covers the items up to the
  // next section; a condition on a hidden question does not hold. -> {id: true}
  function visibleItems(schema, values) {
    var visible = {};
    var byId = {};
    schema.items.forEach(function (i) {
      byId[i.id] = i;
    });
    function holds(c) {
      if (!c) return true;
      var target = byId[c.item];
      var v = values[c.item];
      if (!visible[c.item] || !target || v === undefined || v === null) return false;
      if (target.type === 'yes_no') return c.values.indexOf(v) !== -1;
      return (v.selected || []).some(function (id) {
        return c.values.indexOf(id) !== -1;
      });
    }
    var sectionOk = true;
    schema.items.forEach(function (item) {
      if (item.type === 'section') {
        sectionOk = holds(item.showIf);
        if (sectionOk) visible[item.id] = true;
      } else if (sectionOk && holds(item.showIf)) visible[item.id] = true;
    });
    return visible;
  }

  M.formRender = function (root, schema, opts) {
    opts = opts || {};
    var lang = pickLang(schema, opts.lang);
    var S = STRINGS[lang] || STRINGS.it;
    var t = texter(schema, lang);
    // Kept on opts so that drawing again (another language) keeps the answers.
    var values = opts.values || (opts.preview ? {} : restore(opts.draftKey));
    opts.values = values;
    var fields = {};
    var page = 0;
    var pages = pagesOf(schema);

    // Questions are numbered through the whole form; the consent box is not.
    var numbers = {};
    var count = 0;
    schema.items.forEach(function (item) {
      if (isQuestion(item) && item.type !== 'consent') {
        count++;
        numbers[item.id] = count < 10 ? '0' + count : String(count);
      }
    });

    var saveTimer = null;
    var shown = visibleItems(schema, values);
    var cards = {};
    function changed() {
      applyVisibility();
      if (opts.preview || !opts.draftKey) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        store(opts.draftKey, values);
      }, 300);
    }

    // ── Fields ────────────────────────────────────────────────────────────

    function errorBox() {
      return h('p', { class: 'fm-error', role: 'alert', hidden: true });
    }

    function textField(item, kind) {
      var tag = kind === 'long_text' ? 'textarea' : 'input';
      var attrs = { class: 'fm-input', id: 'fm-' + item.id, name: item.id };
      if (tag === 'input') {
        attrs.type = { email: 'email', url: 'url', number: 'number', date: 'date' }[kind] || 'text';
        if (kind === 'email') {
          attrs.autocomplete = 'email';
          attrs.placeholder = lang === 'it' ? 'nome@esempio.it' : 'name@example.com';
        }
        if (kind === 'url') attrs.placeholder = 'https://';
        if (kind === 'number') {
          attrs.inputmode = 'decimal';
          attrs.step = 'any';
          if (item.min !== undefined) attrs.min = String(item.min);
          if (item.max !== undefined) attrs.max = String(item.max);
        }
      } else {
        attrs.rows = '5';
      }
      if (item.maxLength) attrs.maxlength = String(item.maxLength);
      var input = h(tag, attrs);
      if (values[item.id] !== undefined) input.value = values[item.id];
      var counter =
        kind === 'long_text' && item.maxLength ? h('span', { class: 'fm-counter' }) : null;
      function count() {
        if (counter) counter.textContent = S.chars(input.value.length, item.maxLength);
      }
      count();
      input.addEventListener('input', function () {
        values[item.id] = input.value;
        count();
        changed();
      });
      return { control: h('div', { class: 'fm-text' }, input, counter), focus: input };
    }

    // Many short options read best as chips; long ones as a list.
    function asChips(item) {
      return (
        item.type === 'multi' &&
        !item.other &&
        item.options.length >= 3 &&
        item.options.every(function (o) {
          return t(o.label).length <= 32;
        })
      );
    }

    function choiceField(item) {
      var multi = item.type === 'multi';
      var chips = asChips(item);
      var current = values[item.id] || { selected: [] };
      var group = h('div', {
        class: chips ? 'fm-chips' : 'fm-choices',
        role: multi ? 'group' : 'radiogroup',
      });
      var otherInput = null;
      var otherBox = null;
      function sync() {
        var selected = [];
        group.querySelectorAll('input[data-option]').forEach(function (i) {
          if (i.checked) selected.push(i.getAttribute('data-option'));
        });
        var value = { selected: selected };
        if (otherBox && otherBox.checked) value.other = otherInput.value;
        values[item.id] = value;
        if (otherInput) otherInput.disabled = !otherBox.checked;
        changed();
      }
      item.options.forEach(function (o) {
        var input = h('input', {
          type: multi ? 'checkbox' : 'radio',
          name: 'fm-' + item.id,
          'data-option': o.id,
          onchange: sync,
        });
        input.checked = current.selected.indexOf(o.id) !== -1;
        group.appendChild(
          chips
            ? h(
                'label',
                { class: 'fm-chip' },
                input,
                icon('check', 'fm-chip-tick'),
                h('span', null, t(o.label))
              )
            : h(
                'label',
                { class: 'fm-choice' },
                input,
                h('span', { class: 'fm-choice-text' }, t(o.label))
              )
        );
      });
      if (item.other) {
        otherBox = h('input', {
          type: multi ? 'checkbox' : 'radio',
          name: 'fm-' + item.id,
          onchange: sync,
        });
        otherInput = h('input', {
          class: 'fm-input fm-other-input',
          maxlength: '300',
          placeholder: S.otherPlaceholder,
          'aria-label': S.other,
          oninput: sync,
        });
        otherBox.checked = Boolean(current.other);
        otherInput.value = current.other || '';
        otherInput.disabled = !otherBox.checked;
        group.appendChild(
          h(
            'label',
            { class: 'fm-choice fm-choice-other' },
            otherBox,
            h('span', { class: 'fm-choice-text' }, S.other),
            otherInput
          )
        );
      }
      return { control: group, focus: group.querySelector('input') };
    }

    function dropdownField(item) {
      var select = h(
        'select',
        { class: 'fm-input fm-select', id: 'fm-' + item.id },
        h('option', { value: '' }, S.choose)
      );
      item.options.forEach(function (o) {
        select.appendChild(h('option', { value: o.id }, t(o.label)));
      });
      var current = values[item.id];
      if (current && current.selected && current.selected[0]) select.value = current.selected[0];
      select.addEventListener('change', function () {
        values[item.id] = { selected: select.value ? [select.value] : [] };
        changed();
      });
      return { control: select, focus: select };
    }

    function scaleField(item) {
      var row = h('div', { class: 'fm-scale', role: 'radiogroup' });
      for (var n = item.min; n <= item.max; n++) {
        (function (value) {
          var input = h('input', { type: 'radio', name: 'fm-' + item.id, value: String(value) });
          input.checked = values[item.id] === value;
          input.addEventListener('change', function () {
            values[item.id] = value;
            changed();
          });
          row.appendChild(
            h('label', { class: 'fm-scale-step' }, input, h('span', null, String(value)))
          );
        })(n);
      }
      var ends =
        item.minLabel || item.maxLabel
          ? h(
              'div',
              { class: 'fm-scale-ends' },
              h('span', null, t(item.minLabel)),
              h('span', null, t(item.maxLabel))
            )
          : null;
      return { control: h('div', null, row, ends), focus: row.querySelector('input') };
    }

    function yesNoField(item) {
      var row = h('div', { class: 'fm-yesno', role: 'radiogroup' });
      [
        ['yes', S.yes],
        ['no', S.no],
      ].forEach(function (pair) {
        var input = h('input', { type: 'radio', name: 'fm-' + item.id, value: pair[0] });
        input.checked = values[item.id] === pair[0];
        input.addEventListener('change', function () {
          values[item.id] = pair[0];
          changed();
        });
        row.appendChild(h('label', { class: 'fm-pill' }, input, h('span', null, pair[1])));
      });
      return { control: row, focus: row.querySelector('input') };
    }

    function consentField(item) {
      var input = h('input', { type: 'checkbox', id: 'fm-' + item.id });
      input.checked = values[item.id] === true;
      input.addEventListener('change', function () {
        values[item.id] = input.checked;
        changed();
      });
      return {
        control: h('label', { class: 'fm-consent' }, input, h('span', null, t(item.label))),
        focus: input,
        labelInside: true,
      };
    }

    function build(item) {
      var el = buildItem(item);
      if (el) cards[item.id] = el;
      return el;
    }

    function buildItem(item) {
      if (item.type === 'info') {
        return h(
          'div',
          { class: 'fm-info' },
          item.label ? h('h3', null, t(item.label)) : null,
          item.help ? md(t(item.help)) : null
        );
      }
      var made;
      if (['short_text', 'long_text', 'email', 'url', 'number', 'date'].indexOf(item.type) !== -1)
        made = textField(item, item.type);
      else if (item.type === 'single' || item.type === 'multi') made = choiceField(item);
      else if (item.type === 'dropdown') made = dropdownField(item);
      else if (item.type === 'scale') made = scaleField(item);
      else if (item.type === 'yes_no') made = yesNoField(item);
      else if (item.type === 'consent') made = consentField(item);
      else return null;
      var error = errorBox();
      var labelId = 'fm-label-' + item.id;
      var isGroup =
        made.control.getAttribute &&
        (made.control.getAttribute('role') || '').indexOf('group') !== -1;
      var head = made.labelInside
        ? null
        : h(
            // A group of buttons is named by aria-labelledby, not by a <label>.
            isGroup ? 'div' : 'label',
            { class: 'fm-label', id: labelId, for: isGroup ? null : 'fm-' + item.id },
            h('span', { class: 'fm-num', 'aria-hidden': 'true' }, numbers[item.id] || ''),
            h(
              'span',
              { class: 'fm-label-text' },
              t(item.label),
              item.required
                ? h(
                    'span',
                    { class: 'fm-required', title: S.requiredMark, 'aria-label': S.requiredMark },
                    ' *'
                  )
                : null
            )
          );
      var card = h(
        'div',
        { class: 'fm-question' + (made.labelInside ? ' is-consent' : ''), 'data-id': item.id },
        head,
        h(
          'div',
          { class: 'fm-q-body' },
          item.help && !made.labelInside ? md(t(item.help), 'fm-help') : null,
          made.control,
          item.help && made.labelInside ? md(t(item.help), 'fm-help') : null,
          error
        )
      );
      if (isGroup) made.control.setAttribute('aria-labelledby', labelId);
      fields[item.id] = { item: item, card: card, error: error, focus: made.focus };
      return card;
    }

    // ── Checks (to help; the server checks again) ─────────────────────────

    function check(item) {
      var v = values[item.id];
      var empty =
        v === undefined ||
        v === null ||
        v === '' ||
        v === false ||
        (typeof v === 'object' && v.selected && !v.selected.length && !(v.other && v.other.trim()));
      if (empty) return item.required ? (item.type === 'consent' ? S.consent : S.required) : null;
      var text = typeof v === 'string' ? v.trim() : '';
      if (item.type === 'email' && !M.isEmail(text)) return S.email;
      if (item.type === 'url' && !HTTPS.test(text)) return S.url;
      if (item.type === 'number') {
        var n = Number(String(v).replace(',', '.'));
        if (!isFinite(n)) return S.number;
        if (item.min !== undefined && n < item.min) return S.atLeast(item.min);
        if (item.max !== undefined && n > item.max) return S.atMost(item.max);
      }
      if (
        (item.type === 'short_text' || item.type === 'long_text') &&
        item.minLength &&
        text.length < item.minLength
      ) {
        return S.tooShort(item.minLength);
      }
      if (item.type === 'multi' && item.maxChoices) {
        var count = v.selected.length + (v.other && v.other.trim() ? 1 : 0);
        if (count > item.maxChoices) return S.chooseAtMost(item.maxChoices);
      }
      return null;
    }

    function show(id, message) {
      var f = fields[id];
      if (!f) return;
      M.clear(f.error);
      if (message) f.error.appendChild(icon('alert'));
      f.error.appendChild(document.createTextNode(message || ''));
      f.error.hidden = !message;
      f.card.classList.toggle('has-error', Boolean(message));
    }

    function checkPage(index) {
      var firstBad = null;
      pages[index].items.forEach(function (item) {
        if (!fields[item.id] || !shown[item.id]) return;
        var message = check(item);
        show(item.id, message);
        if (message && !firstBad) firstBad = item.id;
      });
      return firstBad;
    }

    function pageOf(id) {
      for (var i = 0; i < pages.length; i++) {
        if (
          pages[i].items.some(function (it) {
            return it.id === id;
          })
        ) {
          return i;
        }
      }
      return 0;
    }

    function answersOut() {
      var out = {};
      schema.items.forEach(function (item) {
        if (!fields[item.id] || !shown[item.id] || values[item.id] === undefined) return;
        var v = values[item.id];
        if (item.type === 'number' && v !== '') v = Number(String(v).replace(',', '.'));
        out[item.id] = v;
      });
      return out;
    }

    // ── Pages ─────────────────────────────────────────────────────────────

    function partName(i) {
      return pages[i].section ? t(pages[i].section.label) : S.firstPart;
    }

    var honeypot = opts.preview
      ? null
      : h('input', {
          type: 'text',
          name: 'website',
          tabindex: '-1',
          autocomplete: 'off',
          'aria-hidden': 'true',
        });
    var formError = h('p', { class: 'fm-form-error', role: 'alert', hidden: true }, S.fix);
    var body = h('div', { class: 'fm-pages' });
    var progress = h(
      'div',
      { class: 'fm-progress', hidden: pages.length < 2 },
      h('div', { class: 'fm-progress-bar' }),
      h('span', { class: 'fm-progress-text' })
    );
    var back = h(
      'button',
      { type: 'button', class: 'fm-back' },
      icon('arrowLeft'),
      h('span', null, S.back)
    );
    var nextText = h('span');
    var next = h(
      'button',
      { type: 'submit', class: 'btn btn-primary fm-next' },
      nextText,
      icon('arrowRight')
    );
    var note =
      opts.preview || opts.draftKey
        ? h('span', { class: 'fm-draft' }, opts.preview ? S.previewNote : S.draftKept)
        : null;
    var nav = h('div', { class: 'fm-nav' }, back, note, next);
    var form = h(
      'form',
      { class: 'fm-form', novalidate: true },
      progress,
      body,
      formError,
      honeypot ? h('div', { class: 'fm-hp', 'aria-hidden': 'true' }, honeypot) : null,
      nav
    );

    var pageEls = pages.map(function (p, i) {
      var el = h(
        'section',
        { class: 'fm-page', hidden: i !== 0 },
        p.section || pages.length > 1
          ? h(
              'header',
              { class: 'fm-section' },
              pages.length > 1 ? h('p', { class: 'fm-part' }) : null,
              p.section ? h('h2', null, t(p.section.label)) : null,
              p.section && p.section.help ? md(t(p.section.help), 'fm-section-help') : null
            )
          : null,
        p.items.map(build)
      );
      body.appendChild(el);
      return el;
    });

    // A page whose section (or every question) is hidden is skipped.
    function pageShown(i) {
      var sec = pages[i].section;
      if (sec && !shown[sec.id]) return false;
      return (
        !pages[i].items.length ||
        pages[i].items.some(function (it) {
          return shown[it.id];
        })
      );
    }

    function shownPages() {
      var out = [];
      pages.forEach(function (p, i) {
        if (pageShown(i)) out.push(i);
      });
      return out;
    }

    // The nearest shown page in a direction (-1 / 1), or -1.
    function neighbour(dir) {
      for (var i = page + dir; i >= 0 && i < pages.length; i += dir) {
        if (pageShown(i)) return i;
      }
      return -1;
    }

    // The texts that depend on which pages are shown.
    function refreshNav() {
      var list = shownPages();
      var pos = Math.max(0, list.indexOf(page));
      var after = neighbour(1);
      back.hidden = neighbour(-1) === -1;
      nextText.textContent =
        after === -1
          ? S.send
          : pages[after].section
          ? S.nextTo(t(pages[after].section.label))
          : S.next;
      next.classList.toggle('is-send', after === -1);
      progress.hidden = list.length < 2;
      progress.querySelector('.fm-progress-bar').style.width =
        ((pos + 1) / list.length) * 100 + '%';
      progress.querySelector('.fm-progress-text').textContent =
        S.step(pos + 1, list.length) + ' · ' + partName(page);
      pageEls.forEach(function (el, i) {
        var part = el.querySelector('.fm-part');
        if (part) part.textContent = S.step(Math.max(0, list.indexOf(i)) + 1, list.length);
      });
    }

    // Hides what the answers so far say to hide, and renumbers the rest.
    function applyVisibility() {
      shown = visibleItems(schema, values);
      var n = 0;
      schema.items.forEach(function (item) {
        var card = cards[item.id];
        if (card) card.hidden = !shown[item.id];
        if (card && shown[item.id] && isQuestion(item) && item.type !== 'consent') {
          n++;
          var num = card.querySelector('.fm-num');
          if (num) num.textContent = n < 10 ? '0' + n : String(n);
        }
      });
      refreshNav();
      if (opts.onPage) opts.onPage(page);
    }

    function go(index) {
      page = Math.max(0, Math.min(pages.length - 1, index));
      opts.page = page;
      pageEls.forEach(function (el, i) {
        el.hidden = i !== page;
      });
      applyVisibility();
    }

    function toTop() {
      var top = root.getBoundingClientRect().top;
      if (top < 0) root.scrollIntoView({ behavior: 'smooth' });
    }

    function focusQuestion(id) {
      var f = fields[id];
      if (!f) return;
      f.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (f.focus && f.focus.focus) f.focus.focus({ preventScroll: true });
    }

    back.addEventListener('click', function () {
      formError.hidden = true;
      go(neighbour(-1));
      toTop();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      formError.hidden = true;
      var bad = checkPage(page);
      if (bad) {
        focusQuestion(bad);
        return;
      }
      if (neighbour(1) !== -1) {
        go(neighbour(1));
        toTop();
        return;
      }
      // The last page: check everything, then send.
      for (var i = 0; i < pages.length; i++) {
        if (!pageShown(i)) continue;
        var wrong = checkPage(i);
        if (wrong) {
          go(i);
          focusQuestion(wrong);
          formError.hidden = false;
          return;
        }
      }
      if (opts.preview) {
        done(schema.confirmation, true);
        return;
      }
      next.disabled = true;
      nextText.textContent = S.sending;
      Promise.resolve(opts.onSubmit(answersOut(), { website: honeypot ? honeypot.value : '' }))
        .then(function (result) {
          store(opts.draftKey, null);
          done((result && result.confirmation) || schema.confirmation, false);
        })
        .catch(function (err) {
          next.disabled = false;
          nextText.textContent = S.send;
          if (err && err.errors) {
            var first = null;
            Object.keys(err.errors).forEach(function (id) {
              show(id, err.errors[id]);
              if (!first) first = id;
            });
            if (first) {
              go(pageOf(first));
              focusQuestion(first);
            }
            formError.hidden = false;
          } else {
            formError.textContent = (err && err.message) || S.fix;
            formError.hidden = false;
          }
        });
    });

    function done(confirmation, isPreview) {
      M.clear(root);
      var own = confirmation && t(confirmation);
      root.appendChild(
        h(
          'div',
          { class: 'fm-done', tabindex: '-1' },
          icon('check', 'fm-done-icon'),
          // With the form's own closing message, the heading does not repeat its thanks.
          h('h2', null, own ? S.sentTitle : S.thanks),
          own ? md(own, 'fm-done-text') : h('p', { class: 'fm-done-text' }, S.sent),
          isPreview ? h('p', { class: 'fm-note' }, S.previewSent) : null,
          isPreview
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline',
                  onclick: function () {
                    opts.values = null;
                    opts.page = 0;
                    if (opts.restart) opts.restart();
                    else M.formRender(root, schema, opts);
                  },
                },
                S.again
              )
            : null
        )
      );
      if (opts.onDone) opts.onDone();
      toTop();
      root.firstChild.focus({ preventScroll: true });
    }

    M.clear(root);
    root.appendChild(form);
    go(opts.page || 0);
    return {
      lang: lang,
      // The parts in play, with their place in the form (hidden ones left out).
      get pages() {
        return shownPages().map(function (i) {
          return {
            index: i,
            label: partName(i),
            count: pages[i].items.filter(function (it) {
              return isQuestion(it) && shown[it.id];
            }).length,
          };
        });
      },
      goTo: function (index) {
        // Only back: the parts ahead are reached through their checks.
        if (index < page) {
          formError.hidden = true;
          go(index);
          toTop();
        }
      },
      setLang: function (code) {
        opts.lang = code;
        M.formRender(root, schema, opts);
      },
    };
  };

  // ── The page around it ──────────────────────────────────────────────────

  function frame(root, aside, main) {
    M.clear(root);
    root.classList.add('fm-root');
    root.appendChild(
      h(
        'div',
        { class: 'fm-shell' },
        h('aside', { class: 'fm-aside' }, h('div', { class: 'fm-aside-inner' }, aside)),
        h('div', { class: 'fm-body' }, main)
      )
    );
  }

  M.formPage = function (root, schema, opts) {
    opts = opts || {};
    var lang = pickLang(schema, opts.lang);
    var S = STRINGS[lang] || STRINGS.it;
    var t = texter(schema, lang);
    var total = schema.items.filter(isQuestion).length;

    var langToggle = null;
    if (schema.languages.length > 1) {
      langToggle = h('div', { class: 'lang-toggle', role: 'group', 'aria-label': S.language });
      [
        ['it', 'Italiano'],
        ['en', 'English'],
      ].forEach(function (pair) {
        if (schema.languages.indexOf(pair[0]) === -1) return;
        langToggle.appendChild(
          h(
            'button',
            {
              type: 'button',
              lang: pair[0],
              title: pair[1],
              'aria-pressed': String(pair[0] === lang),
              onclick: function () {
                if (pair[0] === lang) return;
                opts.lang = pair[0];
                if (opts.onLang) opts.onLang(pair[0]);
                M.formPage(root, schema, opts);
              },
            },
            pair[0].toUpperCase()
          )
        );
      });
    }

    var closes = null;
    if (opts.closesAt) {
      closes = h(
        'p',
        { class: 'fm-closes' },
        icon('clock'),
        h(
          'span',
          null,
          S.closesOn +
            new Date(opts.closesAt).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB', {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })
        )
      );
    }

    var steps = h('ol', { class: 'fm-steps', 'aria-label': S.parts });
    var view = h('div', { class: 'fm-view' });
    var intro = t(schema.description);
    frame(
      root,
      [
        h('p', { class: 'fm-eyebrow' }, opts.eyebrow || 'AI Safety for Italy'),
        h('h1', { class: 'fm-title' }, t(schema.title)),
        intro ? md(intro, 'fm-intro') : null,
        h('p', { class: 'fm-meta' }, h('span', null, S.questions(total)), closes),
        steps,
        h('p', { class: 'fm-privacy' }, icon('lock'), h('span', null, S.privacy)),
      ],
      [langToggle ? h('div', { class: 'fm-topline' }, langToggle) : null, view]
    );

    var current = opts.page || 0;
    var finished = false;
    var form = null;
    function drawSteps() {
      if (!form) return;
      M.clear(steps);
      steps.hidden = form.pages.length < 2;
      form.pages.forEach(function (p) {
        var i = p.index;
        var state = finished || i < current ? 'done' : i === current ? 'now' : 'next';
        var label = h(
          'span',
          { class: 'fm-step-name' },
          h('span', { class: 'fm-step-num' }, roman(i + 1)),
          h('span', null, p.label)
        );
        var end =
          state === 'done'
            ? icon('check', 'fm-step-done')
            : h(
                'span',
                { class: 'fm-step-end' },
                state === 'now' ? S.current : S.questions(p.count)
              );
        steps.appendChild(
          h(
            'li',
            { class: 'fm-step is-' + state, 'aria-current': state === 'now' ? 'step' : null },
            state === 'done' && !finished
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'fm-step-row fm-step-link',
                    'aria-label': S.goBack(p.label),
                    onclick: function () {
                      form.goTo(i);
                    },
                  },
                  label,
                  end
                )
              : h('div', { class: 'fm-step-row' }, label, end)
          )
        );
      });
    }

    form = M.formRender(
      view,
      schema,
      Object.assign(opts, {
        lang: lang,
        onPage: function (i) {
          current = i;
          drawSteps();
        },
        onDone: function () {
          finished = true;
          drawSteps();
        },
        restart: function () {
          M.formPage(root, schema, opts);
        },
      })
    );
    drawSteps();
    return form;
  };

  M.formNotice = function (root, title, text, lang) {
    frame(
      root,
      [
        h('p', { class: 'fm-eyebrow' }, 'AI Safety for Italy'),
        h('h1', { class: 'fm-title' }, title),
      ],
      h(
        'div',
        { class: 'fm-notice' },
        icon('alert', 'fm-notice-icon'),
        h('p', null, text),
        h(
          'a',
          { class: 'btn btn-outline', href: '/' },
          lang === 'en' ? 'Go to the site' : 'Vai al sito'
        )
      )
    );
  };

  M.formStrings = STRINGS;
})();
