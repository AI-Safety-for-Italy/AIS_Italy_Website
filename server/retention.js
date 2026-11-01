// How long personal data is kept. Run once a day by
// .github/workflows/retention.yml through /api/cron/cleanup.
//
// 12 months (MONTHS) for everyone who was not selected:
//   - answers to forms: deleted 12 months after they were sent;
//   - member applications never approved (rejected, or left pending):
//     deleted 12 months after they were sent;
//   - the board's own copies of people (imported from the sheets, or added by
//     hand) who are not selected for the program: deleted 12 months after they
//     were created. Those that came from a form go with their answer;
//   - what the team wrote about a person on the board (notes, status, pairs)
//     goes when their last record does.
// Longer, only what a purpose needs:
//   - approved applications stay as the record of who is a member and how
//     they joined, but after 12 months the answers to the sign-up questions
//     are dropped: name and email remain;
//   - the board's copies of people selected for the program (selected or
//     paired) stay 24 months (MONTHS_PARTICIPANTS): reports, certificates, the
//     final event.
//
// Each run leaves one line on the audit trail with the counts, never who.

const db = require('./db');
const audit = require('./crm/audit');
const members = require('./members');

const MONTHS = 12;
const MONTHS_PARTICIPANTS = 24;

async function cleanup() {
  const answers = await db.query(
    `delete from form_responses
     where submitted_at < now() - make_interval(months => $1) returning id`,
    [MONTHS]
  );
  const applications = await db.query(
    `delete from member_applications
     where status in ('rejected', 'pending') and created_at < now() - make_interval(months => $1)
     returning id`,
    [MONTHS]
  );
  const trimmed = await members.dropOldAnswers(MONTHS);
  // A person is selected while the team has them as selected or paired: until
  // MONTHS_PARTICIPANTS their copies stay, the others go at MONTHS.
  const boardRecords = await db.query(
    `delete from crm_records r
     where r.origin in ('import', 'board')
       and (
         r.created_at < now() - make_interval(months => $2)
         or (
           r.created_at < now() - make_interval(months => $1)
           and not exists (
             select 1 from crm_people_state s
             where s.person_key = r.person_key and s.status in ('selected', 'matched')
           )
         )
       )
     returning r.id`,
    [MONTHS, MONTHS_PARTICIPANTS]
  );
  const forgotten = await forgetUnlisted();
  const counts = {
    answers: answers.rows.length,
    applications: applications.rows.length,
    approvedTrimmed: trimmed,
    boardRecords: boardRecords.rows.length,
    boardNotes: forgotten,
  };
  await audit.record({ id: null, name: 'retention job' }, 'retention-cleanup', null, {
    months: MONTHS,
    ...counts,
  });
  return counts;
}

/**
 * Drops what the team wrote about people who are no longer on the board: their
 * notes, their status and their ended pairings. Pairings still running stay.
 * Does nothing while the board has no records at all (before the first
 * import), so a board not filled yet loses nothing. Returns the notes dropped.
 */
async function forgetUnlisted() {
  const { rows } = await db.query('select 1 from crm_records limit 1');
  if (!rows.length) return 0;
  const listed = `exists (select 1 from crm_records r where r.person_key = %KEY%)`;
  const notes = await db.query(
    `delete from crm_notes n where not ${listed.replace('%KEY%', 'n.person_key')} returning n.id`
  );
  await db.query(
    `delete from crm_matches m
     where m.status = 'ended'
       and (not ${listed.replace('%KEY%', 'm.mentor_key')}
         or not ${listed.replace('%KEY%', 'm.mentee_key')})`
  );
  await db.query(
    `delete from crm_people_state s
     where not ${listed.replace('%KEY%', 's.person_key')}
       and not exists (
         select 1 from crm_matches m
         where m.status = 'active' and s.person_key in (m.mentor_key, m.mentee_key)
       )`
  );
  return notes.rows.length;
}

module.exports = { MONTHS, MONTHS_PARTICIPANTS, cleanup };
