#!/usr/bin/env python3
"""
Convert the AIS Italy registration form export to data/members.yaml.

Usage:
    python3 scripts/update-members.py              # pull the live Google Sheet
    python3 scripts/update-members.py --local      # use the newest export in data/
    python3 scripts/update-members.py --file X.csv # use a specific export

By default the responses are read straight from the form's response sheet
through the Google Sheets API, so no manual export step is needed. The sheet is
private: it is shared, read-only, with a Google Cloud service account, and the
script signs in as that account. Its JSON key comes from one of:

    GOOGLE_SERVICE_ACCOUNT_JSON     the key file's contents (the GitHub secret)
    GOOGLE_APPLICATION_CREDENTIALS  the path to the key file (handy locally)

Without a key, or if the sheet is not shared with the service account, the run
fails loudly rather than writing a truncated members.yaml.

--local/--file keep the old workflow: drop an export of "AI Safety Italy – Form
di iscrizione (Risposte)" into data/ (.xlsx or .csv) and read that instead.

Publication rules:
  * Members who registered BEFORE the cutoff date (GRANDFATHER_BEFORE) are
    grandfathered in and always published — the consent question did not exist
    when they signed up.
  * From the cutoff date onward a profile is published ONLY if the form's last
    column ("Consenso alla pubblicazione del profilo nella Community") contains
    "Acconsento alla pubblicazione delle informazioni sopra indicate nella
    sezione 'Community' del sito web." Anyone who left it blank or answered
    otherwise is skipped.
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover
    sys.exit(
        "PyYAML is required by this script.\nInstall it with:  pip install -r scripts/requirements.txt"
    )

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
OUT_FILE = os.path.join(DATA_DIR, 'members.yaml')

# Response sheet of the registration form, and the tab holding the responses
# (the `gid` in the sheet's URL). The ID alone grants nothing: the sheet is
# private and readable only by the accounts it is shared with.
SHEET_ID = '1qoxGGUFxEQSXuxbrGaUr44cmgH0jEDRPDSEnE1s4Szo'
SHEET_GID = 0
SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'

GROUPS_MAP = {
    "Programma di mentorship": "mentorship",
    "Governance, fundraising e finanze": "governance",
    "Comunicazione": "communication",
    "Infrastruttura tecnica": "technical",
    "Comunità e networking": "community",
    "Eventi": "events",
    "Seminari": "seminars",
    "Didattica e divulgazione": "education",
}

ACTIVE_VALUES = {"Coordinamento (o co-coordinamento)", "Partecipazione stabile"}

# Column holding the areas of interest, and its checkbox options in the form's
# order. Google Forms joins the ticked options with ", ", and appends whatever
# was typed under "Altro" (sometimes a whole paragraph). Only these options are
# published; free text never is. Some options contain commas, so they are
# matched as whole strings rather than split.
AREAS_COL = 'Quali aree ti interessano di più?'
AREA_OPTIONS = [
    "Interpretability (mechanistic interpretability, analisi delle rappresentazioni, ecc.)",
    "Evaluation (capability evaluations, dangerous capability evals, benchmarking)",
    "Alignment (RLHF, scalable oversight, value alignment)",
    "Robustness e adversarial ML",
    "AI governance e policy",
    "Etica dell'AI e impatto sociale",
    "Sicurezza informatica per modelli di frontiera",
    "Rischi catastrofici / esistenziali",
]

# Column holding the publication consent (the form's last column).
CONSENT_COL = "Consenso alla pubblicazione del profilo nella Community"
# Only this answer authorises publishing a profile on the website.
CONSENT_VALUE = (
    "Acconsento alla pubblicazione delle informazioni sopra indicate "
    "nella sezione \"Community\" del sito web."
)

# Column holding the submission timestamp.
TIMESTAMP_COL = "Informazioni cronologiche"
# Registrations submitted before this date predate the consent question and are
# published regardless of consent. Registrations from this date onward require
# explicit consent (see CONSENT_VALUE).
GRANDFATHER_BEFORE = date(2026, 6, 30)
# xlsx stores dates as serial numbers counted from this epoch.
EXCEL_EPOCH = date(1899, 12, 30)

# Columns the parser depends on. If the form is edited and one of these is
# renamed, every row silently loses that field — so a missing column aborts the
# run instead of publishing a directory full of blanks.
REQUIRED_COLS = [TIMESTAMP_COL, CONSENT_COL, 'Nome', 'Cognome', 'Indirizzo email', AREAS_COL]
# A sync that would drop more than this fraction of the published directory is
# treated as a parsing failure rather than a real exodus. Override with --force.
MAX_SHRINK = 0.25


def _normalize(text):
    """Lowercase, collapse whitespace and unify quote glyphs for robust matching."""
    text = (text or '')
    for fancy in ('“', '”', '„', '‟', '«', '»'):
        text = text.replace(fancy, '"')
    for fancy in ('‘', '’', '‚', '‛'):
        text = text.replace(fancy, "'")
    return re.sub(r'\s+', ' ', text).strip().lower()


def known_areas(raw):
    """The form's area options found in an answer, in form order, as one string."""
    answer = _normalize(raw)
    return ', '.join(opt for opt in AREA_OPTIONS if _normalize(opt) in answer)


