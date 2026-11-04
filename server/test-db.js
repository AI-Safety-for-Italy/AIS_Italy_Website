// A fresh database for each test, fast. Starting PGlite and applying
// schema.js takes a second or more; a clone of a database that already has
// the schema takes a fraction of that. So the schema is applied once per test
// file (each runs in its own process) and every test gets a clone of it.
// Tests of the schema itself (upgrades, migrations) still start their own
// `new PGlite()`.
const { after } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const db = require('./db');

let base = null;
let current = null;

// Left open, the template and the last clone keep the test file's process
// alive, and the runner waits for it to exit.
after(async () => {
  if (current) await current.close().catch(() => {});
  if (base) await (await base).close().catch(() => {});
});

/** A new database with the schema, set as the one server/db.js uses. */
async function fresh() {
  if (!base) {
    base = (async () => {
      const pg = new PGlite();
      db.setDb(pg);
      await db.ensureSchema();
      return pg;
    })();
  }
  const template = await base;
  // The previous test's clone is done with: its memory back.
  if (current) current.close().catch(() => {});
  current = await template.clone();
  db.setDb(current);
  return current;
}

module.exports = { fresh };
