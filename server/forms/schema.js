// What a form is made of, and what an answer to it may contain.
//
//   cleanSchema(input)          the form as the editor sends it -> a checked
//                               schema, or HttpError 400 naming the question
//   cleanAnswers(schema, input) a public submission -> { answers, email } with
//                               only what the form asks, in the shape it asks,
//                               or HttpError 400 with { errors: { id: msg } }
//
// Everything that reaches the database from the public goes through
// cleanAnswers: unknown keys are dropped, every value is checked against its
// question, and nothing is trusted from the page (it can be anything).
//
// A schema:
//   {
//     languages: ['it'] or ['it', 'en'],      the first is the main one
//     title: { it, en }, description: { it, en } (Markdown, markdown-lite),
//     confirmation: { it, en },               shown after sending (Markdown)
//     items: [ { id, type, label: {it,en}, help: {it,en}, required, … } ]
//   }
// Texts are per language; a missing translation falls back to the main one.

const crypto = require('crypto');
const { HttpError } = require('../http');
const { isEmail } = require('../email');

const TYPES = {
  short_text: { answer: true, label: 'Short answer' },
  long_text: { answer: true, label: 'Paragraph' },
  email: { answer: true, label: 'Email' },
  url: { answer: true, label: 'Link' },
  number: { answer: true, label: 'Number' },
  single: { answer: true, choice: true, label: 'One choice' },
  multi: { answer: true, choice: true, label: 'Several choices' },
  dropdown: { answer: true, choice: true, label: 'Drop-down' },
  scale: { answer: true, label: 'Scale' },
  date: { answer: true, label: 'Date' },
  yes_no: { answer: true, label: 'Yes / no' },
  consent: { answer: true, label: 'Consent' },
  info: { answer: false, label: 'Text block' },
  section: { answer: false, label: 'New page' },
};
const LANGS = ['it', 'en'];
const CONDITIONAL = ['single', 'dropdown', 'multi', 'yes_no'];
const ID = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_ITEMS = 150;
const MAX_OPTIONS = 60;
const LIMITS = { label: 500, help: 3000, option: 200, title: 200, description: 6000 };
const TEXT_MAX = { short_text: 300, long_text: 8000 };
const HTTPS = /^https:\/\/[^\s<>"]{3,}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(message, details) {
  return new HttpError(400, message, details);
}

/** A per-language text, trimmed and capped: { it: '…', en: '…' }. */
function texts(input, languages, max, where, { required = false } = {}) {
  const out = {};
  const value = input && typeof input === 'object' ? input : {};
  for (const lang of languages) {
    const text = typeof value[lang] === 'string' ? value[lang].trim() : '';
    if (text.length > max) throw fail(`${where}: at most ${max} characters`, { field: where });
    if (text) out[lang] = text;
  }
  if (required && !out[languages[0]])
    throw fail(`${where}: write it in the main language`, { field: where });
  return out;
}

function int(value, min, max, where) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw fail(`${where}: a whole number from ${min} to ${max}`, { field: where });
  return n;
}

/** A short fingerprint of a consent text: an answer records which text it agreed to. */
function consentVersion(label) {
  return crypto.createHash('sha256').update(JSON.stringify(label)).digest('hex').slice(0, 12);
}

