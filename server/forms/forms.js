// Forms: making them, opening them to the public, and the answers they get.
//
// Who may do what (checked here, on every call, never only in the page):
//   - manage a form (edit, settings, delete): its owner while they hold the
//     `forms` permission, or anyone with `forms_admin`;
//   - read its answers: whoever may manage it, or whoever holds one of the
//     Discord roles listed in the form's access_roles (say, the mentorship
//     team for the mentor applications).
// Every signed-in call needs a sign-in less than a day old, and the Discord
// roles are re-read when older than five minutes (server/crm/access.js).
//
// Answers are encrypted (server/crm/crypto.js) bound to their form and
// response, so one cannot be moved onto another form or response.

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../http');
const permissions = require('../permissions');
const access = require('../crm/access');
const crm = require('../crm/crypto');
const audit = require('../crm/audit');
const schemaLib = require('./schema');
const guard = require('./guard');

const STATUSES = ['draft', 'open', 'closed'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[\w-]{1,40}$/;
const DEFAULT_SETTINGS = {
  oneResponsePerEmail: false,
  retentionMonths: 24,
  notifyOwner: true,
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

function starterSchema(title) {
  return {
    languages: ['it'],
    title: { it: title },
    description: {},
    confirmation: { it: 'Grazie! Abbiamo ricevuto le tue risposte.' },
    items: [
      { id: 'name', type: 'short_text', label: { it: 'Nome e cognome' }, required: true },
      { id: 'email', type: 'email', label: { it: 'Email' }, required: true },
    ],
  };
}

/** A new draft, owned by the user. `schema` may come from a template. */
async function create(user, body) {
  await requireForms(user, { fresh: true });
  const b = body || {};
  const title = String(b.title || '')
    .trim()
    .slice(0, 200);
  if (!title) throw new HttpError(400, 'Give the form a title', { field: 'title' });
  const schema = schemaLib.cleanSchema(b.schema || starterSchema(title));
  const base = slugify(title) || 'form';
  for (let n = 0; n < 10; n++) {
    // A short random tail: links are not guessable from the title alone.
    const slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      const id = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `insert into forms (slug, title, settings, owner_id) values ($1, $2, $3, $4) returning id`,
          [slug, title, DEFAULT_SETTINGS, user.kind === 'admin' ? null : user.id]
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
  if (s.retentionMonths !== undefined) {
    const n = Number(s.retentionMonths);
    if (!Number.isInteger(n) || n < 1 || n > 120)
      throw new HttpError(400, 'Keep answers 1 to 120 months', { field: 'retentionMonths' });
    settings.retentionMonths = n;
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
  if (settings.oneResponsePerEmail && respondentKey) {
    const { rows } = await db.query(
      'select 1 from form_responses where form_id = $1 and respondent_key = $2 and deleted_at is null',
      [form.id, respondentKey]
    );
    if (rows.length) throw new HttpError(409, 'This email has already answered this form');
  }
  const id = crypto.randomUUID();
  await db.query(
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
  return { ok: true, confirmation, responseId: id, formId: form.id };
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
async function responses(user, id) {
  const { form } = await formFor(user, id, 'read');
  const { rows } = await db.query(
    `select id, version, submitted_at, answers_encrypted, status from form_responses
     where form_id = $1 and deleted_at is null order by submitted_at desc`,
    [form.id]
  );
  const versions = {};
  for (const v of new Set(rows.map((r) => r.version).concat(form.current_version))) {
    versions[v] = await schemaOf(form.id, v);
  }
  await audit.record(user, 'form-view-responses', form.id, { count: rows.length });
  return {
    form: summary(form),
    currentVersion: form.current_version,
    versions,
    responses: rows.map((r) => ({
      id: r.id,
      version: r.version,
      submittedAt: r.submitted_at,
      status: r.status,
      answers: openAnswers(form, r),
    })),
  };
}

module.exports = {
  STATUSES,
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
  responses,
  requireForms,
};
