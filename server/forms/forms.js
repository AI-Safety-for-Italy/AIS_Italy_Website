// Forms: making them, opening them to the public, and the answers they get.
//
// Who may do what (checked here, on every call, never only in the page):
//   - manage a form (edit, settings, delete): its owner while they hold the
//     `forms` permission, or anyone with `forms_admin`;
//   - read its answers: whoever may manage it, or whoever holds one of the
//     Discord roles listed in the form's access_roles (say, the mentorship
//     team for the mentor applications).
// Every signed-in call needs a sign-in less than a day old, and the Discord
// roles are re-read when older than five minutes (server/access.js).
//
// Answers are encrypted (server/crm/crypto.js) bound to their form and
// response, so one cannot be moved onto another form or response.

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const db = require('../db');
const { HttpError } = require('../http');
const permissions = require('../permissions');
const access = require('../access');
const crm = require('../crm/crypto');
const audit = require('../crm/audit');
const schemaLib = require('./schema');
const guard = require('./guard');
const templates = require('./templates');
const membership = require('./membership');
const members = require('../members');
const notify = require('../notify');
const mail = require('../mail');

const STATUSES = ['draft', 'open', 'closed'];
// Where the team is with one answer (form_responses.status).
const RESPONSE_STATUSES = ['new', 'reviewing', 'accepted', 'rejected'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[\w-]{1,40}$/;
const DEFAULT_SETTINGS = {
  oneResponsePerEmail: false,
  notifyOwner: true,
  // The community's registration form: see ./membership.js. null for any other.
  membership: null,
};

// ── Who is asking ────────────────────────────────────────────────────────────

/** A recent sign-in and fresh-enough roles: { perms, roles }. */
async function whoIs(user, { fresh = false } = {}) {
  await access.requireRecentLogin(user);
  if (fresh) await permissions.refreshRoles(user);
  else await permissions.refreshIfStale(user);
  return { perms: await permissions.forUser(user), roles: await permissions.rolesOf(user) };
}

function canManage(user, who, form) {
  if (who.perms.includes('forms_admin')) return true;
  return who.perms.includes('forms') && Boolean(form.owner_id) && form.owner_id === user.id;
}

function canRead(user, who, form) {
  if (canManage(user, who, form)) return true;
  return (form.access_roles || []).some((r) => who.roles.includes(r));
}

/** The forms tool is open to `forms` / `forms_admin`; throws 403 otherwise. */
async function requireForms(user, options) {
  const who = await whoIs(user, options);
  if (!who.perms.includes('forms') && !who.perms.includes('forms_admin')) {
    await audit.record(user, 'denied', null, { needs: 'forms' });
    throw new HttpError(403, 'Your Discord roles do not give access to the forms');
  }
  return who;
}

async function loadForm(id) {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, 'No such form');
  const { rows } = await db.query('select * from forms where id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'No such form');
  return rows[0];
}

async function formFor(user, id, need, options) {
  const who = await whoIs(user, options);
  const form = await loadForm(id);
  const allowed = need === 'manage' ? canManage(user, who, form) : canRead(user, who, form);
  if (!allowed) {
    await audit.record(user, 'denied', form.id, {
      needs: need === 'manage' ? 'manage form' : 'read form',
    });
    // The same answer as a missing form: no telling which forms exist.
    throw new HttpError(404, 'No such form');
  }
  return { form, who };
}

// ── Reading forms ────────────────────────────────────────────────────────────

function isOpen(form, at = new Date()) {
  if (form.status !== 'open') return false;
  if (form.opens_at && at < new Date(form.opens_at)) return false;
  if (form.closes_at && at >= new Date(form.closes_at)) return false;
  return true;
}

async function schemaOf(formId, version) {
  const { rows } = await db.query(
    'select schema from form_versions where form_id = $1 and version = $2',
    [formId, version]
  );
  if (!rows.length) throw new HttpError(500, 'A version of this form is missing');
  return rows[0].schema;
}

function summary(form, extra = {}) {
  return {
    id: form.id,
    slug: form.slug,
    title: form.title,
    status: form.status,
    open: isOpen(form),
    opensAt: form.opens_at,
    closesAt: form.closes_at,
    updatedAt: form.updated_at,
    responses: extra.responses || 0,
    lastResponseAt: extra.last || null,
    canManage: extra.canManage || false,
  };
}

/** The forms this user may manage or read, newest change first. */
async function list(user) {
  const who = await whoIs(user);
  const { rows } = await db.query(
    `select f.*, count(r.id) filter (where r.deleted_at is null)::int as responses,
       max(r.submitted_at) filter (where r.deleted_at is null) as last
     from forms f left join form_responses r on r.form_id = f.id
     group by f.id order by f.updated_at desc`
  );
  return rows
    .filter((f) => canRead(user, who, f))
    .map((f) =>
      summary(f, { responses: f.responses, last: f.last, canManage: canManage(user, who, f) })
    );
}

/** One form for the editor: its settings and the current questions. */
async function get(user, id) {
  const { form, who } = await formFor(user, id, 'read');
  const { rows } = await db.query(
    'select count(*)::int as n from form_responses where form_id = $1 and deleted_at is null',
    [form.id]
  );
  return {
    ...summary(form, { responses: rows[0].n, canManage: canManage(user, who, form) }),
    version: form.current_version,
    schema: await schemaOf(form.id, form.current_version),
    settings: { ...DEFAULT_SETTINGS, ...form.settings },
    accessRoles: form.access_roles,
  };
}

// ── Changing forms ───────────────────────────────────────────────────────────

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** A new draft, owned by the user. `schema` may come from a template. */
async function create(user, body) {
  const who = await requireForms(user, { fresh: true });
  const b = body || {};
  const title = String(b.title || '')
    .trim()
    .slice(0, 200);
  if (!title) throw new HttpError(400, 'Give the form a title', { field: 'title' });
  const schema = schemaLib.cleanSchema(b.schema || templates.schemaFor(b.template, title));
  const base = slugify(title) || 'form';
  // The sign-up template comes already wired to the members board, but only
  // for those who may wire a form to it (see updateSettings).
  const settings = { ...DEFAULT_SETTINGS };
  const wiring = b.schema ? null : templates.membershipFor(b.template);
  if (wiring && who.perms.includes('forms_admin')) settings.membership = wiring;
  for (let n = 0; n < 10; n++) {
    // A short random tail: links are not guessable from the title alone. The
    // registration form first tries the address the site's join buttons open.
    const slug =
      n === 0 && settings.membership
        ? membership.JOIN_SLUG
        : `${base}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      const id = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `insert into forms (slug, title, settings, owner_id) values ($1, $2, $3, $4) returning id`,
          [slug, title, settings, user.kind === 'admin' ? null : user.id]
        );
        await tx.query('insert into form_versions (form_id, version, schema) values ($1, 1, $2)', [
          rows[0].id,
          schema,
        ]);
        return rows[0].id;
      });
      await audit.record(user, 'form-create', id);
      return { id, slug };
    } catch (err) {
      if (!(err && (err.code === '23505' || /unique/i.test(err.message || '')))) throw err;
    }
  }
  throw new HttpError(500, 'Could not find a free link for this form');
}

/**
 * Saves the questions. Once a version has answers it is frozen: saving makes
 * a new version, and the old answers keep the questions they were given to.
 */
async function saveSchema(user, id, input) {
  const { form } = await formFor(user, id, 'manage', { fresh: true });
  const schema = schemaLib.cleanSchema(input);
  const { rows } = await db.query(
    'select count(*)::int as n from form_responses where form_id = $1 and version = $2',
    [form.id, form.current_version]
  );
  const version = rows[0].n ? form.current_version + 1 : form.current_version;
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into form_versions (form_id, version, schema) values ($1, $2, $3)
       on conflict (form_id, version) do update set schema = excluded.schema, created_at = now()`,
      [form.id, version, schema]
    );
    await tx.query(
      'update forms set current_version = $2, title = $3, updated_at = now() where id = $1',
      [form.id, version, schema.title[schema.languages[0]]]
    );
  });
  await audit.record(user, 'form-edit', form.id, { version });
  return { version };
}

