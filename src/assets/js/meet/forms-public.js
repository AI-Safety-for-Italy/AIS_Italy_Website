/* /form/?f=<slug>: a form anyone with the link can fill in (api/form.js).
 * The language is the visitor's choice from last time, else the browser's,
 * among the ones the form is written in. The page itself is drawn by
 * forms-render.js (Meet.formPage), the same code as the editor's preview. */
(function () {
  'use strict';
  var M = window.Meet;

  var LANG_KEY = 'form-lang';
  var slug = new URLSearchParams(window.location.search).get('f') || '';
  var view = document.getElementById('formView');

  var TEXT = {
    en: {
      notFound: 'Form not found',
      notFoundText: 'Check the link you were given.',
      closed: 'This form is closed',
      closedText: 'It is not taking answers at the moment.',
      error: 'Something went wrong',
    },
    it: {
      notFound: 'Modulo non trovato',
      notFoundText: 'Controlla il link che hai ricevuto.',
      closed: 'Questo modulo è chiuso',
      closedText: 'Al momento non accetta risposte.',
      error: 'Qualcosa è andato storto',
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

  function titled(title, lang) {
    document.title = title + ' | AI Safety for Italy';
    document.documentElement.lang = lang;
  }

  function start(data) {
    var languages = data.languages || (data.schema && data.schema.languages) || ['it'];
    var lang = preferred(languages);
    var title = text(data.title || (data.schema && data.schema.title), lang, languages);
    titled(title, lang);
    if (!data.open) {
      M.formNotice(
        view,
        title || TEXT[lang].closed,
        TEXT[lang].closed + '. ' + TEXT[lang].closedText,
        lang
      );
      return;
    }
    M.formPage(view, data.schema, {
      lang: lang,
      closesAt: data.closesAt,
      draftKey: 'form-draft:' + data.slug,
      onLang: function (code) {
        try {
          window.localStorage.setItem(LANG_KEY, code);
        } catch (e) {
          /* the switch still works for this visit */
        }
        titled(text(data.schema.title, code, languages), code);
      },
      onSubmit: function (answers, extra) {
        return M.api('POST', '/api/form?f=' + encodeURIComponent(slug), {
          version: data.version,
          token: data.token,
          answers: answers,
          website: extra.website,
        });
      },
    });
  }

  var guess = /^it\b/i.test(navigator.language || '') ? 'it' : 'en';
  if (!slug) {
    M.formNotice(view, TEXT[guess].notFound, TEXT[guess].notFoundText, guess);
    return;
  }
  M.api('GET', '/api/form?f=' + encodeURIComponent(slug))
    .then(start)
    .catch(function (err) {
      if (err.status === 404)
        M.formNotice(view, TEXT[guess].notFound, TEXT[guess].notFoundText, guess);
      else M.formNotice(view, TEXT[guess].error, err.message, guess);
    });
})();
