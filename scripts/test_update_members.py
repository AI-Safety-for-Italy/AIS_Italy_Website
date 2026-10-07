#!/usr/bin/env python3
"""Tests for update-members.py.

Run with:
    python3 -m unittest discover -s scripts -p 'test_*.py'

These exist because a formatting difference in the response sheet once made
every timestamp unparseable, which silently disabled grandfathering and would
have removed nine founding members from the public directory. The failure was
invisible in review: the script exited 0 and wrote a well-formed file. Anything
below that looks pedantic is guarding a way that can happen again.
"""

import importlib.util
import os
import tempfile
import unittest
from datetime import date
from unittest import mock

try:
    import yaml
except ModuleNotFoundError as err:  # pragma: no cover
    raise SystemExit(
        "PyYAML is required by this script.\nInstall it with:  pip install -r scripts/requirements.txt"
    ) from err

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'update-members.py')
_spec = importlib.util.spec_from_file_location('update_members', SCRIPT)
um = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(um)


def row(**over):
    """A minimal consenting, post-cutoff submission; override what a test cares about."""
    base = {
        um.TIMESTAMP_COL: '03/08/2026 11.04.38',
        um.CONSENT_COL: um.CONSENT_VALUE,
        'Nome': 'Giulia',
        'Cognome': 'Rossi',
        'Indirizzo email': 'giulia@example.org',
        um.AREAS_COL: '',
    }
    base.update(over)
    return base


class SubmissionDate(unittest.TestCase):
    def test_italian_csv_timestamp_with_dot_separator(self):
        """Google's CSV export of an Italian sheet writes 'dd/mm/yyyy HH.MM.SS'."""
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: '06/05/2026 11.33.30'})),
            date(2026, 5, 6),
        )

    def test_single_digit_hour(self):
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: '03/08/2026 9.47.58'})),
            date(2026, 8, 3),
        )

    def test_colon_separated_timestamp(self):
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: '06/05/2026 11:33:30'})),
            date(2026, 5, 6),
        )

    def test_day_month_order_not_month_day(self):
        """06/05 is 6 May, not 5 June — the sheet is dd/mm."""
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: '06/05/2026 11.33.30'})).month, 5
        )

    def test_xlsx_serial_number(self):
        serial = (date(2026, 5, 6) - um.EXCEL_EPOCH).days
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: str(serial)})), date(2026, 5, 6)
        )

    def test_iso_timestamp(self):
        self.assertEqual(
            um.submission_date(row(**{um.TIMESTAMP_COL: '2026-05-06 11:33:30'})),
            date(2026, 5, 6),
        )

    def test_blank_and_garbage_are_none(self):
        self.assertIsNone(um.submission_date(row(**{um.TIMESTAMP_COL: ''})))
        self.assertIsNone(um.submission_date(row(**{um.TIMESTAMP_COL: 'not a date'})))


class Consent(unittest.TestCase):
    def test_exact_answer(self):
        self.assertTrue(um.has_consent(row()))

    def test_curly_quotes_still_match(self):
        """Sheets substitutes typographic quotes; the answer is unchanged in meaning."""
        curly = um.CONSENT_VALUE.replace('"', '“', 1).replace('"', '”', 1)
        self.assertTrue(um.has_consent(row(**{um.CONSENT_COL: curly})))

    def test_whitespace_tolerant(self):
        padded = '  ' + um.CONSENT_VALUE.replace(' ', '  ') + '  '
        self.assertTrue(um.has_consent(row(**{um.CONSENT_COL: padded})))

    def test_blank_is_not_consent(self):
        self.assertFalse(um.has_consent(row(**{um.CONSENT_COL: ''})))

    def test_other_answer_is_not_consent(self):
        self.assertFalse(um.has_consent(row(**{um.CONSENT_COL: 'No, preferisco di no'})))


