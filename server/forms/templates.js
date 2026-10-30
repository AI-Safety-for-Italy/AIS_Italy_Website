// Starting points for new forms, modelled on the STRUCTURE of the Google Forms
// AIS4I has used (their questions, never their answers). Each template is a
// schema for server/forms/schema.js; the creator edits it from there.
//
// The research areas and working groups are the ones already public on the
// site (data/members.yaml, the community page).

const AREAS = [
  [
    'interp',
    'Interpretability (mechanistic interpretability, analisi delle rappresentazioni, ecc.)',
  ],
  ['evals', 'Evaluation (capability evaluations, dangerous capability evals, benchmarking)'],
  ['alignment', 'Alignment (RLHF, scalable oversight, value alignment)'],
  ['robustness', 'Robustness e adversarial ML'],
  ['security', 'Sicurezza informatica per modelli di frontiera'],
  ['governance', 'AI governance e policy'],
  ['ethics', "Etica dell'AI e impatto sociale"],
  ['xrisk', 'Rischi catastrofici / esistenziali'],
];

const GROUPS = [
  ['mentorship', 'Programma di mentorship'],
  ['governance', 'Governance, fundraising e finanze'],
  ['communication', 'Comunicazione'],
  ['technical', 'Infrastruttura tecnica'],
  ['community', 'Comunità e networking'],
  ['events', 'Eventi'],
  ['seminars', 'Seminari'],
  ['education', 'Didattica e divulgazione'],
];

const options = (pairs) => pairs.map(([id, it]) => ({ id, label: { it } }));
const q = (id, type, it, extra = {}) => ({ id, type, label: { it }, ...extra });

const PRIVACY = q(
  'privacy',
  'consent',
  'Ho letto e accetto l’informativa sul trattamento dei miei dati personali.',
  { help: { it: 'Leggi l’[informativa privacy](https://www.ais4i.it/privacy/).' } }
);

const TRACKS = options([
  ['projects', 'Progetti di AI safety'],
  ['orientation', 'Orientamento professionale'],
]);

