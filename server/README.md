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
| `/app/settings/`                                 | My settings: the member's own notifications (profile menu)                           |
| `/app/polls/settings/`                           | General settings: the sending mailbox (admin only)                                   |
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

On the Discord application, add a redirect for every host the site runs on:
`https://www.ais4i.it/api/discord`, `https://ais4i-dev.vercel.app/api/discord`
and `http://localhost:8080/api/discord`.

Discord sign-in asks for the member's identity, email and server membership,
and lets in only members of `DISCORD_GUILD_ID` holding one of
`DISCORD_ROLES_IDS`. The role is checked at each sign-in; a session lasts 7 days.

| `DISCORD_BOT_TOKEN_AIS_TEAM_AREA` | The team-area application's bot token (Developer Portal → Bot), with the bot added to the AIS server: lets the site send Discord DMs |

### Email

Invites to invite-only polls and owner notifications are sent over SMTP from
the mailbox the admin sets up on `/app/polls/settings/` (General settings,
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

### Notifications

Each member chooses on `/app/settings/` (profile menu → My settings) how to hear about new answers to their
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
| `/app/content/`                       | The list, newest first, and the latest changes                             |
| `/app/content/edit/`                  | The form (`?type=seminar`, `?type=event`, or `?id=…`), with a live preview |
| `/app/content/permissions/`           | Which Discord role may do what (roles with `manage`, and the admin)        |
| `api/app/content.js`                  | The API                                                                    |
| `server/content.js`                   | Validation, the entry each item becomes, versions, the import              |
| `server/permissions.js`               | Permissions from Discord roles                                             |
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
login page; `node scripts/content-migrate.js --local` (with the server
stopped) imports into the local database; publishing rewrites
`_content-snapshot.json`, which the watching build picks up.

# CRM board (`/app/crm/`, in progress)

A private board for the mentorship programme (mentors by track, mentees,
matches), later people and funding. **Phase 0, the foundations, is here; there
are no pages yet.** Design and phases: the plan this branch was built from.

The rules it is built on, which later phases must keep:

- **Personal data stays in the Google Sheets the forms write to.** The board
  reads them (`server/sheets.js`, read-only scope, fixed in the code) and never
  copies emails, CVs or answers into the database. Reads are cached in memory
  for two minutes, never on disk.
- **The database holds only what is operational**, pointing at a person by an
  opaque key (`personKey` in `server/crm/crypto.js`: an HMAC of the email, not
  the email). Free notes are encrypted with AES-256-GCM, bound to their person.
- **Permissions per part**, checked on the server on every request
  (`server/crm/access.js`): `mentorship`, `people`, `finance`, `crm_admin`,
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

Which spreadsheet and tab each source reads is a setting (`crm_sources`),
edited by `crm_admin`; the sheets are shared, as Viewer, with the service
account one at a time. `server/crm/sources.js` maps the sheets' columns to
fields by header text, so a form that gains a question does not break the board.
