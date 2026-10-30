# Handoff: board candidature membri → integrazione con il form builder

> Per l'agente che lavora sul branch del **form builder** (dashboard con
> creazione/pubblicazione dei form, gestione mentorship, ecc.), che non è su
> GitHub ma solo sul PC di casa. Leggi tutto prima di fare il merge.
> Cancella questo file quando l'integrazione è fatta.

## Perché esiste

Oggi l'iscrizione alla community passa per un Google Form → foglio risposte →
Elisabetta copia a mano nel foglio membri → mette "Approvato" → lo script
`scripts/send-discord-invites.py` (GitHub Action giornaliera) manda un invito
Discord monouso → i ruoli Discord si assegnano a mano, riconoscendo le persone
dal nickname (e se ne perdono: a ottobre 110 nel foglio, 78 su Discord).

L'obiettivo è: form d'iscrizione **sul sito** → board dove Elisabetta approva o
rifiuta e sceglie il ruolo → la persona riceve un link e il bot la fa entrare
nel server **con il ruolo già assegnato**, collegando il suo account Discord
alla candidatura (non più al nickname).

## Cosa c'è sul branch `feat/members-board` (partito da `dev` @ a4cbc79; PR verso `dev`, come gli altri `feat/*`)

La board è pronta e testata. **Il form no**: si assume che lo costruisca il
form builder, che deve solo consegnare ogni invio del form d'iscrizione a
`createApplication()`.

| File | Cosa |
| --- | --- |
| `server/members.js` | Tutta la logica: `createApplication`, `listApplications`, `decide`, `resendInvite`, `checkJoinToken`, `completeJoin` |
| `server/members.test.js` | 6 test (`npm run test:meet` li include) |
| `api/app/members.js` | API della board (GET lista, POST `?action=decide`/`resend`) |
| `api/join.js` | Il link personale: OAuth Discord con scope `identify guilds.join`, poi il bot aggiunge al server con il ruolo |
| `src/content/app/members/index.njk`, `src/assets/js/meet/members.js` | La board (`/app/members/`) |
| `src/content/join.njk` | Pagina pubblica `/join/?s=ok|expired|used|denied|invalid|failed` |
| `server/schema.js` | Nuova tabella `member_applications` (in fondo al file) |
| `server/permissions.js` | Nuovo permesso `members` ("Member applications"); `bot()` ora accetta `{ method, json }` ed è esportato; nuovo `CONTENT_KEYS` |
| `server/discord.js` | Estratto `exchange()` (codice → token + profilo) da `verify()`; `authorizeUrl` accetta `scope` |
| `api/app/content.js` | `requireSomePermission` guarda solo i permessi di contenuto, così chi ha solo `members` non entra in Site content |
| `src/content/app/index.njk`, `src/assets/js/meet/hub.js` | Card "Member applications" in `/app/`, visibile a chi ha `members` |
| `server/README.md` | Sezione "Member applications" (setup Discord) |

## Il contratto con il form builder

```js
const members = require('./server/members');

await members.createApplication(
  {
    name: 'Giulia Bianchi',            // obbligatorio (Nome + Cognome)
    email: 'giulia@example.com',       // obbligatorio
    requestedRole: 'organizer',        // 'participant' | 'organizer' | omesso
    answers: [                         // TUTTE le domande, nell'ordine del form
      { label: 'Città in cui vivi', value: 'Torino' },
      { label: 'Aree di interesse', value: ['Governance', 'Interpretability'] },
    ],
  },
  { source: 'iscrizione-community' }   // slug/id del form, facoltativo
);
// -> { id }; lancia HttpError(400) se nome/email/ruolo non vanno
```

- `answers` è solo da mostrare: la board stampa label e valore così come
  arrivano, quindi il form builder può cambiare le domande senza toccare la
  board. I valori lista vengono uniti con ", ".
- `requestedRole` viene dalla domanda "vuoi partecipare attivamente o solo
  entrare nel Discord?": attivamente → `organizer`, solo Discord →
  `participant`. È solo il ruolo preselezionato: Elisabetta può cambiarlo.

## Cosa deve fare l'agente a casa

1. **Committa il lavoro locale** del form builder prima di tutto. Poi
   `git fetch` e fai il merge di `origin/feat/members-board` nel suo branch
   (o tutti e due in `dev`).
