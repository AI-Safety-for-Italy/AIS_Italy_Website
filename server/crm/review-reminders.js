// The reminders to the reviewers of the mentee selection (server/crm/review.js):
// how many applications each still has to review, in the pre-screening and
// in each of their sections, and how long is left before the deadline.
//
// Two ways, both the admins' (the setup page, step Reminders):
//   now        sent at once, to every reviewer with something left to do,
//              with a line of the admin's own if they write one;
//   automatic  a deadline and the lead times before it (a week, three days,
//              two, one, twelve hours…): each reminder goes when its time
//              comes, by the job of the calendar's reminders (every 10
//              minutes, api/cron/cleanup.js?job=reminders).
// Only reviewers with something left to do are reminded; each on the
// channels they chose on their settings page (notify.notifyUser). Each
// automatic reminder goes once per reviewer, deadline and lead time
// (review_reminders_sent, written before sending), even with two jobs.

const db = require('../db');
const { HttpError } = require('../http');
const notify = require('../notify');
const audit = require('./audit');
const review = require('./review');

const KEY = 'review_reminders';
const HOUR = 60;
const DAY = 24 * HOUR;
// The lead times an admin may pick, in minutes.
const LEADS = [14 * DAY, 7 * DAY, 5 * DAY, 3 * DAY, 2 * DAY, DAY, 12 * HOUR, 6 * HOUR, 2 * HOUR];
const DEFAULT_LEADS = [7 * DAY, 3 * DAY, 2 * DAY, DAY, 12 * HOUR];
// A reminder is still sent this long after its time (a job that ran late),
// never later: a deadline set at the last minute does not send them all.
const WINDOW_MS = 90 * 60 * 1000;
const MAX_MESSAGE = 500;
// Two reminders "now" this close together would be one too many.
const NOW_GAP_MS = 10 * 60 * 1000;

/** The reminders' setup: { deadline, leads, auto, lastSentNow }. */
async function getReminders() {
  const { rows } = await db.query('select value from app_settings where key = $1', [KEY]);
  const v = (rows[0] && rows[0].value) || {};
  return {
    deadline: v.deadline || null,
    leads: Array.isArray(v.leads) ? v.leads.filter((m) => LEADS.includes(m)) : DEFAULT_LEADS,
    auto: v.auto === true,
    lastSentNow: v.lastSentNow || null,
  };
}

async function store(value) {
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, value]
  );
}

/** Saves { deadline: ISO | null, leads: [minutes], auto }. */
async function saveReminders(user, body) {
  const b = body || {};
  const current = await getReminders();
  let deadline = null;
  if (b.deadline) {
    const at = new Date(b.deadline);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'The deadline is not a date');
    deadline = at.toISOString();
  }
  const leads = [...new Set((Array.isArray(b.leads) ? b.leads : []).map(Number))];
  if (leads.some((m) => !LEADS.includes(m)))
    throw new HttpError(
      400,
      'A reminder can go 14, 7, 5, 3, 2 or 1 day, or 12, 6 or 2 hours before'
    );
  const auto = b.auto === true;
  if (auto && !deadline) throw new HttpError(400, 'Set a deadline for the automatic reminders');
  if (auto && !leads.length) throw new HttpError(400, 'Pick when the reminders go');
  if (auto && new Date(deadline).getTime() <= Date.now())
    throw new HttpError(400, 'The deadline has passed: pick a later one');
  const next = {
    deadline,
    leads: leads.sort((x, y) => y - x),
    auto,
    lastSentNow: current.lastSentNow,
  };
  await store(next);
  await audit.record(user, 'review-remind', null, { setup: true, auto, leads: leads.length });
  return reminderPage();
}

