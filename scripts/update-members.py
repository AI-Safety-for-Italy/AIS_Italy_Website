#!/usr/bin/env python3
"""
Convert the AIS Italy registration form export to data/members.yaml.

Usage:
    python3 scripts/update-members.py              # pull the live Google Sheet
    python3 scripts/update-members.py --local      # use the newest export in data/
    python3 scripts/update-members.py --file X.csv # use a specific export

By default the responses are downloaded straight from the form's response sheet
(SHEET_CSV_URL), so no manual export step is needed. The sheet must stay
readable by "anyone with the link" for this to work; if it is ever restricted,
the download fails loudly rather than writing a truncated members.yaml.

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
import os
import re
import sys
import tempfile
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

# Response sheet of the registration form, exported as CSV. Reading this needs
# no credentials as long as the sheet is shared with "anyone with the link".
SHEET_ID = '1qoxGGUFxEQSXuxbrGaUr44cmgH0jEDRPDSEnE1s4Szo'
SHEET_GID = '0'
SHEET_CSV_URL = (
    f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/export'
    f'?format=csv&gid={SHEET_GID}'
)

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
REQUIRED_COLS = [TIMESTAMP_COL, CONSENT_COL, 'Nome', 'Cognome', 'Indirizzo email']
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


def fetch_sheet(url=SHEET_CSV_URL):
    """Download the response sheet as CSV into a temp file and return its path.

    Google answers a request for a sheet that is not link-readable with an HTML
    sign-in page and a 200, so the content type is checked rather than trusted.
    """
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            content_type = resp.headers.get('Content-Type', '')
            body = resp.read()
    except OSError as err:
        sys.exit(f"Could not download the response sheet: {err}")

    if 'text/csv' not in content_type:
        sys.exit(
            "The response sheet did not return CSV (got "
            f"'{content_type or 'no content type'}'). It is most likely no "
            "longer shared with 'anyone with the link'."
        )

    fd, path = tempfile.mkstemp(prefix='ais-members-', suffix='.csv')
    with os.fdopen(fd, 'wb') as f:
        f.write(body)
    return path


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

        name     = f"{row.get('Nome','')} {row.get('Cognome','')}".strip()
        email    = row.get('Indirizzo email', '')
        profile  = row.get('Sito o profilo professionale', '')
        city     = row.get('Città in cui vivi attualmente', '')
        country  = row.get('Paese in cui ti trovi attualmente', '')
        career   = row.get('A quale livello di carriera ti collocheresti?', '')
        institution = row.get('Presso quale istituzione, azienda o laboratorio studi o lavori?', '')
        hours    = row.get('Quante ore vuoi dedicare ad AI Safety Italy ogni mese?', '')
        areas    = row.get('Quali aree ti interessano di più?', '')

        groups = [
            key for col, key in GROUPS_MAP.items()
            if any(active in row.get(col, '') for active in ACTIVE_VALUES)
        ]

        m = {'id': member_id, 'name': name, 'email': email}
        if profile:    m['profile']     = profile
        if city or country:
                       m['location']    = ', '.join(filter(None, [city, country]))
        if career:     m['career']      = career
        if institution:m['institution'] = institution
        if hours:      m['hours_per_month'] = hours
        if areas:      m['areas']       = areas
        if groups:     m['groups']      = groups
        members.append(m)
    return members, skipped, duplicates


def load_existing():
    """Return the members currently published, or None if there is no file yet."""
    if not os.path.exists(OUT_FILE):
        return None
    with open(OUT_FILE, encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}
    return data.get('members')


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
    ap.add_argument('--url', default=SHEET_CSV_URL,
                    help="override the sheet CSV export URL")
    ap.add_argument('--force', action='store_true',
                    help="write even if the sync removes a large share of the directory")
    args = ap.parse_args()

    temp_path = None
    if args.file:
        export_path = args.file
    elif args.local:
        export_path = find_export()
    else:
        temp_path = export_path = fetch_sheet(args.url)

    print(f"Reading: {args.url if temp_path else export_path}")
    try:
        rows = load_rows(export_path)
    finally:
        if temp_path:
            os.unlink(temp_path)
    check_columns(rows)
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
