// Meeting polls: what the API functions call into. Everything that touches the
// database goes through here, and everything here validates its own input, so
// the api/ handlers stay a thin layer of routing.

const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const { HttpError } = require('./http');

const VOTE = { NO: 0, MAYBE: 1, YES: 2 };
const MAX_SLOTS = 200;
const MAX_RESPONSES = 300;
const MAX_INVITES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const newToken = () => crypto.randomBytes(16).toString('base64url');

// ── Validation ──────────────────────────────────────────────────────────────

function text(value, field, { max, required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

function email(value, field = 'Email') {
  const s = text(value, field, { max: 254, required: true }).toLowerCase();
  if (!EMAIL.test(s)) throw new HttpError(400, `${field} is not a valid address`);
  return s;
}

function instant(value, field) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${field} is not a valid date`);
  }
  return date;
}

function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `Invalid ${field}`);
  return value;
}

function timezone(value) {
  const tz = text(value || 'Europe/Rome', 'Timezone', { max: 64 });
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new HttpError(400, 'Unknown timezone');
  }
  return tz;
}

function validatePollInput(body) {
  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) {
    throw new HttpError(400, 'Duration must be between 5 minutes and 24 hours');
  }
  if (!Array.isArray(body.slots) || body.slots.length === 0) {
    throw new HttpError(400, 'Pick at least one time slot');
  }
  if (body.slots.length > MAX_SLOTS) {
    throw new HttpError(400, `At most ${MAX_SLOTS} time slots per poll`);
  }
  const starts = [...new Set(body.slots.map((s) => instant(s, 'Slot').toISOString()))].sort();
  return {
    title: text(body.title, 'Title', { max: 200, required: true }),
    description: text(body.description, 'Description', { max: 5000 }),
    location: text(body.location, 'Location', { max: 500 }),
    durationMinutes,
    timezone: timezone(body.timezone),
    deadline: body.deadline ? instant(body.deadline, 'Deadline') : null,
    hideResponses: Boolean(body.hideResponses),
    notify: body.notify === undefined ? true : Boolean(body.notify),
    inviteOnly: Boolean(body.inviteOnly),
    invitees: body.inviteOnly ? inviteeList(body.invitees, { required: true }) : [],
    slots: starts,
  };
}

/** Distinct, valid, lower-cased emails from an array or a pasted list. */
function inviteeList(value, { required = false } = {}) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const list = [
    ...new Set(
      raw
        .map((e) => String(e).trim())
        .filter(Boolean)
        .map((e) => email(e))
    ),
  ];
  if (required && !list.length) throw new HttpError(400, 'Add the emails of the people to invite');
  if (list.length > MAX_INVITES) throw new HttpError(400, `At most ${MAX_INVITES} guests per poll`);
  return list;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function isOpen(poll, now = new Date()) {
  return poll.status === 'open' && (!poll.deadline || new Date(poll.deadline) > now);
}

function slotEnd(start, minutes) {
  return new Date(new Date(start).getTime() + minutes * 60_000);
}

async function loadPoll(where, value) {
  const { rows } = await db.query(`select * from polls where ${where} = $1`, [value]);
  if (!rows.length) throw new HttpError(404, 'Poll not found');
  return rows[0];
}

/**
 * A poll by id, but only if `ownerId` owns it. Someone else's poll is reported
 * as missing rather than forbidden, so ids reveal nothing about other polls.
 */
async function loadOwnPoll(id, ownerId) {
  const { rows } = await db.query('select * from polls where id = $1 and owner_id = $2', [
    uuid(id),
    uuid(ownerId, 'owner'),
  ]);
  if (!rows.length) throw new HttpError(404, 'Poll not found');
  return rows[0];
}

async function loadSlotsAndVotes(pollId) {
  const slots = (
    await db.query('select id, starts_at from poll_slots where poll_id = $1 order by starts_at', [
      pollId,
    ])
  ).rows;
  const responses = (
    await db.query(
      `select id, name, email, edit_token, created_at, updated_at from poll_responses
       where poll_id = $1 order by created_at`,
      [pollId]
    )
  ).rows;
  const votes = (
    await db.query(
      `select v.response_id, v.slot_id, v.value from poll_votes v
       join poll_responses r on r.id = v.response_id where r.poll_id = $1`,
      [pollId]
    )
  ).rows;

  const byResponse = new Map(responses.map((r) => [r.id, {}]));
  const counts = new Map(slots.map((s) => [s.id, { yes: 0, maybe: 0 }]));
  for (const v of votes) {
    byResponse.get(v.response_id)[v.slot_id] = v.value;
    const c = counts.get(v.slot_id);
    if (v.value === VOTE.YES) c.yes++;
    else if (v.value === VOTE.MAYBE) c.maybe++;
  }
  return { slots, responses, byResponse, counts };
}

function describe(poll) {
  return {
    id: poll.id,
    token: poll.token,
    title: poll.title,
    description: poll.description,
    location: poll.location,
    durationMinutes: poll.duration_minutes,
    timezone: poll.timezone,
    deadline: poll.deadline ? new Date(poll.deadline).toISOString() : null,
    hideResponses: poll.hide_responses,
    inviteOnly: poll.invite_only,
    notify: poll.notify,
    status: poll.status,
    open: isOpen(poll),
    createdAt: new Date(poll.created_at).toISOString(),
  };
}

function slotList(slots, counts, durationMinutes) {
  return slots.map((s) => ({
    id: s.id,
    start: new Date(s.starts_at).toISOString(),
    end: slotEnd(s.starts_at, durationMinutes).toISOString(),
    ...(counts ? counts.get(s.id) : {}),
  }));
}

async function listPolls(ownerId) {
  const { rows } = await db.query(
    `select p.*,
       (select count(*)::int from poll_responses r where r.poll_id = p.id) as response_count,
       (select count(*)::int from poll_slots s where s.poll_id = p.id) as slot_count,
       (select min(starts_at) from poll_slots s where s.poll_id = p.id) as first_slot,
       (select max(starts_at) from poll_slots s where s.poll_id = p.id) as last_slot,
       (select starts_at from poll_slots s where s.id = p.final_slot_id) as final_start
     from polls p where p.owner_id = $1 order by p.created_at desc`,
    [uuid(ownerId, 'owner')]
  );
  return rows.map((p) => ({
    ...describe(p),
    responseCount: p.response_count,
    slotCount: p.slot_count,
    firstSlot: p.first_slot && new Date(p.first_slot).toISOString(),
    lastSlot: p.last_slot && new Date(p.last_slot).toISOString(),
    finalStart: p.final_start && new Date(p.final_start).toISOString(),
  }));
}

/** Everything about a poll, emails included, for its owner. */
async function getPollAdmin(id, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  const { slots, responses, byResponse, counts } = await loadSlotsAndVotes(poll.id);
  return {
    ...describe(poll),
    finalSlotId: poll.final_slot_id,
    slots: slotList(slots, counts, poll.duration_minutes),
    responses: responses.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      votes: byResponse.get(r.id),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    invites: poll.invite_only ? await listInvites(poll.id) : [],
    invitedToMeeting: poll.invited_to_meeting || [],
  };
}

async function listInvites(pollId) {
  const { rows } = await db.query(
    `select id, email, response_id, sent_at, send_error from poll_invites
     where poll_id = $1 order by created_at, email`,
    [pollId]
  );
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    answered: Boolean(i.response_id),
    sentAt: i.sent_at && new Date(i.sent_at).toISOString(),
    sendError: i.send_error,
  }));
}

/** The invite a personal link stands for, or null. */
async function findInvite(conn, pollId, inviteToken, lock = false) {
  if (!inviteToken) return null;
  const { rows } = await conn.query(
    `select * from poll_invites where poll_id = $1 and token = $2${lock ? ' for update' : ''}`,
    [pollId, String(inviteToken)]
  );
  return rows[0] || null;
}

const INVITE_REQUIRED = () =>
  new HttpError(403, 'This poll is by invitation only', { code: 'invite_required' });

/**
 * What anyone holding the poll link sees. Never includes email addresses,
 * except the caller's own when they come back with their edit token.
 */
async function getPollPublic(token, editToken, inviteToken) {
  const poll = await loadPoll('token', text(token, 'Poll', { max: 64, required: true }));
  // An invite-only poll shows nothing at all without a guest's personal link.
  const invite = poll.invite_only ? await findInvite(db, poll.id, inviteToken) : null;
  if (poll.invite_only && !invite) throw INVITE_REQUIRED();
  const { slots, responses, byResponse, counts } = await loadSlotsAndVotes(poll.id);
  const mine = invite
    ? responses.find((r) => r.id === invite.response_id)
    : editToken
    ? responses.find((r) => r.edit_token === editToken)
    : null;
  const finalSlot = slots.find((s) => s.id === poll.final_slot_id);
  // The internal id and the token are left out: the visitor already has the
  // link, and nothing on the public page needs the id.
  const publicPoll = describe(poll);
  delete publicPoll.id;
  delete publicPoll.token;
  return {
    ...publicPoll,
    responseCount: responses.length,
    slots: slotList(slots, poll.hide_responses ? null : counts, poll.duration_minutes),
    responses: poll.hide_responses
      ? null
      : responses.map((r) => ({ name: r.name, votes: byResponse.get(r.id), mine: r === mine })),
    finalSlot: finalSlot
      ? {
          id: finalSlot.id,
          start: new Date(finalSlot.starts_at).toISOString(),
          end: slotEnd(finalSlot.starts_at, poll.duration_minutes).toISOString(),
        }
      : null,
    mine: mine ? { name: mine.name, email: mine.email, votes: byResponse.get(mine.id) } : null,
    invite: invite ? { email: invite.email } : null,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function createPoll(body, ownerId) {
  const input = validatePollInput(body);
  uuid(ownerId, 'owner');
  if (input.inviteOnly && !(await mail.isConfigured())) {
    throw new HttpError(409, 'Invites go out by email, which the admin has not set up yet');
  }
  const token = newToken();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into polls (token, title, description, location, duration_minutes, timezone,
                          deadline, hide_responses, owner_id, notify, invite_only)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        token,
        input.title,
        input.description,
        input.location,
        input.durationMinutes,
        input.timezone,
        input.deadline,
        input.hideResponses,
        ownerId,
        input.notify,
        input.inviteOnly,
      ]
    );
    const id = rows[0].id;
    for (const start of input.slots) {
      await tx.query('insert into poll_slots (poll_id, starts_at) values ($1, $2)', [id, start]);
    }
    const invites = await insertInvites(tx, id, input.invitees);
    return { id, token, invites };
  });
}

/** Adds guests (skipping any already invited); returns the new invites. */
async function insertInvites(conn, pollId, emails) {
  const added = [];
  for (const address of emails) {
    const { rows } = await conn.query(
      `insert into poll_invites (poll_id, email, token) values ($1, $2, $3)
       on conflict do nothing returning *`,
      [pollId, address, newToken()]
    );
    if (rows.length) added.push(rows[0]);
  }
  return added;
}

async function updatePoll(id, body, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  const next = {
    title: 'title' in body ? text(body.title, 'Title', { max: 200, required: true }) : poll.title,
    description:
      'description' in body
        ? text(body.description, 'Description', { max: 5000 })
        : poll.description,
    location: 'location' in body ? text(body.location, 'Location', { max: 500 }) : poll.location,
    deadline:
      'deadline' in body
        ? body.deadline
          ? instant(body.deadline, 'Deadline')
          : null
        : poll.deadline,
    hideResponses: 'hideResponses' in body ? Boolean(body.hideResponses) : poll.hide_responses,
    notify: 'notify' in body ? Boolean(body.notify) : poll.notify,
    status: poll.status,
  };
  if ('status' in body) {
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'Invalid status');
    if (poll.status === 'scheduled') {
      throw new HttpError(409, 'Clear the chosen time before reopening the poll');
    }
    next.status = body.status;
  }
  await db.query(
    `update polls set title = $2, description = $3, location = $4, deadline = $5,
       hide_responses = $6, status = $7, notify = $8, updated_at = now() where id = $1`,
    [
      poll.id,
      next.title,
      next.description,
      next.location,
      next.deadline,
      next.hideResponses,
      next.status,
      next.notify,
    ]
  );
  return getPollAdmin(poll.id, ownerId);
}

async function deletePoll(id, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  await db.query('delete from polls where id = $1', [poll.id]);
}

async function deleteResponse(pollId, responseId, ownerId) {
  const poll = await loadOwnPoll(pollId, ownerId);
  await db.query('delete from poll_responses where id = $1 and poll_id = $2', [
    uuid(responseId, 'response'),
    poll.id,
  ]);
  // A guest whose answer is removed can answer again, so "everyone has
  // answered" may become true again later.
  await db.query('update polls set all_answered_at = null where id = $1', [poll.id]);
  return getPollAdmin(poll.id, ownerId);
}

/** Invites more guests to an invite-only poll; returns the new invites. */
async function addInvites(pollId, emails, ownerId) {
  const poll = await loadOwnPoll(pollId, ownerId);
  if (!poll.invite_only) throw new HttpError(400, 'This poll is open to anyone with the link');
  const list = inviteeList(emails, { required: true });
  const { rows } = await db.query(
    'select count(*)::int as n from poll_invites where poll_id = $1',
    [poll.id]
  );
  if (rows[0].n + list.length > MAX_INVITES) {
    throw new HttpError(400, `At most ${MAX_INVITES} guests per poll`);
  }
  const added = await insertInvites(db, poll.id, list);
  if (added.length) {
    await db.query('update polls set all_answered_at = null where id = $1', [poll.id]);
  }
  return { poll, invites: added };
}

/** One guest's invite, to send it again. */
async function getInvite(pollId, inviteId, ownerId) {
  const poll = await loadOwnPoll(pollId, ownerId);
  const { rows } = await db.query('select * from poll_invites where id = $1 and poll_id = $2', [
    uuid(inviteId, 'invite'),
    poll.id,
  ]);
  if (!rows.length) throw new HttpError(404, 'Invite not found');
  return { poll, invite: rows[0] };
}

/** Removes a guest, and their answer if they gave one. */
async function removeInvite(pollId, inviteId, ownerId) {
  const { poll, invite } = await getInvite(pollId, inviteId, ownerId);
  await db.query('delete from poll_invites where id = $1', [invite.id]);
  if (invite.response_id) {
    await db.query('delete from poll_responses where id = $1', [invite.response_id]);
  }
  return getPollAdmin(poll.id, ownerId);
}

/**
 * True exactly once per completion: when every guest of an invite-only poll
 * has answered and nobody was told yet. The update is atomic, so two answers
 * arriving together cannot both report it.
 */
async function markAllAnswered(pollId) {
  const { rows } = await db.query(
    `update polls set all_answered_at = now()
     where id = $1 and invite_only and all_answered_at is null
       and exists (select 1 from poll_invites where poll_id = $1)
       and not exists (select 1 from poll_invites where poll_id = $1 and response_id is null)
     returning (select count(*)::int from poll_invites where poll_id = $1) as n`,
    [pollId]
  );
  return rows.length ? rows[0].n : 0;
}

/**
 * Adds or (with a matching editToken) replaces a participant's availability.
 * Slots left out of `votes` count as "no".
 */
async function submitResponse(token, body) {
  const poll = await loadPoll('token', text(token, 'Poll', { max: 64, required: true }));
  if (!isOpen(poll)) throw new HttpError(409, 'This poll is closed');

  const name = cleanName(body.name);
  // A guest of an invite-only poll answers as the address they were invited
  // at, whatever the form says.
  const invite = poll.invite_only ? await findInvite(db, poll.id, body.inviteToken) : null;
  if (poll.invite_only && !invite) throw INVITE_REQUIRED();
  const address = invite ? invite.email.toLowerCase() : email(body.email);
  const votes = body.votes && typeof body.votes === 'object' ? body.votes : {};

  const slotIds = new Set(
    (await db.query('select id from poll_slots where poll_id = $1', [poll.id])).rows.map(
      (r) => r.id
    )
  );
  const values = [];
  for (const slotId of slotIds) {
    const v = votes[slotId] === undefined ? VOTE.NO : Number(votes[slotId]);
    if (![VOTE.NO, VOTE.MAYBE, VOTE.YES].includes(v)) throw new HttpError(400, 'Invalid vote');
    values.push([slotId, v]);
  }

  return db
    .transaction(async (tx) => {
      let response;
      let isNew = false;
      const lockedInvite = invite && (await findInvite(tx, poll.id, invite.token, true));
      if (lockedInvite && lockedInvite.response_id) {
        // A guest changing their answer.
        const { rows } = await tx.query(
          'select id, edit_token from poll_responses where id = $1 for update',
          [lockedInvite.response_id]
        );
        response = rows[0];
        await assertAvailable(tx, poll.id, name, address, response.id);
        await tx.query(
          'update poll_responses set name = $2, email = $3, updated_at = now() where id = $1',
          [response.id, name, address]
        );
        await tx.query('delete from poll_votes where response_id = $1', [response.id]);
      } else if (!invite && body.editToken) {
        const { rows } = await tx.query(
          // Locked until this transaction ends, so two saves of the same answer
          // (e.g. from two tabs) run one after the other: the last one wins.
          `select id, edit_token from poll_responses
           where poll_id = $1 and edit_token = $2 for update`,
          [poll.id, String(body.editToken)]
        );
        if (!rows.length) throw new HttpError(403, 'This edit link is not valid for this poll');
        response = rows[0];
        await assertAvailable(tx, poll.id, name, address, response.id);
        await tx.query(
          'update poll_responses set name = $2, email = $3, updated_at = now() where id = $1',
          [response.id, name, address]
        );
        await tx.query('delete from poll_votes where response_id = $1', [response.id]);
      } else {
        await assertAvailable(tx, poll.id, name, address, null);
        const { rows: count } = await tx.query(
          'select count(*)::int as n from poll_responses where poll_id = $1',
          [poll.id]
        );
        if (count[0].n >= MAX_RESPONSES) {
          throw new HttpError(409, 'This poll has reached its maximum number of answers');
        }
        const { rows } = await tx.query(
          `insert into poll_responses (poll_id, name, email, edit_token)
           values ($1, $2, $3, $4) returning id, edit_token`,
          [poll.id, name, address, newToken()]
        );
        response = rows[0];
        isNew = true;
        if (invite) {
          await tx.query('update poll_invites set response_id = $2 where id = $1', [
            invite.id,
            response.id,
          ]);
        }
      }
      for (const [slotId, v] of values) {
        await tx.query('insert into poll_votes (response_id, slot_id, value) values ($1, $2, $3)', [
          response.id,
          slotId,
          v,
        ]);
      }
      const yes = values.filter(([, v]) => v === VOTE.YES).length;
      const maybe = values.filter(([, v]) => v === VOTE.MAYBE).length;
      return { editToken: response.edit_token, isNew, poll, name, yes, maybe };
    })
    .catch((err) => {
      // Two people submitting the same name or email at the same moment both
      // pass assertAvailable; the unique indexes stop the second one here.
      if (err.code === '23505' && UNIQUE_FIELD[err.constraint]) {
        throw TAKEN[UNIQUE_FIELD[err.constraint]]();
      }
      throw err;
    });
}

// The unique indexes in schema.js, and the field each one protects.
const UNIQUE_FIELD = { poll_responses_name: 'name', poll_responses_email: 'email' };

const TAKEN = {
  name: () =>
    new HttpError(409, 'Someone has already answered with this name', {
      field: 'name',
      code: 'name_taken',
    }),
  email: () =>
    new HttpError(409, 'Someone has already answered with this email', {
      field: 'email',
      code: 'email_taken',
    }),
};

/** Trimmed, with runs of whitespace collapsed, so "Anna  Rossi" = "Anna Rossi". */
function cleanName(value) {
  return text(value, 'Name', { max: 100, required: true }).replace(/\s+/g, ' ');
}

/** Which of name/email another answer on this poll already uses. */
async function findTaken(conn, pollId, name, address, exceptId) {
  const { rows } = await conn.query(
    `select bool_or(lower(name) = lower($2)) as name, bool_or(lower(email) = $3) as email
     from poll_responses where poll_id = $1 and ($4::uuid is null or id <> $4::uuid)`,
    [pollId, name, address, exceptId]
  );
  return { name: Boolean(rows[0].name), email: Boolean(rows[0].email) };
}

async function assertAvailable(conn, pollId, name, address, exceptId) {
  const taken = await findTaken(conn, pollId, name, address, exceptId);
  if (taken.email) throw TAKEN.email();
  if (taken.name) throw TAKEN.name();
}

/**
 * Lets the voting page warn about a taken name or email while it is typed,
 * before anything is sent. Excludes the caller's own answer when editing.
 */
async function checkAvailability(token, query) {
  const poll = await loadPoll('token', text(token, 'Poll', { max: 64, required: true }));
  let exceptId = null;
  const invite = poll.invite_only ? await findInvite(db, poll.id, query.i) : null;
  if (poll.invite_only && !invite) throw INVITE_REQUIRED();
  if (invite) {
    exceptId = invite.response_id;
  } else if (query.e) {
    const { rows } = await db.query(
      'select id from poll_responses where poll_id = $1 and edit_token = $2',
      [poll.id, String(query.e)]
    );
    exceptId = rows.length ? rows[0].id : null;
  }
  const name = typeof query.name === 'string' ? query.name.trim().replace(/\s+/g, ' ') : '';
  const address = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';
  const taken = await findTaken(db, poll.id, name || null, address || null, exceptId);
  return { nameTaken: Boolean(name) && taken.name, emailTaken: Boolean(address) && taken.email };
}

/**
 * Marks the time the meeting will happen. Voting closes and the poll page
 * shows it; sending the invite is up to the owner (the panel offers a
 * calendar file and every participant's email).
 */
async function finalizePoll(id, body, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  if (poll.status === 'scheduled') throw new HttpError(409, 'A time has already been chosen');
  const slotId = uuid(body.slotId, 'slot');
  const { rows } = await db.query('select 1 from poll_slots where id = $1 and poll_id = $2', [
    slotId,
    poll.id,
  ]);
  if (!rows.length) throw new HttpError(400, 'That slot is not part of this poll');
  await db.query(
    `update polls set status = 'scheduled', final_slot_id = $2, updated_at = now() where id = $1`,
    [poll.id, slotId]
  );
  return getPollAdmin(poll.id, ownerId);
}

/**
 * Clears the chosen time; the poll stays closed until it is reopened.
 * Returns the poll, plus `cancel` ({ emails, slot, sequence }) when the
 * calendar invite had been emailed, so those people can be told.
 */
async function unschedulePoll(id, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  if (poll.status !== 'scheduled') throw new HttpError(409, 'No time has been chosen');
  const slot = await chosenSlot(poll);
  const { rows } = await db.query(
    `update polls set status = 'closed', final_slot_id = null, invited_to_meeting = null,
       meeting_sequence = meeting_sequence + 1, updated_at = now()
     where id = $1 returning meeting_sequence`,
    [poll.id]
  );
  const emails = poll.invited_to_meeting || [];
  const result = await getPollAdmin(poll.id, ownerId);
  return emails.length
    ? { ...result, cancel: { emails, slot, sequence: rows[0].meeting_sequence } }
    : result;
}

/** The chosen time of a poll row as { start, end } (Dates), or null. */
async function chosenSlot(poll) {
  if (!poll.final_slot_id) return null;
  const { rows } = await db.query('select starts_at from poll_slots where id = $1', [
    poll.final_slot_id,
  ]);
  return rows.length
    ? { start: rows[0].starts_at, end: slotEnd(rows[0].starts_at, poll.duration_minutes) }
    : null;
}

/** The owner's poll with its chosen time, for building calendar files. */
async function getMeeting(id, ownerId) {
  const poll = await loadOwnPoll(id, ownerId);
  const slot = await chosenSlot(poll);
  if (!slot) throw new HttpError(409, 'No time has been chosen');
  return { poll, slot };
}

/**
 * Who the calendar invite goes to: chosen among the poll's participants and
 * guests (anyone else is ignored), plus extra addresses typed by the owner.
 * Records them, so a later change of time can cancel it, and returns
 * { recipients: [{ email, name }], sequence }.
 */
async function prepareMeetingInvite(id, ownerId, { emails, extraEmails }) {
  const { poll, slot } = await getMeeting(id, ownerId);
  const known = new Map();
  const { rows: people } = await db.query(
    `select lower(email) as email, name from poll_responses where poll_id = $1
     union all
     select lower(email), null from poll_invites where poll_id = $1`,
    [poll.id]
  );
  for (const p of people) if (!known.has(p.email) || p.name) known.set(p.email, p.name);

  const recipients = new Map();
  for (const e of Array.isArray(emails) ? emails : []) {
    const address = String(e).trim().toLowerCase();
    if (known.has(address)) recipients.set(address, { email: address, name: known.get(address) });
  }
  for (const address of inviteeList(extraEmails)) {
    if (!recipients.has(address)) recipients.set(address, { email: address, name: null });
  }
  if (!recipients.size) throw new HttpError(400, 'Choose at least one person to invite');
  if (recipients.size > MAX_RESPONSES) throw new HttpError(400, 'Too many people');

  const { rows } = await db.query(
    // Added to whoever already got it, so a later change of time cancels it
    // for everyone.
    `update polls set meeting_sequence = meeting_sequence + 1,
       invited_to_meeting = array(
         select distinct unnest(coalesce(invited_to_meeting, '{}'::text[]) || $2::text[]))
     where id = $1 returning meeting_sequence`,
    [poll.id, [...recipients.keys()]]
  );
  return { poll, slot, recipients: [...recipients.values()], sequence: rows[0].meeting_sequence };
}

module.exports = {
  VOTE,
  validatePollInput,
  isOpen,
  listPolls,
  getPollAdmin,
  getPollPublic,
  createPoll,
  updatePoll,
  deletePoll,
  deleteResponse,
  submitResponse,
  checkAvailability,
  addInvites,
  getInvite,
  removeInvite,
  markAllAnswered,
  finalizePoll,
  unschedulePoll,
  getMeeting,
  prepareMeetingInvite,
};
