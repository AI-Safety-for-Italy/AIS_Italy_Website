#!/usr/bin/env python3
"""
Send a single-use Discord invite to every approved applicant, by email.

Usage:
    python3 scripts/send-discord-invites.py --dry-run   # report, change nothing
    python3 scripts/send-discord-invites.py             # create, send, record

Reads the registration form's response sheet as the same service account as
update-members.py, this time with write access, because the sheet is also the
record of what was sent. Three columns are added to it by hand, and found by
their header wherever they sit:

    Stato       "Approvato" / "Rifiutato" / anything else (pending)
    Invito      the invite link, written by this script
    Inviato il  when the email went out, written by this script
    Ri-invia    a checkbox: tick it to send the person a fresh invite

A person (rows are grouped by email; the most recent submission decides) gets
an invite when their Stato is "Approvato" and no row of theirs has "Inviato il"
filled in. People who first registered before LEGACY_BEFORE count as approved
and as already in the server, so they are skipped unless "Ri-invia" is ticked
(or Stato says "Rifiutato", which stops everything). Typing anything into
"Inviato il" by hand also marks someone as done.

Each step is written to the sheet as soon as it succeeds, so a run that dies
half-way never invites anyone twice: a link that was created but not emailed is
recorded in "Invito", and the next run emails that same link instead of making
a new one. A failure on one row is reported and the run moves on to the next;
the run then exits non-zero so the failure shows up in GitHub.

Nothing personal is ever printed: rows are identified by their sheet row
number, never by email, name or invite link.

Environment (not needed with --dry-run, except the Google key):
    GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS
    DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID
    SMTP_HOST, SMTP_PORT (465 = SSL, otherwise STARTTLS), SMTP_USERNAME,
    SMTP_PASSWORD, and optionally SMTP_FROM (defaults to SMTP_USERNAME)
"""

import argparse
import importlib.util
import json
import os
import re
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from email.message import EmailMessage
from email.utils import formataddr
from zoneinfo import ZoneInfo

_spec = importlib.util.spec_from_file_location(
    'update_members',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'update-members.py'))
um = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(um)

INVITE_COL = 'Invito'
SENT_COL = 'Inviato il'
RESEND_COL = 'Ri-invia'
EMAIL_COL = 'Indirizzo email'
REQUIRED_COLS = [um.TIMESTAMP_COL, EMAIL_COL, 'Nome', um.STATUS_COL,
                 INVITE_COL, SENT_COL, RESEND_COL]

SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
DISCORD_API = 'https://discord.com/api/v10'
INVITE_MAX_AGE = 7 * 24 * 3600  # seconds; the email promises seven days
SENDER_NAME = 'AI Safety for Italy'
TIMEZONE = ZoneInfo('Europe/Rome')

# How a ticked checkbox reads back, in an English or an Italian sheet, plus what
# someone might type by hand instead.
TRUTHY = {'true', 'vero', 'sì', 'si', 'yes', 'x', '1'}
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


class RowError(Exception):
    """A failure that concerns one row only. Its message must hold no personal data."""


# --------------------------------------------------------------------------
# Sheet
# --------------------------------------------------------------------------

def column_letter(index):
    """0 -> 'A', 25 -> 'Z', 26 -> 'AA'."""
    letters = ''
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def records_from_values(values):
    """Header -> value dicts like um.rows_from_values, each tagged with its sheet row."""
    rows = um.rows_from_values(values)
    for offset, row in enumerate(rows):
        row['_row'] = offset + 2  # 1-based, after the header
    header = [(h or '').strip() for h in values[0]] if values else []
    return header, rows


def check_columns(header):
    missing = [c for c in REQUIRED_COLS if c not in header]
    if missing:
        sys.exit("The sheet is missing columns this script needs: "
                 + ", ".join(repr(c) for c in missing)
                 + ". Add them (the header must match exactly) and re-run. "
                   "Nothing was sent.")


