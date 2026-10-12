#!/usr/bin/env node
// One-off: lets the AIS Google account authorise the meeting-poll tool to
// create Calendar events, and prints the GOOGLE_REFRESH_TOKEN to store on
// Vercel.
//
//   node scripts/meet-google-auth.js ~/Downloads/client_secret_….json
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/meet-google-auth.js
//
// The JSON is the file Google Cloud offers to download when the OAuth client is
// created. Either way, the three values to put on Vercel are printed at the end.
//
// The OAuth client must be of type "Desktop app". It opens a consent page;
// sign in as the AIS account (not your personal one) and allow access. The
// OAuth consent screen must be "In production", otherwise Google expires the
// token after 7 days.
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;

if (process.argv[2]) {
  const file = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const client = file.installed || file.web || file;
  clientId = client.client_id;
  clientSecret = client.client_secret;
}

if (!clientId || !clientSecret) {
  console.error(
    'Pass the downloaded client JSON (node scripts/meet-google-auth.js file.json),\n' +
      'or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
  );
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.end();
  if (url.searchParams.get('state') !== state) {
    res.end('State mismatch, try again.');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.end(`Authorisation failed: ${url.searchParams.get('error')}`);
    server.close();
    return;
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = await tokenRes.json();
  if (!body.refresh_token) {
    res.end('No refresh token returned; see the terminal.');
    console.error(body);
  } else {
    res.end('Done. You can close this tab and go back to the terminal.');
    console.log('\nAdd these three to Vercel (Production and Preview):\n');
    console.log(`GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`);
  }
  server.close();
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      // Forces a refresh token even if this client was authorised before.
      prompt: 'consent',
      state,
    });
  console.log(`Open this URL and sign in as the AIS Google account:\n\n${authUrl}\n`);
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl], () => {});
});
