// Member applications: the registration form's submissions, approved or
// rejected on the board (/app/members/) by those whose Discord roles hold the
// `members` permission (server/permissions.js).
//
// Approving sends the person a personal link (/api/join?t=…). Following it
// signs them in with Discord (scope guilds.join), and the bot adds them to the
// server with the role chosen on the board. So the board knows who actually
// joined, by their Discord account rather than their nickname.
//
// The form itself is not here: whatever builds and publishes the forms hands
// each submission of the registration form to createApplication().
//
// Env, besides the Discord sign-in and bot settings /app/ already uses:
//   DISCORD_ROLE_PARTICIPANT, DISCORD_ROLE_ORGANIZER   the role ids to give

const crypto = require('crypto');
const db = require('./db');
const { isEmail } = require('./email');
const mail = require('./mail');
const permissions = require('./permissions');
const discord = require('./discord');
const crm = require('./crm/crypto');
const access = require('./crm/access');
const audit = require('./crm/audit');
const { HttpError } = require('./http');

const ROLES = [
  {
    key: 'participant',
    label: 'Participant',
    labelIt: 'Partecipante',
    env: 'DISCORD_ROLE_PARTICIPANT',
    dev: 'dev-partecipanti',
  },
  {
    key: 'organizer',
    label: 'Organizer',
    labelIt: 'Organizzatore',
    env: 'DISCORD_ROLE_ORGANIZER',
    dev: 'dev-organizzatori',
  },
];
const JOIN_DAYS = 30;
// What a submission may hold: at least as much as a form lets through
// (server/forms/schema.js: 300-character short answers, so a name and a
// surname; 254-character emails; 150 questions; 8000-character texts, and
// choices of up to 60 options of 200 characters).
const LIMITS = { name: 700, email: 254, answers: 200, label: 500, value: 20000 };

function devMode() {
  return permissions.devLogin() && !permissions.botConfigured();
}

function roleId(key) {
  const role = ROLES.find((r) => r.key === key);
  if (!role) return null;
  return devMode() ? role.dev : String(process.env[role.env] || '').trim() || null;
}

/** The roles the board can give: [{ key, label, ready }] (ready: id set). */
function boardRoles() {
  return ROLES.map((r) => ({ key: r.key, label: r.label, ready: Boolean(roleId(r.key)) }));
}