function when(value, field) {
  if (value === null || value === '' || value === undefined) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date', { field });
  return d;
}

/** Status, dates, link, who reads the answers, and the rest of the settings. */
async function updateSettings(user, id, body) {
  const { form } = await formFor(user, id, 'manage', { fresh: true });
  const b = body || {};
  const status = b.status === undefined ? form.status : b.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status', { field: 'status' });
  const opensAt = b.opensAt === undefined ? form.opens_at : when(b.opensAt, 'opensAt');
  const closesAt = b.closesAt === undefined ? form.closes_at : when(b.closesAt, 'closesAt');
  if (opensAt && closesAt && opensAt >= closesAt)
    throw new HttpError(400, 'The form must open before it closes', { field: 'closesAt' });

  let slug = form.slug;
  if (b.slug !== undefined && b.slug !== form.slug) {
    const { rows } = await db.query('select 1 from form_responses where form_id = $1 limit 1', [
      form.id,
    ]);
    if (rows.length)
      throw new HttpError(409, 'The link cannot change once the form has answers', {
        field: 'slug',
      });
    if (!SLUG.test(String(b.slug)))
      throw new HttpError(400, 'Use lower-case letters, digits and dashes', { field: 'slug' });
    slug = b.slug;
  }

  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  const s = b.settings || {};
  if (s.oneResponsePerEmail !== undefined)
    settings.oneResponsePerEmail = Boolean(s.oneResponsePerEmail);
  if (s.notifyOwner !== undefined) settings.notifyOwner = Boolean(s.notifyOwner);
  if (s.membership !== undefined) {
    // Sending answers to the members board is for the forms admins: it is a
    // door into who may be let into the Discord server.
    const wants = s.membership;
    const had = settings.membership || null;
    const schema = await schemaOf(form.id, form.current_version);
    const next = membership.clean(schema, wants);
    // (jsonb does not keep the order of keys: compare the content.)
    if (!isDeepStrictEqual(next, had)) {
      const who = await whoIs(user);
      if (!who.perms.includes('forms_admin'))
        throw new HttpError(
          403,
          'Only the forms admins can link a form to the member applications',
          {
            field: 'membership',
          }
        );
    }
    settings.membership = next;
  }

  let roles = form.access_roles;
  if (b.accessRoles !== undefined) {
    if (
      !Array.isArray(b.accessRoles) ||
      b.accessRoles.length > 30 ||
      !b.accessRoles.every((r) => ROLE.test(String(r)))
    ) {
      throw new HttpError(400, 'Invalid roles', { field: 'accessRoles' });
    }
    roles = [...new Set(b.accessRoles.map(String))];
  }

  if (status === 'open') {
    const schema = await schemaOf(form.id, form.current_version);
    if (!schemaLib.answerable(schema).length)
      throw new HttpError(400, 'Add at least one question before opening the form', {
        field: 'status',
      });
  }

  try {
    await db.query(
      `update forms set status = $2, opens_at = $3, closes_at = $4, slug = $5, settings = $6,
       access_roles = $7, updated_at = now() where id = $1`,
      [form.id, status, opensAt, closesAt, slug, settings, roles]
    );
  } catch (err) {
    if (err && (err.code === '23505' || /unique/i.test(err.message || ''))) {
      throw new HttpError(409, 'Another form already uses this link', { field: 'slug' });
    }
    throw err;
  }
  await audit.record(user, 'form-settings', form.id, { status, roles: roles.length });
  return get(user, id);
}

