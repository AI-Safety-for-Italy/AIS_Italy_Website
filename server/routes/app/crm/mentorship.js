// /api/app/crm/mentorship: the mentorship board. Every call needs the
// `mentorship` permission (server/access.js); changes re-read the Discord
// roles first, except `update` (stage, track, owner), which trusts a check
// from the last five minutes as reads do. Everything read or changed is on the audit trail.
//   GET                                   -> the board: { mentors, mentees, matches, … }
//   GET  ?key=…&kind=mentor|mentee        -> one person, with notes and history
//   POST ?action=update  { key, kind, status?, track?, owner?: 'me'|'none' }
//   POST ?action=note    { key, kind, body }
//   POST ?action=match   { mentorKey, menteeKey, track }
//   POST ?action=end-match { id }
//   POST ?action=add { first_name, last_name, email, … }  -> a mentor to contact, by hand
//   POST ?action=remove { recordId }      -> removes someone added by hand
//   POST ?action=site { key, kind: 'mentor', bio?, photo?: JPEG data URL | null,
//        consent?: { value: 'yes' | 'no', note } | null }
//        -> the mentor's draft for the public site (encrypted)
//   POST ?action=site-entry { key, kind: 'mentor', entry }  -> saves the entry for
//        /mentorship/ as a draft; returns the site part of the person
//   POST ?action=publish { key, kind: 'mentor' }  -> { site, build }: the entry goes on
//        /mentorship/ with the next build (selected or matched mentors, entry complete)
//   POST ?action=unpublish { key, kind: 'mentor' } -> { site, build }
//   GET  ?action=site-order               -> { groups }: everyone on /mentorship/, in teams
//   POST ?action=site-order { ids }       -> { groups, build }: their order on the site
//   POST ?action=emails { kind, keys }    -> { people: [{ name, email }] }, to copy
//   POST ?action=import&source=… [{ csv }] -> copies that sheet (or its CSV) onto the board (crm_admin)
//        replacing an earlier import also needs { replace: true, adminPassword }; without
//        them -> 409 { code: 'confirm_overwrite', existing }
//   GET  ?action=sources                  -> { sources, serviceAccount } (crm_admin)
//   PUT  ?action=sources { <source>: { spreadsheetId, tab } }  -> the same, saved (crm_admin)
const { route, sendJson, readJson, getQuery, HttpError, siteUrl } = require('../../../http');
const { requireUser, checkAdminPassword } = require('../../../auth');
const access = require('../../../access');
const crypto = require('../../../crm/crypto');
const mentorship = require('../../../crm/mentorship');
const sources = require('../../../crm/sources');
const records = require('../../../crm/records');

/** The sheets the board reads, for the settings page: [{ id, label, spreadsheetId, tab }]. */
async function sourceList() {
  const config = await sources.getConfig();
  return {
    sources: sources.SHEET_SOURCES.map((id) => ({
      id,
      label: sources.SOURCES[id].label,
      ...config[id],
    })),
    serviceAccount: sources.serviceAccountEmail(),
  };
}

/** Signed in, CRM set up, and allowed: returns { user, perms }. */
async function door(req, { write = false } = {}) {
  const user = await requireUser(req);
  // Without its keys the CRM would store notes and keys unprotected: refuse.
  if (!crypto.configured())
    throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
  const perms = await access.authorize(user, 'mentorship', { fresh: write });
  return { user, perms };
}

