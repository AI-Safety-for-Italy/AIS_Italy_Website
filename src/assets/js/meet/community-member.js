/* Members board → a member's page (/app/members/member/?id=): everything
 * about one person, from /api/app/community?member= (server/community.js).
 *
 *   Main column  their details and consent, role and working groups (one
 *                form, saved in the database); what they answered (the
 *                applications, the old sheet's rows); their history.
 *   Side column  Discord: who they are there, what waits to change for
 *                them (applied from here or the Discord tab), linking.
 *                Website: whether they are online as they are here, and the
 *                card the site shows.
 * Under each field, where its value came from (the old sheet, an
 * application, the board), so a later import is never a surprise.
 * Whatever people typed goes on the page as text (h() makes text nodes). */
(function () {
  'use strict';
  var M = window.Meet;
  var B = M.board;
  var h = M.h;
  var API = B.API;
  var view = document.getElementById('memberView');
  var id = new URLSearchParams(location.search).get('id');

  var page = null; // { member, sources, applications, discord, site, history, groups, roles }
  var watch = null;

  var LABELS = {
    name: 'Name',
    profile: 'Profile link',
    location: 'Place',
    areas: 'Areas',
    publish: 'Shown on the site',
    role: 'Role',
    groups: 'Working groups',
    discordId: 'Discord account',
  };
  var SOURCES = {
    sheet: 'the old sheet',
    application: 'an application',
    upgrade: 'an upgrade request',
    discord: 'Discord',
    board: 'the board',
  };

  function load() {
    return M.api('GET', API + '?member=' + encodeURIComponent(id || '')).then(function (d) {
      page = d;
      document.title = d.member.name + ' | Members board | AI Safety for Italy';
      render();
    });
  }

  if (!id) {
    view.appendChild(B.empty('No member picked', 'Open someone from the Members tab.'));
  } else {
    view.appendChild(M.loading());
    M.me.then(load).catch(function (err) {
      if (err.status === 404) {
        M.clear(view);
        view.appendChild(
          B.empty(
            'No such member',
            'They may have been removed.',
            h(
              'a',
              { class: 'btn btn-outline btn-sm', href: '/app/members/people/' },
              'Back to Members'
            )
          )
        );
        return;
      }
      B.fail(view)(err);
    });
  }

  function groupTitle(gid) {
    var g = page.groups.filter(function (x) {
      return x.id === gid;
    })[0];
    return g ? g.titleEn : gid;
  }

  function render() {
    B.redraw(view, draw);
  }

  function draw() {
    M.clear(view);
    var m = page.member;
    view.appendChild(head(m));
    view.appendChild(
      h(
        'div',
        { class: 'mb-page' },
        h('div', { class: 'mb-page-main' }, editor(m), notes(), answers(), history()),
        h('aside', { class: 'mb-page-side' }, discordCard(m), siteCard(m), actionsCard(m))
      )
    );
  }

  // ── Head ─────────────────────────────────────────────────────────────────

  function head(m) {
    var bits = [];
    if (m.source)
      bits.push(
        'Came from ' +
          ({ sheet: 'the old sheet', application: 'an application', board: 'Discord' }[m.source] ||
            m.source)
      );
    if (m.joinedOn) bits.push('member since ' + B.day(m.joinedOn));
    return h(
      'div',
      { class: 'mb-head' },
      h('a', { class: 'mb-back', href: '/app/members/people/' }, '← Members'),
      h(
        'div',
        { class: 'mb-head-main' },
        B.avatar({ name: m.name, avatarUrl: null }, 52),
        h(
          'div',
          { class: 'mb-head-text' },
          h('h2', { class: 'mb-head-name' }, m.name),
          h(
            'div',
            { class: 'mb-head-chips' },
            m.archivedAt ? B.pill('muted', 'Offboarded ' + B.day(m.archivedAt)) : null,
            page.discord && (page.discord.gone || []).length
              ? B.pill('warn', 'Left the server')
              : null,
            B.roleChip(page.roles, m.role),
            m.groups.map(function (g) {
              return h(
                'span',
                { class: 'mb-group' + (g.level === 'coordination' ? ' is-coord' : '') },
                g.level === 'coordination' ? '★ ' : '',
                groupTitle(g.group)
              );
            })
          ),
          h('p', { class: 'mb-sub' }, bits.join(' · '))
        )
      )
    );
  }

  // ── Details, role and groups ─────────────────────────────────────────────

  function provenance(field) {
    var s = (page.member.fieldSources || {})[field];
    if (!s || !s.source) return null;
    return h(
      'span',
      { class: 'mb-prov' + (s.source === 'board' ? ' is-board' : '') },
      s.source === 'board'
        ? 'Set on the board' + (s.at ? ' · ' + B.day(s.at) : '')
        : 'From ' + (SOURCES[s.source] || s.source) + (s.at ? ' · ' + B.day(s.at) : '')
    );
  }

  function field(key, input) {
    return h(
      'div',
      { class: 'mb-field' },
      h('label', { class: 'form-label', for: input.id }, LABELS[key]),
      input,
      provenance(key)
    );
  }

  function editor(m) {
    var inputs = {
      name: h('input', {
        class: 'form-input is-compact',
        id: 'mName',
        maxlength: 200,
        required: true,
        value: m.name,
      }),
      profile: h('input', {
        class: 'form-input is-compact',
        id: 'mProfile',
        maxlength: 500,
        placeholder: 'https://',
        value: m.profile,
      }),
      location: h('input', {
        class: 'form-input is-compact',
        id: 'mLocation',
        maxlength: 200,
        value: m.location,
      }),
      areas: h('textarea', {
        class: 'form-input is-compact',
        id: 'mAreas',
        maxlength: 1000,
        rows: 2,
      }),
    };
    inputs.areas.value = m.areas;
    var publish = h('input', {
      type: 'checkbox',
      role: 'switch',
      class: 'fe-switch-input',
      id: 'mPublish',
    });
    publish.checked = m.publish;
    var role = h(
      'select',
      { class: 'form-input is-compact', id: 'mRole' },
      page.roles.map(function (r) {
        return h('option', { value: r.key, selected: m.role === r.key }, r.name);
      })
    );
    var levels = {};
    m.groups.forEach(function (g) {
      levels[g.group] = g.level;
    });
    var picker = h(
      'div',
      { class: 'mb-group-picker', role: 'group', 'aria-label': 'Working groups' },
      page.groups.map(function (g) {
        var box = h('input', { type: 'checkbox', value: g.id, checked: Boolean(levels[g.id]) });
        var star = h('input', {
          type: 'checkbox',
          class: 'mb-coord',
          'data-coord': g.id,
          'aria-label': 'Coordinates ' + g.titleEn,
          title: 'Coordinates this group',
          checked: levels[g.id] === 'coordination',
          disabled: !levels[g.id],
        });
        box.addEventListener('change', function () {
          star.disabled = !box.checked;
          if (!box.checked) star.checked = false;
        });
        return h(
          'div',
          { class: 'mb-group-option' },
          h('label', { class: 'check-row' }, box, h('span', null, g.titleEn)),
          h('label', { class: 'mb-coord-label' }, star, h('span', null, '★ coordinates'))
        );
      })
    );
    var error = h('p', { class: 'form-error', hidden: true });
    var save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save');
    var form = h(
      'form',
      { class: 'panel mb-card', novalidate: true },
      h(
        'div',
        { class: 'mb-card-head' },
        h('h3', null, 'Details'),
        h('span', { class: 'mb-sub' }, 'Saved in the database')
      ),
      h(
        'div',
        { class: 'mb-fields' },
        field('name', inputs.name),
        field('location', inputs.location),
        field('profile', inputs.profile),
        field('areas', inputs.areas)
      ),
      h(
        'div',
        { class: 'mb-field' },
        h(
          'label',
          { class: 'fe-switch' },
          h('span', null, 'Shown on the website (they consented)'),
          publish
        ),
        provenance('publish')
      ),
      h(
        'div',
        { class: 'mb-card-head is-sub' },
        h('h3', null, 'Role and working groups'),
        h('span', { class: 'mb-sub' }, 'On Discord when applied')
      ),
      h('div', { class: 'mb-fields' }, field('role', role)),
      h(
        'div',
        { class: 'mb-field' },
        h('span', { class: 'form-label' }, 'Working groups'),
        picker,
        provenance('groups')
      ),
      error,
      h('div', { class: 'mb-card-foot' }, save)
    );
    watch = M.watchFields(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.hidden = true;
      var next = {
        name: inputs.name.value.trim(),
        profile: inputs.profile.value.trim(),
        location: inputs.location.value.trim(),
        areas: inputs.areas.value.trim(),
        publish: publish.checked,
      };
      var groups = [];
      var coords = {};
      picker.querySelectorAll('input[type=checkbox][value]').forEach(function (b) {
        if (b.checked) groups.push(b.value);
      });
      picker.querySelectorAll('[data-coord]').forEach(function (s) {
        coords[s.getAttribute('data-coord')] = s.checked && !s.disabled;
      });
      var changed = ['name', 'profile', 'location', 'areas'].filter(function (k) {
        return next[k] !== (m[k] || '');
      });
      var publishChanged = next.publish !== m.publish;
      var had = m.groups.map(function (g) {
        return g.group;
      });
      var added = groups.filter(function (g) {
        return had.indexOf(g) === -1;
      });
      var left = had.filter(function (g) {
        return groups.indexOf(g) === -1;
      });
      var roleChanged = role.value !== m.role;
      var coordChanges = Object.keys(coords).filter(function (g) {
        return groups.indexOf(g) !== -1 && coords[g] !== (levels[g] === 'coordination');
      });
      if (!next.name) {
        error.textContent = 'The name is required.';
        error.hidden = false;
        return;
      }
      if (
        !changed.length &&
        !publishChanged &&
        !added.length &&
        !left.length &&
        !roleChanged &&
        !coordChanges.length
      ) {
        M.toast('Nothing changed');
        return;
      }
      var db = [];
      if (changed.length) db.push(changed.map((k) => LABELS[k]).join(', ') + ' changed');
      if (publishChanged)
        db.push(next.publish ? 'shown on the website' : 'hidden from the website');
      if (roleChanged) db.push('made ' + B.roleName(page.roles, role.value));
      if (added.length) db.push('put in ' + added.map(groupTitle).join(', '));
      if (left.length) db.push('taken out of ' + left.map(groupTitle).join(', '));
      if (coordChanges.length) db.push('coordination: ' + coordChanges.map(groupTitle).join(', '));
      var effects = [{ where: 'db', text: cap(db.join('; ')) + '.' }];
      if (roleChanged || added.length || left.length)
        effects.push({
          where: 'discord',
          text: m.discordId
            ? 'Nothing changes yet: the roles wait to be applied (here, or on the Discord tab).'
            : 'Not linked to Discord: their roles follow once linked and applied.',
        });
      if (m.publish || next.publish)
        effects.push({ where: 'site', text: 'Changes when the website is updated.' });
      B.confirm({ title: 'Save ' + m.name + '?', effects: effects, ok: 'Save' }).then(function (
        yes
      ) {
        if (!yes) return;
        save.disabled = true;
        var steps = Promise.resolve();
        if (changed.length || publishChanged)
          steps = steps.then(function () {
            return M.api('PUT', API + '?member=' + encodeURIComponent(m.id), next);
          });
        if (roleChanged || added.length || left.length)
          steps = steps.then(function () {
            return M.api('POST', API + '?action=member-groups', {
              member: m.id,
              groups: groups,
              role: roleChanged ? role.value : undefined,
            });
          });
        coordChanges.forEach(function (g) {
          steps = steps.then(function () {
            return M.api('POST', API + '?action=coordinator', {
              group: g,
              member: m.id,
              on: coords[g],
            });
          });
        });
        steps
          .then(function () {
            watch.saved();
            M.toast(
              'Saved' +
                (roleChanged || added.length || left.length ? '. Discord: apply when ready.' : '')
            );
            return Promise.all([load(), B.refresh()]);
          })
          .catch(function (err) {
            save.disabled = false;
            if (err.status === 400 && err.message) {
              error.textContent = err.message;
              error.hidden = false;
            } else M.appError(err);
          });
      });
    });
    return form;
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── Discord ──────────────────────────────────────────────────────────────

  function discordCard(m) {
    var card = h(
      'section',
      { class: 'panel mb-card mb-side-card' },
      h('div', { class: 'mb-card-head' }, h('h3', null, 'Discord'))
    );
    var d = page.discord || {};
    if (!m.discordId) {
      if (m.discordAbsent) {
        card.appendChild(
          h(
            'p',
            { class: 'mb-side-state' },
            B.pill('muted', 'Not on Discord'),
            m.discordNote ? h('span', { class: 'mb-sub' }, m.discordNote) : null
          )
        );
        card.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                M.api('POST', API + '?action=absent', { member: m.id, absent: false })
                  .then(function () {
                    return Promise.all([load(), B.refresh()]);
                  })
                  .catch(M.appError);
              },
            },
            'Look for them again'
          )
        );
        return card;
      }
      card.appendChild(
        h(
          'p',
          { class: 'mb-side-state' },
          B.pill('todo', 'Not linked'),
          h('span', { class: 'mb-sub' }, 'Who are they on Discord?')
        )
      );
      card.appendChild(
        B.linker({
          member: m,
          done: function () {
            load();
          },
        })
      );
      return card;
    }
    card.appendChild(
      h(
        'div',
        { class: 'mb-account' },
        B.avatar({ displayName: m.discordName || m.discordUsername }, 32),
        h(
          'span',
          { class: 'mb-account-name' },
          h('strong', null, m.discordName || m.discordUsername || 'Linked'),
          m.discordUsername ? h('span', { class: 'mb-sub' }, '@' + m.discordUsername) : null
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'link-button',
            onclick: function () {
              B.confirm({
                title: 'Unlink ' + m.name + '?',
                effects: [
                  { where: 'db', text: 'No longer linked to this Discord account.' },
                  {
                    where: 'discord',
                    text: 'Nothing changes there: their roles stay as they are.',
                  },
                ],
                ok: 'Unlink',
                danger: true,
              }).then(function (yes) {
                if (!yes) return;
                M.api('POST', API + '?action=link', { member: m.id, discordId: null })
                  .then(function () {
                    return Promise.all([load(), B.refresh()]);
                  })
                  .catch(M.appError);
              });
            },
          },
          'Unlink'
        )
      )
    );
    if (d.available === false) {
      card.appendChild(
        h(
          'p',
          { class: 'panel-note' },
          'Their roles cannot be read here: ' + (d.problem || 'no bot') + '.'
        )
      );
      return card;
    }
    if ((d.gone || []).length) {
      card.appendChild(h('p', { class: 'notice' }, 'This account is no longer on the server.'));
      card.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              B.decide([d.gone[0].id], 'unlink')
                .then(function () {
                  return Promise.all([load(), B.refresh()]);
                })
                .catch(M.appError);
            },
          },
          'Unlink here'
        )
      );
      return card;
    }
    if (!d.items.length && !d.decide.length) {
      card.appendChild(
        h(
          'p',
          { class: 'mb-side-state' },
          B.pill('ok', 'In step'),
          h('span', { class: 'mb-sub' }, 'Discord has the roles the board says.')
        )
      );
      return card;
    }
    if (d.items.length) {
      card.appendChild(
        h('p', { class: 'mb-side-label' }, B.plural(d.items.length, 'change') + ' to apply')
      );
      card.appendChild(h('ul', { class: 'mb-changes' }, d.items.map(changeLine)));
      var apply = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm mb-apply',
          onclick: function () {
            B.confirm({
              title: 'Change ' + m.name + '’s roles on Discord?',
              effects: d.items.map(function (i) {
                var t = B.itemText(i);
                return { where: 'discord', text: t.verb + ' ' + t.role + ' — ' + t.why };
              }),
              ok: 'Apply on Discord',
            }).then(function (yes) {
              if (!yes) return;
              apply.disabled = true;
              B.applyAll(
                d.items.map(function (i) {
                  return i.id;
                }),
                { member: m.id }
              )
                .then(function (r) {
                  M.toast(
                    r.failed ? r.failed + ' could not be applied' : 'Applied on Discord',
                    r.failed > 0
                  );
                  return Promise.all([load(), B.refresh()]);
                })
                .catch(function (err) {
                  apply.disabled = false;
                  M.appError(err);
                });
            });
          },
        },
        'Apply on Discord'
      );
      card.appendChild(apply);
    }
    if (d.decide.length) {
      card.appendChild(h('p', { class: 'mb-side-label' }, 'On Discord, not said here'));
      card.appendChild(h('ul', { class: 'mb-changes' }, d.decide.map(decideLine)));
    }
    return card;
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
              return Promise.all([load(), B.refresh()]);
            })
            .catch(M.appError);
        },
      },
      h('option', { value: '' }, i.kind ? 'Decide…' : 'Instead…'),
      B.choicesFor(i).map(function (c) {
        return h('option', { value: c.choice }, c.label);
      })
    );
    return sel;
  }

  function changeLine(i) {
    var t = B.itemText(i);
    return h(
      'li',
      { class: 'mb-change is-' + i.op },
      h('span', { class: 'mb-change-op' }, i.op === 'add' ? '+' : '−'),
      h(
        'span',
        { class: 'mb-change-text' },
        h('strong', null, t.verb + ' ' + t.role),
        h('span', { class: 'mb-sub' }, t.why)
      ),
      choiceMenu(i)
    );
  }

  function decideLine(i) {
    return h(
      'li',
      { class: 'mb-change is-ask' },
      h('span', { class: 'mb-change-op' }, '?'),
      h(
        'span',
        { class: 'mb-change-text' },
        h('strong', null, i.roleName),
        h('span', { class: 'mb-sub' }, B.decideText(i))
      ),
      choiceMenu(i)
    );
  }

  // ── Website ──────────────────────────────────────────────────────────────

  function siteCard(m) {
    var s = page.site;
    var e = s.entry;
    var card = h(
      'section',
      { class: 'panel mb-card mb-side-card' },
      h('div', { class: 'mb-card-head' }, h('h3', null, 'Website'), B.sitePill(s.status))
    );
    var text = {
      online: 'On the Community page as they are here.',
      changed: 'On the Community page, but not as they are here: online with the next update.',
      waiting: 'Not on the Community page yet: online with the next update.',
      hidden: m.publish ? 'Not shown: no name to show.' : 'Not shown: they did not consent.',
    }[s.status];
    card.appendChild(h('p', { class: 'mb-sub' }, text));
    if (e) {
      card.appendChild(
        h(
          'div',
          { class: 'mb-site-card', 'aria-label': 'Their card on the website' },
          h('strong', null, e.name),
          e.location ? h('span', null, e.location) : null,
          e.areas ? h('span', { class: 'mb-sub' }, e.areas) : null,
          e.groups && e.groups.length
            ? h(
                'span',
                { class: 'mb-head-chips' },
                e.groups.map(function (g) {
                  return h('span', { class: 'mb-group' }, groupTitle(g));
                })
              )
            : null,
          e.profile
            ? h('a', { href: e.profile, target: '_blank', rel: 'noopener noreferrer' }, 'Profile ↗')
            : null
        )
      );
    }
    if (s.status === 'changed' || s.status === 'waiting')
      card.appendChild(
        h(
          'a',
          { class: 'btn btn-outline btn-sm', href: '/app/members/site/' },
          'Update the website…'
        )
      );
    return card;
  }

  // ── What they answered ───────────────────────────────────────────────────

  function answerList(list) {
    if (!list || !list.length) return h('p', { class: 'panel-note' }, 'No answers kept.');
    return h(
      'dl',
      { class: 'mb-answers' },
      list.map(function (a) {
        return [h('dt', null, a.label), h('dd', null, M.linkify(String(a.value || '—')))];
      })
    );
  }

  function answers() {
    var blocks = [];
    page.applications.forEach(function (a) {
      var title = a.kind === 'upgrade' ? 'Request to become an organizer' : 'Application to join';
      var status = {
        pending: ['todo', 'Waiting'],
        approved: ['ok', 'Approved'],
        rejected: ['muted', 'Rejected'],
      }[a.status] || ['muted', a.status];
      blocks.push(
        h(
          'details',
          { class: 'mb-source', open: page.applications.length + page.sources.length <= 2 },
          h(
            'summary',
            null,
            h('strong', null, title),
            B.pill(status[0], status[1]),
            h(
              'span',
              { class: 'mb-sub' },
              [B.day(a.createdAt), a.decidedBy ? 'decided by ' + a.decidedBy : null]
                .filter(Boolean)
                .join(' · ')
            )
          ),
          a.answersRemoved
            ? h(
                'p',
                { class: 'panel-note' },
                'The answers were removed a year after approval (retention policy).'
              )
            : answerList(a.answers),
          a.note ? h('p', { class: 'mb-note' }, 'Note: ' + a.note) : null
        )
      );
    });
    page.sources.forEach(function (s) {
      blocks.push(
        h(
          'details',
          { class: 'mb-source' },
          h(
            'summary',
            null,
            h('strong', null, 'The old sheet'),
            h('span', { class: 'mb-sub' }, s.receivedAt ? 'answered ' + B.day(s.receivedAt) : '')
          ),
          s.answers
            ? answerList(s.answers)
            : h('p', { class: 'panel-note' }, 'Cannot be opened with the current key.')
        )
      );
    });
    return h(
      'section',
      { class: 'panel mb-card' },
      h(
        'div',
        { class: 'mb-card-head' },
        h('h3', null, 'What they answered'),
        h('span', { class: 'mb-sub' }, 'As they sent it')
      ),
      blocks.length
        ? blocks
        : h(
            'p',
            { class: 'panel-note' },
            page.member.source === 'sheet'
              ? 'Imported before the answers were kept: importing the old sheet again keeps them.'
              : 'Nothing kept: added from Discord, or the answers were removed.'
          )
    );
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  function notes() {
    var body = h('textarea', {
      class: 'form-input is-compact',
      rows: 2,
      maxlength: 4000,
      placeholder: 'A note for the team: what you agreed, what to remember…',
      'aria-label': 'New note',
      'data-unsaved-ignore': '',
    });
    var add = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm',
        onclick: function () {
          if (!body.value.trim()) return body.focus();
          add.disabled = true;
          M.api('POST', API + '?action=note', { member: page.member.id, body: body.value })
            .then(function (r) {
              page.notes = r.notes;
              render();
            })
            .catch(function (err) {
              add.disabled = false;
              M.appError(err);
            });
        },
      },
      'Add the note'
    );
    return h(
      'section',
      { class: 'panel mb-card' },
      h(
        'div',
        { class: 'mb-card-head' },
        h('h3', null, 'Notes'),
        h('span', { class: 'mb-sub' }, 'For the team only, never on the website')
      ),
      page.notes.length
        ? h(
            'ul',
            { class: 'mb-notes' },
            page.notes.map(function (n) {
              return h(
                'li',
                null,
                h('p', null, M.linkify(n.body)),
                h(
                  'span',
                  { class: 'mb-sub' },
                  n.author + ' · ' + B.when(n.at),
                  n.mine
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'link-button mb-note-x',
                          onclick: function () {
                            M.api('DELETE', API + '?note=' + encodeURIComponent(n.id))
                              .then(function (r) {
                                page.notes = r.notes;
                                render();
                              })
                              .catch(M.appError);
                          },
                        },
                        'Remove'
                      )
                    : null
                )
              );
            })
          )
        : null,
      h('div', { class: 'mb-note-new' }, body, add)
    );
  }

  // ── Leaving, merging, erasing ────────────────────────────────────────────

  function after(text) {
    return function () {
      M.toast(text);
      return Promise.all([load(), B.refresh()]);
    };
  }

  function actionsCard(m) {
    var card = h(
      'section',
      { class: 'panel mb-card mb-side-card mb-actions' },
      h('div', { class: 'mb-card-head' }, h('h3', null, 'Membership'))
    );
    if (m.archivedAt) {
      card.appendChild(
        h(
          'p',
          { class: 'mb-sub' },
          'Offboarded on ' + B.day(m.archivedAt) + (m.archiveNote ? ': ' + m.archiveNote : '.')
        )
      );
      card.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              B.confirm({
                title: 'Restore ' + m.name + '?',
                effects: [
                  { where: 'db', text: 'A member again, with their role and groups.' },
                  {
                    where: 'discord',
                    text: 'Nothing changes yet: their roles wait to be applied.',
                  },
                  { where: 'site', text: 'Hidden until shown again on this page.' },
                ],
                ok: 'Restore',
              }).then(function (yes) {
                if (yes)
                  M.api('POST', API + '?action=restore', { member: m.id })
                    .then(after('Restored'))
                    .catch(M.appError);
              });
            },
          },
          'Restore as a member'
        )
      );
    } else {
      var why = h('input', {
        class: 'form-input is-compact',
        maxlength: 300,
        placeholder: 'Why, e.g. “asked to leave”',
        'aria-label': 'Why they leave',
        'data-unsaved-ignore': '',
      });
      card.appendChild(
        h(
          'div',
          { class: 'mb-offboard' },
          h(
            'p',
            { class: 'mb-sub' },
            'They left the association: kept as a record, off the website, their roles taken off Discord.'
          ),
          why,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                B.confirm({
                  title: 'Offboard ' + m.name + '?',
                  effects: [
                    { where: 'db', text: 'Kept as a record, marked as left; restorable.' },
                    {
                      where: 'discord',
                      text: m.discordId
                        ? 'Every role the board gives them is listed to take off; nothing changes until applied.'
                        : 'Not linked: nothing there.',
                    },
                    {
                      where: 'site',
                      text: m.publish
                        ? 'Hidden at once; gone from the website when it is updated.'
                        : 'Not shown there.',
                    },
                  ],
                  ok: 'Offboard',
                  danger: true,
                }).then(function (yes) {
                  if (yes)
                    M.api('POST', API + '?action=offboard', { member: m.id, note: why.value })
                      .then(after('Offboarded. Apply on Discord to take their roles off.'))
                      .catch(M.appError);
                });
              },
            },
            'Offboard…'
          )
        )
      );
    }
    if (page.maybeSame.length) {
      card.appendChild(h('p', { class: 'mb-side-label' }, 'Maybe the same person'));
      page.maybeSame.forEach(function (o) {
        card.appendChild(
          h(
            'div',
            { class: 'mb-account' },
            B.avatar({ name: o.name }, 26),
            h(
              'span',
              { class: 'mb-account-name' },
              h(
                'a',
                { class: 'mb-who', href: '/app/members/member/?id=' + encodeURIComponent(o.id) },
                h('strong', null, o.name)
              ),
              h(
                'span',
                { class: 'mb-sub' },
                [o.location, o.discordUsername ? '@' + o.discordUsername : '']
                  .filter(Boolean)
                  .join(' · ')
              )
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  B.confirm({
                    title: 'Merge ' + o.name + ' into this record?',
                    effects: [
                      {
                        where: 'db',
                        text: 'This record stays; its gaps are filled from the other, which is removed. The higher role, every group, the answers, notes and history move here.',
                      },
                      {
                        where: 'discord',
                        text: 'Nothing changes yet: any role to give waits to be applied.',
                      },
                    ],
                    ok: 'Merge',
                  }).then(function (yes) {
                    if (yes)
                      M.api('POST', API + '?action=merge', { keep: m.id, drop: o.id })
                        .then(after('Merged'))
                        .catch(M.appError);
                  });
                },
              },
              'Merge in'
            )
          )
        );
      });
    }
    var erase = h(
      'details',
      { class: 'mb-advanced mb-erase' },
      h('summary', null, 'Erase all their data'),
      h(
        'p',
        { class: 'mb-sub' },
        'For a request to be forgotten: their record, notes, kept answers, applications and the form answers they sent are deleted for good. ' +
          (m.discordId
            ? 'Their roles on Discord stay: offboard and apply first to take them off.'
            : '')
      )
    );
    var confirmName = h('input', {
      class: 'form-input is-compact',
      placeholder: 'Type “' + m.name + '” to confirm',
      'aria-label': 'Their name, to confirm',
      'data-unsaved-ignore': '',
    });
    var go = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-danger btn-sm',
        onclick: function () {
          B.confirm({
            title: 'Erase ' + m.name + ' for good?',
            effects: [
              {
                where: 'db',
                text: 'Everything about them is deleted; this cannot be undone. The audit trail keeps that it happened, not who.',
              },
              { where: 'discord', text: 'Nothing changes there.' },
              { where: 'site', text: 'Gone from the website when it is updated.' },
            ],
            ok: 'Erase for good',
            danger: true,
          }).then(function (yes) {
            if (!yes) return;
            M.api('POST', API + '?action=erase', { member: m.id, confirm: confirmName.value })
              .then(function () {
                M.toast('Erased');
                M.leaveTo('/app/members/people/');
              })
              .catch(M.appError);
          });
        },
      },
      'Erase'
    );
    erase.appendChild(h('div', { class: 'mb-absent-form' }, confirmName, go));
    card.appendChild(erase);
    return card;
  }

  // ── History ──────────────────────────────────────────────────────────────

  function describe(e) {
    var d = e.detail || {};
    var a = d.action;
    switch (e.action) {
      case 'community-member':
        if (a === 'edit')
          return (
            'Changed ' +
            (d.fields || [])
              .map((f) => LABELS[f] || f)
              .join(', ')
              .toLowerCase()
          );
        if (a === 'offboard') return 'Offboarded';
        if (a === 'restore') return 'Restored as a member';
        if (a === 'note') return 'A note added';
        if (a === 'note-removed') return 'A note removed';
        if (a === 'merge-members') return 'Another record of them merged in';
        if (a === 'not-duplicate') return 'Told apart from someone of the same name';
        if (a === 'create')
          return (
            'Joined the board from ' +
            (SOURCES[d.from] || d.from) +
            (d.discord ? ' (roles given on Discord)' : '')
          );
        if (a === 'merge')
          return (
            'Completed from ' +
            (SOURCES[d.from] || d.from) +
            (d.kept ? '; kept as on the board: ' + d.kept.join(', ') : '')
          );
        return 'Changed';
      case 'community-tags':
        if (a === 'set') {
          var parts = [];
          if (d.role) parts.push('made ' + B.roleName(page.roles, d.role));
          if ((d.added || []).length) parts.push('put in ' + d.added.map(groupTitle).join(', '));
          if ((d.left || []).length)
            parts.push('taken out of ' + d.left.map(groupTitle).join(', '));
          return cap(parts.join('; ') || 'groups saved');
        }
        if (a === 'add') return 'Put in ' + groupTitle(d.group) + ' (with others)';
        if (a === 'remove') return 'Taken out of ' + groupTitle(d.group) + ' (with others)';
        if (a === 'move')
          return 'Moved from ' + groupTitle(d.group) + ' to ' + groupTitle(d.to) + ' (with others)';
        if (a === 'role') return 'Made ' + B.roleName(page.roles, d.role) + ' (with others)';
        if (a === 'coordinator') return 'Coordinates ' + groupTitle(d.group);
        if (a === 'not-coordinator') return 'No longer coordinates ' + groupTitle(d.group);
        return 'Groups changed';
      case 'community-discord':
        if (a === 'link') return 'Linked to their Discord account';
        if (a === 'unlink') return 'Unlinked from Discord';
        if (a === 'not-on-discord') return 'Checked: not on Discord';
        if (a === 'to-check') return 'To look for on Discord again';
        if (a === 'apply') return 'Applied on Discord: ' + (d.changes || []).join(', ');
        if (a === 'rematch') return 'Linked to Discord (matched again)';
        if (a === 'unignore') return 'A difference with Discord listed again';
        if (a && a.indexOf('decide-') === 0) return 'Discord difference settled: ' + a.slice(7);
        return 'Discord';
      case 'community-import':
        return 'Imported or completed from the old sheet';
      case 'community-groups':
        return d.change === 'delete' ? 'Their group ' + d.group + ' was removed' : 'Groups changed';
      case 'member-decide':
        return (
          (d.upgrade ? 'Request to become an organizer ' : 'Application ') +
          (d.decision === 'approve' ? 'approved' : 'rejected')
        );
      case 'member-resend':
        return 'Join link sent again';
      case 'member-note':
        return 'Application note changed';
      case 'member-contacted':
        return d.on ? 'Application marked as contacted' : 'Application back to review';
      case 'member-contact':
        return 'Emailed to ask for more details';
      default:
        return e.action;
    }
  }

  function history() {
    var list = page.history;
    return h(
      'section',
      { class: 'panel mb-card' },
      h(
        'div',
        { class: 'mb-card-head' },
        h('h3', null, 'History'),
        h('span', { class: 'mb-sub' }, 'From the audit trail')
      ),
      list.length
        ? h(
            'ol',
            { class: 'mb-history' },
            list.map(function (e) {
              return h(
                'li',
                null,
                h('span', { class: 'mb-history-when' }, B.when(e.at)),
                h('span', { class: 'mb-history-what' }, describe(e)),
                h('span', { class: 'mb-sub' }, e.userName)
              );
            })
          )
        : h('p', { class: 'panel-note' }, 'Nothing yet.')
    );
  }
})();
