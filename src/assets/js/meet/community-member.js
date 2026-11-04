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
    M.clear(view);
    var m = page.member;
    view.appendChild(head(m));
    view.appendChild(
      h(
        'div',
        { class: 'mb-page' },
        h('div', { class: 'mb-page-main' }, editor(m), answers(), history()),
        h('aside', { class: 'mb-page-side' }, discordCard(m), siteCard(m))
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