function text(value, label, max, required) {
  const s = String(value == null ? '' : value).trim();
  if (required && !s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s;
}

/**
 * Stores one submission of the registration form. `fields`:
 *   name, email          required
 *   requestedRole        'participant' | 'organizer' (optional)
 *   answers              [{ label, value }]: every question and answer, as
 *                        the board should show them (value: text or list)
 * `source` names the form it came from. Returns { id }.
 */
async function createApplication(fields, { source, q = db } = {}) {
  // Without the keys the details could not be stored protected: take none.
  if (!crm.configured()) throw new HttpError(503, 'Applications are not available right now');
  const f = fields || {};
  const name = text(f.name, 'Name', LIMITS.name, true);
  const email = text(f.email, 'Email', LIMITS.email, true).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const requestedRole = f.requestedRole || null;
  if (requestedRole && !ROLES.some((r) => r.key === requestedRole)) {
    throw new HttpError(400, 'Unknown role');
  }
  const list = f.answers == null ? [] : f.answers;
  if (!Array.isArray(list) || list.length > LIMITS.answers)
    throw new HttpError(400, 'Invalid answers');
  const answers = list.map((a) => ({
    label: text(a && a.label, 'Question', LIMITS.label, true),
    value: text(
      Array.isArray(a.value) ? a.value.join(', ') : a.value,
      'Answer',
      LIMITS.value,
      false
    ),
  }));
  const id = crypto.randomUUID();
  // `q`: the caller's transaction, so the form's answer and the application
  // are kept together or not at all.
  await q.query(
    `insert into member_applications (id, requested_role, source, details_encrypted, email_key)
     values ($1, $2, $3, $4, $5)`,
    [
      id,
      requestedRole,
      source ? String(source).slice(0, 100) : null,
      crm.encrypt(JSON.stringify({ name, email, answers }), context(id)),
      crm.personKey(email),
    ]
  );
  return { id };
}

function context(id) {
  return `member:${id}`;
}

/** Who applied: { name, email, answers }, or null when it cannot be opened. */
function details(row) {
  const text = row.details_encrypted ? crm.decrypt(row.details_encrypted, context(row.id)) : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summary(r) {
  const d = details(r) || {
    name: '(cannot be opened with the current key)',
    email: '',
    answers: [],
  };
  return {
    id: r.id,
    name: d.name,
    email: d.email,
    requestedRole: r.requested_role,
    answers: d.answers,
    source: r.source,
    status: r.status,
    role: r.role,
    note: r.note,
    decidedBy: r.decided_by_name || null,
    decidedAt: r.decided_at,
    inviteSentAt: r.invite_sent_at,
    inviteError: r.invite_error,
    joinExpiresAt: r.join_expires_at,
    discordName: r.discord_name,
    joinedAt: r.joined_at,
    joinError: r.join_error,
    // false: joined with a Discord account whose email is not the application's.
    joinEmailMatch: r.join_email_match,
    createdAt: r.created_at,
    // Same email on another application, e.g. someone who registered twice.
    duplicates: Number(r.duplicates || 0),
  };
}

const SELECT = `
  select a.*, u.name as decided_by_name,
    (select count(*) from member_applications b
      where b.email_key = a.email_key and b.id <> a.id) as duplicates
  from member_applications a
  left join app_users u on u.id = a.decided_by`;

async function listApplications(user) {
  await access.requirePermission(user, 'members');
  const { rows } = await db.query(`${SELECT} order by a.created_at desc`);
  await audit.record(user, 'member-list', null, { count: rows.length });
  return {
    applications: rows.map(summary),
    roles: boardRoles(),
    mailReady: await mail.isConfigured(),
  };
}

async function loadRow(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new HttpError(404, 'Not found');
  const { rows } = await db.query(`${SELECT} where a.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return rows[0];
}

function firstName(name) {
  return String(name).split(/\s+/)[0];
}

/** Emails the join link; records the outcome. Returns { sent, detail }. */
async function sendInvite(row, siteOrigin, token) {
  const who = details(row);
  if (!who) return { sent: false, detail: 'The application cannot be opened with the current key' };
  const role = ROLES.find((r) => r.key === row.role);
  const link = `${siteOrigin}/api/join?t=${token}`;
  const until = new Date(row.join_expires_at).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Rome',
  });
  try {
    await mail.send({
      to: who.email,
      subject: 'Benvenuto/a in AI Safety for Italy: entra su Discord',
      text:
        `Ciao ${firstName(who.name)},\n\n` +
        'la tua richiesta di entrare nella community di AI Safety for Italy è stata accettata: benvenuto/a!\n\n' +
        'Per entrare nel nostro server Discord apri questo link. Ti chiederà di accedere con Discord ' +
        `(se non hai un account puoi crearlo lì) e ti aggiungerà al server come ${role.labelIt}.\n\n` +
        `${link}\n\n` +
        `Il link è personale, vale una volta sola e scade il ${until}.\n\n` +
        'A presto,\nil team di AI Safety for Italy\n',
    });
    await db.query(
      'update member_applications set invite_sent_at = now(), invite_error = null where id = $1',
      [row.id]
    );
    return { sent: true };
  } catch (err) {
    await db.query('update member_applications set invite_error = $2 where id = $1', [
      row.id,
      err.message.slice(0, 300),
    ]);
    return { sent: false, detail: err.message };
  }
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** What the database keeps of a join token: its SHA-256, never the token. */
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

/**
 * Approves (`decision: 'approve'`, with `role`) or rejects a pending
 * application. Approving emails the join link. Returns { application, invite }.
 */
async function decide(user, id, body, { siteOrigin }) {
  await access.requirePermission(user, 'members', { fresh: true });
  const b = body || {};
  const note = text(b.note, 'Note', 2000, false);
  await loadRow(id);
  let updated;
  const token = newToken();
  if (b.decision === 'approve') {
    if (!ROLES.some((r) => r.key === b.role)) throw new HttpError(400, 'Choose a role');
    if (!roleId(b.role))
      throw new HttpError(503, `The Discord id of the ${b.role} role is not set`);
    // The status check is in the update itself: a double click sends one
    // email. A rejection can still be turned into an approval.
    updated = await db.query(
      `update member_applications set status = 'approved', role = $2, note = $3,
         decided_by = $4, decided_at = now(), join_token = $5,
         join_expires_at = now() + make_interval(days => $6)
       where id = $1 and status in ('pending', 'rejected') returning *`,
      [id, b.role, note, user.id, tokenHash(token), JOIN_DAYS]
    );
  } else if (b.decision === 'reject') {
    updated = await db.query(
      `update member_applications set status = 'rejected', note = $2,
         decided_by = $3, decided_at = now()
       where id = $1 and status = 'pending' returning *`,
      [id, note, user.id]
    );
  } else {
    throw new HttpError(400, 'Approve or reject?');
  }
  if (!updated.rows.length) throw new HttpError(409, 'Someone already decided on this application');
  // What was decided, never what the person or the note says.
  await audit.record(user, 'member-decide', id, {
    decision: b.decision,
    role: b.decision === 'approve' ? b.role : undefined,
  });
  const invite =
    b.decision === 'approve' ? await sendInvite(updated.rows[0], siteOrigin, token) : undefined;
  return { application: summary(await loadRow(id)), invite };
}

/** A fresh link for an approved person who has not joined yet. */
async function resendInvite(user, id, { siteOrigin }) {
  await access.requirePermission(user, 'members', { fresh: true });
  await loadRow(id);
  const token = newToken();
  const { rows } = await db.query(
    `update member_applications set join_token = $2,
       join_expires_at = now() + make_interval(days => $3), join_error = null
     where id = $1 and status = 'approved' and joined_at is null returning *`,
    [id, tokenHash(token), JOIN_DAYS]
  );
  if (!rows.length) throw new HttpError(409, 'Only approved people who have not joined yet');
  await audit.record(user, 'member-resend', id);
  const invite = await sendInvite(rows[0], siteOrigin, token);
  return { application: summary(await loadRow(id)), invite };
}

class JoinError extends Error {
  /** `code` is shown on /join/: invalid, expired, used, failed. */
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

/** The approved application a join link belongs to; throws JoinError. */
async function checkJoinToken(token) {
  if (!/^[\w-]{20,64}$/.test(String(token || ''))) throw new JoinError('invalid');
  const { rows } = await db.query('select * from member_applications where join_token = $1', [
    tokenHash(token),
  ]);
  const row = rows[0];
  if (!row || row.status !== 'approved') throw new JoinError('invalid');
  if (row.joined_at) throw new JoinError('used');
  if (new Date(row.join_expires_at) < new Date()) throw new JoinError('expired');
  return row;
}

/**
 * Takes the link for this join, in one statement: of two clicks at the same
 * moment, one wins and the other is told the link was used. Released again
 * if joining then fails, so the person can retry.
 */
async function claim(row) {
  const { rows } = await db.query(
    `update member_applications set joined_at = now(), join_error = null
     where id = $1 and status = 'approved' and joined_at is null and join_expires_at > now()
     returning *`,
    [row.id]
  );
  if (!rows.length) throw new JoinError('used');
  return rows[0];
}

async function release(row, error) {
  await db.query('update member_applications set joined_at = null, join_error = $2 where id = $1', [
    row.id,
    String(error).slice(0, 300),
  ]);
}

async function markJoined(row, discordId, discordName, emailMatch) {
  await db.query(
    // The token stays, so opening the link again says "already used".
    `update member_applications set discord_id = $2, discord_name = $3, join_email_match = $4,
       join_error = null
     where id = $1`,
    [row.id, discordId, discordName, emailMatch]
  );
}

/** Does the Discord account's verified email match the application's? null: unknown. */
function sameEmail(row, discordUser) {
  const who = details(row);
  if (!who || !discordUser.email || discordUser.verified === false) return null;
  return String(discordUser.email).trim().toLowerCase() === String(who.email).toLowerCase();
}

/**
 * The second half of the join link: Discord sent back `code`. Adds the person
 * to the server with their role (or gives them the role if already in), and
 * links the application to their Discord account.
 */
async function completeJoin(token, { code, redirectUri }, fetchImpl) {
  const row = await claim(await checkJoinToken(token));
  let accessToken;
  let user;
  try {
    ({ accessToken, user } = await discord.exchange({ code, redirectUri }, fetchImpl));
  } catch (err) {
    await release(row, err.message);
    throw err;
  }
  const guild = process.env.DISCORD_GUILD_ID;
  const role = roleId(row.role);
  try {
    // 201: added with the role. 204: was already in, and the role is not
    // applied that way, hence the second call (harmless after a 201).
    const add = await permissions.bot(`/guilds/${guild}/members/${user.id}`, {
      method: 'PUT',
      json: { access_token: accessToken, roles: [role] },
    });
    if (!add.ok) throw new Error(`Adding to the server failed (${add.status})`);
    const give = await permissions.bot(`/guilds/${guild}/members/${user.id}/roles/${role}`, {
      method: 'PUT',
    });
    if (!give.ok) throw new Error(`Giving the role failed (${give.status})`);
  } catch (err) {
    await release(row, err.message);
    throw new JoinError('failed', err.message);
  }
  await markJoined(row, user.id, user.global_name || user.username, sameEmail(row, user));
}

/** Local development, without Discord: the link joins at once. */
async function completeJoinDev(token) {
  const row = await claim(await checkJoinToken(token));
  await markJoined(row, `dev-${row.id.slice(0, 8)}`, (details(row) || {}).name || 'Dev', null);
}

module.exports = {
  ROLES,
  JoinError,
  boardRoles,
  createApplication,
  listApplications,
  decide,
  resendInvite,
  checkJoinToken,
  completeJoin,
  completeJoinDev,
  devMode,
};
