// Meeting polls: what the API functions call into. Everything that touches the
// database goes through here, and everything here validates its own input, so
// the api/ handlers stay a thin layer of routing.

const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');

const VOTE = { NO: 0, MAYBE: 1, YES: 2 };
const MAX_SLOTS = 200;
const MAX_RESPONSES = 300;
const MAX_EXTRA_EMAILS = 50;
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
    slots: starts,
  };
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

async function listPolls() {
  const { rows } = await db.query(
    `select p.*,
       (select count(*)::int from poll_responses r where r.poll_id = p.id) as response_count,
       (select count(*)::int from poll_slots s where s.poll_id = p.id) as slot_count,
       (select min(starts_at) from poll_slots s where s.poll_id = p.id) as first_slot,
       (select max(starts_at) from poll_slots s where s.poll_id = p.id) as last_slot,
       (select starts_at from poll_slots s where s.id = p.final_slot_id) as final_start
     from polls p order by p.created_at desc`
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

async function getPollAdmin(id) {
  const poll = await loadPoll('id', uuid(id));
  const { slots, responses, byResponse, counts } = await loadSlotsAndVotes(poll.id);
  return {
    ...describe(poll),
    finalSlotId: poll.final_slot_id,
    calendarEventLink: poll.calendar_event_link,
    meetLink: poll.meet_link,
    slots: slotList(slots, counts, poll.duration_minutes),
    responses: responses.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      votes: byResponse.get(r.id),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  };
}

/**
 * What anyone holding the poll link sees. Never includes email addresses,
 * except the caller's own when they come back with their edit token.
 */
async function getPollPublic(token, editToken) {
  const poll = await loadPoll('token', text(token, 'Poll', { max: 64, required: true }));
  const { slots, responses, byResponse, counts } = await loadSlotsAndVotes(poll.id);
  const mine = editToken ? responses.find((r) => r.edit_token === editToken) : null;
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
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function createPoll(body) {
  const input = validatePollInput(body);
  const token = newToken();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into polls (token, title, description, location, duration_minutes, timezone,
                          deadline, hide_responses)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        token,
        input.title,
        input.description,
        input.location,
        input.durationMinutes,
        input.timezone,
        input.deadline,
        input.hideResponses,
      ]
    );
    const id = rows[0].id;
    for (const start of input.slots) {
      await tx.query('insert into poll_slots (poll_id, starts_at) values ($1, $2)', [id, start]);
    }
    return { id, token };
  });
}

async function updatePoll(id, body) {
  const poll = await loadPoll('id', uuid(id));
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
    status: poll.status,
  };
  if ('status' in body) {
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'Invalid status');
    if (poll.status === 'scheduled') {
      throw new HttpError(409, 'Cancel the scheduled meeting before reopening the poll');
    }
    next.status = body.status;
  }
  await db.query(
    `update polls set title = $2, description = $3, location = $4, deadline = $5,
       hide_responses = $6, status = $7, updated_at = now() where id = $1`,
    [
      poll.id,
      next.title,
      next.description,
      next.location,
      next.deadline,
      next.hideResponses,
      next.status,
    ]
  );
  return getPollAdmin(poll.id);
}

async function deletePoll(id) {
  await db.query('delete from polls where id = $1', [uuid(id)]);
}

async function deleteResponse(pollId, responseId) {
  await db.query('delete from poll_responses where id = $1 and poll_id = $2', [
    uuid(responseId, 'response'),
    uuid(pollId),
  ]);
}

/**
 * Adds or (with a matching editToken) replaces a participant's availability.
 * Slots left out of `votes` count as "no".
 */
async function submitResponse(token, body) {
  const poll = await loadPoll('token', text(token, 'Poll', { max: 64, required: true }));
  if (!isOpen(poll)) throw new HttpError(409, 'This poll is closed');

  const name = cleanName(body.name);
  const address = email(body.email);
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
      if (body.editToken) {
        const { rows } = await tx.query(
          'select id, edit_token from poll_responses where poll_id = $1 and edit_token = $2',
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
      }
      for (const [slotId, v] of values) {
        await tx.query('insert into poll_votes (response_id, slot_id, value) values ($1, $2, $3)', [
          response.id,
          slotId,
          v,
        ]);
      }
      return { editToken: response.edit_token };
    })
    .catch((err) => {
      // Two people submitting the same name or email at the same moment both
      // pass assertAvailable; the unique indexes stop the second one here.
      if (err.code === '23505') {
        const field = /name/.test(err.constraint || err.message) ? 'name' : 'email';
        throw TAKEN[field]();
      }
      throw err;
    });
}

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
  if (query.e) {
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
 * Picks the final slot, creates the calendar event with the chosen people as
 * attendees (the calendar sends the invitations) and marks the poll scheduled.
 */
async function finalizePoll(id, body, calendar) {
  const poll = await loadPoll('id', uuid(id));
  if (poll.status === 'scheduled') throw new HttpError(409, 'This poll is already scheduled');

  const slotId = uuid(body.slotId, 'slot');
  const slot = (
    await db.query('select starts_at from poll_slots where id = $1 and poll_id = $2', [
      slotId,
      poll.id,
    ])
  ).rows[0];
  if (!slot) throw new HttpError(400, 'That slot is not part of this poll');

  const responses = (
    await db.query('select id, name, email from poll_responses where poll_id = $1', [poll.id])
  ).rows;
  const chosen = Array.isArray(body.responseIds)
    ? responses.filter((r) => body.responseIds.includes(r.id))
    : responses;
  const extra = Array.isArray(body.extraEmails) ? body.extraEmails : [];
  if (extra.length > MAX_EXTRA_EMAILS) throw new HttpError(400, 'Too many extra guests');

  const attendees = new Map();
  for (const r of chosen) attendees.set(r.email.toLowerCase(), { email: r.email, name: r.name });
  for (const e of extra) {
    const address = email(e, 'Guest email');
    if (!attendees.has(address)) attendees.set(address, { email: address });
  }

  const event = await calendar.createEvent({
    summary: poll.title,
    description: poll.description,
    location: poll.location,
    start: new Date(slot.starts_at),
    end: slotEnd(slot.starts_at, poll.duration_minutes),
    timezone: poll.timezone,
    attendees: [...attendees.values()],
    createMeet: Boolean(body.createMeet),
    requestId: `${poll.id}-${Date.now()}`,
  });

  await db.query(
    `update polls set status = 'scheduled', final_slot_id = $2, calendar_event_id = $3,
       calendar_event_link = $4, meet_link = $5, updated_at = now() where id = $1`,
    [poll.id, slotId, event.id, event.htmlLink || null, event.meetLink || null]
  );
  return getPollAdmin(poll.id);
}

/**
 * Cancels the calendar event (attendees are notified) and closes the poll
 * again, so a different slot can be picked.
 */
async function unschedulePoll(id, calendar) {
  const poll = await loadPoll('id', uuid(id));
  if (poll.status !== 'scheduled') throw new HttpError(409, 'This poll is not scheduled');
  if (poll.calendar_event_id) await calendar.deleteEvent(poll.calendar_event_id);
  await db.query(
    `update polls set status = 'closed', final_slot_id = null, calendar_event_id = null,
       calendar_event_link = null, meet_link = null, updated_at = now() where id = $1`,
    [poll.id]
  );
  return getPollAdmin(poll.id);
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
  finalizePoll,
  unschedulePoll,
};