function cleanItem(raw, languages, seen) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const type = it.type;
  if (!TYPES[type]) throw fail('Unknown question type', { field: String(it.id || '') });
  const id = String(it.id || '');
  if (!ID.test(id)) throw fail('Each question needs an id of letters, digits and _', { field: id });
  if (seen.has(id)) throw fail(`Two questions share the id ${id}`, { field: id });
  seen.add(id);
  const where = id;
  const item = {
    id,
    type,
    label: texts(it.label, languages, LIMITS.label, where, { required: type !== 'section' }),
  };
  const help = texts(it.help, languages, LIMITS.help, where);
  if (Object.keys(help).length) item.help = help;
  if (!TYPES[type].answer) return item;

  item.required = type === 'consent' ? true : Boolean(it.required);
  if (type === 'short_text' || type === 'long_text') {
    const max = int(it.maxLength, 1, TEXT_MAX[type], where);
    const min = int(it.minLength, 0, TEXT_MAX[type], where);
    item.maxLength = max || TEXT_MAX[type];
    if (min) item.minLength = Math.min(min, item.maxLength);
  }
  if (type === 'number') {
    const min =
      it.min === '' || it.min === undefined || it.min === null ? undefined : Number(it.min);
    const max =
      it.max === '' || it.max === undefined || it.max === null ? undefined : Number(it.max);
    if (
      (min !== undefined && !Number.isFinite(min)) ||
      (max !== undefined && !Number.isFinite(max))
    ) {
      throw fail(`${where}: limits must be numbers`, { field: where });
    }
    if (min !== undefined) item.min = min;
    if (max !== undefined) item.max = max;
    if (min !== undefined && max !== undefined && min > max)
      throw fail(`${where}: minimum above maximum`, { field: where });
  }
  if (TYPES[type].choice) {
    if (!Array.isArray(it.options) || !it.options.length)
      throw fail(`${where}: add at least one option`, { field: where });
    if (it.options.length > MAX_OPTIONS)
      throw fail(`${where}: at most ${MAX_OPTIONS} options`, { field: where });
    const optionIds = new Set();
    item.options = it.options.map((o, i) => {
      const oid = String((o && o.id) || '');
      if (!ID.test(oid) || optionIds.has(oid))
        throw fail(`${where}: option ${i + 1} needs its own id`, { field: where });
      optionIds.add(oid);
      return {
        id: oid,
        label: texts(o.label, languages, LIMITS.option, `${where} option ${i + 1}`, {
          required: true,
        }),
      };
    });
    if (type !== 'dropdown' && it.other) item.other = true;
    if (type === 'multi') {
      const max = int(it.maxChoices, 1, item.options.length, where);
      if (max) item.maxChoices = max;
    }
  }
  if (type === 'scale') {
    item.min = int(it.min, 0, 1, where) ?? 1;
    item.max = int(it.max, 2, 10, where) ?? 5;
    const minLabel = texts(it.minLabel, languages, LIMITS.option, where);
    const maxLabel = texts(it.maxLabel, languages, LIMITS.option, where);
    if (Object.keys(minLabel).length) item.minLabel = minLabel;
    if (Object.keys(maxLabel).length) item.maxLabel = maxLabel;
  }
  if (type === 'consent') item.consentVersion = consentVersion(item.label);
  return item;
}

/** The editor's form -> a checked schema. */
function cleanSchema(input) {
  const s = input && typeof input === 'object' ? input : {};
  const languages = Array.isArray(s.languages) ? LANGS.filter((l) => s.languages.includes(l)) : [];
  if (!languages.length) throw fail('Choose the language of the form', { field: 'languages' });
  // Keep the order the editor chose for the main language.
  if (Array.isArray(s.languages) && s.languages[0] && languages.includes(s.languages[0])) {
    languages.sort((a, b) => (a === s.languages[0] ? -1 : b === s.languages[0] ? 1 : 0));
  }
  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length > MAX_ITEMS) throw fail(`At most ${MAX_ITEMS} questions`, { field: 'items' });
  const seen = new Set();
  const cleaned = items.map((item) => cleanItem(item, languages, seen));
  cleaned.forEach((item, i) => {
    const showIf = cleanShowIf(items[i].showIf, cleaned.slice(0, i), item.id);
    if (showIf) item.showIf = showIf;
  });
  return {
    languages,
    title: texts(s.title, languages, LIMITS.title, 'title', { required: true }),
    description: texts(s.description, languages, LIMITS.description, 'description'),
    confirmation: texts(s.confirmation, languages, LIMITS.description, 'confirmation'),
    items: cleaned,
  };
}

