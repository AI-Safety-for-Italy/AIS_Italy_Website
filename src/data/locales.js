// Locales the site is built in.
//
// Every template in src/content/ that carries the `pagination` block in its
// front matter is rendered once per entry here. `prefix` is glued in front of
// the page's `basePath` to form the permalink, so English stays at /about/ and
// Italian is published as a real, crawlable page at /it/about/.
//
// The first entry is the default locale: it takes the un-prefixed URLs and is
// what hreflang advertises as x-default.
//
// Adding a locale means adding an entry here, giving the translation strings an
// equivalent of the `data-it` attributes used in the templates, and teaching
// resolveLocale() in .eleventy.js nothing at all — it derives everything from
// this list.
module.exports = [
  {
    code: 'en',
    prefix: '',
    ogLocale: 'en_US',
    // How the language switch offers THIS locale, written in this locale — a
    // language picker should always be legible to the speaker it is offering
    // the language to, so these are never translated.
    switchLabel: 'EN',
    switchTitle: 'Switch to English',
  },
  {
    code: 'it',
    prefix: '/it',
    ogLocale: 'it_IT',
    switchLabel: 'IT',
    switchTitle: "Passa all'italiano",
  },
];
