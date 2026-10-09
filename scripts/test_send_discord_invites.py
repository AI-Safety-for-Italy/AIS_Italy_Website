#!/usr/bin/env python3
"""Tests for send-discord-invites.py.

Run with:
    python3 -m unittest discover -s scripts -p 'test_*.py'

The invariant that matters most: nobody is invited twice, whatever fails and
wherever a run stops. The network (Sheets, Discord, SMTP) is always faked.
"""

import importlib.util
import io
import os
import smtplib
import unittest
from unittest import mock

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'send-discord-invites.py')
_spec = importlib.util.spec_from_file_location('send_discord_invites', SCRIPT)
sdi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sdi)
um = sdi.um

NEW = sdi.um.LEGACY_BEFORE.strftime('%d/%m/%Y') + ' 10.00.00'
LATER = '20/10/2026 10.00.00'
LEGACY = '03/08/2026 11.04.38'


def row(n=2, **over):
    """An approved, not yet invited applicant on sheet row `n`."""
    base = {
        '_row': n,
        um.TIMESTAMP_COL: NEW,
        'Nome': 'Giulia',
        sdi.EMAIL_COL: 'giulia@example.org',
        um.STATUS_COL: 'Approvato',
        sdi.INVITE_COL: '',
        sdi.SENT_COL: '',
        sdi.RESEND_COL: 'FALSE',
    }
    base.update(over)
    return base


def kinds(rows):
    return [(a['kind'], a['row']['_row']) for a in sdi.plan(rows)[0]]


class Plan(unittest.TestCase):
    def test_approved_applicant_gets_an_invite(self):
        self.assertEqual(kinds([row()]), [('new', 2)])

    def test_pending_and_rejected_get_nothing(self):
        self.assertEqual(kinds([row(**{um.STATUS_COL: 'In attesa'}),
                                row(3, **{um.STATUS_COL: 'Rifiutato',
                                          sdi.EMAIL_COL: 'b@example.org'}),
                                row(4, **{um.STATUS_COL: '', sdi.EMAIL_COL: 'c@example.org'})]),
                         [])

    def test_already_sent_is_skipped(self):
        self.assertEqual(kinds([row(**{sdi.SENT_COL: '2026-10-10 07:15'})]), [])

    def test_anything_typed_in_sent_counts(self):
        self.assertEqual(kinds([row(**{sdi.SENT_COL: 'già nel server'})]), [])

    def test_recorded_but_unsent_invite_is_reused(self):
        """A run that died after creating the invite must not create another."""
        actions, _ = sdi.plan([row(**{sdi.INVITE_COL: 'https://discord.gg/abc'})])
        self.assertEqual(actions[0]['kind'], 'pending')
        self.assertEqual(actions[0]['link'], 'https://discord.gg/abc')

    def test_legacy_members_are_already_in_the_server(self):
        self.assertEqual(kinds([row(**{um.TIMESTAMP_COL: LEGACY, um.STATUS_COL: ''})]), [])
        self.assertEqual(kinds([row(**{um.TIMESTAMP_COL: LEGACY})]), [])

    def test_resend_works_for_legacy_members_too(self):
        self.assertEqual(kinds([row(**{um.TIMESTAMP_COL: LEGACY, um.STATUS_COL: '',
                                       sdi.RESEND_COL: 'TRUE'})]), [('resend', 2)])

    def test_resend_overrides_a_previous_send(self):
        for ticked in ('TRUE', 'VERO', 'true', ' x '):
            self.assertEqual(kinds([row(**{sdi.SENT_COL: '2026-10-10 07:15',
                                           sdi.RESEND_COL: ticked})]), [('resend', 2)])

    def test_resend_needs_approval(self):
        actions, notes = sdi.plan([row(**{um.STATUS_COL: 'Rifiutato', sdi.RESEND_COL: 'TRUE'})])
        self.assertEqual(actions, [])
        self.assertEqual(len(notes), 1)

    def test_repeat_submission_is_not_invited_twice(self):
        first = row(2, **{sdi.SENT_COL: '2026-10-10 07:15'})
        again = row(3, **{um.TIMESTAMP_COL: LATER})
        self.assertEqual(kinds([first, again]), [])

    def test_most_recent_submission_decides(self):
        old = row(2, **{um.STATUS_COL: 'In attesa'})
        new = row(3, **{um.TIMESTAMP_COL: LATER, sdi.EMAIL_COL: 'Giulia@Example.org '})
        self.assertEqual(kinds([old, new]), [('new', 3)])
        self.assertEqual(kinds([new, old]), [('new', 3)])

    def test_a_legacy_first_registration_carries_over(self):
        old = row(2, **{um.TIMESTAMP_COL: LEGACY, um.STATUS_COL: ''})
        new = row(3, **{um.TIMESTAMP_COL: LATER, um.STATUS_COL: ''})
        self.assertEqual(kinds([old, new]), [])

    def test_rows_without_email_are_flagged_not_sent(self):
        actions, notes = sdi.plan([row(**{sdi.EMAIL_COL: ''})])
        self.assertEqual(actions, [])
        self.assertIn('row 2', notes[0])

    def test_malformed_email_is_flagged_not_sent(self):
        actions, notes = sdi.plan([row(**{sdi.EMAIL_COL: 'giulia at example'})])
        self.assertEqual(actions, [])
        self.assertEqual(len(notes), 1)

    def test_notes_never_hold_personal_data(self):
        _, notes = sdi.plan([row(**{sdi.EMAIL_COL: 'giulia@example', 'Nome': 'Giulia'})])
        self.assertNotIn('giulia', ' '.join(notes).lower())


