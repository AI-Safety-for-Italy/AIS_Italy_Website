// Forms: making them, opening them to the public, and the answers they get.
//
// Who may do what (checked here, on every call, never only in the page):
//   - own a form (delete it, choose who else edits it): its owner while they
//     hold the `forms` permission, or anyone with `forms_admin`;
//   - manage a form (questions, settings, exporting and deleting answers):
//     whoever owns it, and the people added by name with "Can edit";
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
const records = require('../crm/records');
const sources = require('../crm/sources');
const members = require('../members');
const notify = require('../notify');
const mail = require('../mail');
const copyEmail = require('./copy-email');

const STATUSES = ['draft', 'open', 'closed'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[\w-]{1,40}$/;
const DEFAULT_SETTINGS = {
  oneResponsePerEmail: false,
  notifyOwner: true,
  // Email the person a copy of their answers, at the form's first email
  // question. On unless the form's managers switch it off.
  sendCopy: true,
  // Members of the Discord server who read the answers by name, besides the
  // roles ticked on the form: [{ discordId, name, edit? }]. Chosen by its
  // managers; `edit: true` lets them change the form too, given by its owners.
  readers: [],
  // Each reader's own choice about hearing of new answers, by Discord id:
  // { id: true | false }. Without one, a reader added by name hears of them
  // and the rest (roles, forms admins) do not. The owner's is notifyOwner.
  notifyChoices: {},
  // The tags the team puts on answers ([{ key, label }]); null: the default.
  tags: null,
  // The community's registration form: see ./membership.js. null for any other.
  membership: null,
  // The mentorship board list the answers also go to (server/crm/sources.js), or null.
  crm: null,
};

const CRM_LISTS = ['mentors_applications', 'mentees_interest', 'mentees_applications'];
const MAX_READERS = 25;
const DEFAULT_TAGS = [
  { key: 'new', label: 'New' },
  { key: 'seen', label: 'Seen' },
];
const MAX_TAGS = 12;
const DISCORD_ID = /^[\w-]{1,40}$/;

/** People added by name, as sent by the editor: checked and capped. */
function cleanPeople(list) {
  if (!Array.isArray(list))
    throw new HttpError(400, 'Expected a list of people', { field: 'readers' });
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const discordId = String((p && p.discordId) || '');
    if (!DISCORD_ID.test(discordId))
      throw new HttpError(400, 'Unknown person', { field: 'readers' });
    if (seen.has(discordId)) continue;
    seen.add(discordId);
    const person = {
      discordId,
      name: String((p && p.name) || discordId)
        .trim()
        .slice(0, 100),
    };
    if (p && p.edit === true) person.edit = true;
    out.push(person);
  }
  if (out.length > MAX_READERS)
    throw new HttpError(400, `At most ${MAX_READERS} people`, { field: 'readers' });
  return out;
}

/** The tags a form's answers can carry. */
function tagsOf(form) {
  const t = (form.settings && form.settings.tags) || null;
  return Array.isArray(t) && t.length ? t : DEFAULT_TAGS;
}

// ── Who is asking ────────────────────────────────────────────────────────────

/** A recent sign-in and fresh-enough roles: { perms, roles }. */
async function whoIs(user, { fresh = false } = {}) {
  await access.requireRecentLogin(user);
  if (fresh) await permissions.refreshRoles(user);
  else await permissions.refreshIfStale(user);
  return {
    perms: await permissions.forUser(user),
    roles: await permissions.rolesOf(user),
    discordId: await discordIdOf(user),
  };
}

/** A user's Discord id (none for the shared admin). */
async function discordIdOf(user) {
  if (!user || user.kind !== 'discord') return null;
  // The row auth.currentUser read for this request, when there is one.
  if (user.row) return user.row.discord_id || null;
  const { rows } = await db.query('select discord_id from app_users where id = $1', [user.id]);
  return (rows[0] && rows[0].discord_id) || null;
}

/**
 * Whether this user hears about the form's new answers: true / false, or
 * null when they cannot (the shared admin has no channel of its own).
 */
