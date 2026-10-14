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
//   - Discord sign-in: a stand-in that signs in under any name (set the
//     DISCORD_* vars to use a real Discord app)
//   - email: printed in this terminal instead of sent (MEET_FAKE_MAIL=0 to
//     use the SMTP settings saved on /app/polls/settings/)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Local credentials (e.g. a real Discord app to sign in with) can go in
// .env.local, which git ignores. Values already in the environment win.
if (fs.existsSync(path.join(ROOT, '.env.local')))
  process.loadEnvFile(path.join(ROOT, '.env.local'));
const SITE = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT) || 8080;

process.env.MEET_INSECURE_COOKIES = '1';
process.env.SESSION_SECRET ||= 'local-development-secret-not-for-production';
if (!process.env.ADMIN_PASSWORD_HASH) {
  process.env.ADMIN_PASSWORD_HASH = require('../server/auth').hashPassword('admin');
}
// Without a Discord app to sign in with, offer a stand-in on the login page.
if (!process.env.DISCORD_CLIENT_ID) process.env.MEET_DEV_LOGIN ||= '1';
// Emails are printed here instead of sent, unless MEET_FAKE_MAIL=0.
process.env.MEET_FAKE_MAIL ||= '1';

const db = require('../server/db');
if (!process.env.MEET_DATABASE_URL && !process.env.DATABASE_URL) {
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
    console.log(`Personal area running at http://localhost:${PORT}/app/`);
    console.log(
      process.env.MEET_DATABASE_URL || process.env.DATABASE_URL
        ? 'Database: Postgres from the environment'
        : 'Database: PGlite in .meet-dev-db/'
    );
    console.log(
      process.env.MEET_DEV_LOGIN === '1'
        ? 'Sign-in: local stand-in for Discord (any name), or password "admin"'
        : 'Sign-in: Discord, or the admin password'
    );
  });
});