def location(city, country):
    """'Udine, Italia'; just 'Italia' when both fields hold the same place."""
    city, country = city.strip(), country.strip()
    if city and _normalize(city) == _normalize(country):
        return country
    return ', '.join(filter(None, [city, country]))


def has_consent(row):
    return _normalize(row.get(CONSENT_COL, '')) == _normalize(CONSENT_VALUE)


def submission_date(row):
    """Parse the registration timestamp into a date, or None if unparseable."""
    raw = (row.get(TIMESTAMP_COL, '') or '').strip()
    if not raw:
        return None
    # xlsx exports store the timestamp as an Excel serial number.
    try:
        return EXCEL_EPOCH + timedelta(days=int(float(raw)))
    except ValueError:
        pass
    # csv exports store it as a local/ISO date string.
    # The CSV export of an Italian-locale sheet separates the time with dots
    # ("06/05/2026 11.33.30"), so those formats come first.
    for fmt in ("%d/%m/%Y %H.%M.%S", "%d/%m/%Y %H.%M",
                "%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def should_publish(row):
    """Grandfather pre-cutoff registrations; require consent from the cutoff on."""
    d = submission_date(row)
    if d is not None and d < GRANDFATHER_BEFORE:
        return True
    return has_consent(row)


def find_export():
    """Return the newest registration export, preferring .xlsx over .csv."""
    for pattern in [
        os.path.join(DATA_DIR, "AI Safety Italy*Form*.xlsx"),
        os.path.join(DATA_DIR, "AI Safety Italy*.xlsx"),
        os.path.join(DATA_DIR, "AI Safety Italy*Form*.csv"),
        os.path.join(DATA_DIR, "AI Safety Italy*.csv"),
    ]:
        matches = sorted(glob.glob(pattern), key=os.path.getmtime)
        if matches:
            return matches[-1]
    sys.exit("No registration export found in data/ matching 'AI Safety Italy*'")


def access_token():
    """Sign in as the service account and return a short-lived access token.

    google-auth is imported here, not at the top, so --local/--file and the
    tests work without it.
    """
    info = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '').strip()
    path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
    if not info and not path:
        sys.exit(
            "No service account key: set GOOGLE_SERVICE_ACCOUNT_JSON to the key "
            "file's contents or GOOGLE_APPLICATION_CREDENTIALS to its path. "
            "Without one, use --local or --file with an export of the sheet."
        )
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
    except ModuleNotFoundError:
        sys.exit(
            "google-auth is required to read the live sheet.\n"
            "Install it with:  pip install -r scripts/requirements.txt"
        )
    try:
        if info:
            creds = service_account.Credentials.from_service_account_info(
                json.loads(info), scopes=[SHEETS_SCOPE])
        else:
            creds = service_account.Credentials.from_service_account_file(
                path, scopes=[SHEETS_SCOPE])
        creds.refresh(Request())
    except Exception as err:  # bad JSON, revoked key, network: never print the key
        sys.exit(f"Could not sign in with the service account key: {type(err).__name__}: {err}")
    return creds.token


def _api_get(url, token):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        hints = {
            403: "Share the sheet with the service account's email (Viewer), "
                 "and check that the Google Sheets API is enabled in its project.",
            404: "No sheet with this ID. Check SHEET_ID.",
        }
        sys.exit(f"The Sheets API refused the request (HTTP {err.code}). "
                 f"{hints.get(err.code, '')}".strip())
    except OSError as err:
        sys.exit(f"Could not reach the Sheets API: {err}")


