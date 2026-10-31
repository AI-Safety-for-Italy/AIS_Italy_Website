// The people on the mentorship board, kept in the database (crm_records).
//
// Each row is one answer, in the shape server/crm/sources.js gives a sheet's
// row ({ key, row, ...fields }), encrypted and bound to the row's id, so the
// board (server/crm/mentorship.js) reads them all the same way. They come
// from three places:
//   'import'  copied once from a Google sheet (importSource), replacing the
//             previous copy of that source;
//   'form'    an answer to a form linked to the board (server/forms/), written
//             with the answer and deleted with it;
//   'board'   added by hand on the board (the mentors to contact).

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../http');
const crm = require('./crypto');
const audit = require('./audit');
const sources = require('./sources');

const ORIGINS = ['import', 'form', 'board'];

function context(id) {
  return `crm-record:${id}`;
}

async function insert(q, sourceId, record, { origin, responseId = null, user = null }) {
  const id = crypto.randomUUID();
  await q.query(
    `insert into crm_records (id, source, person_key, origin, response_id, data_encrypted, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      sourceId,
      record.key,
      origin,
      responseId,
      crm.encrypt(JSON.stringify(record), context(id)),
      user && user.kind !== 'admin' ? user.id : null,
    ]
  );
  return id;
}

/**
 * Every record on the board: { bySource: { sourceId: [record] }, unreadable }.
 * Each record also carries `recordId` and `origin`. `unreadable` counts the
 * rows the current key cannot open.
 */
async function list() {
  const { rows } = await db.query(
    'select id, source, origin, data_encrypted from crm_records order by created_at, id'
  );
  const bySource = {};
  let unreadable = 0;
  for (const r of rows) {
    const text = crm.decrypt(r.data_encrypted, context(r.id));
    let record = null;
    try {
      record = text === null ? null : JSON.parse(text);
    } catch {
      record = null;
    }
    if (!record || !sources.SOURCES[r.source]) {
      unreadable++;
      continue;
    }
    (bySource[r.source] = bySource[r.source] || []).push({
      ...record,
      recordId: r.id,
      origin: r.origin,
    });
  }
  return { bySource, unreadable };
}

/**
 * Adds one person from `fields` (field name -> text, as in sources.SOURCES).
 * `q`: the caller's transaction, so a form's answer and its record are kept
 * together or not at all. Returns the record id, or null for an empty one.
 */
async function add(sourceId, fields, { origin, responseId = null, user = null, q = db } = {}) {
  if (!sources.SOURCES[sourceId]) throw new HttpError(400, 'Unknown list');
  if (!ORIGINS.includes(origin)) throw new Error(`Unknown origin: ${origin}`);
  const record = sources.toRecord(sourceId, fields || {});
  if (!record) return null;
  return insert(q, sourceId, record, { origin, responseId, user });
}

/**
 * Copies a sheet onto the board once: reads it as sources.load() does and
 * replaces the previous copy of that source, so a second import fixes the
 * first instead of doubling it. Returns { imported, withoutEmail, missing }.
 */
async function importSource(user, sourceId) {
  const loaded = await sources.load(sourceId);
  await db.transaction(async (tx) => {
    await tx.query(`delete from crm_records where source = $1 and origin = 'import'`, [sourceId]);
    for (const record of loaded.records) {
      await insert(tx, sourceId, record, { origin: 'import', user });
    }
    await audit.record(
      user,
      'crm-import',
      null,
      { source: sourceId, rows: loaded.records.length, withoutEmail: loaded.withoutEmail },
      tx
    );
  });
  return {
    imported: loaded.records.length,
    withoutEmail: loaded.withoutEmail,
    missing: loaded.missing,
  };
}

/** Removes a person added by hand (only those: the others have their own source). */
async function remove(user, recordId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(recordId || ''))) throw new HttpError(400, 'Invalid record');
  const { rows } = await db.query(
    `delete from crm_records where id = $1 and origin = 'board' returning source, person_key`,
    [recordId]
  );
  if (!rows.length) throw new HttpError(404, 'Only people added on the board can be removed here');
  await audit.record(user, 'crm-remove', rows[0].person_key, { source: rows[0].source });
}

module.exports = { ORIGINS, list, add, importSource, remove };