class FakeSheet:
    def __init__(self, fail_on=None):
        self.writes = []
        self.fail_on = fail_on

    def write(self, n, cells):
        if self.fail_on and self.fail_on in cells:
            raise sdi.RowError('HTTP 500')
        self.writes.append((n, dict(cells)))


class FakeMailer:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    def send(self, recipient, first_name, link):
        if self.fail:
            raise sdi.RowError('the mail server refused the email')
        self.sent.append((recipient, link))


class Execute(unittest.TestCase):
    def setUp(self):
        self.created = []

    def invite(self):
        link = f"https://discord.gg/code{len(self.created)}"
        self.created.append(link)
        return link

    def test_new_records_the_link_before_emailing_and_the_date_after(self):
        sheet, mailer = FakeSheet(), FakeMailer()
        sdi.execute({'kind': 'new', 'row': row()}, sheet, self.invite, mailer)
        self.assertEqual(sheet.writes[0], (2, {sdi.INVITE_COL: 'https://discord.gg/code0'}))
        self.assertEqual(list(sheet.writes[1][1]), [sdi.SENT_COL])
        self.assertEqual(mailer.sent, [('giulia@example.org', 'https://discord.gg/code0')])

    def test_pending_reuses_the_recorded_link(self):
        sheet, mailer = FakeSheet(), FakeMailer()
        sdi.execute({'kind': 'pending', 'row': row(), 'link': 'https://discord.gg/old'},
                    sheet, self.invite, mailer)
        self.assertEqual(self.created, [])
        self.assertEqual(mailer.sent[0][1], 'https://discord.gg/old')
        self.assertEqual(len(sheet.writes), 1)

    def test_resend_unticks_and_clears_in_the_same_write_as_the_link(self):
        """So a crash before the email leaves a 'pending' row, not a second resend."""
        sheet, mailer = FakeSheet(), FakeMailer()
        sdi.execute({'kind': 'resend', 'row': row()}, sheet, self.invite, mailer)
        self.assertEqual(sheet.writes[0][1], {sdi.INVITE_COL: 'https://discord.gg/code0',
                                              sdi.SENT_COL: '', sdi.RESEND_COL: False})

    def test_failed_email_leaves_the_row_pending(self):
        sheet = FakeSheet()
        with self.assertRaises(sdi.RowError):
            sdi.execute({'kind': 'new', 'row': row()}, sheet, self.invite, FakeMailer(fail=True))
        # The link is recorded, the date is not: the next run plans 'pending'.
        recorded = row(**sheet.writes[0][1])
        self.assertEqual(kinds([recorded]), [('pending', 2)])

    def test_failed_invite_sends_nothing(self):
        def broken():
            raise sdi.RowError('Discord refused the invite (HTTP 403)')
        sheet, mailer = FakeSheet(), FakeMailer()
        with self.assertRaises(sdi.RowError):
            sdi.execute({'kind': 'new', 'row': row()}, sheet, broken, mailer)
        self.assertEqual((sheet.writes, mailer.sent), ([], []))

    def test_failure_to_record_the_send_says_the_email_went_out(self):
        sheet = FakeSheet(fail_on=sdi.SENT_COL)
        with self.assertRaises(sdi.RowError) as ctx:
            sdi.execute({'kind': 'new', 'row': row()}, sheet, self.invite, FakeMailer())
        self.assertIn('WAS sent', str(ctx.exception))


