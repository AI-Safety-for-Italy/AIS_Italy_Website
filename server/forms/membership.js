// A form can be the community's registration form: each answer then also goes
// to the member applications board (server/members.js), where it is approved
// or rejected. Which questions are the person's name, email and the role they
// ask for is a setting of the form, `settings.membership`:
//
//   { nameItem, surnameItem, emailItem, roleItem, roles }
//
// nameItem / surnameItem   short answers (surnameItem optional)
// emailItem                an email question
// roleItem                 a single choice or drop-down (optional)
// roles                    { optionId: 'participant' | 'organizer' } for the
//                          options of roleItem; other options ask for no role
//
// The answers are also kept, encrypted, with the form like any other form's.
const { HttpError } = require('../http');
const schemaLib = require('./schema');

const ROLES = ['participant', 'organizer'];
// The address the site's join buttons open (src/data/site.js, forms.mailingList):
// the registration form must have it, or those buttons find no form.
const JOIN_SLUG = 'iscrizione';

function item(schema, id) {
  return schema.items.find((i) => i.id === id);
}

function need(schema, id, types, label, required) {
  if (id === undefined || id === null || id === '') {
    if (required) throw new HttpError(400, `Choose the ${label} question`, { field: 'membership' });
    return null;
  }
  const found = item(schema, String(id));
  if (!found || !types.includes(found.type)) {
    throw new HttpError(400, `The ${label} question must be one of: ${types.join(', ')}`, {
      field: 'membership',
    });
  }
  return found.id;
}

/** Checks a mapping against the form's questions -> a clean mapping, or null. */
function clean(schema, input) {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, 'Invalid sign-up settings', { field: 'membership' });
  const mapping = {
    nameItem: need(schema, input.nameItem, ['short_text'], 'name', true),
    surnameItem: need(schema, input.surnameItem, ['short_text'], 'surname', false),
    emailItem: need(schema, input.emailItem, ['email'], 'email', true),
    roleItem: need(schema, input.roleItem, ['single', 'dropdown'], 'role', false),
    roles: {},
  };
  if (mapping.nameItem === mapping.surnameItem) mapping.surnameItem = null;
  if (mapping.roleItem) {
    const options = new Set(item(schema, mapping.roleItem).options.map((o) => o.id));
    const roles = input.roles && typeof input.roles === 'object' ? input.roles : {};
    for (const [optionId, role] of Object.entries(roles)) {
      if (!role) continue;
      if (!options.has(optionId) || !ROLES.includes(role))
        throw new HttpError(400, 'Invalid role for an option', { field: 'membership' });
      mapping.roles[optionId] = role;
    }
  }
  return mapping;
}

/** The mapping kept with the form, if it still fits `schema`; else null. */
function usable(schema, stored) {
  try {
    return clean(schema, stored);
  } catch {
    return null;
  }
}

/**
 * The fields members.createApplication() takes, from cleaned answers.
 * Returns null when the answers lack a name or email (nothing to approve).
 */
function toApplication(schema, mapping, answers) {
  const name = [mapping.nameItem, mapping.surnameItem]
    .map((id) => (id && typeof answers[id] === 'string' ? answers[id] : ''))
    .filter(Boolean)
    .join(' ');
  const email = answers[mapping.emailItem];
  if (!name || !email) return null;
  let requestedRole = null;
  if (mapping.roleItem && answers[mapping.roleItem]) {
    const picked = (answers[mapping.roleItem].selected || [])[0];
    requestedRole = mapping.roles[picked] || null;
  }
  const lang = schema.languages[0];
  const list = [];
  for (const it of schemaLib.answerable(schema)) {
    if (answers[it.id] === undefined) continue;
    list.push({
      label: schemaLib.textIn(schema, it.label, lang) || it.id,
      value: schemaLib.answerText(schema, it, answers[it.id]),
    });
  }
  return { name, email, requestedRole, answers: list };
}

module.exports = { ROLES, JOIN_SLUG, clean, usable, toApplication };
