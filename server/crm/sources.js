// The sheets the CRM reads, and how their columns map to fields.
//
// The sheets stay where the forms write them (Google Sheets); the CRM reads
// them through server/sheets.js and never copies the answers into the
// database. Each source says, per field, which column holds it. Columns are
// found by their header text, not their position, so a form that gains a
// question or reorders its columns does not break the board.
//
// A header pattern is matched ignoring case, accents and extra spaces:
//   'Nome'        exactly that header
//   'Quali aree*' any header that starts with it (the forms' questions are long)
// An exact match wins over a prefix one, so 'Nome completo' does not take the
// column 'Nome completo (co-mentor)'. A field with no matching column is
// reported as `missing`, not an error: the rest of the sheet still loads.
//
// Which spreadsheet and tab each source reads is a setting, kept in the
// database (app_settings, key crm_sources) and edited by `crm_admin`.

const db = require('../db');
const { HttpError } = require('../http');
const sheets = require('../sheets');
const crypto_ = require('./crypto');
const audit = require('./audit');

const SOURCES = {
  mentors_prospective: {
    label: 'Prospective mentors (the list to contact)',
    kind: 'mentor',
    stage: 'prospect',
    tab: 'Mentors',
    fields: {
      first_name: ['Nome'],
      last_name: ['Cognome'],
      email: ['Contatto email'],
      social: ['Contatto social'],
      org: ['Provenienza*'],
      career: ['Stadio Carriera*'],
      track: ['Track'],
      referrer: ['Reference*'],
      notes: ['Area tematica*'],
      contacted: ['Contattato'],
      replied: ['Risposta'],
      reply_note: ['Cosa ha risposto'],
    },
  },
  mentors_applications: {
    label: 'Mentor applications (call for mentors)',
    kind: 'mentor',
    stage: 'applied',
    tab: 'Risposte del modulo 1',
    fields: {
      timestamp: ['Informazioni cronologiche'],
      consent: ['Ho letto e accetto*'],
      name: ['Nome completo'],
      email: ['Email'],
      cv: ['CV'],
      role: ['Ruolo e affiliazione attuale'],
      profile: ['Link al tuo profilo'],
      country: ['Paese di residenza*'],
      background: ['Descrivi brevemente il tuo background'],
      areas: ['Quali aree tematiche*'],
      language: ['Lingua di lavoro*'],
      mode: ['Modalità degli incontri'],
      editions: ['A quali edizioni*'],
      tracks: ['A quale track*'],
      project_title: ['Titolo del progetto'],
      project_area: ['Area tematica'],
      project_abstract: ['Abstract del progetto'],
      compute: ['Il progetto richiede risorse*'],
      interview: ['Vuoi intervistare*'],
      mentees: ['Quanti mentee vorresti*'],
      hours_mentee: ['Quante ore a settimana dovrebbe*'],
      hours_mentor: ['Quante ore a settimana puoi*'],
      co_mentor: ['Nome completo (co-mentor)'],
    },
  },
  // Mentee applications come from a form of the site only (the template
  // mentee_application, server/forms/templates.js): there is no sheet to read.
  mentees_applications: {
    label: 'Mentee applications',
    kind: 'mentee',
    stage: 'applied',
    sheet: false,
    fields: {
      name: ['Nome completo'],
      email: ['Email'],
      role: ['Ruolo attuale'],
      affiliation: ['Affiliazione'],
      profile: ['Link al tuo profilo'],
      cv: ['Link al tuo CV'],
      country: ['Paese di residenza*'],
      background: ['Descrivi brevemente il tuo background'],
      areas: ['Quali aree tematiche*'],
      tracks: ['Percorso/i*'],
      motivation: ['Perché vuoi partecipare*'],
      goals: ['Cosa vorresti ottenere*'],
      project_idea: ['Hai già un’idea*'],
      hours: ['Quante ore a settimana*'],
      language: ['Lingua di lavoro*'],
    },
  },
  mentees_interest: {
    label: 'Expressions of interest (mentors and mentees)',
    kind: 'mixed',
    stage: 'interested',
    tab: 'Risposte del modulo 1',
    fields: {
      timestamp: ['Informazioni cronologiche'],
      consent: ['Acconsento al trattamento*'],
      name: ['Nome completo'],
      email: ['Email'],
      form_email: ['Indirizzo email'],
      role: ['Ruolo attuale'],
      affiliation: ['Affiliazione'],
      profile: ['Link al tuo profilo'],
      applying_as: ['Per quale ruolo*'],
      areas: ['Quali aree tematiche*'],
      tracks: ['Percorso/i*'],
      contacted: ['Contattato'],
    },
  },
};

// The sources read from a Google sheet (for the one-time import).
const SHEET_SOURCES = Object.keys(SOURCES).filter((id) => SOURCES[id].sheet !== false);

