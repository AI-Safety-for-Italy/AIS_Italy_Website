# Meeting polls

A private, Doodle-style scheduler: the team proposes times from a password-
protected admin panel, shares a link, people mark when they're available, and
the chosen time is sent out as a Google Calendar invite from the AIS account.

| Where                                            | What                                                       |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `/admin/`                                        | Admin panel (not linked anywhere, not indexed)             |
| `/meet/?p=…`, `/it/meet/?p=…`                    | The voting page people get the link to                     |
| `api/`                                           | Vercel Functions: `admin/session`, `admin/polls`, `admin/poll`, `poll` |
| `server/`                                        | Shared server code: database, auth, polls, Google Calendar |
| `src/content/admin/`, `src/content/meet.njk`     | Page shells                                                |
| `src/assets/js/meet/`, `src/assets/css/meet.css` | Client scripts and styles                                  |

## Run it locally

```sh
npm run dev:meet          # http://localhost:8080/admin/  (password: admin)
npm run test:meet
```

No setup needed: the local server uses PGlite (Postgres in-process, stored in
`.meet-dev-db/`) and a fake calendar that only logs the event it would create.
Set `DATABASE_URL` or the `GOOGLE_*` variables to use the real services.

## Production settings (Vercel → Settings → Environment Variables)

| Variable               | How to get it                                                    |
| ---------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`         | Set automatically when Neon is added from Vercel → Storage       |
| `ADMIN_PASSWORD_HASH`  | `node scripts/meet-hash-password.js`                             |
| `SESSION_SECRET`       | `openssl rand -base64 48` (changing it signs everyone out)        |
| `GOOGLE_CLIENT_ID`     | Google Cloud OAuth client, type "Desktop app"                    |
| `GOOGLE_CLIENT_SECRET` | Same client                                                      |
| `GOOGLE_REFRESH_TOKEN` | `node scripts/meet-google-auth.js`, signed in as the AIS account |
| `GOOGLE_CALENDAR_ID`   | Optional; defaults to the account's primary calendar             |

Tables are created automatically on first use (`server/schema.js`).

### Google Calendar

The OAuth consent screen must be published ("In production"). In "Testing"
Google expires refresh tokens after 7 days and invites start failing with
"Google access has expired". An unverified app is fine: only the AIS account
ever signs in to it.

A service account would not work here: without Google Workspace domain-wide
delegation it may not invite attendees.

## Privacy

- Poll links carry a random 128-bit token; nothing lists them.
- Participants' emails are only returned to the admin, never on the public page.
- Pages send `no-referrer` and `noindex`, and are excluded from the sitemap.
- The admin password is stored only as a scrypt hash; sessions are signed,
  HttpOnly, SameSite=Strict cookies valid for 7 days; logins are throttled
  after 10 failures in 15 minutes.
- `server/auth.js` is the only place that knows how admins sign in, so it can
  later be replaced by per-person accounts.
