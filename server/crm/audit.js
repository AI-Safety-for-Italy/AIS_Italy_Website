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
  'unpublish',
  'export',
  'read-sheet',
  'change-settings',
  // The board's records (server/crm/records.js): detail has counts, never who.
  'crm-import',
  'crm-add',
  'crm-remove',
  'site-draft',
  'denied',
  // Forms (server/forms/): subject_key is the form or response id.
  'form-create',
  'form-notify-me',
  'community-list',
  'community-member',
  'community-tags',
  'community-groups',
  'community-import',
  // Linking members to Discord and checking their roles against their tags.
  'community-discord',
  // The local groups (server/local-groups.js): subject_key is the group's id.
  'local-groups-list',
  'local-groups-edit',
  'local-groups-site',
  'form-tags',
  'form-edit',
  'form-settings',
  'form-delete',
  'form-view-responses',
  'form-view-response',
  'form-review',
  'form-status',
  'form-export',
  'form-sync',
  'form-delete-response',
  // Member applications (server/members.js): subject_key is the application id.
  'member-list',
  'member-decide',
  'member-resend',
  // The daily deletion of what is past its keeping time (server/retention.js).
  'retention-cleanup',
  // The mentee selection (server/crm/review.js): subject_key is the person
  // key; detail says which part and that it was scored, never the scores.
  'review-list',
  'review-score',
  'review-summary',
  'review-settings',
  'review-reviewers',
  // Who may do what (server/permissions.js): detail lists the keys changed.
  'permissions-change',
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

/**
 * A member's history on the members board, newest first: the lines about
 * them (subject_key one of `subjects`: their id, their applications' ids),
 * and those of changes to several people at once that named them
 * (detail.members). Views left out.
 */
async function forMember(memberId, subjects = [], { limit = 100 } = {}) {
  const { rows } = await db.query(
    `select id, at, user_name, action, subject_key, detail from crm_audit
     where (subject_key = any($1::text[])
            or (jsonb_typeof(detail->'members') = 'array'
                and jsonb_exists(detail->'members', $2)))
       and coalesce(detail->>'action', '') <> 'view'
     order by id desc limit $3`,
    [[memberId, ...subjects], memberId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    userName: r.user_name,
    action: r.action,
    detail: r.detail,
  }));
}

module.exports = { ACTIONS, record, recent, forMember };