class Publication(unittest.TestCase):
    def test_pre_cutoff_published_without_consent(self):
        """The consent question did not exist yet; these members are grandfathered."""
        self.assertTrue(um.should_publish(
            row(**{um.TIMESTAMP_COL: '06/05/2026 11.33.30', um.CONSENT_COL: ''})
        ))

    def test_post_cutoff_needs_consent(self):
        self.assertFalse(um.should_publish(
            row(**{um.TIMESTAMP_COL: '03/08/2026 11.04.38', um.CONSENT_COL: ''})
        ))

    def test_post_cutoff_with_consent(self):
        self.assertTrue(um.should_publish(row()))

    def test_cutoff_day_itself_needs_consent(self):
        """GRANDFATHER_BEFORE is exclusive: the cutoff day is already 'after'."""
        stamp = um.GRANDFATHER_BEFORE.strftime('%d/%m/%Y') + ' 10.00.00'
        self.assertFalse(um.should_publish(
            row(**{um.TIMESTAMP_COL: stamp, um.CONSENT_COL: ''})
        ))

    def test_unreadable_timestamp_falls_back_to_consent(self):
        """Never publish on an unparseable date alone — that was the original bug."""
        self.assertFalse(um.should_publish(
            row(**{um.TIMESTAMP_COL: 'garbage', um.CONSENT_COL: ''})
        ))
        self.assertTrue(um.should_publish(row(**{um.TIMESTAMP_COL: 'garbage'})))


class Dedupe(unittest.TestCase):
    def test_repeat_submission_keeps_most_recent(self):
        old = row(**{um.TIMESTAMP_COL: '06/05/2026 12.13.16', 'Nome': 'Old'})
        new = row(**{um.TIMESTAMP_COL: '27/05/2026 11.56.37', 'Nome': 'New'})
        kept, removed = um.dedupe([old, new])
        self.assertEqual(removed, 1)
        self.assertEqual([r['Nome'] for r in kept], ['New'])

    def test_most_recent_wins_regardless_of_row_order(self):
        old = row(**{um.TIMESTAMP_COL: '06/05/2026 12.13.16', 'Nome': 'Old'})
        new = row(**{um.TIMESTAMP_COL: '27/05/2026 11.56.37', 'Nome': 'New'})
        kept, _ = um.dedupe([new, old])
        self.assertEqual([r['Nome'] for r in kept], ['New'])

    def test_email_matching_ignores_case_and_padding(self):
        a = row(**{'Indirizzo email': 'Giulia@Example.org'})
        b = row(**{'Indirizzo email': '  giulia@example.org '})
        _, removed = um.dedupe([a, b])
        self.assertEqual(removed, 1)

    def test_rows_without_email_are_never_merged(self):
        a = row(**{'Indirizzo email': '', 'Nome': 'A'})
        b = row(**{'Indirizzo email': '', 'Nome': 'B'})
        kept, removed = um.dedupe([a, b])
        self.assertEqual(removed, 0)
        self.assertEqual(len(kept), 2)

    def test_distinct_emails_both_kept(self):
        a = row(**{'Indirizzo email': 'a@example.org'})
        b = row(**{'Indirizzo email': 'b@example.org'})
        kept, removed = um.dedupe([a, b])
        self.assertEqual((len(kept), removed), (2, 0))


class Parse(unittest.TestCase):
    def test_name_location_and_optional_fields(self):
        members, _, _ = um.parse([row(**{
            'Città in cui vivi attualmente': 'Udine',
            'Paese in cui ti trovi attualmente': 'Italia',
            'Sito o profilo professionale': 'https://example.org',
        })])
        m = members[0]
        self.assertEqual(m['name'], 'Giulia Rossi')
        self.assertEqual(m['location'], 'Udine, Italia')
        self.assertEqual(m['profile'], 'https://example.org')

    def test_email_is_never_written(self):
        """members.yaml is public; the address must not reach it."""
        m = um.parse([row()])[0][0]
        self.assertNotIn('email', m)
        self.assertNotIn('giulia@example.org', repr(m))

    def test_empty_optional_fields_are_omitted_not_blank(self):
        m = um.parse([row()])[0][0]
        for absent in ('profile', 'location', 'areas', 'groups'):
            self.assertNotIn(absent, m)

    def test_answers_the_site_does_not_show_are_never_written(self):
        """members.yaml is public: only name, profile, location, areas and groups."""
        m = um.parse([row(**{
            'A quale livello di carriera ti collocheresti?': 'Dottorando / PhD student',
            'Presso quale istituzione, azienda o laboratorio studi o lavori?': 'Università',
            'Quante ore vuoi dedicare ad AI Safety Italy ogni mese?': '5',
            'Infrastruttura tecnica': 'Partecipazione stabile',
            um.AREAS_COL: 'Robustness e adversarial ML',
        })])[0][0]
        self.assertEqual(set(m), {'id', 'name', 'areas', 'groups'})

    def test_same_city_and_country_is_shown_once(self):
        m = um.parse([row(**{'Città in cui vivi attualmente': 'Italia',
                             'Paese in cui ti trovi attualmente': ' italia'})])[0][0]
        self.assertEqual(m['location'], 'italia')

    def test_active_participation_maps_to_group(self):
        m = um.parse([row(**{'Infrastruttura tecnica': 'Partecipazione stabile'})])[0][0]
        self.assertEqual(m['groups'], ['technical'])

    def test_coordination_also_counts_as_active(self):
        m = um.parse([row(**{'Eventi': 'Coordinamento (o co-coordinamento)'})])[0][0]
        self.assertEqual(m['groups'], ['events'])

    def test_passive_interest_is_not_a_group(self):
        """Only stable participation or coordination puts someone in a working group."""
        m = um.parse([row(**{'Seminari': 'Solo interesse a partecipare'})])[0][0]
        self.assertNotIn('groups', m)

    def test_non_consenting_rows_are_counted_as_skipped(self):
        members, skipped, _ = um.parse([row(**{um.CONSENT_COL: ''})])
        self.assertEqual((members, skipped), ([], 1))

    def test_ids_are_sequential_over_published_members_only(self):
        rows = [row(**{'Indirizzo email': 'a@x.org'}),
                row(**{'Indirizzo email': 'b@x.org', um.CONSENT_COL: ''}),
                row(**{'Indirizzo email': 'c@x.org'})]
        members, _, _ = um.parse(rows)
        self.assertEqual([m['id'] for m in members], [1, 2])


