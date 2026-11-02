// The tools of the personal area (/app/): one entry each. Everything that
// lists them reads this file: the sidebar and the tabs (src/components/app.njk),
// the home page, the Ctrl+K search (app-common.js) and the to-do counts
// (server/overview.js).
//
// Adding a tool:
//   1. an entry here: key, title, url, icon, area, tabs, actions;
//   2. its pages, each with `{% extends "app.njk" %}` and `tool: <key>`,
//      `tab: <tab key>` in the front matter;
//   3. optionally, its to-do count in server/overview.js.
//
// area: the permission area that opens it (server/permissions.js), or null
// for every signed-in member. A tab or an action with `needs` shows only to
// those holding that permission key; `admin: true` only to the shared admin.
// icon: the inside of a 24×24 stroke SVG (no colours: it takes the text's).

module.exports = [
  {
    key: 'polls',
    title: 'Meeting polls',
    url: '/app/polls/',
    area: null,
    text: 'Find the time that works for everyone.',
    icon: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M8 14h3"/>',
    // No tabs: the green "New poll" button is the way to a new one.
    tabs: [],
    actions: [{ label: 'New poll', url: '/app/polls/new/' }],
  },
  {
    key: 'content',
    title: 'Site content',
    url: '/app/content/',
    area: 'content',
    text: 'Seminars and events on the website.',
    icon: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    // No tabs: the green buttons start a new seminar or event.
    tabs: [],
    actions: [
      { label: 'New seminar', url: '/app/content/edit/?type=seminar', needs: 'seminar' },
      { label: 'New event', url: '/app/content/edit/?type=event', needs: 'event' },
    ],
  },
  {
    key: 'crm',
    title: 'Mentorship board',
    url: '/app/crm/',
    area: 'crm',
    text: 'Mentors, mentees and pairs.',
    icon: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    tabs: [
      { key: 'mentors', label: 'Mentors', url: '/app/crm/#mentors' },
      { key: 'mentees', label: 'Mentees', url: '/app/crm/#mentees' },
      { key: 'pairs', label: 'Pairs', url: '/app/crm/#pairs' },
      { key: 'settings', label: 'Sheets', url: '/app/crm/settings/', needs: 'crm_admin' },
    ],
    actions: [],
  },
  {
    key: 'forms',
    title: 'Forms',
    url: '/app/forms/',
    area: 'forms',
    text: 'Make forms and read the answers.',
    icon: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    tabs: [],
    actions: [{ label: 'New form', url: '/app/forms/?new=1' }],
  },
  {
    key: 'members',
    title: 'Member applications',
    url: '/app/members/',
    area: 'members',
    text: 'Who asked to join, the community and its working groups.',
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 11l2 2 4-4"/>',
    tabs: [
      { key: 'applications', label: 'Applications', url: '/app/members/' },
      { key: 'people', label: 'Members', url: '/app/members/people/' },
      { key: 'groups', label: 'Working groups', url: '/app/members/groups/' },
    ],
    actions: [],
  },
  // For a participant on Discord, not an organizer yet: the organizers' part
  // of the sign-up form, sent to the board (server/members.js, upgrade).
  // Its area, 'upgrade', is not a permission: /api/auth works it out.
  {
    key: 'organizer',
    title: 'Become an organizer',
    url: '/app/organizer/',
    area: 'upgrade',
    text: 'Join a working group and help run the community.',
    icon: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.9z"/>',
    tabs: [],
    actions: [],
  },
];
