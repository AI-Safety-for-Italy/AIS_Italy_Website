// Database access for the meeting-poll API.
//
// Production talks to Neon Postgres through `pg`, using the DATABASE_URL that
// the Vercel/Neon integration sets. Local development and the tests use PGlite
// (Postgres compiled to WASM, running in-process) so nothing has to be
// installed: scripts/meet-dev.js and the tests hand one in with setDb().
//
// Both expose `query(text, params) -> { rows }`, which is all the rest of the
// server code relies on.

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const SCHEMA = require('./schema');

// Which version of schema.js the database already has: running ~70 DDL
// statements (some take table locks) on every cold start made the first
// request of each instance slow, so they run only when schema.js changes.
const SCHEMA_VERSION = crypto.createHash('sha256').update(SCHEMA).digest('hex').slice(0, 16);

// Per-request counters for the Server-Timing header (server/timing.js).
const requestStats = new AsyncLocalStorage();

let db = null;
let schemaReady = null;

function setDb(instance) {
  db = instance;
  schemaReady = null;
}

function getDb() {
  if (db) return db;
  // MEET_DATABASE_URL wins when set: it points the preview deployments (dev)
  // at their own Neon branch, while the integration's DATABASE_URL stays the
  // production database.
  const url = process.env.MEET_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { Pool } = require('pg');
  // Connections stay open between clicks (a new one costs TCP, TLS and the
  // login: several round trips); a few, so Promise.all really runs in
  // parallel. Neon's pooler absorbs the connections of many instances.
  db = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 5 * 60_000 });
  return db;
}

/** The version of the schema the database has, or null (never applied). */
async function appliedVersion(conn) {
  try {
    const { rows } = await conn.query('select version from schema_version limit 1');
    return rows[0] ? rows[0].version : null;
  } catch {
    return null; // no schema_version table yet
  }
}

// The schema is idempotent DDL, so a fresh database needs no separate
// migration step. Each process checks the version first (one query) and runs
// the DDL only when schema.js has changed since it was last applied.
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const conn = getDb();
      if ((await appliedVersion(conn)) === SCHEMA_VERSION) return;
      // In the same batch as the DDL, so under its advisory lock.
      const batch = `${SCHEMA}
create table if not exists schema_version (version text not null);
delete from schema_version;
insert into schema_version (version) values ('${SCHEMA_VERSION}');`;
      // PGlite runs a multi-statement string through exec(); pg's simple query
      // protocol accepts one in query() as long as there are no parameters.
      if (typeof conn.exec === 'function') await conn.exec(batch);
      else await conn.query(batch);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function query(text, params = []) {
  await ensureSchema();
  const stats = requestStats.getStore();
  if (!stats) return getDb().query(text, params);
  const started = performance.now();
  try {
    return await getDb().query(text, params);
  } finally {
    stats.queries++;
    stats.dbMs += performance.now() - started;
  }
}

/**
 * Runs fn(tx) inside a transaction; tx has the same query() as the module.
 */
async function transaction(fn) {
  await ensureSchema();
  const conn = getDb();
  if (typeof conn.transaction === 'function') {
    // PGlite
    return conn.transaction((tx) => fn(tx));
  }
  const client = await conn.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, setDb, ensureSchema, requestStats, SCHEMA_VERSION };
