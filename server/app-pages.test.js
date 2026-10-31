// Tests that the pages of the personal area (src/content/app/) and the tools
// list (src/data/tools.js) agree: every page uses the shared frame, every tool
// and tab points to a real page, and every permission named exists.
// Plain file reads, no build. Run with `npm run test:meet`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

process.env.SESSION_SECRET = 'x'.repeat(40);

const { PERMISSIONS } = require('./permissions');
const tools = require('../src/data/tools');
const appSettings = require('../src/data/appSettings');

const APP_DIR = path.join(__dirname, '..', 'src', 'content', 'app');

function njkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return njkFiles(full);
    return entry.name.endsWith('.njk') ? [full] : [];
  });
}

const pages = njkFiles(APP_DIR)
  .filter((file) => path.relative(APP_DIR, file) !== 'login.njk')
  .map((file) => {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const match = source.match(/^---\n([\s\S]*?)\n---/);
    return {
      name: path.relative(APP_DIR, file).split(path.sep).join('/'),
      source,
      data: match ? yaml.load(match[1]) || {} : {},
    };
  });

const toolKeys = tools.map((t) => t.key);
const permissionKeys = PERMISSIONS.map((p) => p.key);
const areas = [...new Set(PERMISSIONS.map((p) => p.area))];
const pathOf = (url) => url.split('#')[0].split('?')[0];

test('every page of the personal area uses the shared frame', () => {
  assert.ok(pages.length > 0);
  for (const { name, source } of pages) {
    assert.match(source, /\{%-?\s*extends\s+["']app\.njk["']\s*-?%\}/, `${name}: extends app.njk`);
    assert.doesNotMatch(source, /\{%-?\s*block\s+content\b/, `${name}: block content`);
    assert.doesNotMatch(source, /page-hero/, `${name}: page-hero`);
    assert.doesNotMatch(source, /admin-bar/, `${name}: admin-bar`);
  }
});

test('the tool and tab of each page exist in the tools list', () => {
  for (const { name, data } of pages) {
    if (data.tool === undefined) continue;
    const tool =
      data.tool === appSettings.key ? appSettings : tools.find((t) => t.key === data.tool);
    assert.ok(tool, `${name}: unknown tool "${data.tool}"`);
    if (data.tab === undefined) continue;
    const listed = tool.tabs.some((t) => t.key === data.tab);
    // An inner page (like a single poll) names a tab that is not listed, and
    // then sets its own page title.
    assert.ok(listed || data.pageTitle, `${name}: unknown tab "${data.tab}" of ${data.tool}`);
  }
});

test('every tool has a unique key, app urls and at least one page', () => {
  assert.equal(new Set(toolKeys).size, toolKeys.length, 'duplicate tool key');
  for (const tool of tools) {
    assert.ok(
      tool.url.startsWith('/app/') && tool.url.endsWith('/'),
      `${tool.key}: url ${tool.url}`
    );
    for (const item of [...tool.tabs, ...tool.actions]) {
      assert.ok(item.url.startsWith('/app/'), `${tool.key}: url ${item.url}`);
    }
    assert.ok(
      pages.some((p) => p.data.tool === tool.key),
      `${tool.key}: no page declares this tool`
    );
  }
});

test('every tool and tab url is the permalink of a page', () => {
  const permalinks = new Set(pages.map((p) => p.data.permalink));
  for (const tool of [...tools, appSettings]) {
    for (const url of [tool.url, ...tool.tabs.map((t) => t.url)]) {
      assert.ok(permalinks.has(pathOf(url)), `${tool.key}: no page has permalink ${pathOf(url)}`);
    }
  }
});

test('the permissions named by the Settings tabs exist', () => {
  for (const tab of appSettings.tabs) {
    if (tab.needs !== undefined) assert.ok(permissionKeys.includes(tab.needs), tab.key);
  }
});

test('the areas and permissions named by the tools exist', () => {
  for (const tool of tools) {
    assert.ok(tool.area === null || areas.includes(tool.area), `${tool.key}: area ${tool.area}`);
    for (const item of [...tool.tabs, ...tool.actions]) {
      if (item.needs === undefined) continue;
      assert.ok(permissionKeys.includes(item.needs), `${tool.key}: needs ${item.needs}`);
    }
  }
});
