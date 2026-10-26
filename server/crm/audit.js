// The CRM's audit trail: who looked at or changed which record, when.
// Append-only (see crm_audit in schema.js): this module only inserts and reads.
// `subjectKey` is an opaque person key, never an email, and `detail` must not
// hold personal data either: say what was done ("status: contacted →
// replied"), not what the person wrote.

const db = require('../db');

const ACTIONS = new Set([
  'view-list',
  'view-person',
  'set-status',
  'add-note',
  'view-note',
  'set-match',
  'publish',
  'export',
  'read-sheet',
  'change-settings',
  'denied',
]);

/**
 * Writes one line. A failure to write must never be silently ignored: the
 * caller awaits it, and when the audit cannot be written the request fails
 * (nobody sees personal data without a trace).
 */
async function record(user, action, subjectKey = null, detail = null, q = db) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown audit action: ${action}`);
  await q.query(
    `insert into crm_audit (user_id, user_name, action, subject_key, detail)
     values ($1, $2, $3, $4, $5)`,
    [user.id || null, user.name || 'unknown', action, subjectKey, detail]
  );
}

/** The latest lines, newest first, optionally for one person key. */
async function recent({ subjectKey = null, limit = 50 } = {}) {
  const { rows } = await db.query(
    `select id, at, user_name, action, subject_key, detail from crm_audit
     where ($1::text is null or subject_key = $1)
     order by id desc limit $2`,
    [subjectKey, Math.min(Math.max(Number(limit) || 50, 1), 500)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    userName: r.user_name,
    action: r.action,
    subjectKey: r.subject_key,
    detail: r.detail,
  }));
}

module.exports = { ACTIONS, record, recent };