2. **Conflitti probabili**, perché entrambi i branch toccano gli stessi punti
   di "registro":
   - `server/schema.js`: tieni entrambi i blocchi aggiunti in fondo.
   - `server/permissions.js` → `PERMISSIONS`: tieni tutte le chiavi. **Se il
     form builder ha aggiunto un suo permesso** (es. `forms`), escludilo anche
     da `CONTENT_KEYS` e dal filtro della card in `src/assets/js/meet/hub.js`
     (`p !== 'members'`), altrimenti chi ha solo quel permesso vede Site
     content.
   - `src/content/app/index.njk` e `src/assets/js/meet/hub.js`: una card per
     tool, tieni tutte.
   - `package.json` → `test:meet`: elenca tutti i file di test.
   - `server/README.md`: tieni tutte le sezioni.
3. **Collega il form d'iscrizione**: nel punto in cui il form builder salva un
   invio, se il form è quello d'iscrizione (serve un modo per marcarlo: un
   flag/tipo sul form, es. `kind: 'membership'`, più la mappatura di quali
   campi sono nome, cognome, email e ruolo richiesto), chiama
   `createApplication()` come sopra. Se il form builder salva già gli invii in
   una sua tabella va bene tenerli anche lì; la board legge solo
   `member_applications`.
   **L'endpoint pubblico che riceve il form deve avere un limite per IP**
   (stesso schema di `login_attempts` in `server/auth.js`) e un campo nascosto
   anti-bot (honeypot): `createApplication()` non ne ha, e senza un bot di
   spam riempie la board.
4. **Sostituisci i link al Google Form**: `site.forms.mailingList` in
   `src/data/site.js` (usato da header, hero, footer, cta) deve puntare alla
   pagina del nuovo form d'iscrizione.
5. `npm run test:meet`. Nota: `server/content.test.js` va in out-of-memory su
   uno dei due PC già su `main`, quindi non dipende da questo branch.
6. Prova locale: `npm run dev:meet` → invia il form → `/app/members/` (password
   `admin`, o la finta login Discord con un ruolo a cui hai dato "Member
   applications") → approva → il link compare nel terminale (fake mail) →
   aprilo: in locale entra subito senza Discord.

## Setup in produzione (da fare una volta, prima dev poi prod)

- Vercel env: `DISCORD_ROLE_PARTICIPANT`, `DISCORD_ROLE_ORGANIZER` (id dei
  ruoli Partecipanti / Organizzatori).
- Discord Developer Portal → OAuth2 → Redirects: aggiungi
  `https://www.ais4i.it/api/join`, `https://ais4i-dev.vercel.app/api/join`,
  `http://localhost:8080/api/join`.
- **Da verificare:** `guilds.join` funziona solo se il bot
  (`DISCORD_BOT_TOKEN_AIS_TEAM_AREA`) è della **stessa applicazione** di
  `DISCORD_CLIENT_ID`. Se sono due app diverse l'ingresso fallisce con 403
  (lo si vede nella board come "Joining failed"). Il bot deve avere Create
  Instant Invite e Manage Roles, e il suo ruolo deve stare sopra Partecipanti
  e Organizzatori.
- In `/app/content/permissions/` spunta "Member applications" per il ruolo di
  Elisabetta (e di chi altro deve approvare).
- Quando la board va in produzione **spegni il job `send-discord-invites.py`**
  in `.github/workflows/update-members.yml`, altrimenti chi viene approvato
  anche sul foglio riceve due inviti.

## Non fatto (decisioni o lavoro successivo)

- **Pagina Community**: oggi `update-members.py` la genera dal foglio Google
  (chi ha dato il consenso alla pubblicazione). Con il form sul sito va decisa
  la nuova fonte: probabilmente le candidature approvate con consenso, che
  quindi deve essere una domanda del form con una chiave riconoscibile.
- Migrazione dei membri già nel foglio e riconciliazione con chi è già su
  Discord (per loro servirebbe un link "collega il tuo account", senza
  ricandidarsi: `completeJoin` funziona già anche per chi è nel server,
  gli dà solo il ruolo).
- Email diverse per ruolo (le bozze di Elisabetta sono in un Google Doc) e
  email di rifiuto: ora l'email è una sola, in italiano, e il rifiuto non ne
  manda.
- Notifica al team quando arriva una candidatura nuova.
- Storico delle modifiche oltre a "chi ha deciso e quando", export CSV.
- Cancellazione di una candidatura (richieste GDPR): ora serve SQL a mano.
- Un rifiuto si può trasformare in approvazione dalla board; un'approvazione
  invece è definitiva (il link è già partito).