function notifyMeOf(form, user, who) {
  if (!user || user.kind !== 'discord') return null;
  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  if (form.owner_id === user.id) return Boolean(settings.notifyOwner);
  // Seeing the answers is not following them: only an explicit "on" tells.
  return (settings.notifyChoices || {})[who.discordId] === true;
}

/** Whether this Discord id was added to the form's readers by name. */
function addedReader(form, discordId) {
  const readers = (form.settings && form.settings.readers) || [];
  return Boolean(discordId) && readers.some((p) => p.discordId === discordId);
}

/** Whether this Discord id was added by name with "Can edit". */
function addedEditor(form, discordId) {
  const readers = (form.settings && form.settings.readers) || [];
  return Boolean(discordId) && readers.some((p) => p.discordId === discordId && p.edit === true);
}

/** Deletes the form, chooses who edits it: its owner, or a forms admin. */
function canOwn(user, who, form) {
  if (who.perms.includes('forms_admin')) return true;
  return who.perms.includes('forms') && Boolean(form.owner_id) && form.owner_id === user.id;
}

/** Changes the form and handles its answers: its owners, and its editors. */
function canManage(user, who, form) {
  return canOwn(user, who, form) || addedEditor(form, who.discordId);
}

function canRead(user, who, form) {
  if (canManage(user, who, form)) return true;
  if (addedReader(form, who.discordId)) return true;
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
  return withLiveOptions(rows[0].schema);
}

/**
 * A question whose options come from elsewhere (`optionsFrom`) gets them as
 * they are now: the working groups, so the sign-up form follows them.
 */
async function withLiveOptions(schema) {
  if (!schema || !schema.items.some((i) => i.optionsFrom)) return schema;
  const groups = await require('../community').listGroups();
  const options = groups.map((g) => ({ id: g.id, label: { it: g.titleIt, en: g.titleEn } }));
  return {
    ...schema,
    items: schema.items.map((i) => (i.optionsFrom === 'work_groups' ? { ...i, options } : i)),
  };
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
  const visible = rows.filter((f) => canRead(user, who, f));
  const people = await accessContext(visible);
  return visible.map((f) => ({
    ...summary(f, { responses: f.responses, last: f.last, canManage: canManage(user, who, f) }),
    notifyMe: notifyMeOf(f, user, who),
    access: accessOf(f, people),
  }));
}

/** What accessOf needs, read once for a list of forms. */
async function accessContext(forms) {
  const ids = [...new Set(forms.map((f) => f.owner_id).filter(Boolean))];
  const owners = {};
  if (ids.length) {
    const { rows } = await db.query(
      'select id, name, avatar_url, discord_id from app_users where id = any($1)',
      [ids]
    );
    rows.forEach((r) => (owners[r.id] = r));
  }
  const discordIds = [
    ...new Set(
      forms.flatMap((f) => ((f.settings && f.settings.readers) || []).map((p) => p.discordId))
    ),
  ];
  const avatars = {};
  if (discordIds.length) {
    const { rows } = await db.query(
      'select discord_id, avatar_url from app_users where discord_id = any($1)',
      [discordIds]
    );
    rows.forEach((r) => (avatars[r.discord_id] = r.avatar_url));
  }
  const roles = await permissions.listRolePermissions();
  const roleName = {};
  roles.forEach((r) => (roleName[r.roleId] = r.roleName));
  const has = (p) => p.permissions.includes('forms_admin');
  return {
    owners,
    avatars,
    roleName,
    allFormsRoles: roles.filter(has).map((r) => r.roleName),
    allFormsPeople: (await permissions.listUserPermissions()).filter(has),
  };
}

/**
 * Who can see a form's answers, for the faces on its card: [{ kind: 'person'
 * | 'role', name, avatarUrl, what }]. `what` says why, and whether they are
 * told about new answers.
 */
