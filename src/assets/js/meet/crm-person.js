/* One person of the mentorship board, drawn the same way in the board's side
 * panel / dialog (layout 'panel') and on their own page (layout 'page').
 *   CrmPerson.render(p, container, opts) -> { sync(card) }
 * opts: layout, me (user id), statuses / tracks (used when p has none),
 *   change(key, kind, changes) (the board's own optimistic change; without it
 *   the module saves by itself), onNoteAdded(p), onRemoved(), onClose(),
 *   reload() (fetches the person again; the module does it by default).
 * Whatever the sheets say goes on the page as text, never as HTML. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var API = '/api/app/crm/mentorship';

  var SOURCE_LABELS = {
    mentors_prospective: 'List to contact',
    mentors_applications: 'Mentor application',
    mentees_applications: 'Mentee application',
    mentees_interest: 'Expression of interest',
  };

  var ORIGIN_LABELS = {
    import: 'Imported from the sheet',
    form: 'From the form',
    board: 'Added on the board',
  };

  var FIELD_LABELS = {
    timestamp: 'Sent',
    consent: 'Privacy notice',
    first_name: 'First name',
    last_name: 'Last name',
    name: 'Name',
    email: 'Email',
    form_email: 'Form email',
    social: 'Social',
    org: 'Affiliation',
    affiliation: 'Affiliation',
    role: 'Role',
    career: 'Career stage',
    track: 'Track',
    tracks: 'Tracks',
    referrer: 'Recommended by',
    notes: 'Area / notes',
    contacted: 'Contacted',
    replied: 'Reply',
    reply_note: 'What they said',
    cv: 'CV',
    profile: 'Profile',
    country: 'Country and time zone',
    background: 'Background',
    areas: 'Areas',
    language: 'Language',
    mode: 'Meetings',
    editions: 'Editions',
    project_title: 'Project',
    project_area: 'Project area',
    project_abstract: 'Abstract',
    compute: 'Compute needed',
    interview: 'Interviews mentees',
    mentees: 'Mentees wanted',
    hours_mentee: 'Hours a week (mentee)',
    hours_mentor: 'Hours a week (mentor)',
    co_mentor: 'Co-mentor',
    applying_as: 'Applying as',
  };

  var ACTION_LABELS = {
    'view-person': 'opened the card',
    'view-note': 'read the notes',
    'set-status': 'changed',
    'add-note': 'added a note',
    'set-match': 'pairing',
    'site-draft': 'edited the website draft',
    export: 'copied the emails',
    denied: 'was refused',
  };

  var ICON_COPY =
    '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"></rect><path d="M3 10V4a1 1 0 0 1 1-1h6"></path></svg>';
  var ICON_PAGE =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3L8 8M7 4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9"></path></svg>';
  var ICON_CHEVRON =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"></path></svg>';

  // ── Small helpers ────────────────────────────────────────────────────────

  function personUrl(key, kind) {
    return '/app/crm/person/?key=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind);
  }

  /** A web address (https, or http/bare "www.x.y/..." upgraded to https), else null. */
  function linkOf(value) {
    var v = String(value || '').trim();
    if (/\s/.test(v)) return null;
    if (/^https:\/\/\S+$/i.test(v)) return v;
    if (/^http:\/\/\S+$/i.test(v)) return 'https://' + v.slice(7);
    return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(v) || /^www\.\S+\.\S+$/i.test(v)
      ? 'https://' + v
      : null;
  }

  function valueNode(value) {
    var link = linkOf(value);
    return link
      ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, value)
      : value;
  }

  function mailto(email) {
    return 'mailto:' + encodeURIComponent(email).replace(/%40/g, '@');
  }

  function slug(text) {
    return (
      String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'mentor'
    );
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (w) {
        return w.charAt(0).toUpperCase();
      })
      .join('');
  }

  /** Writes to the clipboard; `done` runs on success. */
  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        M.toast('Could not copy: select the text and copy it by hand', true);
      });
    } else {
      M.copy(text);
      done();
    }
  }

  function copyButton(label, text) {
    var span = h('span', null, label);
    var timer;
    var btn = h(
      'button',
      { type: 'button', class: 'crm-copy' },
      h('span', { html: ICON_COPY }),
      span
    );
    btn.addEventListener('click', function () {
      copyText(typeof text === 'function' ? text() : text, function () {
        span.textContent = 'Copied';
        btn.classList.add('is-done');
        clearTimeout(timer);
        timer = setTimeout(function () {
          span.textContent = label;
          btn.classList.remove('is-done');
        }, 1500);
      });
    });
    return btn;
  }

  function firstField(p, names) {
    for (var i = 0; i < p.sheets.length; i++) {
      for (var j = 0; j < names.length; j++) {
        if (p.sheets[i].fields[names[j]]) return p.sheets[i].fields[names[j]];
      }
    }
    return '';
  }

  var OPEN_KEY = 'crm-sections';
  function isOpen(name, dflt) {
    try {
      var saved = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
      if (name in saved) return Boolean(saved[name]);
    } catch (e) {
      /* the default is fine */
    }
    return dflt;
  }
  function rememberOpen(name, open) {
    try {
      var saved = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
      saved[name] = open;
      localStorage.setItem(OPEN_KEY, JSON.stringify(saved));
    } catch (e) {
      /* not remembered, still works */
    }
  }

  // ── The person ───────────────────────────────────────────────────────────

  function render(p, container, opts) {
    opts = opts || {};
    var page = opts.layout === 'page';
    var statuses = p.statuses || opts.statuses || [];
    var tracks = p.tracks || opts.tracks || [];
    var kindLabel = p.kind === 'mentor' ? 'Mentor' : 'Mentee';

    function statusLabel(key) {
      var s = statuses.filter(function (x) {
        return x.key === key;
      })[0];
      return s ? s.label : key;
    }
    function trackLabel(key) {
      var t = tracks.filter(function (x) {
        return x.key === key;
      })[0];
      return t ? t.label : 'No track yet';
    }

    // Stage, track and owner: saved at once, put back if the server refuses.
    function localUpdate(changes, quiet) {
      var before = { status: p.status, track: p.track, ownerId: p.ownerId, owner: p.owner };
      if (changes.status) p.status = changes.status;
      if ('track' in changes) p.track = changes.track;
      if (changes.owner) p.ownerId = changes.owner === 'me' ? opts.me : null;
      if (changes.owner === 'none') p.owner = null;
      api.sync(p);
      return M.api(
        'POST',
        API + '?action=update',
        Object.assign({ key: p.key, kind: p.kind }, changes)
      )
        .then(function (r) {
          if (r) {
            p.status = r.status;
            p.track = r.track;
            p.ownerId = r.ownerId;
            p.owner = r.owner;
          }
          api.sync(p);
          if (changes.status && !quiet) {
            M.toast(p.name + ' moved to ' + statusLabel(p.status), false, {
              label: 'Undo',
              run: function () {
                localUpdate({ status: before.status }, true);
              },
            });
          }
          if (opts.onChanged) opts.onChanged(p);
        })
        .catch(function (err) {
          Object.assign(p, before);
          api.sync(p);
          if (err.status === 401) M.appError(err);
          else M.toast(err.message, true);
        });
    }
    function change(changes) {
      return opts.change ? opts.change(p.key, p.kind, changes) : localUpdate(changes);
    }

    /** One button per stage; the pairing owns "Matched". */
    function stepper() {
      var locked = p.status === 'matched';
      return h(
        'div',
        { class: 'crm-steps', role: 'group', 'aria-label': 'Stage' },
        statuses.map(function (s) {
          var off = locked || (s.key === 'matched' && s.key !== p.status);
          return h(
            'button',
            {
              type: 'button',
              class: 'crm-step',
              style: '--crm-dot:var(--crm-st-' + s.key + ')',
              'aria-pressed': String(s.key === p.status),
              disabled: off ? true : null,
              title: off ? (locked ? 'End the pairing first' : 'Set by pairing') : null,
              onclick: function () {
                if (s.key !== p.status) change({ status: s.key });
              },
            },
            s.label
          );
        })
      );
    }

    var stageSlot = h('div', null, stepper());
    var eyebrowStage = h('span', null);
    var trackSelect = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Track' },
      [h('option', { value: '' }, 'As in the sheets')].concat(
        tracks.map(function (t) {
          return h('option', { value: t.key }, t.label);
        })
      )
    );
    trackSelect.value = p.track || '';
    trackSelect.addEventListener('change', function () {
      change({ track: trackSelect.value || null });
    });
    var ownerName = h('span', { class: 'crm-owner-name' });
    var ownerBtn = h('button', {
      type: 'button',
      class: 'btn btn-outline btn-sm',
      onclick: function () {
        change({ owner: p.ownerId && p.ownerId === opts.me ? 'none' : 'me' });
      },
    });

    var api = {
      /** The board changed this person's card: follow it. */
      sync: function (card) {
        p.status = card.status;
        p.track = card.track;
        p.ownerId = card.ownerId;
        p.owner = card.owner;
        M.clear(stageSlot).appendChild(stepper());
        eyebrowStage.textContent = statusLabel(p.status);
        trackSelect.value = p.track || '';
        ownerName.textContent = p.owner || 'Nobody yet';
        ownerBtn.textContent = p.ownerId && p.ownerId === opts.me ? 'Drop' : 'Take on';
      },
    };
    eyebrowStage.textContent = statusLabel(p.status);
    ownerName.textContent = p.owner || 'Nobody yet';
    ownerBtn.textContent = p.ownerId && p.ownerId === opts.me ? 'Drop' : 'Take on';

    var role = firstField(p, ['role', 'career']);
    var subtitle = [role, p.org].filter(Boolean).join(' · ');
    var ownerRow = h(
      'div',
      { class: 'crm-owner-line' },
      h('span', null, h('span', { class: 'crm-quiet' }, 'Followed by'), ' · ', ownerName),
      ownerBtn
    );
    var lockedNote =
      p.status === 'matched'
        ? h('p', { class: 'panel-note' }, 'Paired: end the pair (in Pairs) to move them by hand.')
        : null;

    // ── Sections ──
    var sections = [];
    p.sheets.forEach(function (s) {
      // The server joins first and last name into `name`: show it only alone.
      var names = Object.keys(s.fields).filter(function (f) {
        return f !== 'name' || !s.fields.first_name;
      });
      var removeBtn =
        s.origin === 'board' && s.recordId
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  if (!window.confirm('Remove ' + p.name + ' from the board?')) return;
                  M.api('POST', API + '?action=remove', { recordId: s.recordId })
                    .then(function () {
                      if (opts.onRemoved) opts.onRemoved();
                    })
                    .catch(function (err) {
                      if (err.status === 401) M.appError(err);
                      else M.toast(err.message, true);
                    });
                },
              },
              'Remove from the board'
            )
          : null;
      function row(f) {
        return h(
          'div',
          { class: 'crm-field' },
          h('div', { class: 'crm-field-label' }, FIELD_LABELS[f] || f),
          h('div', { class: 'crm-field-value' }, valueNode(s.fields[f]))
        );
      }
      var body;
      if (page) {
        var short = names.filter(function (f) {
          return s.fields[f].length <= 40 && s.fields[f].indexOf('\n') === -1;
        });
        body = h(
          'div',
          { class: 'crm-fields' },
          short.length ? h('div', { class: 'crm-fields-grid' }, short.map(row)) : null,
          names
            .filter(function (f) {
              return short.indexOf(f) === -1;
            })
            .map(row)
        );
      } else {
        body = h('div', { class: 'crm-fields' }, names.map(row));
      }
      sections.push({
        name: s.source,
        title: SOURCE_LABELS[s.source] || s.label,
        meta: ORIGIN_LABELS[s.origin],
        count: names.length,
        open: true,
        node: h('div', null, removeBtn, body),
      });
    });

    // Notes
    var noteInput = h('textarea', {
      class: 'form-input is-compact',
      rows: page ? '2' : '3',
      maxlength: '4000',
      placeholder: 'A note for the team (encrypted when stored)…',
      'aria-label': 'New note',
    });
    var noteBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          var text = noteInput.value.trim();
          if (!text) return;
          noteBtn.disabled = true;
          M.api('POST', API + '?action=note', { key: p.key, kind: p.kind, body: text })
            .then(function () {
              return M.api(
                'GET',
                API + '?key=' + encodeURIComponent(p.key) + '&kind=' + encodeURIComponent(p.kind)
              );
            })
            .then(function (fresh) {
              if (opts.onNoteAdded) opts.onNoteAdded(fresh);
              api.sync = render(fresh, container, opts).sync;
            })
            .catch(function (err) {
              noteBtn.disabled = false;
              if (err.status === 401) M.appError(err);
              else M.toast(err.message, true);
            });
        },
      },
      'Add note'
    );
    sections.push({
      name: 'notes',
      title: 'Notes',
      count: p.notes.length,
      open: true,
      node: h(
        'div',
        null,
        p.notes.length
          ? h(
              'ul',
              { class: 'crm-notes' },
              p.notes.map(function (n) {
                return h(
                  'li',
                  null,
                  h('p', null, n.body),
                  h('small', null, n.author + ' · ' + M.fmtDateTime(n.createdAt, 'Europe/Rome'))
                );
              })
            )
          : h('p', { class: 'panel-note' }, 'No notes yet.'),
        noteInput,
        h('div', { class: 'crm-note-actions' }, noteBtn)
      ),
    });

    // Pairing
    var pairs = (p.matches || []).filter(function (m) {
      return m.status === 'active';
    });
    var other = p.kind === 'mentor' ? 'mentee' : 'mentor';
    sections.push({
      name: 'pairing',
      title: 'Pairing',
      count: pairs.length,
      open: false,
      node: pairs.length
        ? h(
            'ul',
            { class: 'crm-pairing' },
            pairs.map(function (m) {
              var name = m.otherName || (opts.nameOf && opts.nameOf(m.otherKey, other));
              return h(
                'li',
                null,
                'Paired with ',
                h('a', { href: personUrl(m.otherKey, other) }, name || 'the ' + other),
                ' · ' + trackLabel(m.track) + ' · since ' + M.fmtDay(m.createdAt, 'Europe/Rome')
              );
            })
          )
        : h(
            'p',
            { class: 'panel-note' },
            'Not paired yet. Pair from the Pairs tab once they are selected.'
          ),
    });

    // History
    sections.push({
      name: 'history',
      title: 'History',
      count: p.history.length,
      open: false,
      node: p.history.length
        ? h(
            'ul',
            { class: 'activity-list' },
            p.history.map(function (a) {
              var what = ACTION_LABELS[a.action] || a.action;
              var d = a.detail || {};
              if (a.action === 'set-status' && d.to)
                what = 'moved ' + statusLabel(d.from) + ' → ' + statusLabel(d.to);
              else if (a.action === 'set-status' && d.owner)
                what = d.owner === 'me' ? 'took them on' : 'dropped them';
              else if (a.action === 'set-status' && 'track' in d)
                what = 'set the track: ' + trackLabel(d.track);
              else if (a.action === 'set-match')
                what =
                  (d.action === 'create' ? 'paired them' : 'ended the pair') +
                  ' (' +
                  trackLabel(d.track) +
                  ')';
              return h(
                'li',
                null,
                h('span', { class: 'activity-when' }, M.fmtDateTime(a.at, 'Europe/Rome')),
                h('span', null, h('strong', null, a.userName), ' ' + what)
              );
            })
          )
        : h('p', { class: 'panel-note' }, 'Nothing yet.'),
    });

    function head(s) {
      return [
        s.title,
        ' ',
        h('span', { class: 'crm-section-count' }, String(s.count)),
        s.meta ? h('span', { class: 'crm-section-meta' }, ' · ' + s.meta) : null,
      ];
    }

    function foldable(s) {
      var open = isOpen(s.name, s.open);
      var body = h('div', { class: 'crm-section-body', hidden: open ? null : true }, s.node);
      var btn = h(
        'button',
        {
          type: 'button',
          class: 'crm-fold',
          'aria-expanded': String(open),
          onclick: function () {
            open = !open;
            btn.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
            rememberOpen(s.name, open);
          },
        },
        h('span', null, head(s)),
        h('span', { class: 'crm-chevron', html: ICON_CHEVRON })
      );
      return h('section', { class: 'crm-fold-section' }, btn, body);
    }

    function card(s) {
      return h('section', { class: 'crm-card-box' }, h('h2', null, head(s)), s.node);
    }

    M.clear(container);
    var byName = {};
    sections.forEach(function (s) {
      byName[s.name] = s;
    });

    if (!page) {
      var chips = [];
      if (p.track) chips.push(h('span', { class: 'crm-chip-pill is-green' }, trackLabel(p.track)));
      var language = firstField(p, ['language']);
      var country = firstField(p, ['country']);
      if (language) chips.push(h('span', { class: 'crm-chip-pill' }, language));
      if (country) chips.push(h('span', { class: 'crm-chip-pill' }, country));
      container.appendChild(
        h(
          'div',
          { class: 'crm-pp' },
          h(
            'div',
            { class: 'crm-pp-head' },
            h(
              'div',
              { class: 'crm-pp-top' },
              h('span', { class: 'crm-eyebrow' }, kindLabel + ' · ', eyebrowStage),
              h(
                'span',
                { class: 'crm-pp-tools' },
                h('a', {
                  class: 'crm-iconlink',
                  href: personUrl(p.key, p.kind),
                  'aria-label': 'Open as a page',
                  title: 'Open as a page',
                  html: ICON_PAGE,
                }),
                opts.onClose
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'crm-iconlink',
                        'aria-label': 'Close',
                        onclick: opts.onClose,
                      },
                      '×'
                    )
                  : null
              )
            ),
            h(
              'div',
              null,
              h('h2', { class: 'crm-pp-name', id: 'personName' }, p.name),
              subtitle ? h('div', { class: 'crm-pp-sub' }, subtitle) : null
            ),
            p.email
              ? h(
                  'div',
                  { class: 'crm-emailbox' },
                  h('a', { href: mailto(p.email) }, p.email),
                  copyButton('Copy', p.email)
                )
              : null,
            chips.length ? h('div', { class: 'crm-chips-row' }, chips) : null
          ),
          h(
            'div',
            { class: 'crm-pp-body' },
            h(
              'div',
              { class: 'crm-pp-stage' },
              h('span', { class: 'crm-field-label' }, 'Stage'),
              stageSlot,
              lockedNote
            ),
            ownerRow,
            h(
              'label',
              { class: 'crm-pp-track' },
              h('span', { class: 'crm-quiet' }, 'Track'),
              trackSelect
            ),
            sections.map(foldable)
          )
        )
      );
      return api;
    }

    // The page: breadcrumb, header, two columns.
    var photo = h('div', { class: 'crm-avatar', 'aria-hidden': 'true' });
    function paintAvatar() {
      M.clear(photo);
      if (p.site && p.site.photo) photo.appendChild(h('img', { src: p.site.photo, alt: '' }));
      else photo.textContent = initials(p.name);
    }
    paintAvatar();
    var back = p.kind === 'mentor' ? '#mentors' : '#mentees';
    container.appendChild(
      h(
        'div',
        { class: 'crm-page' },
        h(
          'nav',
          { class: 'crm-crumbs', 'aria-label': 'Breadcrumb' },
          h('a', { href: '/app/crm/' + back }, 'Mentorship board'),
          h('span', { 'aria-hidden': 'true' }, '/'),
          h('a', { href: '/app/crm/' + back }, kindLabel + 's'),
          h('span', { 'aria-hidden': 'true' }, '/'),
          h('span', { 'aria-current': 'page' }, p.name)
        ),
        h(
          'header',
          { class: 'crm-page-head' },
          photo,
          h(
            'div',
            { class: 'crm-page-title' },
            h('h2', { id: 'personName' }, p.name),
            h(
              'span',
              null,
              [kindLabel, subtitle, p.track ? trackLabel(p.track) : ''].filter(Boolean).join(' · ')
            )
          ),
          h(
            'div',
            { class: 'crm-page-actions' },
            p.email ? copyButton('Copy email', p.email) : null,
            p.email
              ? h('a', { class: 'btn btn-outline btn-sm', href: mailto(p.email) }, 'Write')
              : null
          )
        ),
        h(
          'div',
          { class: 'crm-page-controls' },
          stageSlot,
          h('div', { class: 'crm-page-side' }, ownerRow, h('label', null, trackSelect)),
          lockedNote
        ),
        h(
          'div',
          { class: 'crm-cols' },
          h(
            'div',
            { class: 'crm-col-main' },
            sections
              .filter(function (s) {
                return s.name !== 'pairing' && s.name !== 'history';
              })
              .map(card)
          ),
          h(
            'div',
            { class: 'crm-col-side' },
            p.kind === 'mentor' && p.site ? siteBox(p, paintAvatar) : null,
            card(byName.pairing),
            card(byName.history)
          )
        )
      )
    );
    return api;
  }

  // ── On the website (mentors, page only) ──────────────────────────────────

  /** Cuts the middle square of an image and scales it to 400×400 JPEG. */
  function squarePhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error('That file is not an image'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = 400;
        canvas
          .getContext('2d')
          .drawImage(
            img,
            (img.naturalWidth - side) / 2,
            (img.naturalHeight - side) / 2,
            side,
            side,
            0,
            0,
            400,
            400
          );
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That image cannot be read'));
      };
      img.src = url;
    });
  }

  function siteBox(p, onPhoto) {
    var box = h('section', { class: 'crm-card-box crm-site' });
    var site = p.site;

    function save(body) {
      return M.api(
        'POST',
        API + '?action=site',
        Object.assign({ key: p.key, kind: 'mentor' }, body)
      )
        .then(function (r) {
          site = r;
          p.site = r;
          onPhoto();
          draw();
        })
        .catch(function (err) {
          if (err.status === 401) M.appError(err);
          else M.toast(err.status === 413 ? 'The photo is too large' : err.message, true);
          throw err;
        });
    }

    function draw() {
      M.clear(box);
      var consent = site.consent;
      var fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        squarePhoto(file)
          .then(function (data) {
            return save({ photo: data }).then(function () {
              M.toast('Photo saved');
            });
          })
          .catch(function (err) {
            if (!err.status) M.toast(err.message, true);
          });
      });
      var bio = h('textarea', {
        class: 'form-input',
        id: 'siteBio',
        rows: '5',
        maxlength: '1200',
        placeholder: 'Two or three lines for the mentorship page…',
      });
      bio.value = site.bio || '';
      var counter = h('span', { class: 'crm-quiet' });
      function count() {
        counter.textContent = bio.value.length + ' / 1200';
      }
      bio.addEventListener('input', count);
      count();
      var saveBtn = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          onclick: function () {
            saveBtn.disabled = true;
            save({ bio: bio.value.trim() })
              .then(function () {
                M.toast('Bio saved');
              })
              .catch(function () {
                saveBtn.disabled = false;
              });
          },
        },
        'Save bio'
      );

      box.appendChild(
        h(
          'div',
          { class: 'crm-site-head' },
          h('h2', null, 'On the website'),
          h(
            'span',
            { class: 'crm-chip-pill' + (site.entry ? ' is-green' : '') },
            site.entry ? 'Published' : 'Draft'
          )
        )
      );
      box.appendChild(
        h(
          'p',
          { class: 'crm-site-status' },
          'Consent to publish: ',
          h('strong', null, consent === 'yes' ? 'yes' : consent === 'no' ? 'no' : 'not asked'),
          ' · ',
          site.entry
            ? ['On the site: ', h('a', { href: site.entry.url }, 'open the entry')]
            : 'Not on the site yet'
        )
      );
      if (consent !== 'yes') {
        box.appendChild(
          h(
            'p',
            { class: 'crm-warn', role: 'note' },
            'Without a yes, do not publish anything about this person.'
          )
        );
      }
      box.appendChild(
        h(
          'div',
          { class: 'crm-photo-row' },
          site.photo
            ? h('img', { class: 'crm-photo', src: site.photo, alt: 'Photo of ' + p.name })
            : h('div', { class: 'crm-photo is-empty' }, 'No photo'),
          h(
            'div',
            { class: 'crm-photo-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  fileInput.click();
                },
              },
              site.photo ? 'Replace photo' : 'Upload a photo'
            ),
            site.photo
              ? h(
                  'a',
                  {
                    class: 'btn btn-outline btn-sm',
                    href: site.photo,
                    download: slug(p.name) + '.jpg',
                  },
                  'Download'
                )
              : null,
            site.photo
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-outline btn-sm',
                    onclick: function () {
                      save({ photo: null }).catch(function () {});
                    },
                  },
                  'Remove'
                )
              : null,
            fileInput
          )
        )
      );
      box.appendChild(h('label', { class: 'crm-field-label', for: 'siteBio' }, 'Short bio'));
      box.appendChild(bio);
      box.appendChild(
        h(
          'div',
          { class: 'crm-bio-row' },
          counter,
          h(
            'span',
            { class: 'crm-bio-actions' },
            copyButton('Copy bio', function () {
              return bio.value;
            }),
            saveBtn
          )
        )
      );
      if (site.updatedAt) {
        box.appendChild(
          h(
            'p',
            { class: 'crm-quiet crm-small' },
            'Last edited by ' +
              (site.updatedBy || 'someone') +
              ', ' +
              M.fmtDateTime(site.updatedAt, 'Europe/Rome')
          )
        );
      }
      box.appendChild(
        h(
          'p',
          { class: 'crm-quiet crm-small' },
          'Publishing still happens by adding the mentor to data/mentors.yaml.'
        )
      );
    }
    draw();
    return box;
  }

  window.CrmPerson = {
    render: render,
    personUrl: personUrl,
    copyText: copyText,
    SOURCE_LABELS: SOURCE_LABELS,
  };
})();