function norm(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The header each field maps to in this sheet: { field: header | null }. */
function mapColumns(sourceId, headers) {
  const source = SOURCES[sourceId];
  const normalized = headers.map((h) => ({ header: h, n: norm(h) }));
  const taken = new Set();
  const out = {};
  const find = (pattern) => {
    const prefix = pattern.endsWith('*');
    const want = norm(prefix ? pattern.slice(0, -1) : pattern);
    return (
      normalized.find((h) => !taken.has(h.header) && h.n === want) ||
      (prefix ? normalized.find((h) => !taken.has(h.header) && h.n.startsWith(want)) : null)
    );
  };
  for (const [field, patterns] of Object.entries(source.fields)) {
    let found = null;
    for (const pattern of patterns) {
      found = find(pattern);
      if (found) break;
    }
    out[field] = found ? found.header : null;
    if (found) taken.add(found.header);
  }
  return out;
}

// ── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'crm_sources';

/** { sourceId: { spreadsheetId, tab } } as saved; defaults for the tab. */
async function getConfig() {
  const { rows } = await db.query('select value from app_settings where key = $1', [SETTINGS_KEY]);
  const saved = (rows[0] && rows[0].value) || {};
  const out = {};
  for (const id of SHEET_SOURCES) {
    const source = SOURCES[id];
    out[id] = {
      spreadsheetId: (saved[id] && saved[id].spreadsheetId) || '',
      tab: (saved[id] && saved[id].tab) || source.tab,
    };
  }
  return out;
}

/** The id of a spreadsheet, from its address or from the id itself. */
function sheetId(value) {
  const text = String(value || '').trim();
  const match = /\/d\/([A-Za-z0-9_-]+)/.exec(text);
  return match ? match[1] : text;
}

/** The service account's email, which the sheets must be shared with, or null. */
function serviceAccountEmail() {
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').client_email || null;
  } catch {
    return null;
  }
}

/** Validates and stores which spreadsheet and tab each source reads. */
async function saveConfig(user, body) {
  const input = body && typeof body === 'object' ? body : {};
  const clean = {};
  for (const id of SHEET_SOURCES) {
    const item = input[id] || {};
    const spreadsheetId = sheetId(item.spreadsheetId);
    const tab = String(item.tab || SOURCES[id].tab).trim();
    if (spreadsheetId && !sheets.SHEET_ID.test(spreadsheetId)) {
      throw new HttpError(400, `${SOURCES[id].label}: that is not a spreadsheet id`, { field: id });
    }
    if (!tab || tab.length > 100)
      throw new HttpError(400, `${SOURCES[id].label}: tab name`, { field: id });
    clean[id] = { spreadsheetId, tab };
  }
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTINGS_KEY, clean]
  );
  // The ids themselves are not secret but say nothing useful here: log which
  // sources changed.
  await audit.record(user, 'change-settings', null, { sources: Object.keys(clean) });
  return getConfig();
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * The records of one source. Each is { key, row, ...fields } with `key` the
 * opaque person key (null when the row has no usable email), `row` the row
 * number in the sheet (2 is the first answer), and every field as text.
 * Returns { source, records, missing, withoutEmail }.
 */
async function load(sourceId) {
  const source = SOURCES[sourceId];
  if (!source || source.sheet === false) throw new HttpError(404, 'Unknown source');
  const config = (await getConfig())[sourceId];
  if (process.env.CRM_SHEETS_FAKE !== '1' && !config.spreadsheetId) {
    throw new HttpError(409, `${source.label}: no spreadsheet set in the CRM settings yet`);
  }
  const rows = await sheets.readRows({
    source: sourceId,
    spreadsheetId: config.spreadsheetId,
    tab: config.tab,
  });
  return fromRows(sourceId, rows);
}

/**
 * The records of rows already read ([{ header: text }], from a sheet or a CSV
 * file): the same as load(), for a file the team downloaded.
 */
function fromRows(sourceId, rows) {
  const source = SOURCES[sourceId];
  if (!source || source.sheet === false) throw new HttpError(404, 'Unknown source');
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const columns = mapColumns(sourceId, headers);
  const missing = Object.entries(columns)
    .filter(([, header]) => !header)
    .map(([field]) => field);

  let withoutEmail = 0;
  const records = [];
  rows.forEach((raw, index) => {
    const fields = {};
    for (const [field, header] of Object.entries(columns)) {
      fields[field] = header ? String(raw[header] || '').trim() : '';
    }
    const record = toRecord(sourceId, fields, index + 2);
    if (!record) return; // an empty row the sheet kept
    if (!record.key) withoutEmail++;
    records.push(record);
  });
  return { source: sourceId, records, missing, withoutEmail };
}

/**
 * One person's row, from a sheet, a form or the board: { key, row, ...fields }
 * with every field of the source as text, the email normalized and `key` its
 * person key (null without a usable email). null for an empty row.
 */
function toRecord(sourceId, fields, row = null) {
  const source = SOURCES[sourceId];
  const record = { row };
  for (const field of Object.keys(source.fields)) {
    record[field] = String(fields[field] == null ? '' : fields[field]).trim();
  }
  if (source.fields.first_name && !record.name) {
    record.name = [record.first_name, record.last_name].filter(Boolean).join(' ');
  }
  // The form also records the address the answers came from; use it when
  // the question's own email is empty.
  record.email = crypto_.normalizeEmail(record.email || record.form_email);
  record.key = crypto_.personKey(record.email);
  if (!record.name && !record.email) return null;
  return record;
}

module.exports = {
  SOURCES,
  SHEET_SOURCES,
  norm,
  mapColumns,
  getConfig,
  saveConfig,
  sheetId,
  serviceAccountEmail,
  load,
  fromRows,
  toRecord,
};
