// Entries of the sidebar that open on several tools (src/components/app.njk):
// one per `group` named in src/data/tools.js. The group shows when any of its
// tools does; it starts open on the pages of its tools.
module.exports = {
  mentorship: {
    title: 'Mentorship',
    icon: '<circle cx="8" cy="7" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0"/><path d="M13.5 15.2a4.5 4.5 0 0 1 7.5 3.8"/>',
  },
  members: {
    title: 'Members',
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  },
};