function accessOf(form, ctx) {
  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  const choices = settings.notifyChoices || {};
  const out = [];
  const owner = form.owner_id && ctx.owners[form.owner_id];
  if (owner) {
    out.push({
      kind: 'person',
      name: owner.name,
      avatarUrl: owner.avatar_url,
      what: 'Owner' + (settings.notifyOwner ? ' · notified' : ''),
    });
  }
  (settings.readers || []).forEach((p) => {
    if (owner && owner.discord_id === p.discordId) return;
    out.push({
      kind: 'person',
      name: p.name,
      avatarUrl: ctx.avatars[p.discordId] || null,
      what:
        (p.edit === true ? 'Edits the form' : 'Reads the answers') +
        (choices[p.discordId] === true ? ' · notified' : ''),
    });
  });
  (form.access_roles || []).forEach((id) =>
    out.push({ kind: 'role', name: ctx.roleName[id] || id, what: 'Role: reads the answers' })
  );
  ctx.allFormsRoles.forEach((name) =>
    out.push({ kind: 'role', name, what: 'Role: manages every form' })
  );
  ctx.allFormsPeople.forEach((p) => {
    if (out.some((o) => o.kind === 'person' && o.name === p.name)) return;
    out.push({ kind: 'person', name: p.name, avatarUrl: p.avatarUrl, what: 'Manages every form' });
  });
  return out;
}
/** Who can read a form's answers today besides the roles ticked on it (names only). */
async function readersOf(form) {
  let owner = null;
  if (form.owner_id) {
    const { rows } = await db.query('select name from app_users where id = $1', [form.owner_id]);
    owner = rows.length ? rows[0].name : null;
  }
  const has = (p) => p.permissions.includes('forms_admin');
  const roles = (await permissions.listRolePermissions()).filter(has);
  const people = (await permissions.listUserPermissions()).filter(has);
  return {
    owner,
    allFormsRoles: roles.map((r) => r.roleName),
    // So the editor shows these roles ticked and locked: they read every form.
    allFormsRoleIds: roles.map((r) => r.roleId),
    allFormsPeople: people.map((p) => p.name),
    allFormsAvatars: people.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl || null })),
  };
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
    // Only for those who change the form: the people who read it are theirs to know.
    ...(canManage(user, who, form) ? { readers: await readersOf(form) } : {}),
    // Whether this user may delete the form and choose who edits it.
    canOwn: canOwn(user, who, form),
    notifyMe: notifyMeOf(form, user, who),
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
  const crmList = b.schema ? null : templates.crmFor(b.template);
  if (crmList && who.perms.includes('forms_admin')) settings.crm = crmList;
  // A template's own address is one the site links to: forms admins only.
  const ownSlug =
    b.schema || !who.perms.includes('forms_admin') ? null : templates.slugFor(b.template);
  for (let n = 0; n < 10; n++) {
    // A short random tail: links are not guessable from the title alone. The
    // registration form first tries the address the site's join buttons open.
    const slug =
      n === 0 && settings.membership
        ? membership.JOIN_SLUG
        : n === 0 && ownSlug
        ? ownSlug
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
  // The registration form keeps its link to the member applications only
  // while its name, email and role questions still fit (./membership.js).
  if (form.settings && form.settings.membership) membership.clean(schema, form.settings.membership);
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
  const { form, who } = await formFor(user, id, 'manage', { fresh: true });
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
    // The addresses the site's buttons open: whoever took one would collect
    // the sign-ups or the applications in a form only they can read.
    const reserved = [membership.JOIN_SLUG, ...templates.reservedSlugs()];
    if (reserved.includes(b.slug) && !who.perms.includes('forms_admin'))
      throw new HttpError(403, 'Only a forms admin can give a form this link', { field: 'slug' });
    slug = b.slug;
  }

  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  const s = b.settings || {};
  if (s.oneResponsePerEmail !== undefined)
    settings.oneResponsePerEmail = Boolean(s.oneResponsePerEmail);
  if (s.notifyOwner !== undefined) settings.notifyOwner = Boolean(s.notifyOwner);
  if (s.sendCopy !== undefined) settings.sendCopy = Boolean(s.sendCopy);
  if (s.readers !== undefined) {
    // People who read the answers by name: the form's managers choose them,
    // as they tick the roles below. Who edits it is for its owners only.
    const next = cleanPeople(s.readers);
    if (!canOwn(user, who, form)) {
      const editors = (list) =>
        list
          .filter((p) => p.edit === true)
          .map((p) => p.discordId)
          .sort()
          .join(',');
      if (editors(next) !== editors(settings.readers || []))
        throw new HttpError(
          403,
          'Only the form’s owner, or whoever holds “Forms: all forms”, chooses who edits it',
          { field: 'readers' }
        );
    }
    settings.readers = next;
  }
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
          'Only whoever holds “Forms: all forms” can link a form to the member applications',
          {
            field: 'membership',
          }
        );
    }
    settings.membership = next;
  }

  if (s.crm !== undefined) {
    const next = s.crm || null;
    if (next !== null && !CRM_LISTS.includes(next))
      throw new HttpError(400, 'Unknown mentorship list', { field: 'crm' });
    if (next !== (settings.crm || null)) {
      // Like the members board: a door into the people the program contacts.
      const who = await whoIs(user);
      if (!who.perms.includes('forms_admin'))
        throw new HttpError(
          403,
          'Only whoever holds “Forms: all forms” can link a form to the mentorship board',
          {
            field: 'crm',
          }
        );
    }
    settings.crm = next;
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
  if (!canOwn(user, who, form))
    throw new HttpError(
      403,
      'Only the form’s owner, or whoever holds “Forms: all forms”, deletes it'
    );
  const { rows } = await db.query(
    'select count(*)::int as n from form_responses where form_id = $1',
    [form.id]
  );
  if (rows[0].n && !who.perms.includes('forms_admin')) {
    throw new HttpError(
      409,
      'This form has answers: close it instead, or ask whoever holds “Forms: all forms”'
    );
  }
  await db.query('delete from forms where id = $1', [form.id]);
  await audit.record(user, 'form-delete', form.id, { responses: rows[0].n });
}

