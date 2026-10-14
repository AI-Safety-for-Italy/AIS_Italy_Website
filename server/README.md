# Meeting polls

A private, Doodle-style scheduler inside the team area (`/app/`). Members sign
in with Discord, propose times, share a link, people mark when they're
available, and the owner picks the time. Each member sees only their own polls.
The owner then downloads the event as an `.ics` file and copies everyone's
email to send the invite from their own calendar.

| Where                                            | What                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `/app/login/`                                    | Sign-in: Discord, or the shared admin password                       |
| `/app/`                                          | Tools available after sign-in (meeting polls for now)                |
| `/app/polls/`                                    | The member's own polls (not linked anywhere, not indexed)            |
| `/meet/?p=…`, `/it/meet/?p=…`                    | The voting page people get the link to                               |
| `api/`                                           | Vercel Functions: `auth`, `discord`, `app/polls`, `app/poll`, `poll` |
| `server/`                                        | Shared server code: database, auth, Discord, polls                   |
| `src/content/app/`, `src/content/meet.njk`       | Page shells                                                          |
| `src/assets/js/meet/`, `src/assets/css/meet.css` | Client scripts and styles                                            |

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
| `DISCORD_ROLE_IDS`      | Roles allowed in, comma-separated (Server Settings → Roles → Copy ID)         |

On the Discord application, add a redirect for every host the site runs on:
`https://www.ais4i.it/api/discord`, `https://ais4i-dev.vercel.app/api/discord`
and `http://localhost:8080/api/discord`.

Discord sign-in asks for the member's identity, email and server membership,
and lets in only members of `DISCORD_GUILD_ID` holding one of
`DISCORD_ROLE_IDS`. The role is checked at each sign-in; a session lasts 7 days.

| `DISCORD_BOT_TOKEN` | The invite bot's token (already a GitHub secret): lets the site send Discord DMs |

### Email

Invites to invite-only polls and owner notifications are sent over SMTP from
the mailbox the admin sets up on `/app/settings/` (signed in with the admin
password). For `tech@ais4i.it` on register.it the server is the one in the
mailbox's settings (e.g. `authsmtp.securemail.pro`, port 465), the username is
the full address. "Send a test email" checks it. The password is stored
encrypted with a key derived from `SESSION_SECRET`.

Until email is set up, polls open to anyone with the link work as before;
invite-only polls cannot be created.

### Notifications

Each member chooses on `/app/settings/` how to hear about new answers to their
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