def rows_from_values(values):
    """Turn the API's list of rows into header->value dicts, like read_csv.

    The API drops empty cells at the end of a row, so short rows are padded.
    """
    if not values:
        return []
    header = [(h or '').strip() for h in values[0]]
    width = len(header)
    return [
        {header[i]: (str(row[i]) if i < len(row) else '').strip() for i in range(width)}
        for row in values[1:]
    ]


def fetch_sheet_rows(sheet_id=SHEET_ID, gid=SHEET_GID):
    """Read the responses tab of the live sheet through the Sheets API."""
    token = access_token()
    base = f"{SHEETS_API}/{urllib.parse.quote(sheet_id)}"
    meta = _api_get(f"{base}?fields=sheets.properties(sheetId,title)", token)
    titles = {s['properties']['sheetId']: s['properties']['title']
              for s in meta.get('sheets', [])}
    if gid not in titles:
        sys.exit(f"The sheet has no tab with gid {gid}. Check SHEET_GID.")
    # Quoted, so a tab name with spaces or apostrophes is still one range.
    tab = "'" + titles[gid].replace("'", "''") + "'"
    data = _api_get(f"{base}/values/{urllib.parse.quote(tab, safe='')}"
                    "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE", token)
    return rows_from_values(data.get('values', []))


def _col_index(cell_ref):
    """'C5' -> 2 (zero-based column index)."""
    letters = re.match(r'[A-Z]+', cell_ref).group(0)
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - 64)
    return idx - 1


def read_xlsx(path):
    """Read the first worksheet into a list of header->value dicts (stdlib only)."""
    ns = {'a': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    t_ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            sroot = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sroot.findall('a:si', ns):
                shared.append(''.join(t.text or '' for t in si.iter(t_ns)))
        sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))

        rows = []
        for row in sheet.findall('.//a:row', ns):
            cells = {}
            for c in row.findall('a:c', ns):
                v = c.find('a:v', ns)
                if v is not None:
                    val = shared[int(v.text)] if c.get('t') == 's' else (v.text or '')
                else:
                    inline = c.find('a:is', ns)
                    val = ''.join(x.text or '' for x in inline.iter(t_ns)) if inline is not None else ''
                cells[_col_index(c.get('r'))] = val
            rows.append(cells)

    if not rows:
        return []
    width = max((max(r) for r in rows if r), default=-1) + 1
    header = [(rows[0].get(i, '') or '').strip() for i in range(width)]
    records = []
    for raw in rows[1:]:
        records.append({header[i]: (raw.get(i, '') or '').strip() for i in range(width)})
    return records


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return [{k.strip(): (v or '').strip() for k, v in row.items()}
                for row in csv.DictReader(f)]


def load_rows(path):
    if path.lower().endswith('.xlsx'):
        return read_xlsx(path)
    return read_csv(path)


def dedupe(rows):
    """Collapse repeat submissions by email, keeping the most recent one.

    Rows without an email are never merged. Returns (deduped_rows, removed_count)
    preserving the order in which each email first appeared.
    """
    by_key = {}   # key -> (submission_date, row)
    order = []
    removed = 0
    for idx, row in enumerate(rows):
        email = _normalize(row.get('Indirizzo email', ''))
        key = email or f"__noemail_{idx}"
        d = submission_date(row) or date.min
        if key not in by_key:
            by_key[key] = (d, row)
            order.append(key)
        else:
            removed += 1
            if d >= by_key[key][0]:
                by_key[key] = (d, row)
    return [by_key[k][1] for k in order], removed


def parse(rows):
    members = []
    skipped = 0
    member_id = 0
    rows, duplicates = dedupe(rows)
    for row in rows:
        if not should_publish(row):
            skipped += 1
            continue
        member_id += 1

        name    = f"{row.get('Nome','')} {row.get('Cognome','')}".strip()
        profile = row.get('Sito o profilo professionale', '')
        where   = location(row.get('Città in cui vivi attualmente', ''),
                           row.get('Paese in cui ti trovi attualmente', ''))
        areas   = known_areas(row.get(AREAS_COL, ''))

        groups = [
            key for col, key in GROUPS_MAP.items()
            if any(active in row.get(col, '') for active in ACTIVE_VALUES)
        ]

        # Only what the site shows: members.yaml is committed to a public
        # repository. No email (it is used above, in memory, to merge repeat
        # submissions), and none of the form's other answers.
        m = {'id': member_id, 'name': name}
        if profile: m['profile']  = profile
        if where:   m['location'] = where
        if areas:   m['areas']    = areas
        if groups:  m['groups']   = groups
        members.append(m)
    return members, skipped, duplicates