/** What the editor needs besides the form: templates, question kinds, roles. */
async function meta(user) {
  // Also for the editors added by name, who may hold no forms permission.
  const who = await whoIs(user);
  if (!who.perms.includes('forms') && !who.perms.includes('forms_admin') && !(await readsAny(user)))
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
  let application = false;
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
    application = await toBoard(form, schema, settings, answers, id, tx);
    if (settings.crm) await toMentorship(settings.crm, schema, answers, id, tx);
  });
  // The copy is built here, from the cleaned answers, and only sent by the
  // caller (api/form.js): it never travels back to the page.
  const copy = settings.sendCopy && email ? copyEmail.copyOf(schema, answers, email) : null;
  return { ok: true, confirmation, responseId: id, formId: form.id, copy, application };
}

/**
 * Sends the copy from submit(), if the mailbox is set up; `origin` is the
 * site, for the logo (server/forms/copy-email.js). Returns whether it went.
 */
async function sendCopy(copy, origin, formId) {
  if (!copy || !(await mail.isConfigured())) return false;
  // One copy a day per address and form: the copy must not become a way to
  // mail any text to anyone from our mailbox. Noted with the sending limits
  // (form_submit_attempts, emptied after a day), under the address's key.
  if (formId) {
    const mark = `copy:${crm.personKey(copy.to)}`;
    const { rows } = await db.query(
      `select 1 from form_submit_attempts
       where ip_hash = $1 and form_id = $2 and at > now() - interval '1 day'`,
      [mark, formId]
    );
    if (rows.length) return false;
    await db.query('insert into form_submit_attempts (ip_hash, form_id) values ($1, $2)', [
      mark,
      formId,
    ]);
  }
  const email = copyEmail.render(copy, origin);
  await mail.send({ to: copy.to, ...email });
  return true;
}

/**
 * The registration form's answers also go to the members board, in the same
 * transaction as the answer (`q`): a failure fails the whole submission.
 */
async function toBoard(form, schema, settings, answers, responseId, q) {
  const mapping = membership.usable(schema, settings.membership);
  if (!mapping) return false;
  const application = membership.toApplication(schema, mapping, answers);
  if (!application) return false;
  await members.createApplication(application, { source: form.slug, responseId, q });
  return true;
}

/**
 * The answer also goes to the mentorship board (server/crm/records.js): each
 * field of the list is the answer to the question with that id.
 */
