/* Draws a form (a schema from server/forms/schema.js) and collects its answers.
 * The same code draws the public page (/form/) and the editor's preview, so
 * what the editor shows is what people get.
 *
 *   Meet.formRender(root, schema, {
 *     lang,                 'it' | 'en'
 *     preview,              true: no honeypot, sending only shows the end screen
 *     draftKey,             keep answers in this browser while filling in
 *     onSubmit(answers),    -> Promise of { confirmation }; a rejection with
 *                              err.errors ({ id: message }) marks the questions
 *   })
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
      send: 'Send',
      sending: 'Sending…',
      step: function (i, n) {
        return 'Step ' + i + ' of ' + n;
      },
      fix: 'Some answers need a look.',
      thanks: 'Thank you!',
      sentTitle: 'Sent',
      sent: 'Your answers have been sent.',
      previewSent: 'Preview: nothing was sent.',
      again: 'Fill in again',
      requiredMark: 'Required',
      draftKept: 'Your answers are kept in this browser until you send them.',
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
      send: 'Invia',
      sending: 'Invio…',
      step: function (i, n) {
        return 'Passo ' + i + ' di ' + n;
      },
      fix: 'Alcune risposte vanno controllate.',
      thanks: 'Grazie!',
      sentTitle: 'Inviato',
      sent: 'Le tue risposte sono state inviate.',
      previewSent: 'Anteprima: non è stato inviato nulla.',
      again: 'Compila di nuovo',
      requiredMark: 'Obbligatoria',
      draftKept: 'Le risposte restano in questo browser finché non le invii.',
    },
  };

  var EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
  var HTTPS = /^https:\/\/[^\s<>"]{3,}$/i;

  function md(text) {
    var el = h('div', { class: 'fm-md' });
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

  M.formRender = function (root, schema, opts) {
    opts = opts || {};
    var lang = schema.languages.indexOf(opts.lang) !== -1 ? opts.lang : schema.languages[0];
    var S = STRINGS[lang] || STRINGS.it;
    var t = function (value) {
      return (value && (value[lang] || value[schema.languages[0]])) || '';
    };
    var values = opts.preview ? {} : restore(opts.draftKey);
    var fields = {};
    var page = 0;

    // Pages: a new one at each section; the first holds what comes before.
    var pages = [{ section: null, items: [] }];
    schema.items.forEach(function (item) {
      if (item.type === 'section') pages.push({ section: item, items: [] });
      else pages[pages.length - 1].items.push(item);
    });
    if (!pages[0].items.length && pages.length > 1) pages.shift();

    var saveTimer = null;
    function changed() {
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
        if (kind === 'email') attrs.autocomplete = 'email';
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
      var counter = kind === 'long_text' ? h('span', { class: 'fm-counter' }) : null;
      function count() {
        if (counter) counter.textContent = S.chars(input.value.length, item.maxLength);
      }
      count();
      input.addEventListener('input', function () {
        values[item.id] = input.value;
        count();
        changed();
      });
      return { control: h('div', null, input, counter), focus: input };
    }

    function choiceField(item) {
      var multi = item.type === 'multi';
      var current = values[item.id] || { selected: [] };
      var group = h('div', { class: 'fm-choices', role: multi ? 'group' : 'radiogroup' });
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
        group.appendChild(h('label', { class: 'fm-choice' }, input, h('span', null, t(o.label))));
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
            h('span', null, S.other),
            otherInput
          )
        );
      }
      return { control: group, focus: group.querySelector('input') };
    }

    function dropdownField(item) {
      var select = h(
        'select',
        { class: 'fm-input', id: 'fm-' + item.id },
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
      var head = made.labelInside
        ? null
        : h(
            'label',
            { class: 'fm-label', id: labelId, for: 'fm-' + item.id },
            t(item.label),
            item.required
              ? h(
                  'span',
                  { class: 'fm-required', title: S.requiredMark, 'aria-label': S.requiredMark },
                  ' *'
                )
              : null
          );
      var card = h(
        'div',
        { class: 'fm-question', 'data-id': item.id },
        head,
        item.help && !made.labelInside ? md(t(item.help)) : null,
        made.control,
        item.help && made.labelInside ? md(t(item.help)) : null,
        error
      );
      if (
        made.control.getAttribute &&
        (made.control.getAttribute('role') || '').indexOf('group') !== -1
      ) {
        made.control.setAttribute('aria-labelledby', labelId);
      }
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
      if (item.type === 'email' && !EMAIL.test(text)) return S.email;
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
      f.error.textContent = message || '';
      f.error.hidden = !message;
      f.card.classList.toggle('has-error', Boolean(message));
    }

    function checkPage(index) {
      var firstBad = null;
      pages[index].items.forEach(function (item) {
        if (!fields[item.id]) return;
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
        if (!fields[item.id] || values[item.id] === undefined) return;
        var v = values[item.id];
        if (item.type === 'number' && v !== '') v = Number(String(v).replace(',', '.'));
        out[item.id] = v;
      });
      return out;
    }

    // ── Pages ─────────────────────────────────────────────────────────────

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
    var back = h('button', { type: 'button', class: 'btn btn-outline' }, S.back);
    var next = h('button', { type: 'submit', class: 'btn btn-primary' }, S.next);
    var nav = h('div', { class: 'fm-nav' }, back, next);
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
        p.section
          ? h(
              'header',
              { class: 'fm-section' },
              h('h2', null, t(p.section.label)),
              p.section.help ? md(t(p.section.help)) : null
            )
          : null,
        p.items.map(build)
      );
      body.appendChild(el);
      return el;
    });

    function go(index) {
      page = Math.max(0, Math.min(pages.length - 1, index));
      pageEls.forEach(function (el, i) {
        el.hidden = i !== page;
      });
      back.hidden = page === 0;
      next.textContent = page === pages.length - 1 ? S.send : S.next;
      progress.querySelector('.fm-progress-bar').style.width =
        ((page + 1) / pages.length) * 100 + '%';
      progress.querySelector('.fm-progress-text').textContent = S.step(page + 1, pages.length);
    }

    function focusQuestion(id) {
      var f = fields[id];
      if (!f) return;
      f.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (f.focus && f.focus.focus) f.focus.focus({ preventScroll: true });
    }

    back.addEventListener('click', function () {
      formError.hidden = true;
      go(page - 1);
      root.scrollIntoView({ behavior: 'smooth' });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      formError.hidden = true;
      var bad = checkPage(page);
      if (bad) {
        focusQuestion(bad);
        return;
      }
      if (page < pages.length - 1) {
        go(page + 1);
        root.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      // The last page: check everything, then send.
      for (var i = 0; i < pages.length; i++) {
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
      next.textContent = S.sending;
      Promise.resolve(opts.onSubmit(answersOut(), { website: honeypot ? honeypot.value : '' }))
        .then(function (result) {
          store(opts.draftKey, null);
          done((result && result.confirmation) || schema.confirmation, false);
        })
        .catch(function (err) {
          next.disabled = false;
          next.textContent = S.send;
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
      root.appendChild(
        h(
          'div',
          { class: 'fm-done' },
          h('div', { class: 'fm-done-icon', 'aria-hidden': 'true' }, '✓'),
          // With the form's own closing message, the heading does not repeat its thanks.
          confirmation && t(confirmation) ? h('h2', null, S.sentTitle) : h('h2', null, S.thanks),
          confirmation && t(confirmation) ? md(t(confirmation)) : h('p', null, S.sent),
          isPreview ? h('p', { class: 'fm-note' }, S.previewSent) : null,
          isPreview
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline',
                  onclick: function () {
                    M.formRender(root, schema, opts);
                  },
                },
                S.again
              )
            : null
        )
      );
      root.scrollIntoView({ behavior: 'smooth' });
    }

    M.clear(root);
    root.appendChild(form);
    if (opts.draftKey && !opts.preview) root.appendChild(h('p', { class: 'fm-note' }, S.draftKept));
    go(0);
    return {
      lang: lang,
      setLang: function (code) {
        opts.lang = code;
        M.formRender(root, schema, opts);
      },
    };
  };

  M.formStrings = STRINGS;
})();
