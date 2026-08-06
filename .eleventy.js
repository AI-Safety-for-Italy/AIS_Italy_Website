const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const locales = require("./src/data/locales.js");

const DEFAULT_LOCALE = locales[0];
const PREFIXED_LOCALES = locales.filter(l => l.prefix);

/**
 * Which locale an output URL belongs to, derived from the prefixes in
 * src/data/locales.js so adding a language needs no change here.
 * @param {string} url - Output URL, e.g. "/it/about/"
 * @returns {object} The matching locale, or the default locale
 */
function resolveLocale(url) {
  return PREFIXED_LOCALES.find(l => (url || "").startsWith(l.prefix + "/")) || DEFAULT_LOCALE;
}

// Matches a single opening tag, stepping over quoted attribute values so a ">"
// inside an attribute cannot end the match early.
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const I18N_ATTRS = [
  "data-en",
  "data-it",
  "data-placeholder-en",
  "data-placeholder-it",
];

/**
 * Reads a double-quoted attribute out of a raw attribute string
 * @param {string} attrs - Raw attribute text from an opening tag
 * @param {string} name - Attribute name
 * @returns {string|null} The attribute value, or null when absent
 */
function getAttr(attrs, name) {
  const match = attrs.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return match ? match[1] : null;
}

/**
 * Removes the given attributes from a raw attribute string
 * @param {string} attrs - Raw attribute text from an opening tag
 * @param {string[]} names - Attribute names to drop
 * @returns {string} The attribute text without those attributes
 */
function dropAttrs(attrs, names) {
  return names.reduce(
    (acc, name) => acc.replace(new RegExp('\\s' + name + '="[^"]*"', "g"), ""),
    attrs
  );
}

/**
 * Rewrites a site-relative link to its equivalent inside a locale prefix.
 * Asset paths, files with an extension, anchors, mailto: and absolute URLs are
 * left alone, as are links already inside the prefix.
 * @param {string} href - The original href
 * @param {string} prefix - Locale prefix, e.g. "/it"
 * @returns {string|null} The rewritten href, or null to leave it unchanged
 */