async function toMentorship(sourceId, schema, answers, responseId, q) {
  const fields = {};
  for (const name of Object.keys(sources.SOURCES[sourceId].fields)) {
    const item = schema.items.find((i) => i.id === name);
    fields[name] =
      item && answers[name] !== undefined ? schemaLib.answerText(schema, item, answers[name]) : '';
  }
  await records.add(sourceId, fields, { origin: 'form', responseId, q });
}

/**
 * Tells about a new answer whoever follows the form (notifyMeOf): the owner
 * unless they switched it off, and whoever else reads the answers (by name,
 * by role, forms admins) and switched it on; seeing a form is not following
 * it. Each on their own channels. Says that someone answered, never what. A
 * shared address in General settings stands in for the owner. Returns the
 * channels used.
 */
async function notifyOwner(formId, origin) {
  const { rows } = await db.query('select * from forms where id = $1', [formId]);
  const form = rows[0];
  if (!form) return [];
  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  const message = notify.newFormAnswerMessage({ form, origin });
  const used = new Set();
  const told = new Set();
  const add = (channels) => channels.forEach((c) => used.add(c));
  async function safely(fn) {
    try {
      add(await fn());
    } catch (err) {
      console.error('Notification failed', err.message);
    }
  }

  if (settings.notifyOwner) {
    // One shared address (General settings) when set, whoever owns the form.
    const shared = await mail.formsAddress();
    if (shared && (await mail.isConfigured())) {
      await mail.send({ to: shared, subject: message.subject, ...notify.render(message.lines) });
      used.add('email');
    } else if (form.owner_id) {
      await safely(() => notify.notifyUser(form.owner_id, message));
    }
  }
  if (form.owner_id) {
    const owner = await db.query('select discord_id from app_users where id = $1', [form.owner_id]);
    if (owner.rows[0] && owner.rows[0].discord_id) told.add(owner.rows[0].discord_id);
  }

  const choices = settings.notifyChoices || {};
  // Everyone else who follows it, if they still read the answers.
  for (const [discordId, on] of Object.entries(choices)) {
    if (!on || told.has(discordId)) continue;
    const { rows: found } = await db.query(`select id, kind from app_users where discord_id = $1`, [
      discordId,
    ]);
    if (!found[0]) continue;
    const reader = { id: found[0].id, kind: found[0].kind };
    const who = {
      perms: await permissions.forUser(reader),
      roles: await permissions.rolesOf(reader),
      discordId,
    };
    if (!canRead(reader, who, form)) continue;
    told.add(discordId);
    await safely(() => notify.notifyUser(reader.id, message));
  }
  return [...used];
}

/**
 * Whether this user reads the answers of some form without holding a forms
 * permission (added by name, or through a role ticked on a form): then the
 * forms tool opens for them too (api/auth.js).
 */
async function readsAny(user) {
  if (!user || user.kind !== 'discord') return false;
  const { rows } = await db.query('select discord_id, roles from app_users where id = $1', [
    user.id,
  ]);
  if (!rows[0]) return false;
  const { rows: found } = await db.query(
    `select 1 from forms where access_roles && $1::text[]
       or settings -> 'readers' @> $2::jsonb limit 1`,
    [rows[0].roles || [], JSON.stringify([{ discordId: rows[0].discord_id || '' }])]
  );
  return found.length > 0;
}

/**
 * New answers to the forms this user follows (and still reads): the count
 * on their home page. Seeing a form without following it adds nothing.
 */
async function followedNewAnswers(user) {
  if (!user || user.kind !== 'discord') return 0;
  const who = {
    perms: await permissions.forUser(user),
    roles: await permissions.rolesOf(user),
    discordId: await discordIdOf(user),
  };
  const { rows } = await db.query(
    `select f.*, count(r.id) filter (where r.status = 'new' and r.deleted_at is null)::int as fresh
     from forms f left join form_responses r on r.form_id = f.id group by f.id`
  );
  return rows
    .filter((f) => f.fresh && canRead(user, who, f) && notifyMeOf(f, user, who))
    .reduce((n, f) => n + f.fresh, 0);
}

