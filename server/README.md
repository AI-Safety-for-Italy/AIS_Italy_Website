# Meeting polls

A private, Doodle-style scheduler inside the personal area (`/app/`). Members sign
in with Discord, propose times, share a link, people mark when they're
available, and the owner picks the time. Each member sees only their own polls.
The owner then downloads the event as an `.ics` file and copies everyone's
email to send the invite from their own calendar.

| Where                                            | What                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `/app/login/`                                    | Sign-in: Discord, or the shared admin password                                       |
| `/app/`                                          | Tools available after sign-in (meeting polls for now)                                |
| `/app/polls/`                                    | The member's own polls (not linked anywhere, not indexed)                            |
| `/app/settings/`                                 | Settings: the member's own notifications                                             |
| `/app/settings/permissions/`                     | Who may do what, per Discord role and per person (`manage`, and the admin)           |
| `/app/settings/mail/`                            | Mail settings: the sending mailbox (admin only)                                      |
| `/meet/?p=…`, `/it/meet/?p=…`                    | The voting page people get the link to                                               |
| `api/`                                           | Vercel Functions: `auth`, `discord`, `app/polls`, `app/poll`, `app/settings`, `poll` |
| `server/`                                        | Shared server code: database, auth, Discord, polls, mail, calendar files             |
| `src/content/app/`, `src/content/meet.njk`       | Page shells                                                                          |
| `src/assets/js/meet/`, `src/assets/css/meet.css` | Client scripts and styles                                                            |

## Run it locally

```sh
npm run dev:meet          # http://localhost:8080/app/
npm run test:meet
```

The test files run in parallel, each in its own process; within a file the
tests run one after another, each on its own database: a clone of one that
has the schema already (`server/test-db.js`), so a test does not pay for
starting Postgres and applying `schema.js`. A new test file starts its tests
with `beforeEach(() => testDb.fresh())`.

No setup needed: the local server uses PGlite (Postgres in-process, stored in
`.meet-dev-db/`), and its login page offers a stand-in for Discord that signs in
under any name (or use the admin password `admin`), and emails are printed in
the terminal instead of sent. Set `DATABASE_URL`, the `DISCORD_*` variables or
`MEET_FAKE_MAIL=0` to use the real services.

## Production settings (Vercel → Settings → Environment Variables)

| Variable                | How to get it                                                                 |
| ----------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`          | Set automatically when Neon is added from Vercel → Storage                    |
| `MEET_DATABASE_URL`     | **Preview only**: a Neon branch for `dev`, so tests never touch the live data |
| `ADMIN_PASSWORD_HASH`   | `node scripts/meet-hash-password.js` (the shared admin account)               |
| `SESSION_SECRET`        | `openssl rand -base64 48` (changing it signs everyone out)                    |
| `DISCORD_CLIENT_ID`     | Discord Developer Portal → the AIS application → OAuth2                       |
| `DISCORD_CLIENT_SECRET` | Same page ("Reset Secret"; the bot token is not affected)                     |
| `DISCORD_GUILD_ID`      | Discord, Developer Mode on → right-click the server → Copy ID                 |
| `DISCORD_ROLES_IDS`     | Roles allowed in, comma-separated (Server Settings → Roles → Copy ID)         |
| `SITE_URL`              | **Production only**: `https://www.ais4i.it`, for the links in emails          |

The CRM, the forms and the member applications need more, each set on
**both** Production and Preview, with different values on each:
`CRM_ENCRYPTION_KEY`, `CRM_KEY_SECRET` (without them the public forms answer
503), `DISCORD_ROLE_PARTICIPANT`, `DISCORD_ROLE_ORGANIZER`,
`GOOGLE_SERVICE_ACCOUNT_JSON`, and on Production `CRON_SECRET`; see their
sections below.

Never set `MEET_DEV_LOGIN` on Vercel: it is ignored there anyway (the stand-in
sign-in works only off Vercel), but it has no business in a deployment. On
every deployment (production and the previews, which are public) the shared
admin password opens the site's content and the permissions table only; the
CRM, form answers and member applications need a Discord sign-in. Only on a
developer machine does it open everything.

On the Discord application, add a redirect for every host the site runs on:
`https://www.ais4i.it/api/discord`, `https://ais4i-dev.vercel.app/api/discord`
and `http://localhost:8080/api/discord`.

Discord sign-in asks for the member's identity, email and server membership,
and lets in only members of `DISCORD_GUILD_ID` holding one of
`DISCORD_ROLES_IDS`. The role is checked at each sign-in; a session lasts 7 days.

| `DISCORD_BOT_TOKEN_AIS_TEAM_AREA` | The team-area application's bot token (Developer Portal → Bot), with the bot added to the AIS server: lets the site send Discord DMs |

### Email

Invites to invite-only polls and owner notifications are sent over SMTP from
the mailbox the admin sets up on `/app/settings/mail/` (Settings → Mail settings,
signed in with the admin password). For `tech@ais4i.it` on register.it the server is the one in the
mailbox's settings (e.g. `authsmtp.securemail.pro`, port 465), the username is
the full address. "Send a test email" checks it. The password is stored
encrypted with a key derived from `SESSION_SECRET`.

