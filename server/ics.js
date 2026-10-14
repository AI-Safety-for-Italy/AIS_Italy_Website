// Calendar files (iCalendar, RFC 5545) for a poll's chosen time: a plain file
// to download, an invitation (METHOD:REQUEST) emailed to participants, and
// the matching cancellation (METHOD:CANCEL) if the time is changed.
//
// The event's UID is fixed per poll, so a later invitation or cancellation
// replaces the one already in people's calendars; SEQUENCE orders them.

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function stamp(date) {
  return new Date(date)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

// Lines longer than 75 octets continue on the next line after a space. Split
// on characters, counting UTF-8 bytes, so accented letters are never cut.
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 74) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

/**
 * poll: { id, title, description, location }; slot: { start, end }.
 * Options: method ('PUBLISH' | 'REQUEST' | 'CANCEL'), sequence, link,
 * organizer { name, email }, attendee { name, email } (one per email, so
 * nobody sees the others' addresses).
 */
function build(poll, slot, options = {}) {
  const method = options.method || 'PUBLISH';
  const description = [poll.description, options.link].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Safety for Italy//Meeting polls//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${poll.id}@ais4i.it`,
    `SEQUENCE:${options.sequence || 0}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(slot.start)}`,
    `DTEND:${stamp(slot.end)}`,
    `SUMMARY:${escapeText(poll.title)}`,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    poll.location ? `LOCATION:${escapeText(poll.location)}` : null,
    options.organizer
      ? `ORGANIZER;CN=${escapeText(options.organizer.name)}:mailto:${options.organizer.email}`
      : null,
    options.attendee
      ? `ATTENDEE;CN=${escapeText(
          options.attendee.name || options.attendee.email
        )};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${options.attendee.email}`
      : null,
    method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { build };