const TEMPLATES = {
  blank: {
    label: 'Blank form',
    schema: (title) => ({
      languages: ['it'],
      title: { it: title },
      confirmation: { it: 'Grazie! Abbiamo ricevuto le tue risposte.' },
      items: [
        q('name', 'short_text', 'Nome e cognome', { required: true }),
        q('email', 'email', 'Email', { required: true }),
      ],
    }),
  },

  mentorship_interest: {
    label: 'Mentorship: expression of interest',
    schema: (title) => ({
      languages: ['it'],
      title: { it: title },
      description: {
        it: 'Il programma di mentorship di AI Safety for Italy mette in contatto chi vuole entrare nel campo con chi ci lavora già. Compila il modulo per farci sapere che ti interessa.',
      },
      confirmation: { it: 'Grazie! Ti scriveremo quando si aprono le candidature.' },
      items: [
        PRIVACY,
        q('name', 'short_text', 'Nome completo', { required: true }),
        q('email', 'email', 'Email', { required: true }),
        q('role', 'short_text', 'Ruolo attuale'),
        q('affiliation', 'short_text', 'Affiliazione'),
        q('profile', 'url', 'Link al tuo profilo', {
          help: { it: 'LinkedIn, sito personale o simili.' },
        }),
        q('applying_as', 'single', 'Per quale ruolo vorresti candidarti?', {
          required: true,
          options: options([
            ['mentee', 'Mentee'],
            ['mentor', 'Mentor'],
          ]),
        }),
        q('areas', 'multi', 'Quali aree tematiche si allineano di più al tuo background?', {
          options: options(AREAS),
          other: true,
        }),
        q('tracks', 'multi', 'Percorso/i a cui vorresti partecipare', {
          required: true,
          options: TRACKS,
        }),
      ],
    }),
  },

  mentor_call: {
    label: 'Mentorship: call for mentors',
    schema: (title) => ({
      languages: ['it'],
      title: { it: title },
      description: {
        it: 'Proponi un progetto o un percorso di orientamento per la prossima edizione del programma.',
      },
      confirmation: { it: 'Grazie! Il team mentorship ti contatterà a breve.' },
      items: [
        PRIVACY,
        q('about', 'section', 'Chi sei'),
        q('name', 'short_text', 'Nome completo', { required: true }),
        q('email', 'email', 'Email', { required: true }),
        q('cv', 'url', 'Link al tuo CV', {
          help: { it: 'Un link a un PDF (Drive, Dropbox…) o al tuo sito.' },
        }),
        q('role', 'short_text', 'Ruolo e affiliazione attuale', { required: true }),
        q('profile', 'url', 'Link al tuo profilo'),
        q('country', 'short_text', 'Paese di residenza e fuso orario'),
        q('background', 'long_text', 'Descrivi brevemente il tuo background', { maxLength: 2000 }),
        q('areas', 'multi', 'Quali aree tematiche si allineano di più al tuo background?', {
          options: options(AREAS),
          other: true,
        }),
        q('taught', 'yes_no', 'Hai mai insegnato o supervisionato qualcuno?'),
        q('language', 'single', 'Lingua di lavoro preferita', {
          options: options([
            ['it', 'Italiano'],
            ['en', 'Inglese'],
            ['both', 'Indifferente'],
          ]),
        }),
        q('mode', 'single', 'Modalità degli incontri', {
          options: options([
            ['online', 'Online'],
            ['hybrid', 'Online e in presenza'],
          ]),
        }),
        q('tracks', 'multi', 'A quale track sei interessat* a partecipare come mentor?', {
          required: true,
          options: TRACKS,
        }),
        q('project', 'section', 'Il progetto', { help: { it: 'Solo per il percorso progetti.' } }),
        q('project_title', 'short_text', 'Titolo del progetto'),
        q('project_area', 'dropdown', 'Area tematica', { options: options(AREAS) }),
        q('project_abstract', 'long_text', 'Abstract del progetto', { maxLength: 3000 }),
        q(
          'deliverables',
          'long_text',
          'Quali risultati concreti dovrebbero produrre i partecipanti?'
        ),
        q('weeks', 'number', 'Durata del progetto (stima in settimane)', { min: 1, max: 52 }),
        q(
          'compute',
          'yes_no',
          'Il progetto richiede risorse di calcolo oltre a un normale computer?'
        ),
        q(
          'prerequisites',
          'long_text',
          'Quali competenze o prerequisiti dovrebbe avere il mentee?'
        ),
        q(
          'interview',
          'yes_no',
          'Vuoi intervistare personalmente i mentee candidati al tuo progetto?'
        ),
        q('mentees', 'number', 'Quanti mentee vorresti seguire su questo progetto?', {
          min: 1,
          max: 10,
        }),
        q('hours_mentor', 'number', 'Quante ore a settimana puoi dedicare tu al progetto?', {
          min: 1,
          max: 40,
        }),
        q('co_mentor', 'short_text', 'Nome completo del co-mentor', {
          help: { it: 'Se il progetto ne prevede uno.' },
        }),
      ],
    }),
  },

  community_signup: {
    label: 'Community sign-up',
    schema: (title) => ({
      languages: ['it'],
      title: { it: title },
      description: { it: 'Unisciti alla community di AI Safety for Italy.' },
      confirmation: { it: 'Benvenut*! Riceverai a breve un invito al nostro Discord.' },
      items: [
        q('first_name', 'short_text', 'Nome', { required: true }),
        q('last_name', 'short_text', 'Cognome', { required: true }),
        q('email', 'email', 'Indirizzo email', { required: true }),
        q(
          'involvement',
          'single',
          'Vuoi partecipare attivamente all’organizzazione o solo entrare nel Discord?',
          {
            required: true,
            options: options([
              ['active', 'Voglio partecipare attivamente'],
              ['discord', 'Solo entrare nel Discord'],
            ]),
          }
        ),
        q('profile', 'url', 'Sito o profilo professionale'),
        q('country', 'short_text', 'Paese in cui ti trovi attualmente'),
        q('city', 'short_text', 'Città in cui vivi attualmente'),
        q('career', 'single', 'A quale livello di carriera ti collocheresti?', {
          options: options([
            ['student', 'Studente'],
            ['phd', 'Dottorato'],
            ['early', 'Inizio carriera'],
            ['mid', 'Metà carriera'],
            ['senior', 'Senior'],
          ]),
          other: true,
        }),
        q(
          'institution',
          'short_text',
          'Presso quale istituzione, azienda o laboratorio studi o lavori?'
        ),
        q('areas', 'multi', 'Quali aree ti interessano di più?', {
          options: options(AREAS),
          other: true,
        }),
        q('goals', 'long_text', 'Cosa ti piacerebbe ottenere partecipando alla community?'),
        q('groups', 'multi', 'A quali gruppi di lavoro vorresti contribuire?', {
          options: options(GROUPS),
        }),
        q('hours', 'number', 'Quante ore vuoi dedicare ad AI Safety Italy ogni mese?', {
          min: 0,
          max: 200,
        }),
        q(
          'publish',
          'yes_no',
          "Acconsenti alla pubblicazione del tuo profilo nella sezione 'Community' del sito?"
        ),
        PRIVACY,
      ],
    }),
  },
};

// Templates that come wired to the members board (see ./membership.js).
const MEMBERSHIP = {
  community_signup: {
    nameItem: 'first_name',
    surnameItem: 'last_name',
    emailItem: 'email',
    roleItem: 'involvement',
    roles: { active: 'organizer', discord: 'participant' },
  },
};

function membershipFor(key) {
  return MEMBERSHIP[key] || null;
}

function list() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label }));
}

function schemaFor(key, title) {
  const template = TEMPLATES[key] || TEMPLATES.blank;
  return template.schema(title);
}

module.exports = { list, schemaFor, membershipFor };
