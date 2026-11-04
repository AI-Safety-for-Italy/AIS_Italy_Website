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
// needsAny: permission keys of which the tool needs one, besides its area.
// sections: the parts of a tool shown as boxes on its page, each with the
// key it needs (`needs`) and its own faces.
// faces: true shows who can open the tool at the top of its pages (for the
// tools without items shared one by one; /api/app/access).
// group: tools listed together in the sidebar under one entry that opens on
// them (src/data/toolGroups.js), each named there by its `navLabel`. A group's
// tools stand next to each other in this list.

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
  // The calendar (server/calendars.js): open to every member; each calendar
  // says itself who sees, edits and manages it. Its two keys (calendar_create,
  // calendar_admin) have an area of their own, `keysArea`, so the Permissions
  // page lists them under this tool.
  {
    key: 'calendar',
    title: 'Calendar',
    url: '/app/calendar/',
    area: null,
    keysArea: 'calendar',
    text: 'The events of every team, and your own link to follow them.',
    icon: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="14" r="1"/><circle cx="16" cy="14" r="1"/><circle cx="8" cy="17.5" r="1"/>',
    tabs: [
      { key: 'view', label: 'Calendar', url: '/app/calendar/' },
      { key: 'calendars', label: 'Calendars', url: '/app/calendar/calendars/' },
      { key: 'subscribe', label: 'Subscribe', url: '/app/calendar/subscribe/' },
    ],
    actions: [{ label: 'New event', url: '/app/calendar/?new=1' }],
  },
  // The site's content (server/content.js). One entry in the sidebar; its page
  // shows a box per part (`sections`), each opened by its own key, with who
  // holds it. The tool shows to whoever holds one of them (`needsAny`).
  {
    key: 'content',
    title: 'Site content',
    faces: true,
    url: '/app/content/',
    area: 'content',
    needsAny: ['seminar', 'event', 'homepage', 'local_groups_site'],
    text: 'Seminars, events, banners, the home page spotlight and local groups.',
    icon: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    sections: [
      {
        key: 'seminars',
        label: 'Seminars',
        url: '/app/content/seminars/',
        needs: 'seminar',
        text: 'The talks of the seminar series.',
        icon: '<path d="M3 5h18v11H3z"/><path d="M8 20h8M12 16v4"/>',
      },
      {
        key: 'events',
        label: 'Events',
        url: '/app/content/events/',
        needs: 'event',
        text: 'Meetups, workshops and the other events.',
        icon: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
      },
      {
        key: 'homepage',
        label: 'Banners & spotlight',
        url: '/app/content/homepage/',
        needs: 'homepage',
        text: 'The banners above every page and the boxes beside the home page hero.',
        icon: '<path d="M3 5h18v4H3z"/><rect x="12" y="12" width="9" height="8" rx="1.5"/><path d="M3 13h6M3 17h6"/>',
      },
      // Which groups of the local groups' board the community page's map
      // shows, and where each city links (server/local-groups.js).
      {
        key: 'local-groups',
        label: 'Local groups',
        url: '/app/content/local-groups/',
        needs: 'local_groups_site',
        text: 'Which cities the community page shows, and where each links.',
        icon: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.5"/>',
      },
    ],
    tabs: [],
    actions: [
      { label: 'New seminar', url: '/app/content/edit/?type=seminar', needs: 'seminar' },
      { label: 'New event', url: '/app/content/edit/?type=event', needs: 'event' },
    ],
  },
  {
    key: 'crm',
    faces: true,
    title: 'Mentorship board',
    group: 'mentorship',
    navLabel: 'Board',
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
  // The mentee selection (server/crm/review.js). Its area opens to the admins
  // of the panel (`review_admin`) and to the reviewers they add, who hold no
  // key: /api/auth works it out.
  {
    key: 'review',
    faces: true,
    title: 'Mentee selection',
    group: 'mentorship',
    navLabel: 'Selection',
    url: '/app/review/',
    area: 'review',
    text: 'Score the mentees’ applications, without knowing who they are.',
    icon: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2"/><path d="M9 12l2 2 4-4M9 17h6"/>',
    tabs: [
      { key: 'cv', label: 'Score CVs', url: '/app/review/#cv' },
      { key: 'answers', label: 'Score answers', url: '/app/review/#answers' },
      { key: 'summary', label: 'Summary', url: '/app/review/summary/', needs: 'review_admin' },
      {
        key: 'settings',
        label: 'Grid & reviewers',
        url: '/app/review/settings/',
        needs: 'review_admin',
      },
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
    faces: true,
    title: 'Member applications',
    group: 'members',
    navLabel: 'Applications',
    url: '/app/members/',
    area: 'members',
    text: 'Who asked to join, and letting them into Discord.',
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 11l2 2 4-4"/>',
    tabs: [],
    actions: [],
  },
  // The community's members and working groups (server/community.js), with
  // a permission of its own (`community`), apart from the applications.
  {
    key: 'community',
    faces: true,
    title: 'Members board',
    group: 'members',
    navLabel: 'Board',
    url: '/app/members/people/',
    area: 'community',
    text: 'The community, its working groups, and keeping Discord and the website in step.',
    icon: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0M10.5 20a5.5 5.5 0 0 1 11 0"/>',
    // Members and their pages, the groups; then the two places the board
    // reaches only when told: Discord and the website.
    tabs: [
      { key: 'people', label: 'Members', url: '/app/members/people/' },
      { key: 'groups', label: 'Working groups', url: '/app/members/groups/' },
      { key: 'discord', label: 'Discord', url: '/app/members/discord/' },
      { key: 'site', label: 'Website', url: '/app/members/site/' },
    ],
    actions: [],
  },
  // The local groups (server/local-groups.js): a card per city, with who
  // leads it, their contacts and the WhatsApp link. What the site shows of
  // them is set in Site content → Local groups.
  {
    key: 'localgroups',
    faces: true,
    title: 'Local groups',
    url: '/app/local-groups/',
    area: 'localgroups',
    text: 'The city groups: who leads each, their contacts and WhatsApp.',
    icon: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.5"/>',
    tabs: [],
    actions: [{ label: 'New local group', url: '/app/local-groups/?new=1' }],
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
