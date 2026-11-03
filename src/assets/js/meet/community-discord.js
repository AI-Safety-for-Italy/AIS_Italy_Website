/* /app/members/discord/: who each member is on Discord, and the roles there
 * that differ from the tags here (/api/app/community, server/community.js).
 *   To link      the members not linked yet, each with the accounts of the
 *                server that may be them (by name), a search, and "Not on
 *                Discord" once checked. Linking changes nothing on Discord:
 *                the roles follow with "Give the roles" in the bar on top
 *                (community-status.js).
 *   Differences  roles on Discord without a tag here, tags whose role is
 *                left out, accounts gone from the server: each settled, or
 *                left as it is.
 * What comes from Discord goes on the page as text (h() makes text nodes). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/community';
  var view = document.getElementById('discordView');
  var data = null;
  var suggestions = {}; // member id -> [account] once searched
  var queue = [];
  var check = null; // the last role check
  var noBot = false; // no Discord bot here (a developer's machine): nothing to search

  view.appendChild(M.loading());
  load();

  function load() {
    return Promise.all([M.me, M.api('GET', API)])
      .then(function (r) {
        data = r[1];
        render();
        suggestAll();
        if (!check) runCheck();
      })
      .catch(function (err) {
        if (err.status === 403) {
          M.clear(view).appendChild(
            h(
              'div',
              { class: 'empty-state' },
              h('h3', null, 'No access'),
              h('p', null, err.message)
            )
          );
          return;
        }
        M.appError(err);
      });
  }

  function groupTitle(id) {
    var g = (data.groups || []).filter(function (x) {
      return x.id === id;
    })[0];
    return g ? g.titleEn : id;
  }

  function toLink() {
    return data.members.filter(function (m) {
      return !m.discordId && !m.discordAbsent;
    });
  }

  function absent() {
    return data.members.filter(function (m) {
      return !m.discordId && m.discordAbsent;
    });
  }

  /** Replaces a member in the list with what the server sent back. */
  function update(member) {
    data.members = data.members.map(function (m) {
      return m.id === member.id ? member : m;
    });
  }

  // The suggestions are asked one member at a time, so as not to flood the
  // bot: the list fills in as they come.
  function suggestAll() {
    queue = toLink()
      .map(function (m) {
        return m.id;
      })
      .filter(function (id) {
        return !suggestions[id];
      });
    next();
  }

  function next() {
    var id = queue.shift();
    if (!id) return;
    M.api('GET', API + '?suggest=' + encodeURIComponent(id))
      .then(function (r) {
        if (r.bot === false) noBot = true;
        suggestions[id] = r.suggestions;
        var slot = document.querySelector('[data-suggest="' + id + '"]');
        if (slot) fillSuggestions(slot, id);
      })
      .catch(function () {
        suggestions[id] = [];
      })
      .then(next);
  }

  function link(member, account) {
    return M.api('POST', API + '?action=link', { member: member.id, discordId: account.discordId })
      .then(function (r) {
        update(r.member);
        M.toast(member.name + ' linked to ' + (account.displayName || account.name), false, {
          label: 'Undo',
          run: function () {
            unlink(r.member);
          },
        });
        render();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  /** Back to "To link": a wrong pick undone. The roles already given stay. */
  function unlink(member) {
    return M.api('POST', API + '?action=link', { member: member.id, discordId: null })
      .then(function (r) {
        update(r.member);
        delete suggestions[member.id];
        if (check && check.members) {
          check.members = check.members.filter(function (c) {
            return c.id !== member.id;
          });
        }
        M.toast(member.name + ' unlinked');
        render();
        suggestAll();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function setAbsent(member, isAbsent, note) {
    return M.api('POST', API + '?action=absent', {
      member: member.id,
      absent: isAbsent,
      note: note,
    })
      .then(function (r) {
        update(r.member);
        render();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function accountButton(member, account) {
    return h(
      'button',
      {
        type: 'button',
        class: 'dc-account' + (account.score === 3 ? ' is-strong' : ''),
        title: member.name + ' is this account',
        onclick: function () {
          link(member, account);
        },
      },
      M.avatar(
        { name: account.displayName || account.name || '?', avatarUrl: account.avatarUrl },
        24
      ),
      h(
        'span',
        null,
        h('strong', null, account.displayName || account.name),
        account.username ? h('small', null, '@' + account.username) : null
      ),
      h('span', { class: 'dc-link' }, 'That’s them')
    );
  }

  function fillSuggestions(slot, id) {
    var member = data.members.filter(function (m) {
      return m.id === id;
    })[0];
    M.clear(slot);
    var list = suggestions[id];
    if (!list) {
      slot.appendChild(h('span', { class: 'panel-note' }, 'Looking on Discord…'));
      return;
    }
    if (!list.length) {
      slot.appendChild(
        h(
          'span',
          { class: 'panel-note' },
          noBot
            ? 'The Discord bot is not set up here: nothing to search'
            : 'No one with this name on the server'
        )
      );
      return;
    }
    list.forEach(function (a) {
      slot.appendChild(accountButton(member, a));
    });
  }

  /** A search of the server, for when the suggestions miss them. */
  function searchBox(member) {
    var results = h('div', { class: 'fe-people-results', hidden: true });
    var timer;
    var input = h('input', {
      class: 'form-input is-compact',
      type: 'search',
      placeholder: 'Search the server…',
      'aria-label': 'Search the Discord server for ' + member.name,
      autocomplete: 'off',
      oninput: function () {
        var q = input.value.trim();
        clearTimeout(timer);
        if (q.length < 2) {
          results.hidden = true;
          return;
        }
        timer = setTimeout(function () {
          M.api('GET', API + '?people=' + encodeURIComponent(q)).then(function (d) {
            M.clear(results);
            if (!d.people.length)
              results.appendChild(h('p', { class: 'fe-people-none' }, 'Nobody found'));
            d.people.forEach(function (p) {
              results.appendChild(
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'fe-people-hit',
                    onclick: function () {
                      results.hidden = true;
                      link(member, { discordId: p.discordId, displayName: p.name });
                    },
                  },
                  M.avatar(p, 24),
                  h('span', null, p.name)
                )
              );
            });
            results.hidden = false;
          });
        }, 250);
      },
    });
    return h('div', { class: 'fe-people-search dc-search' }, input, results);
  }

  function tagsOf(m) {
    return m.groups.length
      ? m.groups
          .map(function (g) {
            return groupTitle(g.group);
          })
          .join(', ')
      : 'No tags';
  }

  function linkSection() {
    var list = toLink();
    var section = h(
      'section',
      { class: 'panel dc-panel' },
      h(
        'div',
        { class: 'panel-head', style: 'margin:0' },
        h('h2', { id: 'link' }, 'To link'),
        h('span', { class: 'dc-count' + (list.length ? ' is-on' : '') }, String(list.length))
      ),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'Who each one is on Discord: pick their account among those with their name, or search it. Someone not on Discord at all: mark it, and they leave this list. Linking changes nothing on Discord; their roles follow with “Give the roles” above.'
      )
    );
    if (!list.length) {
      section.appendChild(
        h('p', { class: 'form-note', style: 'margin:0' }, 'Everyone is linked or checked.')
      );
    }
    list.forEach(function (m) {
      var slot = h('div', { class: 'dc-suggestions', 'data-suggest': m.id });
      fillSuggestions(slot, m.id);
      section.appendChild(
        h(
          'div',
          { class: 'dc-row' },
          h('div', { class: 'dc-who' }, h('strong', null, m.name), h('small', null, tagsOf(m))),
          slot,
          h(
            'div',
            { class: 'dc-actions' },
            searchBox(m),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  var note = window.prompt(
                    'Not on Discord: a note for the team (optional), e.g. "left the server"',
                    m.discordNote || ''
                  );
                  if (note === null) return;
                  setAbsent(m, true, note);
                },
              },
              'Not on Discord'
            )
          )
        )
      );
    });
    var gone = absent();
    if (gone.length) {
      section.appendChild(
        h(
          'details',
          { class: 'dc-absent' },
          h('summary', null, 'Checked, not on Discord (' + gone.length + ')'),
          gone.map(function (m) {
            return h(
              'div',
              { class: 'dc-row is-quiet' },
              h(
                'div',
                { class: 'dc-who' },
                h('strong', null, m.name),
                h('small', null, m.discordNote || tagsOf(m))
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'link-button',
                  onclick: function () {
                    setAbsent(m, false);
                  },
                },
                'Check again'
              )
            );
          })
        )
      );
    }
    var linked = data.members.filter(function (m) {
      return m.discordId;
    });
    if (linked.length) {
      section.appendChild(
        h(
          'details',
          { class: 'dc-absent' },
          h('summary', null, 'Linked (' + linked.length + ')'),
          linked.map(function (m) {
            return h(
              'div',
              { class: 'dc-row is-quiet' },
              h(
                'div',
                { class: 'dc-who' },
                h('strong', null, m.name),
                h(
                  'small',
                  null,
                  m.discordUsername
                    ? (m.discordName ? m.discordName + ' · ' : '') + '@' + m.discordUsername
                    : 'Discord account ' + m.discordId
                )
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'link-button',
                  title: 'Not them: back to the ones to link (roles already given stay)',
                  onclick: function () {
                    unlink(m);
                  },
                },
                'Unlink'
              )
            );
          })
        )
      );
    }
    return section;
  }

  // ── Roles on Discord against tags here ─────────────────────────────────

  function runCheck(button) {
    if (button) button.disabled = true;
    return M.api('GET', API + '?action=check')
      .then(function (r) {
        check = r;
        render();
      })
      .catch(function (err) {
        if (button) button.disabled = false;
        if (err.status === 401) return M.appError(err);
        // No bot here: said in the section, not as an error.
        if (err.status === 503) {
          check = { unavailable: err.message };
          return render();
        }
        M.toast(err.message, true);
      });
  }

  // Roles given from the bar on top: the differences change.
  document.addEventListener('members-roles-given', function () {
    runCheck();
  });

  function resolve(member, group, action, kind) {
    return M.api('POST', API + '?action=resolve', {
      member: member.id,
      group: group,
      action: action,
      kind: kind,
    })
      .then(function (r) {
        if (r.discordFailed) M.toast('Discord did not take it: try again in a moment', true);
        // Settled: off the list, without asking Discord again.
        check.members.forEach(function (c) {
          if (c.id !== member.id) return;
          c[kind] = c[kind].filter(function (g) {
            return g !== group;
          });
        });
        check.members = check.members.filter(function (c) {
          return c.notOnServer || c.missing.length || c.extra.length;
        });
        if (action === 'tag' || action === 'untag') load();
        else render();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function diffLine(c, group, kind) {
    var title = groupTitle(group);
    var act = function (action, label, primary) {
      return h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-outline'),
          onclick: function () {
            resolve(c, group, action, kind);
          },
        },
        label
      );
    };
    return h(
      'div',
      { class: 'dc-diff' },
      h(
        'span',
        { class: 'dc-diff-text' },
        kind === 'missing'
          ? ['Tag ', h('strong', null, title), ' here, no role on Discord']
          : ['Role ', h('strong', null, title), ' on Discord, no tag here']
      ),
      kind === 'missing'
        ? [act('give', 'Give the role', true), act('untag', 'Remove the tag')]
        : [act('tag', 'Add the tag', true), act('take', 'Take the role away')],
      h(
        'button',
        {
          type: 'button',
          class: 'link-button',
          onclick: function () {
            resolve(c, group, 'ok', kind);
          },
        },
        'Leave it'
      )
    );
  }

  function checkSection() {
    var linked = data.members.filter(function (m) {
      return m.discordId;
    }).length;
    var button = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          runCheck(button);
        },
      },
      'Check again'
    );
    var section = h(
      'section',
      { class: 'panel dc-panel' },
      h(
        'div',
        { class: 'panel-head', style: 'margin:0' },
        h('h2', { id: 'roles' }, 'Roles that differ from the tags'),
        check && check.members
          ? h(
              'span',
              { class: 'dc-count' + (check.members.length ? ' is-on' : '') },
              String(check.members.length)
            )
          : null
      ),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'For the ' +
          linked +
          ' members linked, the working groups’ roles they have on Discord that differ from their tags here. Settle each one either way, or leave it as it is: it is not listed again.'
      ),
      h('div', null, button)
    );
    if (!check) return section;
    if (check.unavailable) {
      section.appendChild(h('p', { class: 'form-note', style: 'margin:0' }, check.unavailable));
      return section;
    }
    if (check.failed) {
      section.appendChild(
        h(
          'p',
          { class: 'form-note', style: 'margin:0' },
          'Discord did not answer for ' + check.failed + ' of them: check again later.'
        )
      );
    }
    if (!check.members.length) {
      section.appendChild(
        h(
          'p',
          { class: 'form-note', style: 'margin:0' },
          'Roles and tags agree for all ' + check.checked + '.'
        )
      );
    }
    check.members.forEach(function (c) {
      section.appendChild(
        h(
          'div',
          { class: 'dc-row is-check' },
          h(
            'div',
            { class: 'dc-who' },
            h('strong', null, c.name),
            c.discord ? h('small', null, '@' + c.discord.username) : null
          ),
          h(
            'div',
            { class: 'dc-diffs' },
            c.notOnServer
              ? h(
                  'div',
                  { class: 'dc-diff' },
                  h(
                    'span',
                    { class: 'dc-diff-text' },
                    'Their linked account is no longer on the server'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-outline btn-sm',
                      onclick: function () {
                        M.api('POST', API + '?action=link', { member: c.id, discordId: null })
                          .then(function () {
                            check.members = check.members.filter(function (x) {
                              return x.id !== c.id;
                            });
                            load();
                          })
                          .catch(function (err) {
                            M.toast(err.message, true);
                          });
                      },
                    },
                    'Unlink'
                  )
                )
              : null,
            c.missing.map(function (g) {
              return diffLine(c, g, 'missing');
            }),
            c.extra.map(function (g) {
              return diffLine(c, g, 'extra');
            })
          )
        )
      );
    });
    return section;
  }

  function render() {
    // Drawn again after each change: the page stays where it was.
    var y = window.scrollY;
    M.clear(view);
    view.appendChild(h('div', { class: 'dc-page' }, linkSection(), checkSection()));
    window.scrollTo(0, y);
  }
})();
