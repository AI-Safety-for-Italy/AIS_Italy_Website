/* /app/members/discord/: who each member is on Discord, and the roles there
 * that differ from the tags here (/api/app/community, server/community.js).
 *   Triage       on top, the board and Discord made to say the same in three
 *                steps: match again (accounts linked when sure), sync every
 *                role from the board (Participant / Organizer and the groups'
 *                roles; the roles without a tag taken away, tagged, or kept),
 *                and the people on the server with no role. The sections
 *                below are the same, one person at a time.
 *   To link      the members not linked yet, each with the accounts of the
 *                server that may be them (by name), a search, and "Not on
 *                Discord" once checked. Linking changes nothing on Discord:
 *                the roles follow with "Give the roles" in the bar on top
 *                (community-status.js).
 *   Differences  roles on Discord without a tag here, tags whose role is
 *                left out, Partecipante / Organizzatore missing or not the
 *                one of their role here, accounts gone from the server: each
 *                settled, or left as it is.
 *   No role      people on the server with neither Partecipante nor
 *                Organizzatore and not on the board: given one (and put on
 *                the board), one by one or all at once, or left as they are.
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
        check.members = check.members.filter(stillDiffers);
        if (action === 'tag' || action === 'untag') load();
        else render();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function stillDiffers(c) {
    return c.notOnServer || c.missing.length || c.extra.length || c.mainRole;
  }

  var ROLE_LABEL = { participant: 'Participant', organizer: 'Organizer' };

  function resolveMain(member, action, extra) {
    var body = { member: member.id, action: action };
    Object.keys(extra || {}).forEach(function (k) {
      body[k] = extra[k];
    });
    return M.api('POST', API + '?action=resolve-main', body)
      .then(function (r) {
        if (r.discordFailed) M.toast('Discord did not take it: try again in a moment', true);
        check.members.forEach(function (c) {
          if (c.id === member.id) c.mainRole = null;
        });
        check.members = check.members.filter(stillDiffers);
        if (action === 'here') load();
        else render();
        M.communityStatus.refresh();
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  /** Partecipante / Organizzatore: missing on Discord, or not the one here. */
  function mainRoleLine(c) {
    var d = c.mainRole;
    var here = ROLE_LABEL[d.here];
    var btn = function (label, primary, run) {
      return h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-outline'),
          onclick: run,
        },
        label
      );
    };
    var leave = h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        onclick: function () {
          resolveMain(c, 'ok', { kind: d.kind });
        },
      },
      'Leave it'
    );
    if (d.kind === 'missing') {
      return h(
        'div',
        { class: 'dc-diff' },
        h('span', { class: 'dc-diff-text' }, [
          h('strong', null, here),
          ' here, neither Participant nor Organizer on Discord',
        ]),
        btn('Give ' + here, true, function () {
          resolveMain(c, 'give');
        }),
        leave
      );
    }
    var there = ROLE_LABEL[d.there];
    return h(
      'div',
      { class: 'dc-diff' },
      h('span', { class: 'dc-diff-text' }, [
        h('strong', null, here),
        ' here, ',
        h('strong', null, there),
        ' on Discord',
      ]),
      btn('Make them ' + here + ' on Discord', true, function () {
        resolveMain(c, 'give');
      }),
      btn(there + ' here too', false, function () {
        resolveMain(c, 'here', { role: d.there });
      }),
      leave
    );
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
          ' members linked, their roles on Discord that differ from the board: Participant or Organizer, and the working groups’ roles against their tags. Settle each one either way, or leave it as it is: it is not listed again.'
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
            c.mainRole ? mainRoleLine(c) : null,
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

  // ── On the server with no role ─────────────────────────────────────────

  var settling = null; // { done, total } while giving a role to everyone listed
  var PER_CALL = 15;

  /** Gives `action` (participant | organizer | ok) to `ids`, PER_CALL at a time. */
  function settle(ids, action) {
    var queue = ids.slice();
    var total = { given: 0, added: 0, failed: 0 };
    settling = { done: 0, total: ids.length };
    render();
    function step() {
      var batch = queue.splice(0, PER_CALL);
      if (!batch.length) return Promise.resolve();
      return M.api('POST', API + '?action=no-role', { discordIds: batch, action: action }).then(
        function (r) {
          total.given += r.given;
          total.added += r.added;
          total.failed += r.failed;
          check.noRole = check.noRole.filter(function (p) {
            return batch.indexOf(p.discordId) === -1;
          });
          settling.done += batch.length;
          render();
          return step();
        }
      );
    }
    return step()
      .then(function () {
        M.toast(
          action === 'ok'
            ? 'Left as they are'
            : total.given +
                ' given ' +
                ROLE_LABEL[action] +
                ' and put on the board' +
                (total.failed ? '; ' + total.failed + ' did not go: check again later' : '')
        );
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      })
      .then(function () {
        settling = null;
        M.communityStatus.refresh();
        // The new members, on the board's list.
        if (action !== 'ok') return load();
        render();
      });
  }

  function noRoleSection() {
    var list = check && check.noRole;
    var section = h(
      'section',
      { class: 'panel dc-panel' },
      h(
        'div',
        { class: 'panel-head', style: 'margin:0' },
        h('h2', { id: 'noroles' }, 'On the server with no role'),
        list
          ? h('span', { class: 'dc-count' + (list.length ? ' is-on' : '') }, String(list.length))
          : null
      ),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'People on the Discord server with neither Participant nor Organizer, and not on the board (they joined with an invite, not through an application). Give them their role: they are put on the board with it, linked, not shown on the site. Or leave them as they are (a guest, someone’s bot account): they are not listed again.'
      )
    );
    if (!check || check.unavailable) return section;
    if (!list) {
      section.appendChild(
        h(
          'p',
          { class: 'form-note', style: 'margin:0' },
          'Not readable: ' + (check.noRoleProblem || 'the server’s list cannot be read') + '.'
        )
      );
      return section;
    }
    if (!list.length) {
      section.appendChild(
        h('p', { class: 'form-note', style: 'margin:0' }, 'Everyone on the server has a role.')
      );
      return section;
    }
    if (settling) {
      section.appendChild(
        h(
          'p',
          { class: 'form-note', style: 'margin:0' },
          'Working… ' + settling.done + ' of ' + settling.total + ' done.'
        )
      );
      return section;
    }
    var everyone = list.map(function (p) {
      return p.discordId;
    });
    section.appendChild(
      h(
        'div',
        { class: 'dc-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            onclick: function () {
              if (
                !window.confirm(
                  'Give Participant on Discord to all ' +
                    list.length +
                    ' people listed, and put them on the board?'
                )
              )
                return;
              settle(everyone, 'participant');
            },
          },
          'Make all ' + list.length + ' participants'
        )
      )
    );
    list.forEach(function (p) {
      var act = function (action, label, primary) {
        return h(
          'button',
          {
            type: 'button',
            class: primary ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
            onclick: function () {
              settle([p.discordId], action);
            },
          },
          label
        );
      };
      section.appendChild(
        h(
          'div',
          { class: 'dc-row is-check' },
          h(
            'div',
            { class: 'dc-who' },
            h('strong', null, p.displayName || p.username),
            h(
              'small',
              null,
              '@' +
                p.username +
                (p.joinedAt
                  ? ' · joined ' +
                    new Date(p.joinedAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : '')
            )
          ),
          h(
            'div',
            { class: 'dc-diffs' },
            h(
              'div',
              { class: 'dc-diff' },
              act('participant', 'Participant', true),
              act('organizer', 'Organizer'),
              h(
                'button',
                {
                  type: 'button',
                  class: 'link-button',
                  onclick: function () {
                    settle([p.discordId], 'ok');
                  },
                },
                'Leave it'
              )
            )
          )
        )
      );
    });
    return section;
  }

  // ── Triage ─────────────────────────────────────────────────────────────

  var syncing = null; // { done, failed, remaining } while syncing
  var extraChoice = 'take';

  function count(fn) {
    return check && check.members ? check.members.reduce(fn, 0) : 0;
  }

  function step(n, title, text, actions, done) {
    return h(
      'div',
      { class: 'ms-row' + (done ? ' is-done' : '') },
      h('span', { class: 'ms-mark', 'aria-hidden': 'true' }, done ? '✓' : String(n)),
      h('strong', { class: 'ms-title' }, title),
      h('span', { class: 'ms-text' }, text),
      h('span', { class: 'ms-action' }, actions)
    );
  }

  function rematch(button) {
    button.disabled = true;
    M.api('POST', API + '?action=rematch', {})
      .then(function (r) {
        M.toast(
          r.linked
            ? r.linked +
                ' linked (' +
                r.byEmail +
                ' by email, ' +
                r.byName +
                ' by name); ' +
                r.left +
                ' to link by hand'
            : 'No sure match: ' +
                r.left +
                ' to link by hand' +
                (r.problem ? ' (' + r.problem + ')' : '')
        );
        suggestions = {};
        check = null;
        M.communityStatus.refresh();
        load();
      })
      .catch(function (err) {
        button.disabled = false;
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      });
  }

  function syncAll(total) {
    var what =
      extraChoice === 'take'
        ? ' The working groups’ roles without a tag here are taken away.'
        : extraChoice === 'tag'
        ? ' The working groups’ roles without a tag here become tags.'
        : ' The working groups’ roles without a tag here stay.';
    if (
      !window.confirm(
        'Give everyone linked the roles the board says (Participant or Organizer, and their groups’), ' +
          total +
          ' changes?' +
          what
      )
    )
      return;
    syncing = { done: 0, failed: 0, remaining: total };
    render();
    (function next() {
      M.api('POST', API + '?action=sync', { extra: extraChoice })
        .then(function (r) {
          syncing.done += r.done;
          syncing.failed += r.failed;
          syncing.remaining = r.remaining;
          render();
          if (r.remaining > 0 && r.done > 0) return next();
          M.toast(
            syncing.done +
              ' changes made' +
              (syncing.failed ? '; ' + syncing.failed + ' did not go: try again later' : '')
          );
          syncing = null;
          M.communityStatus.refresh();
          runCheck();
        })
        .catch(function (err) {
          syncing = null;
          render();
          if (err.status === 401) return M.appError(err);
          M.toast(err.message, true);
        });
    })();
  }

  function triageSection() {
    var unlinked = toLink().length;
    var section = h(
      'section',
      { class: 'panel dc-panel' },
      h('div', { class: 'panel-head', style: 'margin:0' }, h('h2', { id: 'triage' }, 'Triage')),
      h(
        'p',
        { class: 'panel-note', style: 'margin:0' },
        'The board says who is who and which roles each should have; Discord is made to match it. Run the steps in order, then check again.'
      )
    );
    var matchBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm',
        onclick: function () {
          rematch(matchBtn);
        },
      },
      'Match again'
    );
    var rows = h('div', { class: 'triage-steps' });
    rows.appendChild(
      step(
        1,
        'Who is who',
        unlinked
          ? unlinked +
              ' members not linked to their Discord account. “Match again” links those it is sure of (same email, or a full name only one account has); the others below, by hand.'
          : 'Everyone is linked or checked.',
        unlinked ? matchBtn : null,
        !unlinked
      )
    );
    if (!check) {
      rows.appendChild(step(2, 'Roles', 'Reading the roles on Discord…', null, false));
    } else if (check.unavailable) {
      rows.appendChild(step(2, 'Roles', check.unavailable, null, false));
    } else {
      var main = count(function (n, c) {
        return n + (c.mainRole ? 1 : 0);
      });
      var missing = count(function (n, c) {
        return n + c.missing.length;
      });
      var extra = count(function (n, c) {
        return n + c.extra.length;
      });
      var total = main + missing + (extraChoice === 'keep' ? 0 : extra);
      var parts = [];
      if (main) parts.push(main + ' without the right Participant / Organizer');
      if (missing) parts.push(missing + ' groups’ roles missing');
      if (extra) parts.push(extra + ' groups’ roles without a tag here');
      var actions = null;
      if (syncing) {
        actions = h(
          'span',
          { class: 'panel-note' },
          'Syncing… ' + syncing.done + ' done, ' + syncing.remaining + ' left'
        );
      } else if (main || missing || extra) {
        var choice = h(
          'select',
          {
            class: 'form-input is-compact',
            'aria-label': 'Roles on Discord without a tag here',
            onchange: function () {
              extraChoice = choice.value;
              render();
            },
          },
          h('option', { value: 'take' }, 'Roles without a tag: take away'),
          h('option', { value: 'tag' }, 'Roles without a tag: tag them here'),
          h('option', { value: 'keep' }, 'Roles without a tag: keep')
        );
        choice.value = extraChoice;
        var go = h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            disabled: total === 0,
            onclick: function () {
              syncAll(total);
            },
          },
          'Sync all roles'
        );
        actions = [choice, go];
      }
      rows.appendChild(
        step(
          2,
          'Roles',
          parts.length
            ? parts.join(' · ') + '.'
            : 'Discord has the roles the board says, for all ' + check.checked + ' linked.',
          actions,
          !parts.length
        )
      );
      var none = check.noRole;
      rows.appendChild(
        step(
          3,
          'No role',
          none === null || none === undefined
            ? 'Not readable: ' + (check.noRoleProblem || 'the server’s list cannot be read') + '.'
            : none.length
            ? none.length +
              ' people on the server with neither Participant nor Organizer, not on the board.'
            : 'Everyone on the server has a role.',
          none && none.length
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm',
                  onclick: function () {
                    var el = document.getElementById('noroles');
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  },
                },
                'Review →'
              )
            : null,
          Boolean(none && !none.length)
        )
      );
    }
    section.appendChild(rows);
    return section;
  }

  function render() {
    // Drawn again after each change: the page stays where it was.
    var y = window.scrollY;
    M.clear(view);
    view.appendChild(
      h(
        'div',
        { class: 'dc-page' },
        triageSection(),
        linkSection(),
        checkSection(),
        noRoleSection()
      )
    );
    window.scrollTo(0, y);
  }
})();