/** "Show only if": { item, values } pointing at an earlier choice / yes-no question. */
function cleanShowIf(raw, earlier, where) {
  if (raw === undefined || raw === null) return null;
  const ref = raw && typeof raw === 'object' ? raw : {};
  const target = earlier.find((i) => i.id === ref.item);
  if (!target)
    throw fail(`${where}: "show only if" needs a question that comes before`, { field: where });
  if (!CONDITIONAL.includes(target.type))
    throw fail(`${where}: "show only if" works on choice and yes/no questions`, { field: where });
  const allowed = target.type === 'yes_no' ? ['yes', 'no'] : target.options.map((o) => o.id);
  const values = Array.isArray(ref.values) ? [...new Set(ref.values.map(String))] : [];
  if (!values.length || values.some((v) => !allowed.includes(v)))
    throw fail(`${where}: "show only if" needs at least one answer of that question`, {
      field: where,
    });
  return { item: target.id, values };
}

/** Does this answer satisfy the condition? */
function matches(showIf, target, answer) {
  if (answer === undefined || answer === null) return false;
  if (target.type === 'yes_no') return showIf.values.includes(answer);
  return (answer.selected || []).some((id) => showIf.values.includes(id));
}

/**
 * Ids of the items shown for these (cleaned) answers, in order. A section's
 * condition covers every item up to the next section; an item may add its own.
 * A condition on a hidden question does not hold.
 */
function visibleIds(schema, answers) {
  const visible = new Set();
  const byId = new Map(schema.items.map((i) => [i.id, i]));
  const holds = (c) =>
    !c || (visible.has(c.item) && matches(c, byId.get(c.item), (answers || {})[c.item]));
  let sectionOk = true;
  for (const item of schema.items) {
    if (item.type === 'section') {
      sectionOk = holds(item.showIf);
      if (sectionOk) visible.add(item.id);
    } else if (sectionOk && holds(item.showIf)) visible.add(item.id);
  }
  return visible;
}

/** Questions that take an answer. */
function answerable(schema) {
  return schema.items.filter((i) => TYPES[i.type].answer);
}

function cleanChoice(item, raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const selected = Array.isArray(value.selected) ? value.selected.map(String) : [];
  const allowed = new Set(item.options.map((o) => o.id));
  const picked = [...new Set(selected)].filter((id) => allowed.has(id));
  if (picked.length !== new Set(selected).size) return { error: 'Choose one of the options' };
  // An "Other" text where the question offers none is refused, not ignored.
  if (!item.other && typeof value.other === 'string' && value.other.trim()) {
    return { error: 'Choose one of the options' };
  }
  let other = item.other && typeof value.other === 'string' ? value.other.trim() : '';
  if (other.length > 300) return { error: 'At most 300 characters' };
  if (item.type !== 'multi' && picked.length + (other ? 1 : 0) > 1)
    return { error: 'Choose only one' };
  if (item.maxChoices && picked.length + (other ? 1 : 0) > item.maxChoices) {
    return { error: `Choose at most ${item.maxChoices}` };
  }
  if (!picked.length && !other) return { empty: true };
  const out = { selected: picked };
  if (other) out.other = other;
  return { value: out };
}