class Guards(unittest.TestCase):
    """Every guard must exit non-zero rather than write a degraded directory."""

    def test_renamed_area_options_abort(self):
        rows = [row(**{um.AREAS_COL: 'Interpretabilità'}), row(**{um.AREAS_COL: 'Allineamento'})]
        with self.assertRaises(SystemExit):
            um.check_area_options(rows)

    def test_some_free_text_only_answers_pass(self):
        rows = [row(**{um.AREAS_COL: 'Robustness e adversarial ML'}),
                row(**{um.AREAS_COL: 'Robustness e adversarial ML'}),
                row(**{um.AREAS_COL: 'AI verification'}),
                row()]
        um.check_area_options(rows)  # must not raise

    def test_missing_required_column_aborts(self):
        bad = row()
        del bad[um.TIMESTAMP_COL]
        with self.assertRaises(SystemExit):
            um.check_columns([bad])

    def test_no_rows_aborts(self):
        with self.assertRaises(SystemExit):
            um.check_columns([])

    def test_complete_columns_pass(self):
        um.check_columns([row()])  # must not raise

    def test_mass_removal_aborts(self):
        existing = [{'id': i} for i in range(40)]
        with self.assertRaises(SystemExit):
            um.check_no_mass_removal([{'id': 1}] * 9, existing, force=False)

    def test_small_removal_is_allowed(self):
        existing = [{'id': i} for i in range(40)]
        um.check_no_mass_removal([{'id': 1}] * 39, existing, force=False)

    def test_force_overrides_mass_removal(self):
        existing = [{'id': i} for i in range(40)]
        um.check_no_mass_removal([{'id': 1}], existing, force=True)

    def test_growth_is_never_blocked(self):
        existing = [{'id': i} for i in range(2)]
        um.check_no_mass_removal([{'id': i} for i in range(40)], existing, force=False)

    def test_first_run_without_existing_file_is_allowed(self):
        um.check_no_mass_removal([{'id': 1}], None, force=False)


