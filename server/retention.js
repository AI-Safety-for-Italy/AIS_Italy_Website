// How long personal data is kept: 24 months. Run once a day by
// .github/workflows/retention.yml through /api/cron/cleanup.
//
//   - answers to forms: deleted 24 months after they were sent;
//   - member applications never approved (rejected, or left pending):
//     deleted 24 months after they were sent. Approved ones stay: they are
//     the record of who is a member and how they joined;
//   - the board's own copies of people (imported from the sheets, or added by
//     hand): deleted 24 months after they were created. Those that came from a
//     form go with their answer;
//   - a mentor's draft for the site (photo and bio) goes with their last
//     record on the board.
//
// Each run leaves one line on the audit trail with the counts, never who.

const db = require('./db');
const audit = require('./crm/audit');

const MONTHS = 24;

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
  const boardRecords = await db.query(
    `delete from crm_records
     where origin in ('import', 'board') and created_at < now() - make_interval(months => $1)
     returning id`,
    [MONTHS]
  );
  // A mentor's draft for the site (photo and bio) goes with their last record.
  // Not while the board is empty (before the first import): nothing to match.
  const { rows: any } = await db.query('select 1 from crm_records limit 1');
  const siteDrafts = any.length
    ? await db.query(
        `delete from crm_site_profiles p
         where not exists (select 1 from crm_records r where r.person_key = p.person_key)
         returning p.person_key`
      )
    : { rows: [] };
  const counts = {
    answers: answers.rows.length,
    applications: applications.rows.length,
    boardRecords: boardRecords.rows.length,
    siteDrafts: siteDrafts.rows.length,
  };
  await audit.record({ id: null, name: 'retention job' }, 'retention-cleanup', null, {
    months: MONTHS,
    ...counts,
  });
  return counts;
}

module.exports = { MONTHS, cleanup };