/**
 * The forms this user reads, with whether they follow each, for the
 * Settings page: [{ id, title, notifyMe }]. Titles only, and no recent
 * sign-in asked: switching one still asks for it.
 */
async function followable(user) {
  if (!user || user.kind !== 'discord') return [];
  const who = {
    perms: await permissions.forUser(user),
    roles: await permissions.rolesOf(user),
    discordId: await discordIdOf(user),
  };
  const { rows } = await db.query('select * from forms order by lower(title)');
  return rows
    .filter((f) => canRead(user, who, f))
    .map((f) => ({ id: f.id, title: f.title, notifyMe: notifyMeOf(f, user, who) }));
}

/** Switches this user's own notifications for one form they read on or off. */
async function setNotifyMe(user, id, on) {
  const { form, who } = await formFor(user, id, 'read');
  if (notifyMeOf(form, user, who) === null)
    throw new HttpError(400, 'This account has no channel to be told on');
  const settings = { ...DEFAULT_SETTINGS, ...form.settings };
  if (form.owner_id === user.id) settings.notifyOwner = Boolean(on);
  else settings.notifyChoices = { ...settings.notifyChoices, [who.discordId]: Boolean(on) };
  await db.query('update forms set settings = $2 where id = $1', [form.id, settings]);
  await audit.record(user, 'form-notify-me', form.id, { on: Boolean(on) });
  return { id: form.id, notifyMe: Boolean(on) };
}
/** Members of the Discord server to add to a form's readers: its managers. */
async function searchPeople(user, id, query) {
  await formFor(user, id, 'manage');
  return { people: await permissions.searchMembers(query) };
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
  const wanted = [...new Set(rows.map((r) => r.version).concat(form.current_version))];
  const schemas = await Promise.all(wanted.map((v) => schemaOf(form.id, v)));
  wanted.forEach((v, i) => {
    versions[v] = schemas[i];
  });
  // An export reads the answers too, but writes its own line, not this one.
  if (record) await audit.record(user, 'form-view-responses', form.id, { count: rows.length });
  return {
    form: summary(form),
    currentVersion: form.current_version,
    versions,
    // The form's tags, then any an answer still carries from before
    // (a tag since removed, or the old fixed ones), so none is hidden.
    statuses: tagsOf(form).concat(
      [...new Set(rows.map((r) => r.status))]
        .filter((key) => !tagsOf(form).some((t) => t.key === key))
        .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), old: true }))
    ),
    canEditTags: canRead(user, who, form),
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

// ── For the mentee selection (server/crm/review.js) ─────────────────────────
// The selection reads a form chosen by its admins: they may choose one they
// can read here, or one feeding the mentee applications on the board. These
// do not check who asks: review.js does, before calling them.

/** The forms an admin of the selection may pick: [{ id, title, status, responses, board }]. */
async function forReview(user) {
  const who = await whoIs(user);
  const { rows } = await db.query(
    `select f.*, count(r.id) filter (where r.deleted_at is null)::int as responses
     from forms f left join form_responses r on r.form_id = f.id
     group by f.id order by f.updated_at desc`
  );
  return rows
    .filter(
      (f) => canRead(user, who, f) || (f.settings && f.settings.crm === 'mentees_applications')
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      responses: f.responses,
      board: Boolean(f.settings && f.settings.crm === 'mentees_applications'),
    }));
}

/**
 * Every question a form ever asked that takes an answer, the current
 * version's first and in its order: [{ id, label, type }]. null: no such form.
 */
async function questionsOf(formId) {
  if (!UUID.test(String(formId || ''))) return null;
  const { rows } = await db.query(
    'select schema from form_versions where form_id = $1 order by version desc',
    [formId]
  );
  if (!rows.length) return null;
  const out = [];
  const seen = new Set();
  rows.forEach(({ schema }) => {
    schemaLib.answerable(schema).forEach((item) => {
      // A consent ticked is nothing to review.
      if (seen.has(item.id) || item.type === 'consent') return;
      seen.add(item.id);
      out.push({
        id: item.id,
        label: schemaLib.textIn(schema, item.label, schema.languages[0]) || item.id,
        type: item.type,
      });
    });
  });
  return out;
}