/** Deletes a form: drafts without answers, or anything for forms_admin. */
async function remove(user, id) {
  const { form, who } = await formFor(user, id, 'manage', { fresh: true });
  const { rows } = await db.query(
    'select count(*)::int as n from form_responses where form_id = $1',
    [form.id]
  );
  if (rows[0].n && !who.perms.includes('forms_admin')) {
    throw new HttpError(409, 'This form has answers: close it instead, or ask a forms admin');
  }
  await db.query('delete from forms where id = $1', [form.id]);
  await audit.record(user, 'form-delete', form.id, { responses: rows[0].n });
}

/** What the editor needs besides the form: templates, question kinds, roles. */
async function meta(user) {
  await requireForms(user);
  let roles = [];
  try {
    roles = await permissions.guildRoles();
  } catch {
    // Without the Discord bot the roles cannot be listed; the editor says so.
  }
  return {
    templates: templates.list(),
    types: Object.entries(schemaLib.TYPES).map(([key, t]) => ({
      key,
      label: t.label,
      answer: t.answer,
    })),
    roles,
    // The address the registration form needs (see ./membership.js).
    joinSlug: membership.JOIN_SLUG,
  };
}

// ── The public side ──────────────────────────────────────────────────────────

async function bySlug(slug) {
  if (!SLUG.test(String(slug || ''))) throw new HttpError(404, 'No such form');
  const { rows } = await db.query('select * from forms where slug = $1', [slug]);
  if (!rows.length || rows[0].status === 'draft') throw new HttpError(404, 'No such form');
  return rows[0];
}