module.exports = route({
  async GET(req, res) {
    if (getQuery(req).action === 'sources') {
      const user = await requireUser(req);
      await access.authorize(user, 'crm_admin');
      sendJson(res, 200, await sourceList());
      return;
    }
    const { user, perms } = await door(req);
    const { key, kind, action } = getQuery(req);
    if (action === 'site-order') {
      sendJson(res, 200, await mentorship.siteGroups());
      return;
    }
    if (key) {
      sendJson(res, 200, await mentorship.person(user, perms, key, kind));
      return;
    }
    sendJson(res, 200, await mentorship.board(user));
  },

  async PUT(req, res) {
    const user = await requireUser(req);
    if (getQuery(req).action !== 'sources') throw new HttpError(400, 'Unknown action');
    await access.authorize(user, 'crm_admin', { fresh: true });
    await sources.saveConfig(user, await readJson(req));
    sendJson(res, 200, await sourceList());
  },

  async POST(req, res) {
    const query = getQuery(req);
    if (query.action === 'import') {
      const user = await requireUser(req);
      if (!crypto.configured())
        throw new HttpError(503, 'The CRM is not set up here yet (encryption keys)');
      await access.authorize(user, 'crm_admin', { fresh: true });
      // A downloaded sheet can be a few megabytes of long answers.
      const body = (await readJson(req, { max: 5_000_000 })) || {};
      const csv = typeof body.csv === 'string' ? body.csv : undefined;
      // Replacing an import already on the board takes both confirmations of
      // the page and the admin password: a wrong file would wipe the list.
      const confirmOverwrite = async (existing) => {
        if (body.replace !== true)
          throw new HttpError(409, 'This list was already imported', {
            code: 'confirm_overwrite',
            existing,
          });
        const password = typeof body.adminPassword === 'string' ? body.adminPassword : '';
        if (!(await checkAdminPassword(req, password)))
          throw new HttpError(403, 'Wrong admin password', { code: 'wrong_password' });
      };
      sendJson(
        res,
        200,
        await records.importSource(user, String(query.source || ''), { csv, confirmOverwrite })
      );
      return;
    }
    const { action } = query;
    // A stage change trusts roles checked in the last five minutes, as reads
    // do, so the board stays quick; every other change asks Discord again.
    const { user } = await door(req, { write: action !== 'update' });
    // A 400x400 JPEG as a data URL is up to about 270 kB.
    const body = (await readJson(req, action === 'site' ? { max: 400_000 } : undefined)) || {};
    if (action === 'site') {
      sendJson(res, 200, await mentorship.saveSite(user, body.key, body.kind, body));
      return;
    }
    if (action === 'site-entry') {
      sendJson(res, 200, await mentorship.saveEntry(user, body.key, body.kind, body.entry));
      return;
    }
    if (action === 'publish') {
      const siteOrigin = siteUrl(req);
      sendJson(res, 200, await mentorship.publish(user, body.key, body.kind, { siteOrigin }));
      return;
    }
    if (action === 'unpublish') {
      sendJson(res, 200, await mentorship.unpublish(user, body.key, body.kind));
      return;
    }
    if (action === 'site-order') {
      sendJson(res, 200, await mentorship.saveSiteOrder(user, body.ids));
      return;
    }
    if (action === 'emails') {
      sendJson(res, 200, await mentorship.emails(user, body.kind, body.keys));
      return;
    }
    if (action === 'add') {
      sendJson(res, 201, await mentorship.addProspect(user, body));
      return;
    }
    if (action === 'remove') {
      await records.remove(user, body.recordId);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'update') {
      const { key, kind, ...changes } = body;
      const allowed = {};
      ['status', 'track', 'owner'].forEach((f) => {
        if (changes[f] !== undefined) allowed[f] = changes[f];
      });
      sendJson(res, 200, await mentorship.update(user, key, kind, allowed));
    } else if (action === 'note') {
      await mentorship.addNote(user, body.key, body.kind, body.body);
      sendJson(res, 201, { ok: true });
    } else if (action === 'match') {
      sendJson(
        res,
        201,
        await mentorship.createMatch(user, body.mentorKey, body.menteeKey, body.track)
      );
    } else if (action === 'end-match') {
      await mentorship.endMatch(user, body.id);
      sendJson(res, 200, { ok: true });
    } else {
      throw new HttpError(400, 'Unknown action');
    }
  },
});
