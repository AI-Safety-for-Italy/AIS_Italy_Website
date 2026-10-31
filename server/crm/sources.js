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
  for (const [id, source] of Object.entries(SOURCES)) {
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
  for (const id of Object.keys(SOURCES)) {
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
  if (!source) throw new HttpError(404, 'Unknown source');
  const config = (await getConfig())[sourceId];
  if (process.env.CRM_SHEETS_FAKE !== '1' && !config.spreadsheetId) {
    throw new HttpError(409, `${source.label}: no spreadsheet set in the CRM settings yet`);
  }
  const rows = await sheets.readRows({
    source: sourceId,
    spreadsheetId: config.spreadsheetId,
    tab: config.tab,
  });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const columns = mapColumns(sourceId, headers);
  const missing = Object.entries(columns)
    .filter(([, header]) => !header)
    .map(([field]) => field);

  let withoutEmail = 0;
  const records = [];
  rows.forEach((raw, index) => {
    const record = { row: index + 2 };
    for (const [field, header] of Object.entries(columns)) {
      record[field] = header ? String(raw[header] || '').trim() : '';
    }
    if (source.fields.first_name && !record.name) {
      record.name = [record.first_name, record.last_name].filter(Boolean).join(' ');
    }
    // The form also records the address the answers came from; use it when
    // the question's own email is empty.
    const email = record.email || record.form_email;
    record.email = crypto_.normalizeEmail(email);
    record.key = crypto_.personKey(record.email);
    if (!record.name && !record.email) return; // an empty row the sheet kept
    if (!record.key) withoutEmail++;
    records.push(record);
  });
  return { source: sourceId, records, missing, withoutEmail };
}

module.exports = {
  SOURCES,
  norm,
  mapColumns,
  getConfig,
  saveConfig,
  sheetId,
  serviceAccountEmail,
  load,
};
