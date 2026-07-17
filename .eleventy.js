const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

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
  // Copy favicon to root
  eleventyConfig.addPassthroughCopy({ "src/assets/img/favicon.svg": "favicon.svg" });

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
      includes: "components",
      layouts: "layouts",
      data: "data" // Point to src/data directory to maintain compatibility with existing site data
    },
    templateFormats: ["md", "njk", "html"], // Include md for content files
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    passthroughFileCopy: true
  };
};
