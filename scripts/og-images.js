#!/usr/bin/env node
/**
 * Renders the Open Graph cards in src/assets/img/og/, one per page and locale.
 *
 * The look follows the A5 flyer of the first Milan meetup: cream paper, the
 * tricolour strip on top, Fraunces Black for the headline, IBM Plex for the
 * rest, the petal logo on the right and a green band at the bottom.
 *
 * The PNGs are committed, not built: this needs a local Chrome and network
 * access for the Google Fonts, neither of which the Vercel build has. Run it
 * after changing a page's nav label or hero subtitle and commit the result:
 *
 *   node scripts/og-images.js            # every card
 *   node scripts/og-images.js about      # only the cards whose name matches
 *
 * CHROME overrides the browser path (default: Google Chrome on macOS).
 * base.njk picks the file from the page's basePath, so a new page needs an
 * entry here named after its basePath ("/" is "home").
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const locales = require('../src/data/locales.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src/assets/img/og');
const readSvg = (file) => fs.readFileSync(path.join(ROOT, 'src/assets/img', file), 'utf8');
const MARK = readSvg('ais4i-logo.svg');
const FLOWER = readSvg('ais4i-logo-label.svg');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Every word on a card comes from the site's own data, never from this file:
// line3 is the page's nav label, body its hero subtitle, kicker its URL. Edit
// the copy there and re-run this script.
const loadYaml = (file) => yaml.load(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
const T = loadYaml('translations.yaml');
const pageHero = (file) => {
  const { hero } = loadYaml(file);
  return { en: hero.subtitle, it: hero.subtitle_it };
};

// name: the card's file name, from basePath ("/" is "home").
// nav: key under translations.<lang>.nav, absent on the home card.
const PAGES = [
  { name: 'home', basePath: '/', body: { en: T.en.hero.subtitle, it: T.it.hero.subtitle } },
  { name: 'about', basePath: '/about/', nav: 'about', body: pageHero('about.yaml') },
  {
    name: 'community',
    basePath: '/community/',
    nav: 'community',
    body: { en: T.en.community.hero_subtitle, it: T.it.community.hero_subtitle },
  },
  { name: 'initiatives', basePath: '/initiatives/', nav: 'events', body: pageHero('events.yaml') },
  {
    name: 'resources',
    basePath: '/resources/',
    nav: 'resources',
    body: pageHero('resources.yaml'),
  },
  { name: 'faq', basePath: '/faq/', nav: 'faq', body: pageHero('faq.yaml') },
  { name: 'contact', basePath: '/contact/', nav: 'contact', body: pageHero('contact.yaml') },
];

function cardFor(page, locale) {
  const lang = locale.code;
  return {
    kicker: ('ais4i.it' + locale.prefix + page.basePath).replace(/\/$/, ''),
    line3: page.nav && T[lang].nav[page.nav] + '.',
    body: page.body[lang],
  };
}

const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderHtml(card, lang) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,900,0..100,0..1;1,9..144,900,0..100,0..1&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;600&display=block" />
<style>
  :root { --paper: #f5f3ee; --ink: #141414; --green: #2f6b42; --band: #336e45; --red: #a3262a; --rule: #d9d6cf; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; background: var(--paper); }
  body { position: relative; font-family: 'IBM Plex Sans', sans-serif; color: var(--ink); }
  .flag { position: absolute; inset: 0 0 auto 0; height: 12px; display: flex; }
  .flag span { flex: 1; }
  .flag span:nth-child(1) { background: var(--band); }
  .flag span:nth-child(2) { background: #fff; }
  .flag span:nth-child(3) { background: var(--red); }
  .brand { position: absolute; left: 72px; top: 44px; display: flex; align-items: center; gap: 14px; font-weight: 600; font-size: 24px; }
  .brand svg { width: 46px; height: 46px; }
  .pill { position: absolute; right: 72px; top: 46px; border: 2px solid var(--ink); border-radius: 999px; padding: 7px 20px; font-family: 'IBM Plex Mono', monospace; font-weight: 500; font-size: 20px; letter-spacing: 0.12em; text-transform: uppercase; }
  .copy { position: absolute; left: 72px; top: 128px; width: 720px; }
  .kicker { font-family: 'IBM Plex Mono', monospace; font-weight: 500; font-size: 20px; letter-spacing: 0.06em; color: var(--green); }
  h1 { margin-top: 14px; font-family: 'Fraunces', serif; font-weight: 900; font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 0; font-optical-sizing: none; letter-spacing: -0.03em; line-height: 0.94; font-size: 86px; }
  h1.two { font-size: 112px; margin-top: 18px; }
  h1 .g { color: var(--green); display: block; }
  h1 .k { display: block; }
  h1 .i { display: block; font-style: italic; }
  .body { margin-top: 22px; font-size: 23px; line-height: 1.4; max-width: 660px; }
  .flower { position: absolute; right: 44px; top: 96px; width: 400px; height: 400px; }
  .flower svg { width: 100%; height: 100%; }
  .band { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: var(--band); }
</style>
</head>
<body>
  <div class="flag"><span></span><span></span><span></span></div>
  <div class="brand">${MARK}<span>AI Safety for Italy</span></div>
  <div class="pill">${lang}</div>
  <div class="copy">
    <p class="kicker">${escape(card.kicker)}</p>
    <h1 class="${
      card.line3 ? '' : 'two'
    }"><span class="g">AI Safety</span><span class="k">for Italy${card.line3 ? '' : '.'}</span>${
    card.line3 ? `<span class="i">${escape(card.line3)}</span>` : ''
  }</h1>
    <p class="body">${escape(card.body)}</p>
  </div>
  <div class="flower">${FLOWER}</div>
  <div class="band"></div>
</body>
</html>`;
}

function main() {
  const filter = process.argv[2];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const page of PAGES) {
    if (filter && !page.name.includes(filter)) continue;
    for (const locale of locales) {
      const lang = locale.code;
      const html = path.join(tmp, `${page.name}-${lang}.html`);
      const png = path.join(OUT_DIR, `${page.name}-${lang}.png`);
      fs.writeFileSync(html, renderHtml(cardFor(page, locale), lang));
      // virtual-time-budget holds the screenshot until the webfonts are in.
      execFileSync(
        CHROME,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          '--window-size=1200,630',
          '--virtual-time-budget=8000',
          `--screenshot=${png}`,
          `file://${html}`,
        ],
        { stdio: 'ignore' }
      );
      console.log(path.relative(ROOT, png));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main();