/** What the public page needs: the questions and a fresh token. */
async function publicView(slug) {
  const form = await bySlug(slug);
  const schema = await schemaOf(form.id, form.current_version);
  if (!isOpen(form)) {
    return { slug: form.slug, open: false, title: schema.title, languages: schema.languages };
  }
  return {
    slug: form.slug,
    open: true,
    version: form.current_version,
    schema,
    closesAt: form.closes_at,
    token: guard.issueToken(form.id),
  };
}

/**
 * A public submission: { version, token, answers, website (the honeypot) }.
 * Returns { ok, confirmation }. A bot gets the same answer and nothing is kept.
 */
async function submit(slug, body, ip) {
  const form = await bySlug(slug);
  if (!isOpen(form)) throw new HttpError(410, 'This form is closed');
  const b = body || {};
  const verdict = await guard.check({ formId: form.id, token: b.token, honeypot: b.website, ip });

  // The answers are checked against the version the person saw, if it exists.
  const asked = Number(b.version);
  const version =
    Number.isInteger(asked) && asked >= 1 && asked <= form.current_version
      ? asked
      : form.current_version;
  const schema = await schemaOf(form.id, version);
  const confirmation = schema.confirmation;
  if (verdict === 'bot') return { ok: true, confirmation };

  const { answers, email } = schemaLib.cleanAnswers(schema, b.answers);
  const respondentKey = email ? crm.personKey(email) : null;
  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  const onePerEmail = settings.oneResponsePerEmail && respondentKey;
  const id = crypto.randomUUID();
  // The answer and, for the sign-up form, the application on the members
  // board are written together: if the board refuses it, the person is told
  // and nothing is kept, rather than an answer nobody will ever review.
  await db.transaction(async (tx) => {
    if (onePerEmail) {
      // One submission at a time per form, so two sent together cannot both
      // pass the check below: the second waits, then sees the first.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [form.id]);
      const { rows } = await tx.query(
        'select 1 from form_responses where form_id = $1 and respondent_key = $2 and deleted_at is null',
        [form.id, respondentKey]
      );
      if (rows.length) throw new HttpError(409, 'This email has already answered this form');
    }
    await tx.query(
      `insert into form_responses (id, form_id, version, answers_encrypted, respondent_key)
       values ($1, $2, $3, $4, $5)`,
      [
        id,
        form.id,
        version,
        crm.encrypt(JSON.stringify(answers), `form:${form.id}:${id}`),
        respondentKey,
      ]
    );
    await toBoard(form, schema, settings, answers, tx);
  });
  return { ok: true, confirmation, responseId: id, formId: form.id };
}

/**
 * The registration form's answers also go to the members board, in the same
 * transaction as the answer (`q`): a failure fails the whole submission.
 */
async function toBoard(form, schema, settings, answers, q) {
  const mapping = membership.usable(schema, settings.membership);
  if (!mapping) return;
  const application = membership.toApplication(schema, mapping, answers);
  if (application) await members.createApplication(application, { source: form.slug, q });
}

/**
 * Tells the form's owner a new answer came, if they asked for it (the
 * setting) and the form has one (a form made with the admin password has
 * none). Says that someone answered, never what. Returns the channels used.
 */
async function notifyOwner(formId, origin) {
  const { rows } = await db.query('select id, title, owner_id, settings from forms where id = $1', [
    formId,
  ]);
  const form = rows[0];
  if (!form || !{ ...DEFAULT_SETTINGS, ...form.settings }.notifyOwner) return [];
  const message = notify.newFormAnswerMessage({ form, origin });
  // One shared address (General settings) when set, whoever owns the form.
  const shared = await mail.formsAddress();
  if (shared && (await mail.isConfigured())) {
    await mail.send({ to: shared, subject: message.subject, ...notify.render(message.lines) });
    return ['email'];
  }
  return form.owner_id ? notify.notifyUser(form.owner_id, message) : [];
}

// ── Answers ──────────────────────────────────────────────────────────────────

function openAnswers(form, row) {
  const text = crm.decrypt(row.answers_encrypted, `form:${form.id}:${row.id}`);
  if (text === null) return { unreadable: true };
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
}