class Sheet:
    """The responses tab, read once and written back one cell range at a time."""

    def __init__(self, token, sheet_id=um.SHEET_ID, gid=um.SHEET_GID):
        self.token = token
        self.base = f"{um.SHEETS_API}/{urllib.parse.quote(sheet_id)}"
        meta = um._api_get(f"{self.base}?fields=sheets.properties(sheetId,title)", token)
        titles = {s['properties']['sheetId']: s['properties']['title']
                  for s in meta.get('sheets', [])}
        if gid not in titles:
            sys.exit(f"The sheet has no tab with gid {gid}. Check SHEET_GID.")
        self.tab = "'" + titles[gid].replace("'", "''") + "'"
        data = um._api_get(f"{self.base}/values/{urllib.parse.quote(self.tab, safe='')}"
                           "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE", token)
        self.header, self.rows = records_from_values(data.get('values', []))

    def write(self, row_number, cells):
        """Write {column header: value} into one row, in a single request."""
        body = {
            # RAW keeps the timestamp a plain string, whatever the sheet's
            # locale, and stores False as a real boolean for the checkbox.
            'valueInputOption': 'RAW',
            'data': [
                {'range': f"{self.tab}!{column_letter(self.header.index(col))}{row_number}",
                 'values': [[value]]}
                for col, value in cells.items()
            ],
        }
        req = urllib.request.Request(
            f"{self.base}/values:batchUpdate", data=json.dumps(body).encode(),
            method='POST', headers={'Authorization': f'Bearer {self.token}',
                                    'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60):
                pass
        except urllib.error.HTTPError as err:
            hint = (" Share the sheet with the service account as Editor."
                    if err.code == 403 else "")
            raise RowError(f"the sheet refused the write (HTTP {err.code}).{hint}") from None
        except OSError as err:
            raise RowError(f"could not reach the Sheets API ({type(err).__name__})") from None


# --------------------------------------------------------------------------
# Who gets what
# --------------------------------------------------------------------------

def is_ticked(value):
    return um._normalize(value) in TRUTHY


def plan(rows, today=None):
    """Decide, per person, what to do. Pure: no network, no side effects.

    Returns (actions, notes). Each action is a dict with:
        kind  'new'     create an invite, then email it
              'pending' an invite was recorded but never emailed: email it
              'resend'  'Ri-invia' is ticked: a fresh invite, then email it
        row   the person's most recent row, where everything is written
        link  the recorded invite, for 'pending'
    `notes` are row-numbered messages about rows that need a human.
    """
    actions, notes = [], []
    groups, order = {}, []
    for row in rows:
        key = um.email_key(row)
        if not key:
            if um.status(row) == um._normalize(um.STATUS_APPROVED):
                notes.append(f"row {row['_row']}: approved but has no email address")
            continue
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)

    for key in order:
        group = groups[key]
        # Most recent submission decides; on a tie the lower row is the newer one.
        latest = max(group, key=lambda r: (um.submission_date(r) or date.min, r['_row']))
        first = min((d for d in map(um.submission_date, group) if d), default=None)
        if not um.is_approved(latest, first):
            if is_ticked(latest.get(RESEND_COL, '')):
                notes.append(f"row {latest['_row']}: 'Ri-invia' is ticked but the "
                             "person is not approved; nothing sent")
            continue
        if not EMAIL_RE.match(latest.get(EMAIL_COL, '').strip()):
            notes.append(f"row {latest['_row']}: the email address looks malformed")
            continue
        if is_ticked(latest.get(RESEND_COL, '')):
            actions.append({'kind': 'resend', 'row': latest})
        elif um.is_legacy(first):
            continue  # already in the server
        elif any(r.get(SENT_COL, '').strip() for r in group):
            continue  # already invited
        elif latest.get(INVITE_COL, '').strip():
            actions.append({'kind': 'pending', 'row': latest,
                            'link': latest[INVITE_COL].strip()})
        else:
            actions.append({'kind': 'new', 'row': latest})
    return actions, notes


# --------------------------------------------------------------------------
# Discord
# --------------------------------------------------------------------------

def create_invite(bot_token, channel_id, attempts=3):
    """Create a single-use, seven-day invite and return its URL."""
    body = json.dumps({'max_age': INVITE_MAX_AGE, 'max_uses': 1, 'unique': True}).encode()
    for attempt in range(attempts):
        req = urllib.request.Request(
            f"{DISCORD_API}/channels/{channel_id}/invites", data=body, method='POST',
            headers={'Authorization': f'Bot {bot_token}',
                     'Content-Type': 'application/json',
                     # Discord rejects requests without a bot-style User-Agent.
                     'User-Agent': 'DiscordBot (https://ais4i.it, 1.0)'})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                code = json.load(resp)['code']
            return f"https://discord.gg/{code}"
        except urllib.error.HTTPError as err:
            try:
                detail = json.load(err)
            except ValueError:
                detail = {}
            if err.code == 429 and attempt + 1 < attempts:
                time.sleep(float(detail.get('retry_after', 1)) + 0.5)
                continue
            hints = {401: " Check DISCORD_BOT_TOKEN.",
                     403: " The bot needs 'Create Instant Invite' on this channel.",
                     404: " Check DISCORD_CHANNEL_ID."}
            # Discord's message ("Missing Permissions", ...) never echoes the token.
            message = str(detail.get('message', '')).strip()
            raise RowError(f"Discord refused the invite (HTTP {err.code}"
                           f"{': ' + message if message else ''}).{hints.get(err.code, '')}"
                           ) from None
        except (OSError, KeyError, ValueError) as err:
            raise RowError(f"could not create the invite ({type(err).__name__})") from None
    raise RowError("Discord kept rate-limiting the invite")


# --------------------------------------------------------------------------
# Email
# --------------------------------------------------------------------------

SUBJECT = ("Il tuo invito al Discord di AI Safety for Italy · "
           "Your invite to the AI Safety for Italy Discord")


def email_body(first_name, link):
    hello_it = f"Ciao {first_name}," if first_name else "Ciao,"
    hello_en = f"Hi {first_name}," if first_name else "Hi,"
    return f"""\
{hello_it}

grazie per esserti iscritto/a ad AI Safety for Italy: la tua candidatura è stata
approvata. Questo è il tuo invito personale al nostro server Discord:

{link}

Il link è valido per 7 giorni e può essere usato una sola volta, quindi non
condividerlo. Se scade prima che tu riesca a usarlo, rispondi a questa email e
te ne mandiamo uno nuovo.

A presto!
Il team di AI Safety for Italy

— English below —

{hello_en}

thank you for registering with AI Safety for Italy: your application has been
approved. This is your personal invite to our Discord server:

{link}

The link is valid for 7 days and can be used only once, so please do not share
it. If it expires before you get to use it, reply to this email and we will
send you a new one.

See you soon!
The AI Safety for Italy team
"""


def build_message(sender, recipient, first_name, link):
    msg = EmailMessage()
    msg['From'] = formataddr((SENDER_NAME, sender))
    msg['To'] = recipient
    msg['Subject'] = SUBJECT
    msg.set_content(email_body(first_name, link))
    return msg


class Mailer:
    def __init__(self, host, port, username, password, sender):
        self.host, self.port = host, int(port)
        self.username, self.password, self.sender = username, password, sender

    def send(self, recipient, first_name, link):
        msg = build_message(self.sender, recipient, first_name, link)
        try:
            if self.port == 465:
                server = smtplib.SMTP_SSL(self.host, self.port, timeout=60)
            else:
                server = smtplib.SMTP(self.host, self.port, timeout=60)
                server.starttls()
            with server:
                server.login(self.username, self.password)
                server.send_message(msg)
        except smtplib.SMTPResponseException as err:
            # Only the code: the server's text often quotes the address.
            raise RowError(f"the mail server refused the email "
                           f"({type(err).__name__}, code {err.smtp_code})") from None
        except (smtplib.SMTPException, OSError) as err:
            raise RowError(f"could not send the email ({type(err).__name__})") from None


# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------

def now_stamp():
    return datetime.now(TIMEZONE).strftime('%Y-%m-%d %H:%M')


def execute(action, sheet, invite, mailer):
    """Carry out one action, recording each step in the sheet as it succeeds."""
    row = action['row']
    n = row['_row']
    if action['kind'] == 'pending':
        link = action['link']
    else:
        link = invite()
        cells = {INVITE_COL: link}
        if action['kind'] == 'resend':
            # Untick and clear in the same write that records the new link, so a
            # crash before the email leaves an ordinary 'pending' row behind,
            # which the next run emails without minting yet another invite.
            cells.update({SENT_COL: '', RESEND_COL: False})
        sheet.write(n, cells)
    mailer.send(row[EMAIL_COL].strip(), row.get('Nome', '').strip(), link)
    try:
        sheet.write(n, {SENT_COL: now_stamp()})
    except RowError as err:
        raise RowError(f"the email WAS sent, but recording it failed: {err} "
                       f"Fill in '{SENT_COL}' by hand, or the next run sends it again.") from None


DESCRIBE = {
    'new': 'create an invite and email it',
    'pending': 'email the invite already recorded in the sheet',
    'resend': "create a fresh invite, email it and untick 'Ri-invia'",
}


def require_env(names):
    missing = [n for n in names if not os.environ.get(n, '').strip()]
    if missing:
        sys.exit("Missing configuration: " + ", ".join(missing)
                 + ". Set them as GitHub secrets/variables, or run with --dry-run.")
    return {n: os.environ[n].strip() for n in names}


def summary(lines):
    """Append to the GitHub run summary when there is one."""
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--dry-run', action='store_true',
                    help="print what would happen; create, send and write nothing")
    ap.add_argument('--sheet-id', default=um.SHEET_ID,
                    help="use this Google Sheet instead of the registration one")
    args = ap.parse_args()

    if not args.dry_run:
        env = require_env(['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'SMTP_HOST',
                           'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD'])
        if not env['DISCORD_CHANNEL_ID'].isdigit():
            sys.exit("DISCORD_CHANNEL_ID must be the channel's numeric ID.")

    scope = um.SHEETS_SCOPE if args.dry_run else SHEETS_WRITE_SCOPE
    sheet = Sheet(um.access_token(scope), args.sheet_id)
    check_columns(sheet.header)
    actions, notes = plan(sheet.rows)

    mode = 'DRY RUN, nothing will be created, sent or written' if args.dry_run else 'live'
    print(f"Discord invites ({mode}): {len(actions)} to send.")
    for note in notes:
        print(f"::warning::{note}")

    done, failed = [], []
    for action in actions:
        n = action['row']['_row']
        if args.dry_run:
            print(f"row {n}: would {DESCRIBE[action['kind']]}")
            done.append(n)
            continue
        try:
            execute(action, sheet,
                    invite=lambda: create_invite(env['DISCORD_BOT_TOKEN'],
                                                 env['DISCORD_CHANNEL_ID']),
                    mailer=Mailer(env['SMTP_HOST'], env['SMTP_PORT'],
                                  env['SMTP_USERNAME'], env['SMTP_PASSWORD'],
                                  os.environ.get('SMTP_FROM', '').strip()
                                  or env['SMTP_USERNAME']))
        except RowError as err:
            print(f"::error::row {n}: {err}")
            failed.append(n)
            continue
        print(f"row {n}: done ({action['kind']})")
        done.append(n)

    verb = 'Would send' if args.dry_run else 'Sent'
    summary([f"### Discord invites{' (dry run)' if args.dry_run else ''}", '',
             f"{verb}: {len(done)} · Failed: {len(failed)} · Needs a look: {len(notes)}"]
            + [f"- row {n}: failed, see the log" for n in failed]
            + [f"- {note}" for note in notes])
    if failed:
        sys.exit(f"{len(failed)} invite(s) failed: rows {', '.join(map(str, failed))}.")


if __name__ == '__main__':
    main()
