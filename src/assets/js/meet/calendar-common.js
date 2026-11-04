/* What the calendar's pages share (/app/calendar/): the badge of a member's
 * level on a calendar, the words for reminder times, the Discord channels,
 * and the picker of Discord roles and people used by the access of a
 * calendar. Exposed as window.Cal, on top of window.Meet. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/calendar';

  // What each level lets one do, in the words every page uses.
  var LEVELS = {
    manage: {
      label: 'Manage',
      icon: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
      text: 'Changes the calendar, who has access and its announcements, and every event.',
    },
    edit: {
      label: 'Edit',
      icon: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
      text: 'Creates, changes and deletes every event of the calendar.',
    },
    view: {
      label: 'View',
      icon: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      text: 'Sees the events and answers whether they come.',
    },
    public: {
      label: 'Public',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
      text: 'Anyone with the link sees the events, signed in or not.',
    },
  };

  function svg(inner, cls) {
    return h('span', {
      class: 'cal-ico' + (cls ? ' ' + cls : ''),
      'aria-hidden': 'true',
      html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        inner +
        '</svg>',
    });
  }

  /** The badge of a level: View, Edit, Manage, Public. */
  function levelBadge(level) {
    var l = LEVELS[level] || LEVELS.view;
    return h(
      'span',
      { class: 'cal-level is-' + level, title: l.text },
      svg(l.icon),
      h('span', null, l.label)
    );
  }

  /** "1 day before", "2 hours before", "At the start". */
  function leadLabel(minutes) {
    if (minutes === 0) return 'At the start';
    if (minutes % 10080 === 0)
      return minutes === 10080 ? '1 week before' : minutes / 10080 + ' weeks before';
    if (minutes % 1440 === 0)
      return minutes === 1440 ? '1 day before' : minutes / 1440 + ' days before';
    if (minutes % 60 === 0)
      return minutes === 60 ? '1 hour before' : minutes / 60 + ' hours before';
    return minutes + ' minutes before';
  }

  /** "1 day", "1 h", "15 min": the short form, on chips. */
  function leadShort(minutes) {
    if (minutes === 0) return 'at start';
    if (minutes % 10080 === 0) return minutes / 10080 + ' wk';
    if (minutes % 1440 === 0) return minutes / 1440 + (minutes === 1440 ? ' day' : ' days');
    if (minutes % 60 === 0) return minutes / 60 + ' h';
    return minutes + ' min';
  }

  var LEAD_TIMES = [0, 5, 10, 15, 30, 60, 120, 180, 1440, 2880, 10080];

  var channelsReq = null;
  /** The Discord server's channels, once per page: { text, voice }. */
  function channels() {
    if (!channelsReq) {
      channelsReq = M.api('GET', API + '?channels=1').catch(function (err) {
        channelsReq = null;
        throw err;
      });
    }
    return channelsReq;
  }

  var rolesReq = null;
  function roles() {
    if (!rolesReq) {
      rolesReq = M.api('GET', API + '?roles=1').then(function (r) {
        return r.roles;
      });
    }
    return rolesReq;
  }

  /** The platform of a video-call link, to name it: "Google Meet", "Zoom"… */
  function platform(url) {
    var u = String(url || '').toLowerCase();
    if (u.indexOf('meet.google.') !== -1) return 'Google Meet';
    if (u.indexOf('zoom.') !== -1) return 'Zoom';
    if (u.indexOf('teams.microsoft.') !== -1 || u.indexOf('teams.live.') !== -1)
      return 'Microsoft Teams';
    if (u.indexOf('jit.si') !== -1 || u.indexOf('jitsi') !== -1) return 'Jitsi';
    if (u.indexOf('discord.') !== -1) return 'Discord';
    if (u.indexOf('webex.') !== -1) return 'Webex';
    return u ? 'Video call' : '';
  }

  var DISCORD_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.6 5.6A16.6 16.6 0 0 0 15.5 4.3l-.5 1a15.3 15.3 0 0 0-6 0l-.5-1a16.5 16.5 0 0 0-4.1 1.3C1.8 9.6 1.1 13.5 1.4 17.3a16.7 16.7 0 0 0 5 2.5l1.1-1.7a10.7 10.7 0 0 1-1.7-.8l.4-.3a11.9 11.9 0 0 0 11.6 0l.4.3c-.6.3-1.1.6-1.7.8l1.1 1.7a16.6 16.6 0 0 0 5-2.5c.4-4.4-.7-8.2-3-11.7zM8.5 15c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm7 0c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z"/></svg>';
  var VIDEO_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/></svg>';

  /** The button that joins an event's call: a link or a Discord channel. */
  function joinButton(video, cls) {
    if (!video || !video.url) return null;
    var discord = video.kind === 'discord';
    return h(
      'a',
      {
        class: 'btn btn-sm cal-join' + (discord ? ' is-discord' : '') + (cls ? ' ' + cls : ''),
        href: video.url,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      h('span', { class: 'cal-join-ico', html: discord ? DISCORD_ICON : VIDEO_ICON }),
      discord ? 'Join #' + (video.name || 'voice') : 'Join ' + platform(video.url)
    );
  }

  /**
   * The picker of one level's access: "All members" (and "Public" for view),
   * Discord roles as chips, people by name. opts: { level, value: { all,
   * roles, people }, isPublic, onChange(), disabled }. Returns { el, get() }.
   */
  function accessLevel(opts) {
    var value = {
      all: Boolean(opts.value && opts.value.all),
      roles: ((opts.value && opts.value.roles) || []).slice(),
      people: ((opts.value && opts.value.people) || []).slice(),
    };
    var isPublic = Boolean(opts.isPublic);
    var info = LEVELS[opts.level];
    var changed = function () {
      if (opts.onChange) opts.onChange();
    };

    var allInput = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
    allInput.checked = value.all;
    allInput.disabled = opts.disabled;
    allInput.addEventListener('change', function () {
      value.all = allInput.checked;
      draw();
      changed();
    });
    var publicInput = null;
    if (opts.level === 'view') {
      publicInput = h('input', { type: 'checkbox', role: 'switch', class: 'fe-switch-input' });
      publicInput.checked = isPublic;
      publicInput.disabled = opts.disabled;
      publicInput.addEventListener('change', function () {
        isPublic = publicInput.checked;
        changed();
      });
    }

    var chips = h('div', { class: 'cal-chips' });
    var roleSelect = h('select', {
      class: 'form-input is-compact',
      'aria-label': 'Add a Discord role',
      disabled: opts.disabled,
    });
    var search = h('input', {
      class: 'form-input is-compact',
      type: 'search',
      placeholder: 'Add a person…',
      'aria-label': 'Add a person by name',
      autocomplete: 'off',
      disabled: opts.disabled,
    });
    var results = h('div', { class: 'fe-people-results', role: 'listbox', hidden: true });

    function chip(kind, item) {
      return h(
        'span',
        { class: 'cal-chip is-' + kind },
        kind === 'role'
          ? h('span', { class: 'cal-chip-ico', 'aria-hidden': 'true' }, '@')
          : M.avatar({ name: item.name, avatarUrl: item.avatarUrl }, 20),
        h('span', null, item.name),
        opts.disabled
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'cal-chip-x',
                'aria-label': 'Remove ' + item.name,
                onclick: function () {
                  var list = kind === 'role' ? value.roles : value.people;
                  list.splice(list.indexOf(item), 1);
                  draw();
                  changed();
                },
              },
              '×'
            )
      );
    }

    function draw() {
      M.clear(chips);
      if (value.all) {
        chips.appendChild(
          h('span', { class: 'cal-chip is-all' }, svg(LEVELS.view.icon), 'Every member')
        );
      }
      value.roles.forEach(function (r) {
        chips.appendChild(chip('role', r));
      });
      value.people.forEach(function (p) {
        chips.appendChild(chip('person', p));
      });
      if (!value.all && !value.roles.length && !value.people.length) {
        chips.appendChild(
          h(
            'span',
            { class: 'cal-chips-none' },
            opts.level === 'manage' ? 'Only the creator and the calendar admins' : 'Nobody yet'
          )
        );
      }
      fillRoles();
    }

    var serverRoles = [];
    function fillRoles() {
      M.clear(roleSelect);
      roleSelect.appendChild(h('option', { value: '' }, '+ Add a Discord role'));
      serverRoles
        .filter(function (r) {
          return !value.roles.some(function (x) {
            return x.id === r.id;
          });
        })
        .forEach(function (r) {
          roleSelect.appendChild(h('option', { value: r.id }, r.name));
        });
    }
    roles()
      .then(function (list) {
        serverRoles = list;
        fillRoles();
      })
      .catch(function () {
        roleSelect.hidden = true;
      });
    roleSelect.addEventListener('change', function () {
      var r = serverRoles.find(function (x) {
        return x.id === roleSelect.value;
      });
      if (r) {
        value.roles.push({ id: r.id, name: r.name });
        draw();
        changed();
      }
      roleSelect.value = '';
    });

    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = search.value.trim();
        if (q.length < 2) {
          results.hidden = true;
          return;
        }
        M.api('GET', API + '?people=' + encodeURIComponent(q))
          .then(function (data) {
            M.clear(results);
            var fresh = data.people.filter(function (p) {
              return !value.people.some(function (c) {
                return c.discordId === p.discordId;
              });
            });
            if (!fresh.length)
              results.appendChild(h('p', { class: 'fe-people-none' }, 'Nobody found'));
            fresh.forEach(function (p) {
              results.appendChild(
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'option',
                    class: 'fe-people-hit',
                    onclick: function () {
                      value.people.push(p);
                      search.value = '';
                      results.hidden = true;
                      draw();
                      changed();
                    },
                  },
                  M.avatar(p, 24),
                  h('span', null, p.name)
                )
              );
            });
            results.hidden = false;
          })
          .catch(M.appError);
      }, 250);
    });

    draw();
    var el = h(
      'section',
      { class: 'cal-access-level is-' + opts.level },
      h(
        'div',
        { class: 'cal-access-head' },
        h('span', { class: 'cal-access-badge is-' + opts.level }, svg(info.icon)),
        h('div', null, h('h3', null, info.label), h('p', null, info.text))
      ),
      publicInput
        ? h(
            'label',
            { class: 'cal-access-toggle' },
            h(
              'span',
              null,
              h('strong', null, 'Public'),
              h(
                'small',
                null,
                'Anyone, signed in or not, on the site’s calendar page and its .ics link.'
              )
            ),
            publicInput
          )
        : null,
      h(
        'label',
        { class: 'cal-access-toggle' },
        h(
          'span',
          null,
          h('strong', null, 'All members'),
          h('small', null, 'Everyone who signs in to the personal area.')
        ),
        allInput
      ),
      chips,
      opts.disabled
        ? null
        : h(
            'div',
            { class: 'cal-access-add' },
            roleSelect,
            h('div', { class: 'fe-people-search' }, search, results)
          )
    );
    return {
      el: el,
      get: function () {
        return {
          all: value.all,
          roles: value.roles,
          people: value.people.map(function (p) {
            return { discordId: p.discordId, name: p.name };
          }),
        };
      },
      isPublic: function () {
        return isPublic;
      },
    };
  }

  /**
   * The rows of Discord channels an event is announced in, each with its
   * lead times as chips. opts: { value: [{ channelId, name, minutes }],
   * onChange() }. Returns { el, get(), add() }.
   */
  function announceRows(opts) {
    var list = (opts.value || []).map(function (c) {
      return { channelId: c.channelId, name: c.name, minutes: (c.minutes || []).slice() };
    });
    var box = h('div', { class: 'cal-rows' });
    var text = [];
    var changed = function () {
      if (opts.onChange) opts.onChange();
    };
    channels()
      .then(function (c) {
        text = c.text;
        draw();
      })
      .catch(function () {
        draw();
      });

    function draw() {
      M.clear(box);
      if (!list.length) {
        box.appendChild(h('p', { class: 'cal-rows-none' }, 'No channel yet.'));
      }
      list.forEach(function (item) {
        var select = h('select', { class: 'form-input is-compact', 'aria-label': 'Channel' });
        var known = text.some(function (c) {
          return c.id === item.channelId;
        });
        if (!known && item.channelId)
          select.appendChild(h('option', { value: item.channelId }, '#' + item.name));
        text.forEach(function (c) {
          var o = h('option', { value: c.id }, '#' + c.name);
          if (c.id === item.channelId) o.selected = true;
          select.appendChild(o);
        });
        select.addEventListener('change', function () {
          var c = text.find(function (x) {
            return x.id === select.value;
          });
          item.channelId = select.value;
          item.name = c ? c.name : item.name;
          changed();
        });
        var leads = h('div', { class: 'cal-leads', role: 'group', 'aria-label': 'When' });
        [10080, 1440, 180, 60, 30, 15, 0].forEach(function (m) {
          var on = item.minutes.indexOf(m) !== -1;
          leads.appendChild(
            h(
              'button',
              {
                type: 'button',
                class: 'cal-lead' + (on ? ' is-on' : ''),
                'aria-pressed': on ? 'true' : 'false',
                title: leadLabel(m),
                onclick: function () {
                  var i = item.minutes.indexOf(m);
                  if (i === -1) item.minutes.push(m);
                  else item.minutes.splice(i, 1);
                  draw();
                  changed();
                },
              },
              leadShort(m)
            )
          );
        });
        box.appendChild(
          h(
            'div',
            { class: 'cal-row cal-announce-row' },
            h('div', { class: 'cal-row-main' }, select, leads),
            h(
              'button',
              {
                type: 'button',
                class: 'cal-row-x',
                'aria-label': 'Remove this channel',
                onclick: function () {
                  list.splice(list.indexOf(item), 1);
                  draw();
                  changed();
                },
              },
              '×'
            )
          )
        );
      });
    }
    draw();
    return {
      el: box,
      get: function () {
        return list.filter(function (c) {
          return c.channelId && c.minutes.length;
        });
      },
      add: function () {
        var taken = list.map(function (c) {
          return c.channelId;
        });
        var free = text.find(function (c) {
          return taken.indexOf(c.id) === -1;
        });
        if (!free) {
          M.toast(
            text.length
              ? 'Every channel is already listed'
              : 'The Discord bot lists no channel here',
            true
          );
          return;
        }
        list.push({ channelId: free.id, name: free.name, minutes: [1440] });
        draw();
        changed();
      },
    };
  }

  /** "#general · 1 day, 1 h" for a list of announcements. */
  function announceSummary(list) {
    if (!list || !list.length) return 'no channel';
    return list
      .map(function (c) {
        return '#' + c.name + ' · ' + c.minutes.map(leadShort).join(', ');
      })
      .join('; ');
  }

  window.Cal = {
    API: API,
    LEVELS: LEVELS,
    LEAD_TIMES: LEAD_TIMES,
    svg: svg,
    levelBadge: levelBadge,
    leadLabel: leadLabel,
    leadShort: leadShort,
    channels: channels,
    platform: platform,
    joinButton: joinButton,
    accessLevel: accessLevel,
    announceRows: announceRows,
    announceSummary: announceSummary,
  };
})();
