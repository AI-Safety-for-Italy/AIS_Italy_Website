// Small request/response helpers shared by the functions in api/.
//
// They use only Node's own http objects, so the same handlers run on Vercel
// and under scripts/meet-dev.js without either one's helpers.

class HttpError extends Error {
  /** `details` (e.g. { field, code }) is sent alongside the message. */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const MAX_BODY = 100_000;

/** The JSON body. `max`: a larger limit for the few calls that carry a file. */
async function readJson(req, { max = MAX_BODY } = {}) {
  // Vercel may already have buffered and parsed the body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return parseJson(String(req.body));
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw new HttpError(413, 'Request too large');
  }
  return parseJson(raw);
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** The site's own origin as the visitor reached it, e.g. https://www.ais4i.it */
function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto =
    req.headers['x-forwarded-proto'] ||
    (process.env.MEET_INSECURE_COOKIES === '1' ? 'http' : 'https');
  return `${String(proto).split(',')[0]}://${host}`;
}

/**
 * The site's address for links in emails and messages: SITE_URL when set
 * (production: https://www.ais4i.it), else the origin of the request (the
 * previews and a local machine). Not for OAuth redirect URIs, which must be
 * the host the browser is really on: those use origin().
 */
function siteUrl(req) {
  const fixed = String(process.env.SITE_URL || '').trim();
  return fixed ? fixed.replace(/\/+$/, '') : origin(req);
}

function getQuery(req) {
  return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Wraps a { GET, POST, ... } map into a handler that dispatches on the method,
 * turns HttpErrors into JSON responses and hides anything unexpected.
 */
function route(methods) {
  return async (req, res) => {
    try {
      const handler = methods[req.method];
      if (!handler) {
        res.setHeader('Allow', Object.keys(methods).join(', '));
        throw new HttpError(405, 'Method not allowed');
      }
      // A JSON content type cannot be sent cross-site without a CORS
      // preflight, which nothing here answers. Together with the SameSite
      // session cookie this keeps other sites from posting on an admin's
      // behalf.
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const type = req.headers['content-type'] || '';
        if (!type.startsWith('application/json')) {
          throw new HttpError(415, 'Expected application/json');
        }
      }
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...err.details });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Something went wrong' });
      }
    }
  };
}

module.exports = {
  HttpError,
  sendJson,
  readJson,
  redirect,
  origin,
  siteUrl,
  getQuery,
  getCookie,
  clientIp,
  route,
};
