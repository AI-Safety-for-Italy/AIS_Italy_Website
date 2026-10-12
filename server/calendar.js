// Google Calendar, through its REST API with plain fetch.
//
// Events are created on the AIS Google account's calendar with every
// participant as an attendee and sendUpdates=all, so Google itself emails the
// invitations and tracks who accepted.
//
// It acts as that account using a long-lived OAuth refresh token, obtained once
// with `node scripts/meet-google-auth.js`. A service account cannot be used:
// without Google Workspace domain-wide delegation it is not allowed to invite
// attendees.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, and
// optionally GOOGLE_CALENDAR_ID (defaults to the account's primary calendar).
//
// For local development, MEET_FAKE_CALENDAR=1 swaps in a stand-in that only
// logs what it would have sent.

const { HttpError } = require('./http');

const API = 'https://www.googleapis.com/calendar/v3';

let cachedToken = null;

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Google token refresh failed', res.status, body);
    // invalid_grant: the refresh token was revoked or expired (e.g. the OAuth
    // app was left in "Testing", where tokens last 7 days).
    throw new HttpError(
      502,
      body.error === 'invalid_grant'
        ? 'Google access has expired. Run scripts/meet-google-auth.js again and update GOOGLE_REFRESH_TOKEN.'
        : 'Could not sign in to Google Calendar'
    );
  }
  cachedToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

function calendarPath() {
  return `${API}/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary')}`;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Google Calendar error', res.status, data);
    throw new HttpError(502, `Google Calendar refused the request (${res.status})`);
  }
  return data;
}

const google = {
  async createEvent(e) {
    const params = new URLSearchParams({ sendUpdates: 'all' });
    if (e.createMeet) params.set('conferenceDataVersion', '1');
    const event = await call('POST', `${calendarPath()}/events?${params}`, {
      summary: e.summary,
      description: e.description,
      location: e.location || undefined,
      start: { dateTime: e.start.toISOString(), timeZone: e.timezone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timezone },
      attendees: e.attendees.map((a) => ({ email: a.email, displayName: a.name })),
      guestsCanSeeOtherGuests: true,
      ...(e.createMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: e.requestId,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }
        : {}),
    });
    return { id: event.id, htmlLink: event.htmlLink, meetLink: event.hangoutLink || null };
  },

  async deleteEvent(eventId) {
    try {
      await call(
        'DELETE',
        `${calendarPath()}/events/${encodeURIComponent(eventId)}?sendUpdates=all`
      );
    } catch (err) {
      // Already deleted by hand in Google Calendar: nothing left to cancel.
      if (!/\((404|410)\)/.test(err.message)) throw err;
    }
  },
};

const fake = {
  async createEvent(e) {
    console.log('[fake calendar] create event', JSON.stringify(e, null, 2));
    const id = `fake-${Date.now()}`;
    return {
      id,
      htmlLink: `https://calendar.google.com/calendar/r/eventedit/${id}`,
      meetLink: e.createMeet ? 'https://meet.google.com/abc-defg-hij' : null,
    };
  },
  async deleteEvent(eventId) {
    console.log('[fake calendar] delete event', eventId);
  },
};

function getCalendar() {
  if (process.env.MEET_FAKE_CALENDAR === '1') return fake;
  if (!isConfigured()) {
    throw new HttpError(503, 'Google Calendar is not connected yet (GOOGLE_* settings missing)');
  }
  return google;
}

module.exports = { getCalendar, isConfigured };