class Main(unittest.TestCase):
    """The loop: one bad row never stops the others, and dry runs touch nothing."""

    def run_main(self, rows, argv, **patches):
        sheet = mock.Mock(header=sdi.REQUIRED_COLS, rows=rows)
        env = {'DISCORD_BOT_TOKEN': 'tok', 'DISCORD_CHANNEL_ID': '123',
               'SMTP_HOST': 'smtp.example.org', 'SMTP_PORT': '465',
               'SMTP_USERNAME': 'tech@example.org', 'SMTP_PASSWORD': 'pw'}
        with mock.patch.object(sdi.um, 'access_token', return_value='t'), \
             mock.patch.object(sdi, 'Sheet', return_value=sheet), \
             mock.patch.dict(os.environ, env, clear=False), \
             mock.patch('sys.argv', ['send-discord-invites.py'] + argv), \
             mock.patch.multiple(sdi, **patches):
            sdi.main()
        return sheet

    def test_dry_run_creates_sends_and_writes_nothing(self):
        create = mock.Mock()
        mailer = mock.Mock()
        sheet = self.run_main([row()], ['--dry-run'], create_invite=create, Mailer=mailer)
        create.assert_not_called()
        mailer.assert_not_called()
        sheet.write.assert_not_called()

    def test_dry_run_reads_with_the_read_only_scope(self):
        with mock.patch.object(sdi.um, 'access_token', return_value='t') as tok, \
             mock.patch.object(sdi, 'Sheet', return_value=mock.Mock(header=sdi.REQUIRED_COLS,
                                                                    rows=[])), \
             mock.patch('sys.argv', ['x', '--dry-run']):
            sdi.main()
        tok.assert_called_once_with(sdi.um.SHEETS_SCOPE)

    def test_one_failing_row_does_not_stop_the_rest(self):
        rows = [row(2, **{sdi.EMAIL_COL: 'a@example.org'}),
                row(3, **{sdi.EMAIL_COL: 'b@example.org'})]
        calls = []

        def create(token, channel):
            calls.append(1)
            if len(calls) == 1:
                raise sdi.RowError('Discord refused the invite (HTTP 403)')
            return 'https://discord.gg/ok'

        mailer = mock.Mock()
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(rows, [], create_invite=create,
                          Mailer=mock.Mock(return_value=mailer))
        self.assertIn('rows 2', str(ctx.exception))
        mailer.send.assert_called_once_with('b@example.org', 'Giulia', 'https://discord.gg/ok')

    def test_missing_secrets_abort_before_reading_the_sheet(self):
        with mock.patch.dict(os.environ, {'DISCORD_BOT_TOKEN': ''}), \
             mock.patch.object(sdi.um, 'access_token') as tok, \
             mock.patch('sys.argv', ['x']):
            with self.assertRaises(SystemExit):
                sdi.main()
        tok.assert_not_called()

    def test_logs_hold_no_email_name_or_link(self):
        rows = [row()]
        with mock.patch('builtins.print') as out:
            self.run_main(rows, [], create_invite=mock.Mock(return_value='https://discord.gg/zz'),
                          Mailer=mock.Mock())
        logged = ' '.join(str(c) for c in out.call_args_list).lower()
        for secret in ('giulia', 'discord.gg/zz', 'tok', 'pw'):
            self.assertNotIn(secret, logged)


