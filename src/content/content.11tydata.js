const locales = require('../data/locales.js');

const DEFAULT_LOCALE = locales[0];

/**
 * Directory data for src/content/.
 *
 * Pages built for more than one language get a `locale` from their pagination
 * block; style-guide.njk has none. These computed values give every template a
 * locale to read regardless, so components never have to guard for it:
 *
 *   lang        active language code, e.g. "it" — also used for <html lang>
 *   loc         the full locale object (prefix, ogLocale, switch labels)
 *   altLocales  the other locales, for hreflang alternates and the language
 *               switch. Computed here rather than in the template because a
 *               Nunjucks `{% set %}` inside a `{% for %}` does not survive the
 *               loop.
 *   t           the translations subtree for the active language, so a template
 *               can write `t.nav.about` instead of `translations.en.nav.about`.
 *               Use this for strings the build has to resolve server-side
 *               (aria-label, title); visible text uses the data-en/data-it pairs
 *               that the "localize" transform in .eleventy.js resolves.
 */
const codeOf = (data) => (data.locale && data.locale.code) || DEFAULT_LOCALE.code;

module.exports = {
  eleventyComputed: {
    lang: codeOf,
    loc: (data) => data.locale || DEFAULT_LOCALE,
    altLocales: (data) => locales.filter((l) => l.code !== codeOf(data)),
    t: (data) => (data.translations && data.translations[codeOf(data)]) || {},
  },
};