/**
 * The answers to a form as text, newest first: [{ id, submittedAt,
 * respondentKey, texts: { questionId: text } }]. Unreadable ones are left out.
 */
async function answerTexts(formId) {
  if (!UUID.test(String(formId || ''))) return [];
  const form = await loadForm(formId).catch(() => null);
  if (!form) return [];
  const { rows } = await db.query(
    `select id, version, submitted_at, answers_encrypted, respondent_key from form_responses
     where form_id = $1 and deleted_at is null order by submitted_at desc`,
    [form.id]
  );
  const schemas = {};
  for (const v of new Set(rows.map((r) => r.version))) {
    schemas[v] = await schemaOf(form.id, v).catch(() => null);
  }
  const out = [];
  rows.forEach((r) => {
    const answers = openAnswers(form, r);
    const schema = schemas[r.version];
    if (answers.unreadable || !schema) return;
    const texts = {};
    schemaLib.answerable(schema).forEach((item) => {
      if (answers[item.id] === undefined || answers[item.id] === null) return;
      texts[item.id] = schemaLib.answerText(schema, item, answers[item.id]);
    });
    out.push({ id: r.id, submittedAt: r.submitted_at, respondentKey: r.respondent_key, texts });
  });
  return out;
}

/** Puts one of the form's tags on an answer. Readers may. */
async function setResponseStatus(user, id, responseId, status) {
  const { form } = await formFor(user, id, 'read', { fresh: true });
  await responseOf(form, responseId);
  if (!tagsOf(form).some((t) => t.key === status)) throw new HttpError(400, 'Unknown tag');
  await db.query('update form_responses set status = $3 where id = $1 and form_id = $2', [
    responseId,
    form.id,
    status,
  ]);
  await audit.record(user, 'form-review', responseId, { status });
  return { id: responseId, status };
}

/**
 * Adds a tag ({ add: label }) or removes one ({ remove: key }) from those
 * the form's answers can carry. Whoever reads the answers may. "New" stays,
 * and a tag still on an answer cannot go. Returns { tags }.
 */
async function editTags(user, id, body) {
  const { form } = await formFor(user, id, 'read', { fresh: true });
  const tags = tagsOf(form).slice();
  const b = body || {};
  if (b.add !== undefined) {
    const label = String(b.add).replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!label) throw new HttpError(400, 'Give the tag a name', { field: 'tag' });
    const key = slugify(label).slice(0, 30);
    if (!key) throw new HttpError(400, 'Use letters or digits in the name', { field: 'tag' });
    if (tags.some((t) => t.key === key))
      throw new HttpError(409, 'There is a tag with this name already', { field: 'tag' });
    if (tags.length >= MAX_TAGS)
      throw new HttpError(400, `At most ${MAX_TAGS} tags`, { field: 'tag' });
    tags.push({ key, label });
  } else if (b.remove !== undefined) {
    const key = String(b.remove);
    if (key === 'new') throw new HttpError(400, '“New” is where every answer starts');
    if (!tags.some((t) => t.key === key)) throw new HttpError(404, 'No such tag');
    const { rows } = await db.query(
      'select count(*)::int as n from form_responses where form_id = $1 and status = $2 and deleted_at is null',
      [form.id, key]
    );
    if (rows[0].n)
      throw new HttpError(
        409,
        rows[0].n === 1
          ? 'One answer has this tag: move it first'
          : `${rows[0].n} answers have this tag: move them first`
      );
    tags.splice(
      tags.findIndex((t) => t.key === key),
      1
    );
  } else {
    throw new HttpError(400, 'Add or remove a tag');
  }
  const settings = { ...DEFAULT_SETTINGS, ...form.settings, tags };
  await db.query('update forms set settings = $2 where id = $1', [form.id, settings]);
  await audit.record(user, 'form-tags', form.id, { count: tags.length });
  return { tags };
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
  setResponseStatus,
  editTags,
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
  searchPeople,
  setNotifyMe,
  readsAny,
  followedNewAnswers,
  followable,
  sendCopy,
  responses,
  requireForms,
  meta,
  forReview,
  questionsOf,
  answerTexts,
};