/** One answer -> { value } | { empty } | { error }. */
function cleanOne(item, raw) {
  if (raw === undefined || raw === null) return { empty: true };
  switch (item.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof raw !== 'string') return { error: 'Expected text' };
      const text =
        item.type === 'short_text'
          ? raw.replace(/\s+/g, ' ').trim()
          : raw.replace(/\r\n?/g, '\n').trim();
      if (!text) return { empty: true };
      if (text.length > item.maxLength) return { error: `At most ${item.maxLength} characters` };
      if (item.minLength && text.length < item.minLength)
        return { error: `At least ${item.minLength} characters` };
      return { value: text };
    }
    case 'email': {
      if (typeof raw !== 'string') return { error: 'Expected an email' };
      const email = raw.trim().toLowerCase();
      if (!email) return { empty: true };
      if (!isEmail(email)) return { error: 'Enter a valid email' };
      return { value: email };
    }
    case 'url': {
      if (typeof raw !== 'string') return { error: 'Expected a link' };
      const url = raw.trim();
      if (!url) return { empty: true };
      if (url.length > 500 || !HTTPS.test(url))
        return { error: 'Enter a link starting with https://' };
      return { value: url };
    }
    case 'number': {
      if (raw === '') return { empty: true };
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) return { error: 'Enter a number' };
      if (item.min !== undefined && n < item.min) return { error: `At least ${item.min}` };
      if (item.max !== undefined && n > item.max) return { error: `At most ${item.max}` };
      return { value: n };
    }
    case 'single':
    case 'multi':
    case 'dropdown':
      return cleanChoice(item, raw);
    case 'scale': {
      if (raw === '') return { empty: true };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < item.min || n > item.max)
        return { error: `Choose from ${item.min} to ${item.max}` };
      return { value: n };
    }
    case 'date': {
      if (typeof raw !== 'string' || !raw)
        return raw === '' ? { empty: true } : { error: 'Enter a date' };
      const d = new Date(`${raw}T12:00:00Z`);
      if (!DAY.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw)
        return { error: 'Enter a valid date' };
      return { value: raw };
    }
    case 'yes_no':
      if (raw === '') return { empty: true };
      return raw === 'yes' || raw === 'no' ? { value: raw } : { error: 'Choose yes or no' };
    case 'consent':
      return raw === true
        ? { value: { accepted: true, version: item.consentVersion } }
        : { empty: true };
    default:
      return { empty: true };
  }
}

/**
 * A public submission -> { answers, email }. `email` is the first email answer
 * (for one-answer-per-person and, later, the CRM). Throws 400 with { errors }.
 */
function cleanAnswers(schema, input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const answers = {};
  const errors = {};
  // Walk in order: a question's visibility depends on the answers before it.
  const shown = new Set();
  const byId = new Map(schema.items.map((i) => [i.id, i]));
  const holds = (c) => !c || (shown.has(c.item) && matches(c, byId.get(c.item), answers[c.item]));
  let sectionOk = true;
  for (const item of schema.items) {
    if (item.type === 'section') sectionOk = holds(item.showIf);
    if (!TYPES[item.type].answer) continue;
    // Hidden: whatever the page sent is dropped and `required` does not apply.
    if (!sectionOk || !holds(item.showIf)) continue;
    shown.add(item.id);
    const result = cleanOne(
      item,
      Object.prototype.hasOwnProperty.call(raw, item.id) ? raw[item.id] : undefined
    );
    if (result.error) errors[item.id] = result.error;
    else if (result.empty) {
      if (item.required)
        errors[item.id] =
          item.type === 'consent' ? 'Please accept to continue' : 'This question is required';
    } else answers[item.id] = result.value;
  }
  if (Object.keys(errors).length) throw fail('Some answers need a look', { errors });
  const emailItem = answerable(schema).find((i) => i.type === 'email' && answers[i.id]);
  return { answers, email: emailItem ? answers[emailItem.id] : null };
}

/** One cleaned answer as plain text, in the form's main language. */
function answerText(schema, item, value) {
  const lang = schema.languages[0];
  switch (item.type) {
    case 'single':
    case 'multi':
    case 'dropdown': {
      const labels = (value.selected || []).map((id) => {
        const o = item.options.find((x) => x.id === id);
        return o ? textIn(schema, o.label, lang) : id;
      });
      if (value.other) labels.push(value.other);
      return labels.join(', ');
    }
    case 'yes_no':
      return value === 'yes' ? (lang === 'en' ? 'Yes' : 'Sì') : 'No';
    case 'consent':
      return lang === 'en' ? 'Accepted' : 'Accettato';
    default:
      return String(value);
  }
}

/** A text in the wanted language, or the form's main one. */
function textIn(schema, value, lang) {
  if (!value) return '';
  return value[lang] || value[schema.languages[0]] || '';
}

module.exports = {
  TYPES,
  LANGS,
  cleanSchema,
  cleanAnswers,
  visibleIds,
  answerable,
  consentVersion,
  textIn,
  answerText,
};
