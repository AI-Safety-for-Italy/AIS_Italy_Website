// The Settings section of the personal area (/app/settings/): reached from
// the profile menu, not listed with the tools, but drawn
// in the same frame with its own tabs (src/components/app.njk) and offered by
// the Ctrl+K search. A tab with `needs` shows only to those holding that
// permission key (server/permissions.js); one with `admin`, only to the
// shared admin account.

module.exports = {
  key: 'settings',
  title: 'Settings',
  url: '/app/settings/',
  tabs: [
    { key: 'notifications', label: 'Notifications', url: '/app/settings/' },
    {
      key: 'permissions',
      label: 'Permissions',
      url: '/app/settings/permissions/',
      needs: 'manage',
    },
    { key: 'mail', label: 'Mail settings', url: '/app/settings/mail/', admin: true },
  ],
};
