/* /form/?f=<slug>: a form anyone with the link can fill in (api/form.js).
 * The language is the visitor's choice from last time, else the browser's,
 * among the ones the form is written in. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var LANG_KEY = 'form-lang';
  var slug = new URLSearchParams(window.location.search).get('f') || '';
  var view = document.getElementById('formView');
  var titleEl = document.getElementById('formTitle');
  var descEl = document.getElementById('formDescription');
  var toggle = document.getElementById('langToggle');

  var TEXT = {
    en: {
      notFound: 'Form not found',
      notFoundText: 'Check the link you were given.',
      closed: 'This form is closed',
      closedText: 'It is not taking answers at the moment.',
      error: 'Something went wrong. Please try again.',
      closesOn: 'Open until ',
    },
    it: {
      notFound: 'Modulo non trovato',
      notFoundText: 'Controlla il link che hai ricevuto.',
      closed: 'Questo modulo è chiuso',
      closedText: 'Al momento non accetta risposte.',
      error: 'Qualcosa è andato storto. Riprova.',
      closesOn: 'Aperto fino al ',
    },
  };

  function preferred(languages) {
    var saved = null;
    try {
      saved = window.localStorage.getItem(LANG_KEY);
    } catch (e) {
      /* no storage */
    }
    var browser = /^it\b/i.test(
      (navigator.languages && navigator.languages[0]) || navigator.language || ''
    )
      ? 'it'
      : 'en';
    if (saved && languages.indexOf(saved) !== -1) return saved;
    if (languages.indexOf(browser) !== -1) return browser;
    return languages[0];
  }

  function text(value, lang, languages) {
    return (value && (value[lang] || value[languages[0]])) || '';
  }

  function message(title, body) {
    titleEl.textContent = title;
    M.clear(view);
    view.appendChild(h('div', { class: 'empty-state fm-empty' }, h('p', null, body)));
  }

  function header(data, lang) {
    var languages = data.languages || (data.schema && data.schema.languages) || ['it'];
    var title = text(data.title || (data.schema && data.schema.title), lang, languages);
    titleEl.textContent = title;
    document.title = title + ' | AI Safety for Italy';
    document.documentElement.lang = lang;
    var description = data.schema ? text(data.schema.description, lang, languages) : '';
    descEl.hidden = !description;
    // markdown-lite escapes everything but its own tags.
    descEl.innerHTML = description ? M.md.toHtml(description) : '';
    if (data.closesAt && data.open) {
      descEl.hidden = false;
      descEl.appendChild(
        h(
          'p',
          { class: 'fm-closes' },
          TEXT[lang].closesOn +
            new Date(data.closesAt).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB', {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })
        )
      );
    }
    toggle.hidden = languages.length < 2;
    toggle.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    });
  }

  function start(data) {
    var languages = data.languages || (data.schema && data.schema.languages) || ['it'];
    var lang = preferred(languages);
    header(data, lang);
    if (!data.open) {
      message(
        text(data.title, lang, languages) || TEXT[lang].closed,
        TEXT[lang].closed + '. ' + TEXT[lang].closedText
      );
      titleEl.textContent = text(data.title, lang, languages);
      return;
    }
    var form = M.formRender(view, data.schema, {
      lang: lang,
      draftKey: 'form-draft:' + data.slug,
      onSubmit: function (answers, extra) {
        return M.api('POST', '/api/form?f=' + encodeURIComponent(slug), {
          version: data.version,
          token: data.token,
          answers: answers,
          website: extra.website,
        });
      },
    });
    toggle.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        var code = b.getAttribute('lang');
        try {
          window.localStorage.setItem(LANG_KEY, code);
        } catch (e) {
          /* the switch still works for this visit */
        }
        header(data, code);
        form.setLang(code);
      };
    });
  }

  var guess = /^it\b/i.test(navigator.language || '') ? 'it' : 'en';
  if (!slug) {
    message(TEXT[guess].notFound, TEXT[guess].notFoundText);
    return;
  }
  view.appendChild(M.loading());
  M.api('GET', '/api/form?f=' + encodeURIComponent(slug))
    .then(start)
    .catch(function (err) {
      if (err.status === 404) message(TEXT[guess].notFound, TEXT[guess].notFoundText);
      else message(TEXT[guess].error, err.message);
    });
})();
