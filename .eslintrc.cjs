module.exports = {
  env: {
    browser: false,
    node: true,
    es2021: true
  },
  extends: ["eslint:recommended", "prettier"],
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: "module"
  },
  rules: {
    // project-specific rules can be added here
  },
  overrides: [
    {
      // Everything else here is build-time Node code; this is the one directory
      // that ships to the browser, so it gets the browser globals instead.
      files: ["src/assets/js/**/*.js"],
      env: {
        browser: true,
        node: false
      },
      parserOptions: {
        sourceType: "script"
      }
    }
  ]
};