def load_existing():
    """Return the members currently published, or None if there is no file yet."""
    if not os.path.exists(OUT_FILE):
        return None
    with open(OUT_FILE, encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}
    return data.get('members')


def check_area_options(rows):
    """Abort if the area answers no longer contain the options listed above.

    If the form's options are renamed, every answer would silently lose its
    areas, so a sync where most answers match no option is treated as an error.
    """
    answered = [r.get(AREAS_COL, '') for r in rows if r.get(AREAS_COL, '').strip()]
    unmatched = sum(1 for a in answered if not known_areas(a))
    if answered and unmatched > len(answered) / 2:
        sys.exit(
            f"{unmatched} of {len(answered)} answers to {AREAS_COL!r} match none "
            "of AREA_OPTIONS. The form's options were probably edited. Update "
            "AREA_OPTIONS in this script; members.yaml is left untouched."
        )


def check_columns(rows):
    """Abort unless every column the parser reads is present in the export."""
    if not rows:
        sys.exit("The export contained no rows; refusing to touch members.yaml.")
    present = set(rows[0])
    missing = [c for c in REQUIRED_COLS if c not in present]
    if missing:
        sys.exit(
            "The export is missing columns the parser needs: "
            + ", ".join(repr(c) for c in missing)
            + ".\nThe form was probably edited. Fix the column names in this "
              "script before syncing; members.yaml is left untouched."
        )


def check_no_mass_removal(members, existing, force):
    """Abort on a suspicious drop in the published count.

    A genuine removal is one or two people leaving the sheet. Losing a quarter
    of the directory at once is far more likely to be the parser breaking on an
    upstream change, and that must not silently reach the website.
    """
    if existing is None or not existing or force:
        return
    lost = len(existing) - len(members)
    if lost > 0 and lost / len(existing) > MAX_SHRINK:
        sys.exit(
            f"Refusing to sync: this would cut the directory from "
            f"{len(existing)} to {len(members)} members ({lost} removed).\n"
            f"That usually means the export changed shape rather than that "
            f"people left. Inspect the sheet, then re-run with --force if the "
            f"removal is genuine. members.yaml is left untouched."
        )


def write_members(members, existing):
    """Write members.yaml atomically, preserving last_updated when nothing moved.

    The file is rendered in full before it replaces the old one, so an error
    part-way through leaves the previous directory intact. `last_updated` only
    moves when the roster actually changed — otherwise the daily sync would
    produce a one-line diff every morning and train everyone to merge these
    pull requests unread.
    """
    stamp = date.today().isoformat()
    if existing == members:
        with open(OUT_FILE, encoding='utf-8') as f:
            stamp = (yaml.safe_load(f) or {}).get('last_updated', stamp)

    body = yaml.dump({'last_updated': stamp, 'members': members},
                     allow_unicode=True, default_flow_style=False, sort_keys=False)

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT_FILE), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(body)
        os.replace(tmp, OUT_FILE)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return existing == members


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    src = ap.add_mutually_exclusive_group()
    src.add_argument('--local', action='store_true',
                     help="read the newest export in data/ instead of the live sheet")
    src.add_argument('--file', metavar='PATH',
                     help="read this .xlsx/.csv export instead of the live sheet")
    ap.add_argument('--sheet-id', default=SHEET_ID,
                    help="read this Google Sheet instead of the registration one")
    ap.add_argument('--force', action='store_true',
                    help="write even if the sync removes a large share of the directory")
    args = ap.parse_args()

    if args.file or args.local:
        export_path = args.file or find_export()
        print(f"Reading: {export_path}")
        rows = load_rows(export_path)
    else:
        print("Reading: the registration form's response sheet (Sheets API)")
        rows = fetch_sheet_rows(args.sheet_id)
    check_columns(rows)
    check_area_options(rows)
    members, skipped, duplicates = parse(rows)
    if not members:
        sys.exit("The export produced no publishable members; "
                 "members.yaml is left untouched.")

    existing = load_existing()
    check_no_mass_removal(members, existing, args.force)
    unchanged = write_members(members, existing)

    if unchanged:
        print(f"No change: {len(members)} members already up to date.")
    else:
        print(f"Written {len(members)} members to {OUT_FILE} "
              f"({duplicates} duplicate submissions merged; "
              f"{skipped} skipped: post-{GRANDFATHER_BEFORE.isoformat()} without consent)")


if __name__ == '__main__':
    main()
