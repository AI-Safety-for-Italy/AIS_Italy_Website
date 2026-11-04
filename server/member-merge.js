// One set of rules for a member's data arriving from anywhere: the old sheet
// (an import, previewed first), an approved application or upgrade (on
// their own, nobody previews them), someone found on Discord, and the board
// itself. Pure: it says what would change; server/community.js writes it.
//
// Each member row keeps where each field last came from (field_sources:
// { field: { source, at } }), so a later source can tell a gap, or an older
// value, from one the team chose:
//
//   name, profile, location, areas
//       an empty field is filled; an equal one stays; a different one is
//       taken only when the incoming answer is newer than the value there.
//       Newer but set on the board: never overwritten on its own, it is a
//       conflict (an import shows it, to keep or take; an application keeps
//       the board's). Newer and not the board's: an application takes it (the
//       person said so again), an import shows it as a conflict.
//   role         never lowered; raised by an application (someone approved
//                it), a conflict on an import.
//   publish      the latest statement wins; one set on the board against a
//                newer answer is a conflict on an import, taken from an
//                application (it is the person's own consent). Added
//                without being asked (from Discord): no statement at all.
//   groups       only added, never removed; not when the board set the groups
//                after the incoming answer.
//   discordId    only filled, never replaced; not when the board unlinked
//                them; an account another member has is flagged, not taken.
//   joinedOn     the earliest date.
//
// Rows from before field_sources count as set by 'unknown' at their last
// change (updated_at): an older import leaves them as they are.

const TEXT = ['name', 'profile', 'location', 'areas'];

function time(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Where `field` of `row` came from: { source, at }. */
function provenance(row, field) {
  const fs = (row && row.field_sources) || {};
  if (fs[field] && fs[field].source) return fs[field];
  return { source: 'unknown', at: row && row.updated_at ? new Date(row.updated_at) : null };
}

const same = (a, b) =>
  String(a || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase() ===
  String(b || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * What `incoming` changes on a member. `current`: null for someone new, else
 * { row, details: { name, profile, location, areas }, groups: [group id],
 * discordTaken: bool (incoming.discordId is someone else's) }.
 * `incoming`: { source, at, details, publish?, role?, groups?, discordId?,
 * joinedOn? }. `auto`: nobody previews it (an application), so what an
 * import would ask is decided here. `discordTaken`: incoming.discordId is
 * another member's.
 *
 * Returns { create, set: { field: value }, conflicts: [{ field, here,
 * there }], kept: [field], groups: [id], discordId, discordTaken, joinedOn }:
 * `set` is applied, `conflicts` only when chosen (takeConflicts), `kept`
 * says what stayed because the board or a newer answer had it.
 */
function compare(current, incoming, { auto = false, discordTaken = false } = {}) {
  const inc = incoming || {};
  const d = inc.details || {};
  const out = {
    create: !current,
    set: {},
    conflicts: [],
    kept: [],
    groups: [],
    discordId: null,
    discordTaken: false,
    joinedOn: null,
  };
  if (!current) {
    TEXT.forEach((f) => (out.set[f] = d[f] || ''));
    out.set.role = inc.role === 'organizer' ? 'organizer' : 'participant';
    out.set.publish = Boolean(inc.publish);
    out.groups = [...new Set(inc.groups || [])];
    if (inc.discordId && discordTaken) out.discordTaken = true;
    else out.discordId = inc.discordId || null;
    out.joinedOn = inc.joinedOn || null;
    return out;
  }
  const { row } = current;
  const here = current.details || {};
  const newer = (field) => time(inc.at) > time(provenance(row, field).at);
  const byBoard = (field) => provenance(row, field).source === 'board';

  for (const f of TEXT) {
    const there = d[f];
    if (!there || same(here[f], there)) continue;
    if (!here[f]) {
      out.set[f] = there;
    } else if (!newer(f)) {
      out.kept.push(f);
    } else if (byBoard(f)) {
      if (auto) out.kept.push(f);
      else out.conflicts.push({ field: f, here: here[f], there });
    } else if (auto) {
      out.set[f] = there;
    } else {
      out.conflicts.push({ field: f, here: here[f], there });
    }
  }

  // The role: never lowered.
  if (inc.role === 'organizer' && row.role !== 'organizer') {
    if (auto) out.set.role = 'organizer';
    else out.conflicts.push({ field: 'role', here: row.role, there: 'organizer' });
  }

  // Consent: the latest statement.
  if (inc.publish !== undefined && Boolean(inc.publish) !== Boolean(row.publish)) {
    if (!newer('publish')) out.kept.push('publish');
    else if (auto || !byBoard('publish')) out.set.publish = Boolean(inc.publish);
    else out.conflicts.push({ field: 'publish', here: row.publish, there: Boolean(inc.publish) });
  }

  // Groups: only added, unless the board set them after this answer.
  const have = new Set(current.groups || []);
  const adding = [...new Set(inc.groups || [])].filter((g) => !have.has(g));
  if (adding.length) {
    if (byBoard('groups') && !newer('groups')) out.kept.push('groups');
    else out.groups = adding;
  }

  // Discord: only filled, never someone else's.
  if (inc.discordId && !row.discord_id) {
    if (discordTaken) out.discordTaken = true;
    else if (byBoard('discordId')) out.kept.push('discordId');
    else out.discordId = inc.discordId;
  }

  if (inc.joinedOn && (!row.joined_on || time(inc.joinedOn) < time(row.joined_on)))
    out.joinedOn = inc.joinedOn;
  return out;
}

/** `changes` with the conflicts on `fields` taken (the others stay as they are). */
function takeConflicts(changes, fields) {
  const take = new Set(fields || []);
  const out = { ...changes, set: { ...changes.set }, conflicts: [] };
  for (const c of changes.conflicts) {
    if (take.has(c.field)) out.set[c.field] = c.there;
    else out.conflicts.push(c);
  }
  return out;
}

/** Whether `changes` would change anything at all. */
function isEmpty(changes) {
  return (
    !changes.create &&
    !Object.keys(changes.set).length &&
    !changes.groups.length &&
    !changes.discordId &&
    !changes.joinedOn
  );
}

/** The field_sources a write of `changes` leaves, merged on `before`. */
function stamped(before, changes, { source, at, publish }) {
  const hasPublish = publish !== undefined;
  const out = { ...(before || {}) };
  const stamp = { source, at: at ? new Date(at).toISOString() : new Date().toISOString() };
  Object.keys(changes.set).forEach((f) => (out[f] = stamp));
  // No consent asked (someone added from Discord): not a statement, so any
  // later answer of theirs says more.
  if ('publish' in changes.set && !hasPublish) out.publish = { source, at: null };
  if (changes.groups.length) out.groups = stamp;
  if (changes.discordId) out.discordId = stamp;
  return out;
}

module.exports = { TEXT, compare, takeConflicts, isEmpty, stamped, provenance };