Until email is set up, polls open to anyone with the link work as before;
invite-only polls cannot be created.

### Calendar invite for the chosen time

When choosing the time, the owner can email the event to the participants
(ticked by default), to guests who did not answer, and to other addresses. Each
person gets their own email from the team mailbox with an iCalendar
invitation (`METHOD:REQUEST`) naming only them, which mail apps offer to add to
the calendar. "Change time" then sends them the cancellation (`METHOD:CANCEL`)
for the same event. "Download calendar event" gives the same event as a file.

Invitations show the poll owner's name as the sender ("Anna Rossi · AI Safety
for Italy", from the team address) and replies go to the owner.

### Recurring meetings

A poll can say its meeting repeats: every week, every 2 weeks, every month, or
every N weeks or months, with no end, until a date, or a number of times.
People vote for the first meeting. Once the time is chosen the series follows
it: the same weekday (weekly), or the same weekday of the month, e.g. "the 2nd
Tuesday" or "the last Thursday" (monthly). The calendar invitation and the
downloadable file carry an RRULE with the times in the poll's time zone and a
VTIMEZONE, so the meeting stays at the same local time across daylight-saving
changes; "Change time" cancels the whole series. See `server/recurrence.js`.

### Sharing a poll

A poll is its owner's. On the poll's page ("Who sees the poll") they share it
with Discord roles and with people by name (any member of the server, found
through the bot): those see it in their list ("Shared with you") and on its
page, with the answers but not the voters' emails, the guests or the voting
link, and change nothing. Seeing is not following: each turns on "Notify me"
(on the card, the poll's page, or Settings → Notifications) to hear about new
answers; the owner follows their own poll until they switch it off. Each card
shows, at the bottom, who sees the poll (name and why on hover). Columns
`share_roles`, `share_people`, `notify_choices` of `polls`.

### Notifications

Each member chooses on `/app/settings/` (Settings, at the bottom of the sidebar) how to hear about new answers to their
polls: email, Discord direct message, both, or off; each poll also has its own
"Notify me" switch. A Discord DM that cannot be delivered (no bot token, or the
member blocks DMs) falls back to email. On invite-only polls the owner is also
told once everyone invited has answered.

Tables are created automatically on first use (`server/schema.js`).

### Google Calendar (not connected)

Sending the invite through Google Calendar is switched off for now:
`server/calendar.js` and `scripts/meet-google-auth.js` are kept but unused.
Reconnecting means calling the calendar from `finalizePoll()` again.

## Privacy

- Poll links carry a random 128-bit token; nothing lists them.
- Participants' emails are only returned to the admin, never on the public page.
- Pages send `no-referrer` and `noindex`, and are excluded from the sitemap.
- A member only ever sees their own polls; anyone else's poll answers 404.
- An invite-only poll shows nothing without a guest's personal link, and each
  guest answers as the address they were invited at.
- The admin password is stored only as a scrypt hash, and its logins are
  throttled after 10 failures in 15 minutes. It signs in as a single shared
  "Admin" account, which owns the polls made before accounts existed.
- Sessions are signed, HttpOnly, SameSite=Strict cookies valid for 7 days.

# Site content (`/app/content/`)

Seminars and events published straight to the site by members whose Discord
roles allow it, without touching the code. No review: what is published goes
online at the next build, which publishing starts (about 3 minutes).

| Where                                 | What                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `/app/content/`                       | A box per part (seminars, events), each with who can use it                |
| `/app/content/seminars/`, `/events/`  | The seminars, the events: newest first, and their latest changes           |
| `/app/content/edit/`                  | The form (`?type=seminar`, `?type=event`, or `?id=…`), with a live preview |
| `server/routes/app/content.js`        | The API                                                                    |
| `server/content.js`                   | Validation, the entry each item becomes, versions, the import              |
| `server/permissions.js`               | Permissions from Discord roles and per person (`/api/app/permissions`)     |
| `server/content-build.js`             | What the site's build gets (`.eleventy.js`, the `events` data)             |
| `server/content-publish.js`           | After a save: start the build, tell the team channel                       |
| `scripts/content-migrate.js`          | Moves the seminars and events of `data/events.yaml` into the database      |
| `src/assets/js/meet/markdown-lite.js` | The small Markdown the texts are written in, shared with the browser       |

**How it fits the site.** Each item is stored as an entry shaped like one of
`data/events.yaml`, so the templates do not change. The build reads the
published items from the public `/api/content` of the site it deploys to (the
deploy workflow sets `CONTENT_SOURCE`: www.ais4i.it for main,
ais4i-dev.vercel.app for dev), so it needs no database address, and puts them
in place of the YAML's seminars and events: an entry is upcoming until its day
and past from the next (Past chip, no registration button, the "after the
event" text if there is one). Other entries of the YAML (the mentorship call)
and seminars or events without a `day` stay in the YAML. If `/api/content`
answers with an error, the build fails on purpose and the live site keeps its
current content.

**Permissions.** The Permissions page maps each Discord role to: Seminars,
Events, Videos & podcasts, Blog (the last two for later), Edit others' content,
Manage permissions. A member gets what all their roles allow together. Roles
are stored at sign-in and read again from Discord with the bot before every
publish, so losing a role on Discord takes effect at once. Discord sign-in
also lets in any role with a permission here, besides `DISCORD_ROLES_IDS`.
Without "Edit others' content" a member can only change what they published.

**Safety net.** Every save, removal and restore is a version: each item's page
lists them and can put any one back. Removing only hides an item. Texts are
Markdown limited to bold, italic, links and lists; everything else is escaped.

## Switching it on

Once per environment (dev first, then production):

1. Settings in Vercel, for that environment (Preview for dev, Production):
   - `CONTENT_BUILD_TOKEN`: a fine-grained GitHub token for this repository
     with only **Actions: Read and write**, so publishing rebuilds the site.
   - `CONTENT_BUILD_REF`: `dev` in Preview, `main` in Production.
   - `DISCORD_CONTENT_CHANNEL_ID`: the channel for the announcements (the bot
     `DISCORD_BOT_TOKEN_AIS_TEAM_AREA` must be able to write there).
2. Set the permissions: sign in as the admin, open Site content → Permissions,
   tick what each role may do, save.
3. On Site content, press **Switch on**: the seminars and events of
   `data/events.yaml` are copied in, and the site is rebuilt from them. From
   then on, edit them in the dashboard: changes to them in the YAML no longer
   show. **Switch off**, at the bottom of the same page, sends the site back to
   the YAML at its next update; nothing is deleted.

`scripts/content-migrate.js` does the same from the command line (`--off` to
switch off), against `DATABASE_URL` / `MEET_DATABASE_URL` or, with `--local`,
the local database.

Locally, `npm run dev:meet` offers stand-ins for the Discord roles on the
login page (Admin, Direttivo, Organizzatori, Partecipanti, one click each;
a fresh local database gives each a starting set of permissions,
`permissions.DEV_DEFAULTS`, to see what each one sees); `node scripts/content-migrate.js --local` (with the server
stopped) imports into the local database; publishing rewrites
`_content-snapshot.json`, which the watching build picks up.

# CRM board (`/app/crm/`, in progress)

A private board for the mentorship programme, later people and funding.
Phases 0 (foundations) and 1 (the mentorship board) are here.

**The mentorship board** (`/app/crm/`, permission `mentorship`;
`server/crm/mentorship.js`, `api/app/crm/mentorship.js`):

- **Mentors** and **Mentees**: a column per stage of the selection (mentors:
  to contact, contacted, interested, applied, selected, matched, declined;
  mentees: interested, contacted, applied, selected, matched, declined). Drag a
  card to move it, filter by track, search, or show only the people you follow.
- The three sheets are joined by person key: someone in two lists is one card.
  Until the team moves them, the stage comes from the sheets (an application
  means Applied; "Contattato: Sì" means Contacted…). Rows without an email
  are listed apart: they cannot be tracked until the sheet has one.
- A person's card: stage, track, who follows them, the team's notes
  (encrypted), every record about them (contact details only with
  `mentorship`) and their history from the audit trail.
- **Pairs**: a selected mentor and a selected mentee on the same track. A
  mentee has one mentor; a mentor can go over the number of mentees they asked
  for, with a warning. Pairing sets both to Matched; ending a pair sets them back
  to Selected and keeps the ended pair.

**The mentee selection** (`/app/review/`; `server/crm/review.js`,
`server/routes/app/crm/review.js`): reviewers score the mentees' applications
without knowing who they are, and a summary ranks them.

- **Who.** The panel's admins hold `review_admin`, a key given to people by
  name only (never to a Discord role) and only by the shared admin. They pick
  the reviewers on _Grid & reviewers_ from anyone who signed in with Discord
  (`review_reviewers`; reviewers hold no permission key). A reviewer sees the
  applications under a code and their own scores, never a name, the others'
  scores or the summary. Neither needs `mentorship`.
- **Two parts, scored apart**, each on its own grid (criteria 1 to 5, each with
  a weight, edited by the admins): the **CV** (the CV and profile links: not
  anonymous, a CV says who someone is) and the **answers** to the application
  form, with the name, role, affiliation, emails, links, handles and phone
  numbers taken out (`scrub`, best effort). A mentee's code differs between the
  two parts, so a reviewer doing both cannot pair a CV with its answers. A
  reviewer who knows the person steps aside instead of scoring.
- **Summary** (admins only): every applicant with the names, each part's mean
  over the complete reviews, how far the reviewers differ, the overall score
  (the parts' means, weighted) and each review with its comment (encrypted).
  "Hide names" shows the codes only, to discuss before the names.
- **The status is the board's.** Changing it in the summary moves the mentee
  on the board (`mentorship.update`) and the other way round: there is one
  status. Declined applicants leave the reviewers' lists. Matched is still
  set by pairing on the board. The board's history of a person leaves out the
  selection's lines, so it does not tell who reviewed whom.
- Scores go with the application they score (`server/retention.js`).

The foundations it stands on:

The rules, which later phases must keep:

- **Personal data in the database is always encrypted.** The board keeps its
  own copy of each person (`crm_records`, `server/crm/records.js`): imported
  once from the Google Sheets (`server/sheets.js`, read-only scope, fixed in
  the code), added by hand, or sent by a form. Each record, emails and answers
  included, is stored encrypted with AES-256-GCM (`data_encrypted`), bound to
  its row; so are form answers and member applications.
- **What is operational points at a person by an opaque key** (`personKey` in
  `server/crm/crypto.js`: an HMAC of the email, not the email): stages,
  pairs, followers. Free notes are encrypted too, bound to their person.
- **Permissions per part**, checked on the server on every request
  (`server/access.js`): `mentorship`, `people`, `finance`, `crm_admin`,
  set on the same Permissions page as the content tool's. A CRM permission
  opens nothing in the content tool and the other way round (`areas` in
  `server/permissions.js`). A sign-in older than 24 hours is asked again, and
  the Discord roles are re-read when the last read is older than five minutes.
- **Fields only some may read** (email, CV, profile links) are removed on the
  server by `access.redact`, not hidden by the page.
- **An append-only audit trail** (`crm_audit`; database triggers refuse update,
  delete and truncate) of who looked at or changed which record. Records are
  named by person key, never by email, and never carry what a person wrote.
- **Development and tests use invented data** (`server/crm/fixtures.js`), the
  same columns as the real sheets. `CRM_SHEETS_FAKE=1` is refused on the live
  site. Real answers never go in git, in the local database, or in `dev`.

Environment (Vercel; `scripts/meet-dev.js` sets throwaway values locally):

| Variable                      | What                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `CRM_ENCRYPTION_KEY`          | 32 random bytes, base64 (`openssl rand -base64 32`). Without it the CRM refuses to store. |
| `CRM_ENCRYPTION_KEY_PREVIOUS` | The old key while rotating: still opens old notes, never writes.                          |
| `CRM_KEY_SECRET`              | At least 32 characters. Makes the person keys. **Never change it**: it orphans every key. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The service account key (the same secret as the members workflow), to read the sheets.    |

Which spreadsheet and tab each source imports from is a setting (`crm_sources`),
edited by `crm_admin`; the sheets are shared, as Viewer, with the service
account one at a time. `server/crm/sources.js` maps the sheets' columns to
fields by header text, so a form that gains a question does not break the board.

# Forms (`/app/forms/`, `/form/?f=…`)

Forms made and answered on the platform instead of Google Forms: the engine,
the editor, the public page and the answers (review, charts, CSV export) are
here; a linked Google Sheet is not. The site's join buttons open the form with
the link `iscrizione`, and "Apply as a mentee" the one with
`candidatura-mentee`: both must exist and be open on each environment, and
only a forms admin can give a form those links.

- **The editor** (`/app/forms/`, permission `forms`, or `forms_admin` for all
  forms): start blank or from a template modelled on the current Google
  Forms (mentorship expression of interest, call for mentors, community
  sign-up); add questions from the left, drag them in the middle, set the
  chosen one on the right; texts in Italian and English; a preview drawn by
  the public page's own code; settings (draft / open / closed, dates, link,
  one answer per email, telling the owner about new answers (by email or
  Discord DM, as on their settings page; never what the answer says),
  emailing each person a copy of their answers (to the form's first email
  question, from the mailbox in Mail settings; on by default), which
  Discord roles and which people (any member of the Discord server, found
  by name) read the answers) and the public link, which the forms list
  also copies straight from each card. Answers are deleted
  24 months after they were sent (see "Keeping time of personal data").
- **Following**: seeing a form is not following it. Each person who reads
  the answers turns "Notify me" on (the form's card, or the editor) to be
  told about new answers on the channel from their Settings, and to have
  them counted on their home page; the owner follows their own form until
  they switch it off. The member applications board has the same switch
  (`server/follows.js`).
- **Tags** on answers: New and Seen to start (opening a new answer marks it
  Seen, once); whoever reads the answers adds more, or removes one no answer
  carries. On the sign-up form the board's decision shows as the answer's
  tag (Approved, Rejected).
- **Answers** (the editor's Answers tab; also the only tab for the Discord
  roles a form lets read its answers): a summary with a chart per question
  (bars, columns or donut, sortable, the choice remembered per form), numbers
  at a glance and answers over time; filters by status and date, and a click
  on a bar keeps only the answers that chose it, on every chart. One answer at
  a time, with previous / next (arrow keys) and its status (new, reviewing,
  accepted, rejected); a table with a column per question. The form's managers
  can also delete an answer for good and export them all as CSV (no cell runs
  as a formula in a spreadsheet). Every look, change, deletion and export is
  on the audit trail.
- **Questions**: short and long text, email, https link, number, one or several
  choices (with Other), drop-down, scale, date, yes/no, consent (recorded with
  the version of its text), text blocks and pages.
- **The public page** (`/form/?f=<slug>`, `api/form.js`, no sign-in): one page
  per section with a progress bar, errors beside their question, a draft kept
  in the browser, in the form's languages.

Security (`server/forms/`):

- Every public answer is checked on the server against the version of the form
  it was given to (`schema.js`); unknown keys are dropped.
- Answers are stored encrypted (AES-256-GCM, `server/crm/crypto.js`), bound to
  their form and response; the respondent is known only by the opaque key of
  their email. Editing a form with answers makes a new version, so old answers
  keep their questions.
- Anti-spam (`guard.js`): a signed token with the time the form was opened, a
  honeypot, a minimum filling time, and at most 5 answers per address and form
  in 10 minutes; the address is kept only as a daily HMAC, for a day.
- Who may manage a form or read its answers is checked on every call; a form
  you may not see answers 404. Views, changes and refusals go on the CRM's
  append-only audit trail.

# Member applications (`/app/members/`)

The registration form's submissions, reviewed by members whose Discord roles
hold **Member applications** (`members`, ticked on Settings → Permissions).
In the sidebar: Members → Applications.

| Where                   | What                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `/app/members/`         | The board: to review, contacted, invited, on Discord, rejected |
| `api/app/members.js`    | The board's API                                                |
| `api/join.js`, `/join/` | The personal link an approved person gets, and where it ends   |
| `server/members.js`     | Submissions (`createApplication`), decisions, the join         |

**Flow.** A submission becomes a pending application (`createApplication()`,
called by whatever serves the registration form). Approving picks a role,
Participant or Organizer (the one asked for is preselected), and emails a
personal link valid 30 days. Following it signs in with Discord (scope
`identify guilds.join`); the bot adds the person to the server with that role,
or gives it to them if they are already in, and the board shows their Discord
account. The link works once; "Send the link again" makes a new one. Rejecting
sends nothing.

**Before deciding.** The internal note is saved on its own, at any stage
(deciding saves it too). A pending application can be asked for more details:
"Ask for more details by email" writes to the applicant from the mailbox, in
the writer's name, with replies to and a Bcc copy in the team's inbox
(`MEMBERS_CONTACT_EMAIL`, default `info@ais4i.it`); the email is not stored,
only who sent one and when. Sending it, or the "Contacted" switch (for
contact made elsewhere), moves the application to **Contacted**: still to be
decided, but waiting on the applicant, so not counted on the home page.

**Personal data.** Name, email and answers are stored encrypted with the
CRM keys (`CRM_ENCRYPTION_KEY`, `CRM_KEY_SECRET`), bound to their row; the
email is otherwise kept only as an opaque key, to spot someone who applied
twice. Without the keys no application is taken (503). The board goes
through the same door as the CRM (`server/access.js`): a sign-in less
than a day old, Discord roles read again, and every look and decision on the
audit trail. The internal note is not encrypted: it must not hold personal
data.

**Setting up**, besides what sign-in and the bot already need:

- `DISCORD_ROLE_PARTICIPANT`, `DISCORD_ROLE_ORGANIZER`: the role ids to give.
- On the Discord application, redirects `https://<host>/api/join` for every
  host, next to the `/api/discord` ones.
- `guilds.join` only works with the bot of the **same** application as
  `DISCORD_CLIENT_ID`. The bot needs Create Instant Invite and Manage Roles,
  and its role must sit above the two roles it gives.

Locally (`npm run dev:meet`, no Discord) the link joins at once.

# The community: members and working groups (`/app/members/people/`, `/groups/`)

The directory of members and the working groups, kept in the database instead
of the old members sheet (`scripts/update-members.py`, `data/members.yaml`).
In the sidebar: Members → Board, with its own permission, **Members board**
(`community`), given apart from the applications. Whoever held `members`
before the split got `community` too, once (`migration_community_key` in
`server/schema.js`).

**The Permissions page** lists first the association's Discord roles (Admin,
Direttivo, Organizzatori, Partecipanti: by id for the two in
`DISCORD_ROLE_PARTICIPANT` / `DISCORD_ROLE_ORGANIZER`, else by name,
`isMainRole`); the others, the working groups' roles used as tags among
them, are folded under "Other roles", still editable. A person shows what
they already hold through their Discord roles as yellow, locked switches
("From role: Direttivo"), changed on the role. Opening the page reads
everyone's roles again from Discord (`refreshPeopleRoles`), so a role taken
away there no longer shows as held.

**The members board: the database says, Discord and the website follow.**
Every change on the board is saved in the database at once, and only there.
Discord and the website are two places that follow the board when someone
says so, and a bar on top of every tab (`community-common.js`, `status` in
`server/community.js`) says where each stands: _Database_ (always saved),
_Discord_ (changes to apply, things to decide, accounts to link) and
_Website_ (changes not online yet, the last update's build). Before
anything leaves the database a dialog lists what changes, and where.

- **Discord** (`discordPlan`): the board is compared with the server each
  time, so there is no list of changes to keep in step. _Changes to apply_
  are the roles of the members' groups and of their role (Partecipante /
  Organizzatore, `DISCORD_ROLE_PARTICIPANT` / `DISCORD_ROLE_ORGANIZER`) that
  are missing there, and those the board took away (`discord_removals`: out
  of a group, made a participant) or that belonged to a group removed or
  given another role (`discord_retired_roles`). They change on Discord only
  when applied (`applyDiscord`, 15 a call, each checked against Discord
  again just before), from the Discord tab or from a member's page. _To
  decide_ is what Discord has that the board does not say (a group's role
  given by hand, Organizzatore on a participant): adopted here, queued to
  take off, or left (`decideDiscord`). Choices to leave something as it is
  (`member_role_ok`, `member_main_role_ok`, `discord_no_role_ok`) are listed
  under _Left as they are_, and can be undone (`unignore`). People on the
  server with neither role and not on the board can be added (their role
  then waits to be applied) or left. Accounts gone from the server are
  unlinked here. **Only two automatic flows change Discord at once**:
  joining with the invite link (`completeJoin`) and an approved upgrade
  (`decideUpgrade`), which give the roles they were approved with; they
  are on the member's history. Whoever is made an organizer on the board has
  their waiting upgrade request approved with it (`upgradeSettled`).
- **Website**: "Update the website" (Website tab) stores what the site may
  show (consented members, their public fields, the groups) and starts a
  build. The tab lists, name by name, what the next update changes
  (`siteState().diff`); each member's row and page say whether they are
  online as they are here.
- **A member's page** (`/app/members/member/?id=`, `memberDetail`): their
  details and consent, role and groups (coordinators too) in one form; their
  Discord account (linked from there: suggestions by name, a search, or "not
  on Discord") and what waits there for them; their card on the website;
  what they answered (their applications and upgrades, read from
  `member_applications`, and the old sheet's rows, `member_sources`); their
  history from the audit trail (`audit.forMember`: lines about them, and
  changes to several people that named them in `detail.members`). Under each
  field, where its value came from (`field_sources`).
- **Data from several places, one set of rules** (`server/member-merge.js`):
  the old sheet, applications, upgrades, Discord and the board each record
  where every field came from and when (`field_sources`). A later source
  fills empty fields and takes newer answers; what was set on the board is
  never overwritten on its own (an import shows it as a conflict, to keep or
  take; an application keeps the board's); the role is never lowered;
  groups are only added; a Discord account is only filled, never replaced;
  consent goes by the latest statement. Importing the old sheet is
  previewed as a merge report (new, completed, to decide, unchanged,
  possible duplicate: a name alone never merges on its own) and then applied
  in one transaction, exactly as previewed; the sheet's rows are kept on the
  member (encrypted, by their hash, so the same sheet again adds nothing).
  Matching to Discord before storing: by email (they signed in here with
  Discord), else by name (the sheet's name, letter for letter, is one
  account's nickname, display name or username and no other's; it needs the
  bot to read the server's list, the Server Members intent, and the preview
  says why when it cannot).

**A member's life on the board.**

- _Offboarding_ (`offboard`, a member's page) is for someone who left. They
  stay as a record, with a note of why, and are hidden from the website at
  once. Every role the board gives them is listed on the Discord tab to take
  off (reason `archived`). _Restore_ makes them a member again, and approving
  a new application of theirs does too. The Members tab shows offboarded
  people under their own filter.
- _Possible duplicates_ (`duplicates`): members with the same name, ignoring
  accents, case and word order. They show under their own filter and on each
  one's page.
  - _Merge_ (`mergeMembers`) keeps one record and fills its gaps from the
    other. It takes the higher role, every group, and the Discord account and
    email key if missing. The kept answers, notes and choices move over. The
    other record is removed, and its history is read under the kept one
    (`merged_ids`).
  - _Not the same person_ (`member_not_duplicates`) stops offering the pair.
- _Notes_ (`member_notes`) are for the team only. They are encrypted, and
  removed only by their author.
- _Erase all their data_ (`eraseMember`, typing their name to confirm) is for
  a request to be forgotten. It deletes their record, groups, notes, kept
  answers, their applications and the form answers those came from. The
  audit trail keeps that it happened, never who. Discord is not touched:
  offboard and apply first to take their roles off.
- _The daily Discord check_ (`driftCheck`, `/api/cron/discord-check`,
  `.github/workflows/discord-check.yml`, with the same `CRON_SECRET` as the
  cleanup) compares the board with the server. It tells whoever follows the
  board (topic `community`: "Notify me" on the Discord tab, or Settings) what
  changed there by hand: roles given or kept by hand, accounts gone, newcomers
  with no role. It sends counts only, and tells each thing once
  (`community_drift_seen`).

**Export CSV** (Members tab) downloads every member, one row each: name,
role, working groups and those they coordinate, place, areas, profile,
consent, their Discord account, source and join date (`exportCsv`, written
on the audit trail; cells starting like a formula kept as text).

**Locally**, `MEET_DEV_DISCORD=1 npm run dev:meet` puts a stand-in Discord
server with invented people behind the bot (`scripts/dev-discord.js`), so
the Discord tab can be tried; without it nothing reaches Discord, and the
bar and the tab say so.

**The sidebar's groups.** Tools that belong together are listed under one
entry that opens on them (`group` and `navLabel` in `src/data/tools.js`,
the groups in `src/data/toolGroups.js`): Mentorship → Board, Selection;
Members → Applications, Board. Each tool keeps its own permission area, so
a group shows only the tools one may open, and the Permissions page lists
the keys under the same names ("Mentorship › Selection").

**Site content** is one entry, shown to whoever holds `seminar` or `event`
(`needsAny`; holding only "Manage permissions" opens nothing to publish, so
no empty tool). Its page has a box per part (`sections` in `tools.js`),
each shown to who holds that part's key, with its own faces; each list
(`?type=` on the API) is refused to who may not publish that kind.

| Where                         | What                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/app/members/`               | Applications: approve with a role and the working groups as tags                                               |
| `/app/members/people/`        | Members: filters (needs attention, role, group, Discord, website, source), changes in bulk, CSV export, import |
| `/app/members/member/?id=`    | A member's page: details, role and groups, Discord, website, answers, history                                  |
| `/app/members/groups/`        | Working groups: names, descriptions, order, the Discord role of each, coordinators                             |
| `/app/members/discord/`       | Discord: changes to apply, what to decide, accounts to link, people with no role, choices to undo              |
| `/app/members/site/`          | Website: what the next update changes, and updating it                                                         |
| `/app/organizer/`             | A participant asks to become an organizer (an upgrade on the board)                                            |
| `server/community.js`         | Groups, members, tags, the Discord plan, the import, publishing                                                |
| `server/member-merge.js`      | The rules for data arriving from several places                                                                |
| `server/community-build.js`   | What the site's build takes: the published copy, or the YAML                                                   |
| `/api/content?part=community` | The published copy, for the build (public, consented members only)                                             |

- **Working groups are tags.** Each is a Discord role (`work_groups`, the
  eight first ones seeded with their role ids). Being in a group means its role
  on Discord, leaving it means taking it off, once applied; here it opens nothing. A new group
  needs its role made on Discord first (and the bot's role above it). The
  sign-up form's group questions take their options from this table
  (`optionsFrom: 'work_groups'`), so the form follows the groups.
- **Coordinators.** Chosen on Working groups (each group's card: add, take
  back) or on a member's page. Forms no longer ask who would coordinate; the old sheet's
  "Coordinamento", older forms' answers, applications and Members' tags all
  mean taking part. Once on each database, the coordination declared before
  became taking part (`migration_coordinators`). Stable participation gives
  the tag (occasional does not).
- **Members** (`community_members`, `member_groups`): someone approved on the
  board joins the list when they enter Discord, with their tags and their
  consent to be shown; the old sheet is imported (CSV, previewed as a merge,
  the rules of `update-members.py`), as many times as needed. Details are
  encrypted like an application's.
- **The site changes only on "Update the website"** (the Website tab). That stores a copy of
  what the site may show (consented members, their public fields, the groups)
  and starts a build; another build (a seminar) shows the same copy. Never
  published, the YAML stays the site; "Back to the old directory" undoes it.
- **Becoming an organizer.** A participant (Participant role, not Organizer)
  answers the organizers' part from `/app/organizer/`; it reaches the board
  flagged as an upgrade. Approving gives the Organizer role and the tags at
  once (no join link) and tells them.

Once the directory is published from the dashboard, the scheduled job that
rebuilt `data/members.yaml` from the sheet (`update-members.yml`) only changes
the fallback: it can be switched off.

# Local groups (`/app/local-groups/`, Site content → Local groups)

A board of the city groups, and what the community page's map shows of them.

| Where                            | What                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| `/app/local-groups/`             | The board (`local_groups`): a column per status, or a table; CSV download |
| `/app/content/local-groups/`     | Which cities the map shows, each pin and link (`local_groups_site`)       |
| `server/local-groups.js`         | The groups, their encrypted details, the CSV, publishing the map          |
| `server/local-groups-build.js`   | What the site's build takes: the published cities, or community.yaml's    |
| `/api/content?part=local-groups` | The published cities, for the build (public: name, pin, link)             |

- **The board.** A card per city: its status (starting, active, paused; drag
  to move), who leads it with their email and phone, the WhatsApp invite link
  and notes. Leads, link and notes are personal data or as good as a key to
  the chat: encrypted like the CRM's (`CRM_ENCRYPTION_KEY`), read only with
  `local_groups` (a guarded key: recent sign-in, given by `manage_all`), every
  read, change and export on the audit trail. The table shows every lead with
  their contacts; "Download CSV" gives one row per group.
- **The site.** Site content → Local groups lists the board's cities without
  any of those details: tick those the map shows, add a link if the name
  should open something (the WhatsApp group, a site), and place the pin
  (ticking a known city places it; "Move the pin", then a click on the map).
  "Publish to the site" saves and rebuilds; never published, the cities of
  `data/community.yaml` stay the site. The board starts with those same
  cities (`migration_local_groups_seed`), so the first publish changes nothing.

# Keeping time of personal data

12 months for everyone who was not selected: answers to forms, member
applications never approved, and the mentorship board's own copies of people
(imported or added by hand; those from a form go with their answer), together
with the notes and status the team wrote about them. Approved applications
stay, as the record of who is a member, but after 12 months only name and email
remain (the answers are dropped). The board's copies of people selected for the
program (selected or paired) stay 24 months (`server/retention.js`). A GitHub
Action runs it once a day
on the live site (`.github/workflows/retention.yml`), calling
`/api/cron/cleanup` with a shared secret; each run leaves one line with the
counts on the audit trail.

Setting up, once: a random `CRON_SECRET` of at least 32 characters
(`openssl rand -base64 48`), saved both as a Vercel environment variable
(Production) and as a GitHub repository secret. Without it the job does
nothing. The privacy notice (`src/content/privacy.njk`) says the same periods:
when one changes here, change it there and tell the people already on file.

# Calendar (`/app/calendar/`)

One calendar for the whole community, split into calendars of their own
(a team, a working group, the site's seminars), open to every signed-in member
(`server/calendars.js`, `server/routes/app/calendar.js`; pages in
`src/content/app/calendar/`, scripts `src/assets/js/meet/calendar-*.js`).

| Where                         | What                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `/app/calendar/`              | Month, week, day and agenda views; the card of an event; its editor       |
| `/app/calendar/calendars/`    | The calendars one sees, and for who manages one: details, access, Discord |
| `/app/calendar/subscribe/`    | The personal `.ics` link, and what it carries                             |
| `/calendar/`, `/it/calendar/` | The public calendars on the site, read live from `api/calendar.js`        |
| `/calendar/feed/<token>.ics`  | A member's personal feed (rewritten to `api/calendar.js?feed=`)           |
| `/calendar/<slug>.ics`        | A public calendar's feed, the same for everyone                           |

**Who may do what.** Each calendar has three levels, each given to every
member, to Discord roles and to people by name, each including the one before:

- **View**: sees the events and answers going / maybe / no;
- **Edit**: also creates, changes and deletes every event of the calendar;
- **Manage**: also changes the calendar, who has access and its Discord
  announcements, and archives it.

A calendar can also be **public**: anyone sees it, signed in or not. Whoever
created a calendar manages it. Two keys on Settings › Permissions, under
Calendar: `calendar_create` creates new calendars, `calendar_admin` manages all
of them (the Seminars and Events ones too). Whoever holds `manage` can give both.

**Events**: times in a time zone, or whole days; repeating daily, weekly or
monthly (`recurrence.js`), changed or deleted for one occurrence, for the
following ones or for all; a place; a video call, as a link (Meet, Zoom, Teams…)
or a voice channel of the Discord server; reminders; Discord announcements.

**Following.** On Subscribe, in the simple mode, a tick per calendar shows it
on the dashboard and puts it in the personal link, and one switch sends the
reminders of the same calendars; "Per calendar" gives each its three switches.
A calendar nobody chose about is on. The link is checked again on every read:
someone who loses a role loses those events at the calendar app's next read.
Google reads a subscribed calendar every 12–24 hours, Outlook and Apple more often.

**Reminders and announcements** (`server/calendar-reminders.js`). Whoever writes
an event chooses its reminders (how long before; Discord DM and/or email); they
go to who turned notifications on for its calendar and still sees it, and to
who answered going or maybe. Each calendar can name Discord text channels, each
with its lead times, where the bot announces its events; an event can name its
own instead, or none. Only the channels where the bot may write are offered
(`server/calendar-discord.js`). The job runs every 10 minutes from
`.github/workflows/calendar-reminders.yml` (`/api/cron/cleanup?job=reminders`,
the same `CRON_SECRET` as the cleanup); a run late by up to 30 minutes still
sends what was due, and nothing goes twice (`calendar_reminders_sent`).

**From other tools.** A seminar or event of Site content lands in Seminars or
Events (created once, public), in another calendar its form chooses, or in
none; a poll's chosen time lands in the calendar chosen when it is set. Those
copies are changed where they come from only, and follow every change there.

Tables: `calendars`, `calendar_events`, `calendar_rsvps`, `calendar_prefs`,
`calendar_reminders_sent`; `content_items.calendar_choice`, `polls.calendar_id`.
