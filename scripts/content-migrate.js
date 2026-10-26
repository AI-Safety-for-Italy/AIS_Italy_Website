#!/usr/bin/env node
// Moves the seminars and events of data/events.yaml into the content tool's
// database, then switches the site to take them from there (see
// server/content-build.js). Run it once per database. The "Switch on" button
// on /app/content/ does the same from the dashboard; this is the command-line
// way, and the only one for the local database.
//
//   node scripts/content-migrate.js --dry-run   what would be imported
//   node scripts/content-migrate.js             import, then switch the site over
//   node scripts/content-migrate.js --no-live   import only
//   node scripts/content-migrate.js --off       switch the site back to the YAML
//
// The database is DATABASE_URL / MEET_DATABASE_URL, or with --local the one
// of scripts/meet-dev.js (stop that server first: PGlite allows one process).
// Entries already imported (same anchor) are skipped, so it is safe to rerun.
//
// Once the site is switched over, edits to seminars and events in
// data/events.yaml no longer show: make them in /app/content/. Other entries
// of the YAML (the mentorship call) are unaffected.
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));

async function main() {
  const db = require('../server/db');
  if (args.has('--local')) {
    const { PGlite } = require('@electric-sql/pglite');
    db.setDb(new PGlite(path.join(ROOT, '.meet-dev-db')));
  } else if (!process.env.MEET_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL (or MEET_DATABASE_URL), or pass --local');
  }
  const content = require('../server/content');

  if (args.has('--off')) {
    await content.setLive(false);
    console.log('The site takes its seminars and events from data/events.yaml again.');
    return;
  }

  const entries = content.yamlEntries();
  console.log(`${entries.length} seminars and events in data/events.yaml:`);
  entries.forEach((e) =>
    console.log(`  ${e.day || '(no day)  '}  ${e.category.padEnd(7)}  ${e.title}`)
  );
  const undated = entries.filter((e) => !e.day);
  if (undated.length) {
    console.log(
      `\n${undated.length} without a \`day\` stay in data/events.yaml and are edited there ` +
        '(add `day: YYYY-MM-DD` and run this again to move them):'
    );
    undated.forEach((e) => console.log(`  ${e.anchor}  ${e.title}`));
    console.log('');
  }
  if (args.has('--dry-run')) return;

  const { imported, skipped } = await content.importEntries(entries);
  console.log(`Imported ${imported}, skipped ${skipped} (already there or without a day).`);
  if (!args.has('--no-live')) {
    await content.setLive(true);
    console.log('The site now takes its seminars and events from the database.');
  }
  if (args.has('--local')) {
    require('../server/content-build').writeSnapshot(await content.exportForBuild());
    console.log('Local snapshot written for the build.');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