/** "1 week", "3 days", "12 hours", "40 minutes". */
function spanText(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m >= DAY) {
    const days = Math.round(m / DAY);
    if (days === 7) return '1 week';
    if (days === 14) return '2 weeks';
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (m >= HOUR) {
    const hours = Math.round(m / HOUR);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/** When, in Italian time: "Friday 20 November, 18:00 (Rome time)". */
function whenText(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${day}, ${time} (Rome time)`;
}

/** What one reviewer has left: { total, parts: [{ label, left }] }. */
function leftOf(lists) {
  const parts = lists
    .map((s) => ({ label: s.label, left: Math.max(0, s.total - s.done) }))
    .filter((p) => p.left > 0);
  return { total: parts.reduce((n, p) => n + p.left, 0), parts };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The message to one reviewer: { subject, lines }. `minutesLeft` (null: no
 * deadline) says how long is left; `note` is the admin's own line, if any.
 */
function message(left, { deadline, minutesLeft, note, origin }) {
  const apps = plural(left.total, 'application', 'applications');
  const subject =
    minutesLeft === null
      ? `Mentee selection: ${apps} left to review`
      : `Mentee selection: ${spanText(minutesLeft)} left, ${apps} to review`;
  const detail = left.parts.map((p) => `${p.left} in ${p.label}`).join(', ');
  return {
    subject,
    lines: [
      deadline
        ? `The reviews of the mentee selection close on ${whenText(deadline)}: ${spanText(
            minutesLeft
          )} left.`
        : null,
      `You still have ${apps} to review (${detail}).`,
      note || null,
      { label: 'Open the selection', link: `${origin}/app/review/` },
    ].filter(Boolean),
  };
}

/** Every reviewer, with what each has left: [{ userId, name, left }]. */
async function standing() {
  const ctx = await review.context();
  const team = await review.reviewers();
  const out = [];
  for (const r of team) {
    out.push({
      userId: r.userId,
      name: r.name,
      left: leftOf(await review.progress(r.userId, ctx)),
    });
  }
  return out;
}

/** The reminders' page: the setup, the lead times offered, and who has what left. */
async function reminderPage() {
  const [setup, team] = await Promise.all([getReminders(), standing()]);
  return {
    ...setup,
    options: LEADS,
    team: team.map((r) => ({ userId: r.userId, name: r.name, left: r.left.total })),
  };
}

/**
 * Reminds every reviewer with something left to do, now: { note? }. Returns
 * { sent, reviewers }, `sent` those reached on some channel.
 */
async function sendNow(user, body, { origin }) {
  const b = body || {};
  const note = String(b.note || '').trim();
  if (note.length > MAX_MESSAGE)
    throw new HttpError(400, `The message is ${MAX_MESSAGE} characters at most`);
  const setup = await getReminders();
  if (setup.lastSentNow && Date.now() - new Date(setup.lastSentNow).getTime() < NOW_GAP_MS)
    throw new HttpError(429, 'A reminder went a few minutes ago: wait a little before the next');
  const deadline =
    setup.deadline && new Date(setup.deadline).getTime() > Date.now() ? setup.deadline : null;
  const minutesLeft = deadline ? (new Date(deadline).getTime() - Date.now()) / 60000 : null;
  const due = (await standing()).filter((r) => r.left.total > 0);
  let sent = 0;
  for (const r of due) {
    const msg = message(r.left, { deadline, minutesLeft, note, origin });
    if ((await notify.notifyUser(r.userId, msg)).length) sent++;
  }
  await store({ ...setup, lastSentNow: new Date().toISOString() });
  await audit.record(user, 'review-remind', null, { now: true, reviewers: due.length, sent });
  return { sent, reviewers: due.length };
}

/**
 * The automatic reminders due at `now`, from the scheduled job. Returns {
 * sent }: how many reviewers were reached.
 */
async function run({ now = new Date(), origin } = {}) {
  const setup = await getReminders();
  if (!setup.auto || !setup.deadline) return { sent: 0 };
  const site = (origin || process.env.SITE_URL || 'https://www.ais4i.it').replace(/\/+$/, '');
  const nowMs = new Date(now).getTime();
  const end = new Date(setup.deadline).getTime();
  if (nowMs >= end) return { sent: 0 };
  // The latest lead time whose moment has come, within the window.
  const lead = setup.leads
    .filter((m) => {
      const at = end - m * 60000;
      return at <= nowMs && at > nowMs - WINDOW_MS;
    })
    .sort((x, y) => x - y)[0];
  if (lead === undefined) return { sent: 0 };
  let sent = 0;
  for (const r of await standing()) {
    if (!r.left.total) continue;
    const { rows } = await db.query(
      `insert into review_reminders_sent (deadline, lead_minutes, reviewer_id) values ($1, $2, $3)
       on conflict do nothing returning reviewer_id`,
      [setup.deadline, lead, r.userId]
    );
    if (!rows.length) continue;
    const msg = message(r.left, {
      deadline: setup.deadline,
      minutesLeft: lead,
      note: null,
      origin: site,
    });
    if ((await notify.notifyUser(r.userId, msg)).length) sent++;
  }
  if (sent) {
    await audit.record({ id: null, name: 'reminders job' }, 'review-remind', null, {
      lead,
      sent,
    });
  }
  return { sent };
}

module.exports = {
  LEADS,
  DEFAULT_LEADS,
  getReminders,
  saveReminders,
  reminderPage,
  sendNow,
  run,
  message,
  spanText,
};