/** Every answer to a form, decrypted, with the questions of each version. */
async function responses(user, id, { record = true } = {}) {
  const { form, who } = await formFor(user, id, 'read');
  const { rows } = await db.query(
    `select id, version, submitted_at, answers_encrypted, status from form_responses
     where form_id = $1 and deleted_at is null order by submitted_at desc`,
    [form.id]
  );
  const versions = {};
  for (const v of new Set(rows.map((r) => r.version).concat(form.current_version))) {
    versions[v] = await schemaOf(form.id, v);
  }
  // An export reads the answers too, but writes its own line, not this one.
  if (record) await audit.record(user, 'form-view-responses', form.id, { count: rows.length });
  return {
    form: summary(form),
    currentVersion: form.current_version,
    versions,
    statuses: RESPONSE_STATUSES,
    // Deleting answers and exporting them: the form's managers only.
    canManage: canManage(user, who, form),
    responses: rows.map((r) => ({
      id: r.id,
      version: r.version,
      submittedAt: r.submitted_at,
      status: r.status,
      answers: openAnswers(form, r),
    })),
  };
}

async function responseOf(form, responseId) {
  if (!UUID.test(String(responseId || ''))) throw new HttpError(404, 'No such answer');
  const { rows } = await db.query(
    'select id from form_responses where id = $1 and form_id = $2 and deleted_at is null',
    [responseId, form.id]
  );
  if (!rows.length) throw new HttpError(404, 'No such answer');
  return rows[0];
}

/** Moves one answer along: new, reviewing, accepted, rejected. Readers may. */
async function setResponseStatus(user, id, responseId, status) {
  const { form } = await formFor(user, id, 'read', { fresh: true });
  await responseOf(form, responseId);
  if (!RESPONSE_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
  await db.query('update form_responses set status = $3 where id = $1 and form_id = $2', [
    responseId,
    form.id,
    status,
  ]);
  await audit.record(user, 'form-review', responseId, { status });
  return { id: responseId, status };
}

/**
 * Deletes one answer for good (a person asking to be forgotten, a test, a
 * duplicate): the row goes, with its encrypted answers. Managers only.
 */
async function deleteResponse(user, id, responseId) {
  const { form } = await formFor(user, id, 'manage', { fresh: true });
  await responseOf(form, responseId);
  await db.query('delete from form_responses where id = $1 and form_id = $2', [
    responseId,
    form.id,
  ]);
  await audit.record(user, 'form-delete-response', responseId, { form: form.id });
  return { ok: true };
}

// A cell a spreadsheet would run as a formula starts with one of these: a
// leading apostrophe makes it text (OWASP "CSV injection").
const FORMULA = /^[=+\-@\t\r]/;

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Every answer as CSV, one column per question of any version (the current
 * ones first), for the form's managers. Written on the audit trail.
 */
async function exportCsv(user, id) {
  const { form } = await formFor(user, id, 'manage', { fresh: true });
  const data = await responses(user, id, { record: false });
  const columns = [];
  const seen = new Set();
  const newestFirst = Object.keys(data.versions)
    .map(Number)
    .sort((a, b) => b - a);
  for (const v of newestFirst) {
    const schema = data.versions[v];
    for (const item of schemaLib.answerable(schema)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      columns.push({
        id: item.id,
        label: schemaLib.textIn(schema, item.label, schema.languages[0]),
      });
    }
  }
  const lines = [['Submitted', 'Status', 'Version', ...columns.map((c) => c.label)]];
  for (const r of data.responses.slice().reverse()) {
    const schema = data.versions[r.version];
    const cells = columns.map((c) => {
      if (r.answers.unreadable) return '(cannot be opened)';
      const item = schema.items.find((i) => i.id === c.id);
      const value = r.answers[c.id];
      return item && value !== undefined ? schemaLib.answerText(schema, item, value) : '';
    });
    lines.push([new Date(r.submittedAt).toISOString(), r.status, r.version, ...cells]);
  }
  await audit.record(user, 'form-export', form.id, { count: data.responses.length });
  return {
    filename: `${form.slug}-answers.csv`,
    // The BOM lets Excel read the accents as UTF-8.
    csv: '\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n',
  };
}

module.exports = {
  STATUSES,
  RESPONSE_STATUSES,
  setResponseStatus,
  deleteResponse,
  exportCsv,
  DEFAULT_SETTINGS,
  isOpen,
  list,
  get,
  create,
  saveSchema,
  updateSettings,
  remove,
  publicView,
  submit,
  notifyOwner,
  responses,
  requireForms,
  meta,
};