class Columns(unittest.TestCase):
    def test_letters(self):
        self.assertEqual([sdi.column_letter(i) for i in (0, 25, 26, 27, 51, 52)],
                         ['A', 'Z', 'AA', 'AB', 'AZ', 'BA'])

    def test_missing_column_aborts(self):
        with self.assertRaises(SystemExit):
            sdi.check_columns([c for c in sdi.REQUIRED_COLS if c != sdi.RESEND_COL])

    def test_records_carry_their_sheet_row(self):
        _, rows = sdi.records_from_values([['Nome'], ['A'], ['B']])
        self.assertEqual([r['_row'] for r in rows], [2, 3])


class Discord(unittest.TestCase):
    def test_invite_request_is_single_use_and_seven_days(self):
        captured = {}

        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{"code": "abc"}'

        def fake_urlopen(req, timeout):
            captured['req'] = req
            return Resp()

        with mock.patch.object(sdi.urllib.request, 'urlopen', fake_urlopen):
            link = sdi.create_invite('tok', '123')
        req = captured['req']
        self.assertEqual(link, 'https://discord.gg/abc')
        self.assertEqual(req.full_url, 'https://discord.com/api/v10/channels/123/invites')
        self.assertEqual(req.get_header('Authorization'), 'Bot tok')
        self.assertEqual(sdi.json.loads(req.data),
                         {'max_age': 604800, 'max_uses': 1, 'unique': True})

    def test_errors_never_echo_the_token(self):
        body = io.BytesIO(b'{"message": "401: Unauthorized", "code": 0}')
        err = sdi.urllib.error.HTTPError('u', 401, 'Unauthorized', {}, body)
        self.addCleanup(err.close)
        with mock.patch.object(sdi.urllib.request, 'urlopen', side_effect=err):
            with self.assertRaises(sdi.RowError) as ctx:
                sdi.create_invite('secret-token', '123')
        self.assertIn('Check DISCORD_BOT_TOKEN', str(ctx.exception))
        self.assertNotIn('secret-token', str(ctx.exception))


class Email(unittest.TestCase):
    def test_body_is_bilingual_and_holds_the_link(self):
        msg = sdi.build_message('tech@ais4i.it', 'giulia@example.org', 'Giulia',
                                'https://discord.gg/abc')
        body = msg.get_content()
        self.assertIn('Ciao Giulia,', body)
        self.assertIn('Hi Giulia,', body)
        self.assertEqual(body.count('https://discord.gg/abc'), 2)
        self.assertEqual(msg['From'], 'AI Safety for Italy <tech@ais4i.it>')

    def test_smtp_errors_do_not_leak_the_address(self):
        refusal = smtplib.SMTPRecipientsRefused({'giulia@example.org': (550, b'no such user')})
        mailer = sdi.Mailer('smtp.example.org', 465, 'u', 'p', 'tech@ais4i.it')
        with mock.patch.object(sdi.smtplib, 'SMTP_SSL', side_effect=refusal):
            with self.assertRaises(sdi.RowError) as ctx:
                mailer.send('giulia@example.org', 'Giulia', 'https://discord.gg/abc')
        self.assertNotIn('giulia', str(ctx.exception))

    def test_server_refusal_reports_only_the_code(self):
        refusal = smtplib.SMTPDataError(550, b'<giulia@example.org> rejected')
        mailer = sdi.Mailer('smtp.example.org', 465, 'u', 'p', 'tech@ais4i.it')
        with mock.patch.object(sdi.smtplib, 'SMTP_SSL', side_effect=refusal):
            with self.assertRaises(sdi.RowError) as ctx:
                mailer.send('giulia@example.org', 'Giulia', 'https://discord.gg/abc')
        self.assertIn('550', str(ctx.exception))
        self.assertNotIn('giulia', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