class WriteMembers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = os.path.join(self.tmp.name, 'members.yaml')
        self._real_out = um.OUT_FILE
        um.OUT_FILE = self.out
        self.addCleanup(setattr, um, 'OUT_FILE', self._real_out)

    def read(self):
        with open(self.out, encoding='utf-8') as f:
            return yaml.safe_load(f)

    def test_writes_members_and_todays_stamp(self):
        um.write_members([{'id': 1, 'name': 'Giulia Rossi'}], None)
        data = self.read()
        self.assertEqual(data['members'][0]['name'], 'Giulia Rossi')
        self.assertEqual(data['last_updated'], date.today().isoformat())

    def test_unchanged_roster_preserves_last_updated(self):
        """Otherwise the daily sync produces a one-line diff every morning."""
        members = [{'id': 1, 'name': 'Giulia Rossi'}]
        with open(self.out, 'w', encoding='utf-8') as f:
            yaml.dump({'last_updated': '2026-01-01', 'members': members}, f)
        unchanged = um.write_members(members, members)
        self.assertTrue(unchanged)
        self.assertEqual(self.read()['last_updated'], '2026-01-01')

    def test_changed_roster_moves_last_updated(self):
        old = [{'id': 1, 'name': 'Giulia Rossi'}]
        with open(self.out, 'w', encoding='utf-8') as f:
            yaml.dump({'last_updated': '2026-01-01', 'members': old}, f)
        unchanged = um.write_members(old + [{'id': 2, 'name': 'Marco Bianchi'}], old)
        self.assertFalse(unchanged)
        self.assertEqual(self.read()['last_updated'], date.today().isoformat())

    def test_non_ascii_names_are_not_escaped(self):
        um.write_members([{'id': 1, 'name': 'Niccolò Potertì'}], None)
        with open(self.out, encoding='utf-8') as f:
            self.assertIn('Niccolò Potertì', f.read())

    def test_leaves_no_temp_files_behind(self):
        um.write_members([{'id': 1, 'name': 'Giulia Rossi'}], None)
        self.assertEqual(os.listdir(self.tmp.name), ['members.yaml'])

    def test_load_existing_returns_none_when_absent(self):
        self.assertIsNone(um.load_existing())


class ReadCsv(unittest.TestCase):
    def test_header_and_value_whitespace_is_stripped(self):
        """The live sheet's email header carries a trailing space."""
        path = os.path.join(tempfile.mkdtemp(), 'x.csv')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('Nome ,Indirizzo email \n Giulia , giulia@example.org \n')
        rows = um.read_csv(path)
        self.assertEqual(rows[0], {'Nome': 'Giulia', 'Indirizzo email': 'giulia@example.org'})


class Areas(unittest.TestCase):
    INTERP = um.AREA_OPTIONS[0]  # contains commas inside its parentheses

    def test_options_with_commas_are_kept_whole(self):
        raw = f"{self.INTERP}, AI governance e policy"
        self.assertEqual(um.known_areas(raw), raw)

    def test_free_text_is_dropped(self):
        raw = (f"AI governance e policy, {self.INTERP}, Mi sono avvicinato all'AI "
               "partendo da zero, poi ho fatto due ricerche, soprattutto per imparare.")
        self.assertEqual(um.known_areas(raw), f"{self.INTERP}, AI governance e policy")

    def test_free_text_only_gives_no_areas(self):
        self.assertEqual(um.known_areas('AI verification, Affidabilità'), '')

    def test_curly_apostrophe_still_matches(self):
        self.assertEqual(um.known_areas('Etica dell’AI e impatto sociale'),
                         "Etica dell'AI e impatto sociale")


class SheetsApi(unittest.TestCase):
    """The live sheet is read through the Sheets API; the network is mocked."""

    def test_rows_match_the_csv_reader(self):
        """Same shape as read_csv: stripped headers and values, short rows padded."""
        values = [['Nome ', 'Indirizzo email ', 'Città'], [' Giulia ', 'giulia@example.org ']]
        self.assertEqual(um.rows_from_values(values),
                         [{'Nome': 'Giulia', 'Indirizzo email': 'giulia@example.org', 'Città': ''}])

    def test_empty_sheet_gives_no_rows(self):
        self.assertEqual(um.rows_from_values([]), [])

    def test_reads_the_tab_matching_the_gid(self):
        meta = {'sheets': [
            {'properties': {'sheetId': 7, 'title': 'Altro'}},
            {'properties': {'sheetId': 0, 'title': "Risposte del modulo 1"}},
        ]}
        values = {'values': [['Nome'], ['Giulia']]}
        urls = []

        def fake_get(url, token):
            urls.append(url)
            return meta if len(urls) == 1 else values

        with mock.patch.object(um, 'access_token', return_value='t'), \
             mock.patch.object(um, '_api_get', side_effect=fake_get):
            rows = um.fetch_sheet_rows('SHEET', 0)
        self.assertEqual(rows, [{'Nome': 'Giulia'}])
        self.assertIn("/values/%27Risposte%20del%20modulo%201%27", urls[1])

    def test_missing_tab_aborts(self):
        with mock.patch.object(um, 'access_token', return_value='t'), \
             mock.patch.object(um, '_api_get', return_value={'sheets': []}):
            with self.assertRaises(SystemExit):
                um.fetch_sheet_rows('SHEET', 0)

    def test_no_key_aborts_before_any_request(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS')}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(SystemExit) as ctx:
                um.access_token()
        self.assertIn('GOOGLE_SERVICE_ACCOUNT_JSON', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