function prefixHref(href, prefix) {
  if (!href || !href.startsWith("/")) return null;
  if (href.startsWith(prefix + "/")) return null;
  if (href.startsWith("/assets/")) return null;
  if (/\.[a-z0-9]+(\?|#|$)/i.test(href)) return null;
  return prefix + href;
}

/**
 * Resolves the inline bilingual markup into single-language HTML.
 *
 * Templates author both languages at once — `data-en` / `data-it` on text-only
 * elements, `data-placeholder-en` / `-it` on form fields — because that is how
 * contributors already write content. This turns each rendered page into one
 * language's static HTML: the active language's text replaces the element body,
 * placeholders are set, internal links are moved under the locale prefix, and
 * the now-redundant attributes are dropped so pages do not ship both languages.
 *
 * A bilingual element is a whole-content replacement, so it must contain text
 * only. One wrapping other markup is left untouched and reported rather than
 * mangled. An empty `data-it` (a translation that has not been written yet)
 * also falls back to the English body.
 *
 * @param {string} html - Rendered page HTML
 * @param {object} locale - The locale from src/data/locales.js
 * @param {string} outputPath - Output path, used only in warnings
 * @returns {string} HTML for that one language
 */
function localizeHtml(html, locale, outputPath) {
  const textAttr = "data-" + locale.code;
  const placeholderAttr = "data-placeholder-" + locale.code;

  let out = "";
  let cursor = 0;
  let match;

  OPEN_TAG.lastIndex = 0;
  while ((match = OPEN_TAG.exec(html)) !== null) {
    const [full, tag, rawAttrs, selfClose] = match;

    // A pair, not a lone attribute: a single data-en with no data-it is not
    // bilingual markup and is left alone.
    const bilingual =
      getAttr(rawAttrs, "data-en") !== null && getAttr(rawAttrs, "data-it") !== null;
    const placeholder = getAttr(rawAttrs, placeholderAttr);
    // The language switch already points at the other locale; prefixing it
    // would send it back to the page it is on.
    const isLink =
      tag.toLowerCase() === "a" && !rawAttrs.includes(" data-lang-switch");
    const newHref = locale.prefix && isLink
      ? prefixHref(getAttr(rawAttrs, "href"), locale.prefix)
      : null;

    if (!bilingual && placeholder === null && newHref === null) continue;

    let attrs = rawAttrs;
    if (placeholder !== null) {
      attrs = attrs.replace(/\splaceholder="[^"]*"/, ' placeholder="' + placeholder + '"');
    }
    if (newHref !== null) {
      attrs = attrs.replace(/\shref="[^"]*"/, ' href="' + newHref + '"');
    }
    attrs = dropAttrs(attrs, I18N_ATTRS);

    out += html.slice(cursor, match.index) + "<" + tag + attrs + selfClose + ">";
    cursor = match.index + full.length;

    if (bilingual) {
      const closeTag = "</" + tag + ">";
      const end = html.indexOf(closeTag, cursor);
      const body = end === -1 ? null : html.slice(cursor, end);

      if (body === null || body.includes("<")) {
        console.warn(
          `Warning: ${outputPath} has a <${tag}> with data-en/data-it that is ` +
          `not text-only; its content was left in English. Move the ` +
          `data-en/data-it pair onto an element that wraps text only.`
        );
      } else {
        // An attribute value and text content use the same entity escaping, so
        // the translation can be copied across verbatim.
        const translated = getAttr(rawAttrs, textAttr);
        if (translated && translated.trim()) {
          out += translated;
          cursor = end;
        }
      }
    }

    OPEN_TAG.lastIndex = cursor;
  }

  return out + html.slice(cursor);
}

/**
 * Loads a YAML file from the specified directory
 * @param {string} directory - Directory path
 * @param {string} filename - Filename to load
 * @returns {object} Parsed YAML content or empty object if file doesn't exist
 * @private
 */
function loadYamlFile(directory, filename) {
  try {
    const filePath = path.join(directory, filename);
    if (fs.existsSync(filePath)) {
      const fileContents = fs.readFileSync(filePath, 'utf8');
      return yaml.load(fileContents) || {};
    }
  } catch (error) {
    console.error(`Error loading ${filename} from ${directory}:`, error.message);
  }
  return {};
}

module.exports = function(eleventyConfig) {
  // Pass through copy
  eleventyConfig.addPassthroughCopy("src/assets/img");
  eleventyConfig.addPassthroughCopy("src/assets/js");
  eleventyConfig.addPassthroughCopy({ "src/assets/fonts": "assets/fonts" });
  // Copy favicons to root
  eleventyConfig.addPassthroughCopy({ "src/assets/img/favicon.svg": "favicon.svg" });
  eleventyConfig.addPassthroughCopy({ "src/assets/img/favicon.ico": "favicon.ico" });
  eleventyConfig.addPassthroughCopy({ "src/assets/img/apple-touch-icon.png": "apple-touch-icon.png" });

  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/llms.txt");

  // Watch targets for live reload
  eleventyConfig.addWatchTarget("src/assets/css/");
  eleventyConfig.addWatchTarget("src/design/");
  eleventyConfig.addWatchTarget("data/");

  // Filters
  /**
   * Converts date to readable format
   */
  eleventyConfig.addFilter("readableDate", dateObj => {
    return new Date(dateObj).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  });

  /**
   * Converts date to readable Italian format
   */
  eleventyConfig.addFilter("readableDateIt", dateObj => {
    return new Date(dateObj).toLocaleDateString('it-IT', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  });

  eleventyConfig.addFilter("date", (dateObj, format) => {
    const date = new Date(dateObj);
    if (Number.isNaN(date.getTime())) return "";
    if (format === "Y-m-d") {
      return date.toISOString().slice(0, 10);
    }
    return date.toLocaleDateString('en-US');
  });

  /**
   * Splits string by delimiter
   */
  eleventyConfig.addFilter("split", (str, delimiter) => {
    if (typeof str !== 'string') return [];
    return str.split(delimiter);
  });

  /**
   * Concatenates one array-valued key across a list of objects.
   * Used to flatten faq.categories[].questions into a single list.
   */
  eleventyConfig.addFilter("pluckFlat", (list, key) => {
    return (list || []).reduce((acc, item) => acc.concat((item && item[key]) || []), []);
  });

  /**
   * Serialises a value as a JSON literal for embedding in a JSON-LD block.
   * "<" is escaped so content can never break out of the <script> element.
   */
  eleventyConfig.addFilter("jsonld", value => {
    return JSON.stringify(value === undefined ? null : value).replace(/</g, "\\u003c");
  });

  // Resolve the inline data-en/data-it markup down to one language per page.
  // Runs on every HTML output; see localizeHtml() above for the rules.
  eleventyConfig.addTransform("localize", function (content) {
    const outputPath = this.page.outputPath || "";
    if (!outputPath.endsWith(".html")) return content;
    return localizeHtml(content, resolveLocale(this.page.url), outputPath);
  });

  // Collections
  eleventyConfig.addCollection("events", function(collection) {
    return collection.getFilteredByGlob("src/content/initiatives.njk");
  });

  // Add data extensions for YAML files
  eleventyConfig.addDataExtension("yaml", contents => yaml.load(contents));
  eleventyConfig.addDataExtension("yml", contents => yaml.load(contents));

  // Setup directories for data loading
  const rootDataDir = path.join(__dirname, 'data');
  const designDir = path.join(__dirname, 'src', 'design');

  /**
   * Create global data loader for root data directory files
   */
  const dataFileNames = [
    'home.yaml',
    'about.yaml',
    'events.yaml',
    'activities.yaml',
    'community.yaml',
    'faq.yaml',
    'contact.yaml',
    'global.yaml',
    'translations.yaml',
    'news.yaml',
    'members.yaml',
    'resources.yaml'
  ];

  // Load and expose each data file as global data
  dataFileNames.forEach(filename => {
    const dataKey = filename.replace('.yaml', '');
    eleventyConfig.addGlobalData(dataKey, () => {
      const data = loadYamlFile(rootDataDir, filename);
      if (Object.keys(data).length === 0) {
        console.warn(`Warning: ${filename} is empty or missing`);
      }
      return data;
    });
  });

  /**
   * Load all design tokens and make them globally available
   */
  eleventyConfig.addGlobalData("design", () => {
    return {
      colors: loadYamlFile(designDir, 'colors.yaml'),
      themes: loadYamlFile(designDir, 'themes.yaml'),
      typography: loadYamlFile(designDir, 'typography.yaml'),
      spacing: loadYamlFile(designDir, 'spacing.yaml'),
      components: loadYamlFile(designDir, 'components.yaml'),
      layout: loadYamlFile(designDir, 'layout.yaml'),
      settings: loadYamlFile(designDir, 'design.yaml')
    };
  });

  // Exclude README files from processing
  eleventyConfig.ignores.add("src/README.md");
  eleventyConfig.ignores.add("src/assets/img/README.md");
  eleventyConfig.ignores.add("src/design/README.md");

  return {
    dir: {
      input: "src",
      output: "_site",
      // Page shells live in components/ alongside the partials because they are
      // pulled in with Nunjucks `{% extends %}`, not Eleventy's `layout:` front
      // matter — see the comment at the top of components/base.njk for why.
      includes: "components",
      data: "data" // Point to src/data directory to maintain compatibility with existing site data
    },
    templateFormats: ["md", "njk", "html"], // Include md for content files
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    passthroughFileCopy: true
  };
};
