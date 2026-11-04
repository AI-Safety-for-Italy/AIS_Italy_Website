/* Members board → Discord (/app/members/discord/): the one place where the
 * board and the Discord server are brought in step (server/community.js,
 * discordPlan). Nothing here changes Discord until "Apply" is pressed.
 *
 *   1. Changes to apply      roles to give or take off, as the board says;
 *                            picked and applied, 15 at a time
 *   2. To decide             what Discord has that the board does not say:
 *                            adopt it here, take it off there, or leave it
 *   3. Accounts to link      members not linked yet: suggested by name
 *   4. Left the server       linked accounts no longer there
 *   5. On the server, no role  not on the board: add them, or leave them
 *   6. Left as they are      the "leave it" choices, to undo
 * Whatever people typed goes on the page as text (h() makes text nodes). */
(function () {
  'use strict';
  var M = window.Meet;
  var B = M.board;
  var h = M.h;
  var API = B.API;
  var view = document.getElementById('discordView');

  var plan = null; // discordPlan + { roles, groups }
  var members = null; // the board's members
  var picked = new Set(); // ids of changes to apply
  var pickedAsk = new Set(); // ids of items to decide, or of people with no role
  var busy = false;
  var open = {}; // sections folded open

  function load() {
    return Promise.all([M.api('GET', API + '?view=discord-plan'), M.api('GET', API)]).then(
      function (r) {
        plan = r[0];
        members = r[1].members;
        // Picked by default: every change (the board is what should be).
        if (!picked.size)
          plan.items.forEach(function (i) {
            picked.add(i.id);
          });
        var ids = new Set(
          plan.items.map(function (i) {
            return i.id;
          })
        );
        picked.forEach(function (id) {
          if (!ids.has(id)) picked.delete(id);
        });
        pickedAsk.clear();
        ignoredList = null;
        render();
      }
    );
  }

  function reload() {
    return Promise.all([load(), B.refresh()]);
  }

  view.appendChild(M.loading('Reading Discord…'));
  M.me.then(load).catch(B.fail(view));

  function groupTitle(id) {
    var g = (plan.groups || []).filter(function (x) {
      return x.id === id;
    })[0];
    return g ? g.titleEn : id;
  }

  function memberLink(i) {
    return h(
      'a',
      { class: 'mb-who', href: '/app/members/member/?id=' + encodeURIComponent(i.memberId) },
      i.name
    );
  }

  function section(key, title, count, note, body, opts) {
    opts = opts || {};
    var fold = opts.fold;
    var isOpen = fold ? Boolean(open[key]) : true;
    var head = h(
      fold ? 'button' : 'div',
      {
        class: 'mb-sec-head',
        type: fold ? 'button' : null,
        'aria-expanded': fold ? String(isOpen) : null,
        onclick: fold
          ? function () {
              open[key] = !open[key];
              render();
            }
          : null,
      },
      h('h3', null, title),
      count === ''
        ? null
        : h(
            'span',
            { class: 'mb-sec-count' + (count && opts.tone ? ' is-' + opts.tone : '') },
            String(count)
          ),
      note ? h('span', { class: 'mb-sec-note' }, note) : null,
      opts.tools ? h('span', { class: 'mb-sec-tools' }, opts.tools) : null,
      fold ? h('span', { class: 'crm-chevron', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸') : null
    );
    return h('section', { class: 'panel mb-sec', id: 'sec-' + key }, head, isOpen ? body : null);
  }

  function render() {
    M.clear(view);
    if (!plan.available) {
      view.appendChild(
        B.empty(
          'Discord cannot be read here',
          'The board cannot compare with the server: ' +
            plan.problem +
            '. Every change is still saved, and waits here until the bot is set up.'
        )
      );
      view.appendChild(toLink());
      return;
    }
    if (plan.failed)
      view.appendChild(
        h(
          'p',
          { class: 'notice' },
          B.plural(plan.failed, 'account') +
            ' could not be read from Discord just now: they are left out. Reload to try again.'
        )
      );
    view.appendChild(intro());
    view.appendChild(changes());
    view.appendChild(toDecide());
    view.appendChild(toLink());
    if (plan.gone.length) view.appendChild(gone());
    view.appendChild(noRole());
    view.appendChild(ignored());
  }

  function intro() {
    var nothing =
      !plan.items.length && !plan.decide.length && !plan.gone.length && !(plan.noRole || []).length;
    return h(
      'div',
      { class: 'mb-intro' + (nothing ? ' is-ok' : '') },
      h(
        'p',
        null,
        nothing
          ? 'Discord is in step with the board: ' +
              B.plural(plan.checked, 'linked member') +
              ' checked.'
          : 'The board says what should be. Below, what that changes on Discord, and what Discord has that the board does not say. Nothing changes on Discord until you apply it.'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          onclick: function (e) {
            e.target.disabled = true;
            load().then(B.refresh).catch(M.appError);
          },
        },
        'Read Discord again'
      )
    );
  }

  // ── 1. Changes to apply ──────────────────────────────────────────────────

  function byMember(list) {
    var out = [];
    var at = {};
    list.forEach(function (i) {
      if (!(i.memberId in at)) {
        at[i.memberId] = out.length;
        out.push({ memberId: i.memberId, name: i.name, discord: i.discord, items: [] });
      }
      out[at[i.memberId]].items.push(i);
    });
    return out;
  }

  function choiceMenu(i) {
    var sel = h(
      'select',
      {
        class: 'form-input is-compact mb-choice',
        'aria-label': 'Instead',
        onchange: function () {
          if (!sel.value) return;
          B.decide([i.id], sel.value)
            .then(function () {
              M.toast('Saved here');
              return reload();
            })
            .catch(M.appError);
        },
      },
      h('option', { value: '' }, 'Instead…'),
      B.choicesFor(i).map(function (c) {
        return h('option', { value: c.choice }, c.label);
      })
    );
    return sel;
  }

  function changes() {
    var groups = byMember(plan.items);
    var n = picked.size;
    var applyBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        disabled: !n || busy,
        onclick: function () {
          var ids = Array.from(picked);
          var adds = plan.items.filter((i) => picked.has(i.id) && i.op === 'add').length;
          var removes = ids.length - adds;
          var who = new Set(plan.items.filter((i) => picked.has(i.id)).map((i) => i.memberId)).size;
          B.confirm({
            title: 'Apply ' + B.plural(ids.length, 'change') + ' on Discord?',
            effects: [
              {
                where: 'discord',
                text:
                  [
                    adds ? B.plural(adds, 'role') + ' given' : null,
                    removes ? B.plural(removes, 'role') + ' taken off' : null,
                  ]
                    .filter(Boolean)
                    .join(', ') +
                  ', for ' +
                  B.plural(who, 'member') +
                  '. Each is checked against Discord again just before.',
              },
              { where: 'db', text: 'Nothing changes: the board already says this.' },
            ],
            ok: 'Apply on Discord',
          }).then(function (yes) {
            if (!yes) return;
            busy = true;
            applyBtn.disabled = true;
            applyBtn.textContent = 'Applying… 0/' + ids.length;
            B.applyAll(ids, {
              progress: function (done, total) {
                applyBtn.textContent = 'Applying… ' + done + '/' + total;
              },
            })
              .then(function (r) {
                busy = false;
                picked.clear();
                M.toast(
                  r.failed
                    ? r.done + ' applied, ' + r.failed + ' failed: try again'
                    : B.plural(r.done, 'change') + ' applied on Discord',
                  r.failed > 0
                );
                return reload();
              })
              .catch(function (err) {
                busy = false;
                M.appError(err);
                reload();
              });
          });
        },
      },
      n ? 'Apply ' + B.plural(n, 'change') + ' on Discord' : 'Apply on Discord'
    );
    var all = plan.items.length && plan.items.every((i) => picked.has(i.id));
    var tools = plan.items.length
      ? [
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                if (all) picked.clear();
                else plan.items.forEach((i) => picked.add(i.id));
                render();
              },
            },
            all ? 'Pick none' : 'Pick all'
          ),
          applyBtn,
        ]
      : null;
    var body = plan.items.length
      ? h(
          'div',
          { class: 'mb-plan' },
          groups.map(function (g) {
            var mine = g.items.every((i) => picked.has(i.id));
            return h(
              'div',
              { class: 'mb-plan-member' },
              h(
                'label',
                { class: 'mb-plan-who' },
                h('input', {
                  type: 'checkbox',
                  checked: mine,
                  'aria-label': 'Pick every change for ' + g.name,
                  onchange: function (e) {
                    g.items.forEach((i) =>
                      e.target.checked ? picked.add(i.id) : picked.delete(i.id)
                    );
                    render();
                  },
                }),
                B.avatar(g.discord, 26),
                memberLink(g),
                g.discord && g.discord.username
                  ? h('span', { class: 'mb-sub' }, '@' + g.discord.username)
                  : null
              ),
              h(
                'ul',
                { class: 'mb-changes' },
                g.items.map(function (i) {
                  var t = B.itemText(i);
                  return h(
                    'li',
                    { class: 'mb-change is-' + i.op },
                    h('input', {
                      type: 'checkbox',
                      checked: picked.has(i.id),
                      'aria-label': t.verb + ' ' + t.role,
                      onchange: function (e) {
                        if (e.target.checked) picked.add(i.id);
                        else picked.delete(i.id);
                        render();
                      },
                    }),
                    h('span', { class: 'mb-change-op' }, i.op === 'add' ? '+' : '−'),
                    h(
                      'span',
                      { class: 'mb-change-text' },
                      h('strong', null, t.verb + ' ' + t.role),
                      h('span', { class: 'mb-sub' }, t.why)
                    ),
                    choiceMenu(i)
                  );
                })
              )
            );
          })
        )
      : h(
          'p',
          { class: 'panel-note mb-none' },
          'Nothing to change on Discord: it has every role the board says.'
        );
    return section(
      'apply',
      'Changes to apply',
      plan.items.length,
      'From the board to Discord',
      body,
      {
        tone: 'todo',
        tools: tools,
      }
    );
  }

  // ── 2. To decide ─────────────────────────────────────────────────────────

  function bulkChoices(ids, choices, after) {
    return h(
      'span',
      { class: 'mb-bulk-choices' },
      choices.map(function (c) {
        return h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            disabled: !ids.length,
            onclick: function () {
              B.confirm({
                title: c.label + ' — ' + B.plural(ids.length, 'item') + '?',
                effects: c.effects,
                ok: c.label,
              }).then(function (yes) {
                if (!yes) return;
                B.decide(ids, c.choice)
                  .then(function () {
                    M.toast('Saved');
                    if (after) after();
                    return reload();
                  })
                  .catch(M.appError);
              });
            },
          },
          c.label + (ids.length ? ' (' + ids.length + ')' : '')
        );
      })
    );
  }

  function pickBox(id, label) {
    return h('input', {
      type: 'checkbox',
      checked: pickedAsk.has(id),
      'aria-label': label,
      onchange: function (e) {
        if (e.target.checked) pickedAsk.add(id);
        else pickedAsk.delete(id);
        render();
      },
    });
  }

  function toDecide() {
    var ids = plan.decide.map((i) => i.id).filter((id) => pickedAsk.has(id));
    var tools = plan.decide.length
      ? bulkChoices(ids, [
          {
            choice: 'tag',
            label: 'Adopt here',
            effects: [
              {
                where: 'db',
                text: 'The board takes what Discord has: put in the group, or made an organizer.',
              },
              { where: 'discord', text: 'Nothing changes.' },
            ],
          },
          {
            choice: 'remove',
            label: 'Take off Discord',
            effects: [
              {
                where: 'discord',
                text: 'Queued to take off: they show under “Changes to apply”, nothing changes until applied.',
              },
            ],
          },
          {
            choice: 'ignore',
            label: 'Leave it',
            effects: [{ where: 'db', text: 'Not listed again (undo under “Left as they are”).' }],
          },
        ])
      : null;
    var body = plan.decide.length
      ? h(
          'ul',
          { class: 'mb-changes mb-decide' },
          plan.decide.map(function (i) {
            return h(
              'li',
              { class: 'mb-change is-ask' },
              pickBox(i.id, 'Pick ' + i.name + ' ' + i.roleName),
              B.avatar(i.discord, 26),
              h(
                'span',
                { class: 'mb-change-text' },
                h('strong', null, memberLink(i), ' · ', i.roleName),
                h('span', { class: 'mb-sub' }, B.decideText(i))
              ),
              B.choicesFor(i).map(function (c) {
                return h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-outline btn-sm',
                    onclick: function () {
                      B.decide([i.id], c.choice)
                        .then(function () {
                          M.toast('Saved');
                          return reload();
                        })
                        .catch(M.appError);
                    },
                  },
                  c.label
                );
              })
            );
          })
        )
      : h('p', { class: 'panel-note mb-none' }, 'Discord has nothing the board does not say.');
    return section(
      'decide',
      'To decide',
      plan.decide.length,
      'Given by hand on Discord, not said here',
      body,
      {
        tone: 'ask',
        tools: tools,
      }
    );
  }

  // ── 3. Accounts to link ──────────────────────────────────────────────────

  var linking = {};

  function toLink() {
    var list = members.filter((m) => !m.discordId && !m.discordAbsent);
    var absent = members.filter((m) => !m.discordId && m.discordAbsent);
    var rematch = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm',
        disabled: !list.length,
        onclick: function () {
          rematch.disabled = true;
          M.api('POST', API + '?action=rematch', {})
            .then(function (r) {
              M.toast(
                r.linked
                  ? B.plural(r.linked, 'member') +
                      ' linked (' +
                      r.byEmail +
                      ' by email, ' +
                      r.byName +
                      ' by name)'
                  : 'Nobody else could be matched for sure' + (r.problem ? ': ' + r.problem : '')
              );
              return reload();
            })
            .catch(function (err) {
              rematch.disabled = false;
              M.appError(err);
            });
        },
      },
      'Link the sure ones'
    );
    var body = h(
      'div',
      null,
      list.length
        ? h(
            'p',
            { class: 'panel-note' },
            '“Link the sure ones” links by the email they signed in with, or a name that only one account on the server has. Linking changes nothing on Discord.'
          )
        : h('p', { class: 'panel-note mb-none' }, 'Everyone is linked or checked.'),
      h(
        'ul',
        { class: 'mb-link-rows' },
        list.map(function (m) {
          return h(
            'li',
            { class: 'mb-link-row' },
            h(
              'div',
              { class: 'mb-link-row-head' },
              B.avatar({ name: m.name }, 26),
              h(
                'a',
                { class: 'mb-who', href: '/app/members/member/?id=' + encodeURIComponent(m.id) },
                m.name
              ),
              h('span', { class: 'mb-sub' }, m.location || ''),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm',
                  'aria-expanded': String(Boolean(linking[m.id])),
                  onclick: function () {
                    linking[m.id] = !linking[m.id];
                    render();
                  },
                },
                linking[m.id] ? 'Close' : 'Find on Discord'
              )
            ),
            linking[m.id]
              ? B.linker({
                  member: m,
                  done: function () {
                    delete linking[m.id];
                    reload();
                  },
                })
              : null
          );
        })
      ),
      absent.length
        ? h(
            'details',
            { class: 'mb-absent' },
            h('summary', null, 'Checked, not on Discord (' + absent.length + ')'),
            h(
              'ul',
              { class: 'mb-link-rows' },
              absent.map(function (m) {
                return h(
                  'li',
                  { class: 'mb-link-row-head' },
                  h(
                    'a',
                    {
                      class: 'mb-who',
                      href: '/app/members/member/?id=' + encodeURIComponent(m.id),
                    },
                    m.name
                  ),
                  h('span', { class: 'mb-sub' }, m.discordNote || ''),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'link-button',
                      onclick: function () {
                        M.api('POST', API + '?action=absent', { member: m.id, absent: false })
                          .then(reload)
                          .catch(M.appError);
                      },
                    },
                    'Look again'
                  )
                );
              })
            )
          )
        : null
    );
    return section('link', 'Accounts to link', list.length, 'Who each member is on Discord', body, {
      tone: 'todo',
      tools: list.length ? rematch : null,
    });
  }

  // ── 4. Left the server ───────────────────────────────────────────────────

  function gone() {
    var body = h(
      'ul',
      { class: 'mb-changes' },
      plan.gone.map(function (g) {
        return h(
          'li',
          { class: 'mb-change is-ask' },
          h(
            'span',
            { class: 'mb-change-text' },
            h('strong', null, memberLink(g)),
            h('span', { class: 'mb-sub' }, 'Their linked account is no longer on the server')
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                B.decide([g.id], 'unlink')
                  .then(function () {
                    M.toast(g.name + ' unlinked');
                    return reload();
                  })
                  .catch(M.appError);
              },
            },
            'Unlink here'
          )
        );
      })
    );
    return section('gone', 'Left the server', plan.gone.length, null, body, { tone: 'ask' });
  }

  // ── 5. On the server with no role ────────────────────────────────────────

  function noRole() {
    var people = plan.noRole;
    if (people === null)
      return section(
        'norole',
        'On the server, no role',
        '–',
        null,
        h('p', { class: 'panel-note' }, 'Cannot be listed: ' + plan.noRoleProblem + '.'),
        { fold: true }
      );
    var ids = people.map((p) => p.id).filter((id) => pickedAsk.has(id));
    var roleOf = function (k) {
      return B.roleName(plan.roles, k);
    };
    var add = function (k) {
      return {
        choice: k,
        label: 'Add as ' + roleOf(k),
        effects: [
          {
            where: 'db',
            text: 'Put on the board as ' + roleOf(k) + ', linked, not shown on the website.',
          },
          {
            where: 'discord',
            text: 'Nothing changes yet: their role waits under “Changes to apply”.',
          },
        ],
      };
    };
    var tools = people.length
      ? bulkChoices(ids, [
          add('participant'),
          add('organizer'),
          {
            choice: 'ignore',
            label: 'Leave them',
            effects: [{ where: 'db', text: 'Not listed again (undo under “Left as they are”).' }],
          },
        ])
      : null;
    var body = people.length
      ? h(
          'div',
          null,
          h(
            'label',
            { class: 'check-row mb-pick-all' },
            h('input', {
              type: 'checkbox',
              checked: people.length && people.every((p) => pickedAsk.has(p.id)),
              onchange: function (e) {
                people.forEach((p) =>
                  e.target.checked ? pickedAsk.add(p.id) : pickedAsk.delete(p.id)
                );
                render();
              },
            }),
            h('span', null, 'Pick all')
          ),
          h(
            'ul',
            { class: 'mb-people-grid' },
            people.map(function (p) {
              return h(
                'li',
                { class: 'mb-account' + (pickedAsk.has(p.id) ? ' is-picked' : '') },
                pickBox(p.id, 'Pick ' + p.displayName),
                B.avatar(p, 28),
                h(
                  'span',
                  { class: 'mb-account-name' },
                  h('strong', null, p.displayName),
                  h(
                    'span',
                    { class: 'mb-sub' },
                    '@' + p.username + (p.joinedAt ? ' · joined ' + B.day(p.joinedAt) : '')
                  )
                )
              );
            })
          )
        )
      : h(
          'p',
          { class: 'panel-note mb-none' },
          'Everyone on the server has a role, or is on the board.'
        );
    return section(
      'norole',
      'On the server, no role',
      people.length,
      'Joined with an invite, not through an application',
      body,
      {
        tone: 'ask',
        tools: tools,
        fold: !people.length,
      }
    );
  }

  // ── 6. Left as they are ──────────────────────────────────────────────────

  var ignoredList = null;
  var ignoredLoading = false;

  function ignored() {
    var body = h('div', null);
    if (open.ignored) {
      if (!ignoredList) {
        body.appendChild(M.loading());
        if (!ignoredLoading) {
          ignoredLoading = true;
          M.api('GET', API + '?view=ignored')
            .then(function (r) {
              ignoredList = r.ignored;
              render();
            })
            .catch(M.appError)
            .then(function () {
              ignoredLoading = false;
            });
        }
      } else if (!ignoredList.length) {
        body.appendChild(
          h('p', { class: 'panel-note mb-none' }, 'No difference was left as it is.')
        );
      } else {
        var KIND = {
          'group-missing': 'A group’s role left missing on Discord',
          'group-extra': 'A group’s role on Discord left there',
          'main-missing': 'Their role left missing on Discord',
          'main-differs': 'The other role on Discord left there',
          'no-role': 'On the server with no role, left out',
        };
        body.appendChild(
          h(
            'ul',
            { class: 'mb-changes' },
            ignoredList.map(function (i) {
              return h(
                'li',
                { class: 'mb-change' },
                h(
                  'span',
                  { class: 'mb-change-text' },
                  h(
                    'strong',
                    null,
                    i.memberId
                      ? memberLink({ memberId: i.memberId, name: i.name || 'A member' })
                      : 'Discord account ' + i.discordId,
                    i.group ? ' · ' + groupTitle(i.group) : ''
                  ),
                  h('span', { class: 'mb-sub' }, KIND[i.kind] || i.kind)
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link-button',
                    onclick: function () {
                      M.api('POST', API + '?action=unignore', { ids: [i.id] })
                        .then(function (r) {
                          ignoredList = r.ignored;
                          M.toast('Listed again');
                          return reload();
                        })
                        .catch(M.appError);
                    },
                  },
                  'List again'
                )
              );
            })
          )
        );
      }
    }
    return section(
      'ignored',
      'Left as they are',
      ignoredList ? ignoredList.length : '',
      'Choices to undo',
      body,
      { fold: true }
    );
  }
})();
