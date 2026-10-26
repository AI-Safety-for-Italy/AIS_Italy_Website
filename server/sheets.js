// Reads Google Sheets, read-only, as the service account the sheets are shared
// with (the same account scripts/update-members.py signs in as).
//
// Why a module of its own: the CRM keeps its personal data in the sheets the
// forms write to, and never copies it into the database. This is the only
// code that touches them, so the guarantees live here:
//   - the scope is fixed to spreadsheets.readonly: this file cannot write;
//   - the sheet id and tab are validated before they go into a URL;
//   - what is read is cached in memory for a couple of minutes, never on disk
//     or in the database;
//   - errors say what to fix, never echo the key or the sheet's contents.
//
// Env: GOOGLE_SERVICE_ACCOUNT_JSON, the key file's contents (a GitHub secret
// for the members script; add it to Vercel for this). Locally,
// CRM_SHEETS_FAKE=1 (set by scripts/meet-dev.js) reads server/crm/fixtures/
// instead, so development never needs the key or real data.

const crypto = require('crypto');
const { HttpError } = require('./http');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
const CACHE_MS = 2 * 60 * 1000;

let fetchImpl = (...args) => fetch(...args);
let now = () => Date.now();
let token = null; // { value, expires }
const cache = new Map(); // `${id}\n${tab}` -> { at, rows }

/** For the tests: the network and the clock. */
function setForTests({ fetch: f, clock } = {}) {
  fetchImpl = f || ((...args) => fetch(...args));
  now = clock || (() => Date.now());
  token = null;
  cache.clear();
}

function clearCache() {
  cache.clear();
}

function credentials() {
  let key;
  try {
    key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw new HttpError(503, 'Google Sheets is not set up here (GOOGLE_SERVICE_ACCOUNT_JSON)');
  }
  if (!key || !key.client_email || !key.private_key) {
    throw new HttpError(503, 'The Google service account key is incomplete');
  }
  return key;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function accessToken() {
  if (token && token.expires - 60_000 > now()) return token.value;
  const key = credentials();
  const issued = Math.floor(now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claims)
  )}`;
  let assertion;
  try {
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
    assertion = `${unsigned}.${signature.toString('base64url')}`;
  } catch {
    throw new HttpError(503, 'The Google service account key cannot sign');
  }
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Google');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error('Google sign-in failed', res.status);
    throw new HttpError(502, 'Google refused the service account sign-in');
  }
  token = { value: body.access_token, expires: now() + (Number(body.expires_in) || 3600) * 1000 };
  return token.value;
}

/** The API's list of rows as header → value objects. Short rows are padded. */
function rowsFromValues(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const header = values[0].map((h) => String(h || '').trim());
  return values.slice(1).map((row) => {
    const out = {};
    header.forEach((name, i) => {
      if (name) out[name] = (i < row.length ? String(row[i]) : '').trim();
    });
    return out;
  });
}

async function fromGoogle({ spreadsheetId, tab }) {
  const bearer = await accessToken();
  const url = `${API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(
    tab
  )}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${bearer}` } });
  } catch {
    throw new HttpError(502, 'Could not reach the Sheets API');
  }
  if (res.status === 403) {
    throw new HttpError(
      502,
      'The sheet is not shared with the service account (Viewer), or the Sheets API is off in its project'
    );
  }
  if (res.status === 404 || res.status === 400) {
    throw new HttpError(502, 'No such sheet or tab: check its id and the tab name in the settings');
  }
  if (!res.ok) {
    console.error('Sheets API answered', res.status);
    throw new HttpError(502, 'The Sheets API did not answer');
  }
  const body = await res.json().catch(() => ({}));
  return body.values || [];
}

/**
 * The rows of one tab: [{ header: value }]. `ref` is { source, spreadsheetId,
 * tab }; `source` only names the fixture in fake mode.
 */
async function readRows(ref) {
  const { source, spreadsheetId, tab } = ref;
  if (process.env.CRM_SHEETS_FAKE === '1') {
    // Invented data must never stand in for the real sheets on the live site.
    if (process.env.VERCEL_ENV === 'production') {
      throw new HttpError(500, 'CRM_SHEETS_FAKE must not be set in production');
    }
    return rowsFromValues(require('./crm/fixtures').values(source));
  }
  if (!SHEET_ID.test(String(spreadsheetId || ''))) throw new HttpError(400, 'Invalid sheet id');
  if (!tab || String(tab).length > 100 || /[\u0000-\u001f]/.test(tab)) {
    throw new HttpError(400, 'Invalid tab name');
  }
  const cacheKey = `${spreadsheetId}\n${tab}`;
  const hit = cache.get(cacheKey);
  if (hit && now() - hit.at < CACHE_MS) return hit.rows;
  const rows = rowsFromValues(await fromGoogle({ spreadsheetId, tab }));
  cache.set(cacheKey, { at: now(), rows });
  return rows;
}

module.exports = { SCOPE, SHEET_ID, rowsFromValues, readRows, clearCache, setForTests };
