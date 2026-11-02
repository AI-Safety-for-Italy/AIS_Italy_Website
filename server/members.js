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
const access = require('./access');
const audit = require('./crm/audit');
const { HttpError } = require('./http');
const follows = require('./follows');
const community = require('./community');
const notify = require('./notify');

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
 *   tags                 [{ group, level }]: the working groups asked for,
 *                        which whoever approves can change (optional)
 *   profile, location, areas, publish   what the community directory takes
 *                        once the person is in (optional; server/community.js)
 * `source` names the form it came from. Returns { id }.
 */
async function createApplication(fields, { source, responseId = null, q = db } = {}) {
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
  const directory = {
    profile: /^https?:\/\//i.test(String(f.profile || ''))
      ? text(f.profile, 'Profile', 500, false)
      : '',
    location: text(f.location, 'Place', 200, false),
    areas: text(f.areas, 'Areas', 1000, false),
    publish: Boolean(f.publish),
  };
  // `q`: the caller's transaction, so the form's answer and the application
  // are kept together or not at all.
  await q.query(
    `insert into member_applications
       (id, requested_role, source, details_encrypted, email_key, response_id, tags, kind,
        discord_id, discord_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      requestedRole,
      source ? String(source).slice(0, 100) : null,
      crm.encrypt(JSON.stringify({ name, email, answers, ...directory }), context(id)),
      crm.personKey(email),
      responseId,
      JSON.stringify(cleanTagShape(f.tags)),
      f.kind === 'upgrade' ? 'upgrade' : 'join',
      f.discordId || null,
      f.discordName || null,
    ]
  );
  return { id };
}

function context(id) {
  return `member:${id}`;
}

/**
 * Tags in their shape only ([{ group, level }]), each group once and taking
 * part: who coordinates is chosen on Working groups. Which groups exist is
 * checked on deciding.
 */
function cleanTagShape(tags) {
  const seen = new Set();
  return (Array.isArray(tags) ? tags : [])
    .filter((t) => t && /^[\w-]{1,40}$/.test(String(t.group)) && community.LEVELS.includes(t.level))
    .filter((t) => !seen.has(String(t.group)) && seen.add(String(t.group)))
    .slice(0, 50)
    .map((t) => ({ group: String(t.group), level: 'stable' }));
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
    // The working groups: asked for on the form, then as decided.
    tags: r.tags || [],
    // 'join', or 'upgrade': a participant asking to become an organizer.
    kind: r.kind || 'join',
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
  await access.authorize(user, 'members');
  const { rows } = await db.query(`${SELECT} order by a.created_at desc`);
  await audit.record(user, 'member-list', null, { count: rows.length });
  return {
    applications: rows.map(summary),
    roles: boardRoles(),
    mailReady: await mail.isConfigured(),
    // The working groups, for the tags under the role (server/community.js).
    groups: (await community.listGroups()).map((g) => ({ id: g.id, title: g.titleEn })),
    following: user.kind === 'discord' ? await follows.isFollowing(user.id, 'members') : null,
  };
}

/** Follows the board (told about new applications, counted at home) or not. */
async function setFollowing(user, on) {
  await access.authorize(user, 'members');
  if (user.kind !== 'discord')
    throw new HttpError(400, 'This account has no channel to be told on');
  return { following: await follows.setFollowing(user.id, 'members', on) };
}

/**
 * Tells whoever follows the board, and still holds `members`, that someone
 * applied: that it happened, never who. Returns how many were told.
 */
async function notifyFollowers(origin) {
  const message = {
    subject: 'New member application',
    lines: [
      'Someone asked to join AI Safety for Italy.',
      { label: 'Open the applications', link: `${origin}/app/members/` },
    ],
  };
  let told = 0;
  for (const userId of await follows.followers('members')) {
    const { rows } = await db.query('select id, kind from app_users where id = $1', [userId]);
    if (!rows[0] || !(await permissions.forUser(rows[0])).includes('members')) continue;
    try {
      if ((await notify.notifyUser(userId, message)).length) told++;
    } catch (err) {
      console.error('Notification failed', err.message);
    }
  }
  return told;
}

/**
 * The decision shows on the form answer the application came from, as its
 * tag (Approved, Rejected), the tag added to the form's if missing.
 */
async function tagAnswer(row, decision) {
  if (!row || !row.response_id) return;
  const key = decision === 'approve' ? 'approved' : 'rejected';
  const label = decision === 'approve' ? 'Approved' : 'Rejected';
  const { rows } = await db.query(
    `select f.id, f.settings from form_responses r join forms f on f.id = r.form_id
     where r.id = $1`,
    [row.response_id]
  );
  if (!rows[0]) return;
  const settings = rows[0].settings || {};
  const tags =
    Array.isArray(settings.tags) && settings.tags.length
      ? settings.tags.slice()
      : [
          { key: 'new', label: 'New' },
          { key: 'seen', label: 'Seen' },
        ];
  if (!tags.some((t) => t.key === key)) {
    tags.push({ key, label });
    await db.query('update forms set settings = $2 where id = $1', [
      rows[0].id,
      { ...settings, tags },
    ]);
  }
  await db.query('update form_responses set status = $2 where id = $1', [row.response_id, key]);
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
  const until = (locale) =>
    new Date(row.join_expires_at).toLocaleDateString(locale, {
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
        `Il link è personale, vale una volta sola e scade il ${until('it-IT')}.\n\n` +
        'A presto,\nil team di AI Safety for Italy\n\n' +
        '---\n\n' +
        `Hi ${firstName(who.name)}, your request to join AI Safety for Italy has been accepted. ` +
        `Open the link above to join our Discord server as ${role.label}: ` +
        `it is personal, works once and expires on ${until('en-GB')}.\n`,
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
  await access.authorize(user, 'members', { fresh: true });
  const b = body || {};
  const note = text(b.note, 'Note', 2000, false);
  const row = await loadRow(id);
  // The working groups chosen (the form's, unless changed): known ones only,
  // all as taking part. Who coordinates is set on Working groups.
  const tags = community
    .cleanTags(b.tags === undefined ? row.tags : b.tags, await community.listGroups())
    .map((t) => ({ group: t.group, level: 'stable' }));
  if (row.kind === 'upgrade') return decideUpgrade(user, row, b, { note, tags });
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
         join_expires_at = now() + make_interval(days => $6), tags = $7
       where id = $1 and status in ('pending', 'rejected') returning *`,
      [id, b.role, note, user.id, tokenHash(token), JOIN_DAYS, JSON.stringify(tags)]
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
  await tagAnswer(updated.rows[0], b.decision);
  const invite =
    b.decision === 'approve' ? await sendInvite(updated.rows[0], siteOrigin, token) : undefined;
  return { application: summary(await loadRow(id)), invite };
}

/**
 * A participant asking to become an organizer: they are on Discord already,
 * so approving gives them the Organizer role and their tags at once (no join
 * link), and tells them. Rejecting changes nothing.
 */
async function decideUpgrade(user, row, b, { note, tags }) {
  let updated;
  if (b.decision === 'approve') {
    const organizer = roleId('organizer');
    if (!organizer) throw new HttpError(503, 'The Discord id of the organizer role is not set');
    updated = await db.query(
      `update member_applications set status = 'approved', role = 'organizer', note = $2,
         decided_by = $3, decided_at = now(), joined_at = now(), tags = $4
       where id = $1 and status in ('pending', 'rejected') returning *`,
      [row.id, note, user.id, JSON.stringify(tags)]
    );
    if (!updated.rows.length)
      throw new HttpError(409, 'Someone already decided on this application');
    if (permissions.botConfigured()) {
      const give = await permissions.bot(
        `/guilds/${process.env.DISCORD_GUILD_ID}/members/${row.discord_id}/roles/${organizer}`,
        { method: 'PUT' }
      );
      if (!give.ok) {
        await db.query('update member_applications set join_error = $2 where id = $1', [
          row.id,
          `Giving the organizer role failed (${give.status})`,
        ]);
      }
    }
    const who = details(row) || {};
    await community.fromApplication({
      email: who.email,
      name: who.name,
      role: 'organizer',
      tags,
      discordId: row.discord_id,
    });
    const { rows: users } = await db.query('select id from app_users where discord_id = $1', [
      row.discord_id,
    ]);
    if (users[0]) {
      await notify
        .notifyUser(users[0].id, {
          subject: 'You are now an organizer',
          lines: [
            'Your request to join the organizers of AI Safety for Italy was approved: you have the Organizer role on Discord, with your working groups.',
          ],
        })
        .catch((err) => console.error('Notification failed', err.message));
    }
  } else if (b.decision === 'reject') {
    updated = await db.query(
      `update member_applications set status = 'rejected', note = $2, decided_by = $3,
         decided_at = now() where id = $1 and status = 'pending' returning *`,
      [row.id, note, user.id]
    );
    if (!updated.rows.length)
      throw new HttpError(409, 'Someone already decided on this application');
  } else {
    throw new HttpError(400, 'Approve or reject?');
  }
  await audit.record(user, 'member-decide', row.id, { decision: b.decision, upgrade: true });
  return { application: summary(await loadRow(row.id)) };
}

// ── Becoming an organizer ────────────────────────────────────────────────────
// A participant fills in the organizers' part of the sign-up form from the
// dashboard (/app/organizer/); it reaches the board flagged as an upgrade.

/** The organizers' questions, the working groups as they are now. */
async function upgradeSchema() {
  const schemaLib = require('./forms/schema');
  const groups = await community.listGroups();
  const options = groups.map((g) => ({ id: g.id, label: { it: g.titleIt, en: g.titleEn } }));
  const q = (id, type, it, en, extra = {}) => ({ id, type, label: { it, en }, ...extra });
  const schema = schemaLib.cleanSchema({
    languages: ['it', 'en'],
    title: { it: 'Diventa organizzatore', en: 'Become an organizer' },
    confirmation: {
      it: 'Grazie! Il team valuterà la tua richiesta e ti avviserà.',
      en: 'Thank you! The team will review your request and let you know.',
    },
    items: [
      q(
        'groups',
        'multi',
        'In quali gruppi di lavoro vorresti partecipare stabilmente?',
        'Which working groups would you like to take part in regularly?',
        { optionsFrom: 'work_groups', required: true }
      ),
      q(
        'hours',
        'number',
        'Quante ore vuoi dedicare ad AI Safety Italy ogni mese?',
        'How many hours a month would you like to give AI Safety Italy?',
        { min: 0, max: 200, required: true }
      ),
      q(
        'experience',
        'long_text',
        'Hai esperienza pregressa rilevante che vuoi segnalare?',
        'Any relevant experience you would like to mention?'
      ),
      q(
        'initiative',
        'long_text',
        "Hai già in mente un'iniziativa specifica che vorresti proporre o supportare?",
        'Do you have a specific initiative in mind you would like to propose or support?'
      ),
    ],
  });
  return {
    ...schema,
    items: schema.items.map((i) => (i.optionsFrom === 'work_groups' ? { ...i, options } : i)),
  };
}

/**
 * Whether this member may ask to become an organizer: a participant on
 * Discord, not an organizer yet, with no request waiting. { can, pending }.
 */
async function upgradeState(user) {
  if (!user || user.kind !== 'discord') return { can: false, pending: false };
  const roles = await permissions.rolesOf(user);
  const participant = roleId('participant');
  const organizer = roleId('organizer');
  if (!participant || !roles.includes(participant) || (organizer && roles.includes(organizer)))
    return { can: false, pending: false };
  const { rows: me } = await db.query('select discord_id from app_users where id = $1', [user.id]);
  const { rows } = await db.query(
    `select 1 from member_applications where kind = 'upgrade' and discord_id = $1 and status = 'pending'`,
    [me[0] && me[0].discord_id]
  );
  return { can: !rows.length, pending: rows.length > 0 };
}

/** The organizers' part, answered: a request on the board, flagged as an upgrade. */
async function requestUpgrade(user, answersIn, { siteOrigin } = {}) {
  const state = await upgradeState(user);
  if (state.pending) throw new HttpError(409, 'Your request is already waiting for the team');
  if (!state.can) throw new HttpError(403, 'Only participants can ask to become organizers');
  const schemaLib = require('./forms/schema');
  const schema = await upgradeSchema();
  const { answers } = schemaLib.cleanAnswers(schema, answersIn);
  const { rows } = await db.query('select * from app_users where id = $1', [user.id]);
  const me = rows[0];
  // Who coordinates is chosen on Working groups, not asked here.
  const tags = ((answers.groups && answers.groups.selected) || []).map((group) => ({
    group,
    level: 'stable',
  }));
  const lang = schema.languages[0];
  const list = schemaLib
    .answerable(schema)
    .filter((it) => answers[it.id] !== undefined)
    .map((it) => ({
      label: schemaLib.textIn(schema, it.label, lang),
      value: schemaLib.answerText(schema, it, answers[it.id]),
    }));
  const created = await createApplication(
    {
      name: me.name,
      // The Discord account's email; a placeholder when Discord gave none.
      email: me.email || `${me.discord_id}@discord.invalid`,
      requestedRole: 'organizer',
      answers: list,
      tags,
      kind: 'upgrade',
      discordId: me.discord_id,
      discordName: me.name,
    },
    { source: 'upgrade' }
  );
  if (siteOrigin) await notifyFollowers(siteOrigin).catch(() => 0);
  return { id: created.id, confirmation: schema.confirmation };
}

/** A fresh link for an approved person who has not joined yet. */
async function resendInvite(user, id, { siteOrigin }) {
  await access.authorize(user, 'members', { fresh: true });
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
  await joinCommunity(row, user.id);
}

/** The person who just joined, in the community directory with their tags. */
async function joinCommunity(row, discordId) {
  const who = details(row) || {};
  try {
    await community.fromApplication({
      email: who.email,
      name: who.name,
      profile: who.profile,
      location: who.location,
      areas: who.areas,
      publish: who.publish,
      role: row.role || 'participant',
      tags: row.tags || [],
      discordId,
    });
  } catch (err) {
    // They are in: a failure here is fixed from Members, not by failing the join.
    console.error('Adding to the community failed', err.message);
  }
}

/** Local development, without Discord: the link joins at once. */
async function completeJoinDev(token) {
  const row = await claim(await checkJoinToken(token));
  await markJoined(row, `dev-${row.id.slice(0, 8)}`, (details(row) || {}).name || 'Dev', null);
  await joinCommunity(row, `dev-${row.id.slice(0, 8)}`);
}

module.exports = {
  ROLES,
  JoinError,
  boardRoles,
  createApplication,
  listApplications,
  upgradeSchema,
  upgradeState,
  requestUpgrade,
  setFollowing,
  notifyFollowers,
  decide,
  resendInvite,
  checkJoinToken,
  completeJoin,
  completeJoinDev,
  joinCommunity,
  devMode,
};
