// Database access for the meeting-poll API.
//
// Production talks to Neon Postgres through `pg`, using the DATABASE_URL that
// the Vercel/Neon integration sets. Local development and the tests use PGlite
// (Postgres compiled to WASM, running in-process) so nothing has to be
// installed: scripts/meet-dev.js and the tests hand one in with setDb().
//
// Both expose `query(text, params) -> { rows }`, which is all the rest of the
// server code relies on.

const SCHEMA = require('./schema');

let db = null;
let schemaReady = null;

function setDb(instance) {
  db = instance;
  schemaReady = null;
}

function getDb() {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { Pool } = require('pg');
  // A serverless instance handles one request at a time, so a couple of
  // connections is plenty; Neon's pooler absorbs the churn between instances.
  db = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10_000 });
  return db;
}

// The schema is idempotent DDL, applied once per process on first use, so a
// fresh database needs no separate migration step.
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const conn = getDb();
      // PGlite runs a multi-statement string through exec(); pg's simple query
      // protocol accepts one in query() as long as there are no parameters.
      if (typeof conn.exec === 'function') await conn.exec(SCHEMA);
      else await conn.query(SCHEMA);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function query(text, params = []) {
  await ensureSchema();
  return getDb().query(text, params);
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

module.exports = { query, transaction, setDb, ensureSchema };
