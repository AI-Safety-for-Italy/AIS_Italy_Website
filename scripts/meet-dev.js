#!/usr/bin/env node
// Local server for the meeting-poll tool: serves the built site from _site/
// and runs the functions in api/ the way Vercel would, so the admin panel and
// the poll pages can be tried without a Vercel login or a cloud database.
//
//   npm run dev:meet        (builds and watches the site too)
//
// Defaults, all overridable from the environment:
//   - database: PGlite stored in .meet-dev-db/ (DATABASE_URL to use Postgres)
//   - admin password: "admin"
//   - Google Calendar: a fake that only logs (set the GOOGLE_* vars for real)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT) || 8080;

process.env.MEET_INSECURE_COOKIES = '1';
process.env.SESSION_SECRET ||= 'local-development-secret-not-for-production';
if (!process.env.ADMIN_PASSWORD_HASH) {
  process.env.ADMIN_PASSWORD_HASH = require('../server/auth').hashPassword('admin');
}
if (!process.env.GOOGLE_REFRESH_TOKEN) process.env.MEET_FAKE_CALENDAR ||= '1';

const db = require('../server/db');
if (!process.env.DATABASE_URL) {
  const { PGlite } = require('@electric-sql/pglite');
  db.setDb(new PGlite(path.join(ROOT, '.meet-dev-db')));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = path.join(SITE, decodeURIComponent(pathname));
  if (!file.startsWith(SITE)) {
    res.statusCode = 403;
    return res.end();
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    file = path.join(SITE, '404.html');
    if (!fs.existsSync(file)) return res.end('Not found (has the site been built?)');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    const file = path.join(ROOT, `${pathname.replace(/\/$/, '')}.js`);
    if (!file.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    return require(file)(req, res);
  }
  serveStatic(req, res);
});

db.ensureSchema().then(() => {
  server.listen(PORT, () => {
    console.log(`Meeting polls running at http://localhost:${PORT}/admin/`);
    console.log(
      process.env.DATABASE_URL ? 'Database: DATABASE_URL' : 'Database: PGlite in .meet-dev-db/'
    );
    console.log(
      process.env.MEET_FAKE_CALENDAR === '1'
        ? 'Calendar: fake (events are only logged here)'
        : 'Calendar: Google'
    );
  });
});
