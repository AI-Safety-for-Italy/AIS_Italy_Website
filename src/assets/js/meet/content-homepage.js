/* /app/content/homepage/: the banners above every page and the boxes beside
 * the home page hero (server/highlights.js). Each one has its switch: what
 * is off stays here, off the site. One save sends them all and rebuilds the
 * site. A box for an event or a seminar can start from one already
 * published (/api/app/content). */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var API = '/api/app/highlights';

  var form = document.getElementById('hlForm');
  var formState = document.getElementById('formState');
  var bannersBox = document.getElementById('banners');
  var spotsBox = document.getElementById('spotlights');
  var formError = document.getElementById('formError');
  var saveBtn = document.getElementById('saveBtn');
  var saveNote = document.getElementById('saveNote');

  var data = null; // { banners, spotlights, updatedAt, updatedBy, limits }
  var dirty = false;
  var upcoming = { event: null, seminar: null }; // the published ones, once asked
  var previewLang = 'en';
  var previews = []; // [{ box, render }]: redrawn on every change

  var KIND_LABELS = {
    mentorship: 'Mentorship',
    event: 'Event',
    seminar: 'Seminar',
    other: 'Other',
  };

  // What a new box starts with: the buttons it usually has.
  var TEMPLATES = {
    mentorship: {
      label: 'Open call',
      label_it: 'Call aperta',
      meta: 'Free · Online · 12 weeks',
      meta_it: 'Gratuito · Online · 12 settimane',
      title: 'AI Safety for Italy Mentorship Program',
      title_it: 'Programma di mentorship AI Safety for Italy',
      details_text: 'Tracks, requirements and key dates →',
      details_text_it: 'Percorsi, requisiti e date principali →',
      details_link: '/mentorship/',
      primary_text: 'Apply as a mentee',
      primary_text_it: 'Candidati come mentee',
      primary_link: '/form/?f=candidatura-mentee',
      secondary_text: 'Explore the mentors',
      secondary_text_it: 'Scopri i mentor',
      secondary_link: '/mentorship/#mentors',
    },
    event: {
      label: 'Next event',
      label_it: 'Prossimo evento',
      details_text: 'All the events →',
      details_text_it: 'Tutti gli eventi →',
      details_link: '/events/',
    },
    seminar: {
      label: 'Next seminar',
      label_it: 'Prossimo seminario',
      details_text: 'All the seminars →',
      details_text_it: 'Tutti i seminari →',
      details_link: '/seminars/',
    },
    other: {},
  };

  function changed() {
    dirty = true;
    saveNote.textContent = 'Not saved yet.';
    refreshPreviews();
  }

  // ── Previews: the same markup and classes as the site (header.njk,
  // index.njk), in the language picked at the top. ─────────────────────────

  function tx(obj, key) {
    return (previewLang === 'it' && obj[key + '_it']) || obj[key] || '';
  }

  function external(link) {
    return /:\/\//.test(link || '') ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  }

  function linkTo(href, cls, text) {
    var attrs = Object.assign({ class: cls, href: href || '#' }, external(href));
    return h('a', attrs, text);
  }

  function bannerPreview(b) {
    return h(
      'div',
      { class: 'announce-bar hl-banner-preview' },
      h(
        'div',
        { class: 'announce-viewport' },
        h(
          'p',
          { class: 'announce-item is-current' },
          h('span', { class: 'announce-dot', 'aria-hidden': 'true' }),
          h('span', null, tx(b, 'text') || 'The banner text'),
          b.link ? linkTo(b.link, '', tx(b, 'link_text')) : null
        )
      )
    );
  }

  function spotPreview(s) {
    var top = h(
      'div',
      { class: 'event-card-top' },
      h(
        'span',
        { class: 'mono-label red live-label' },
        h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
        h('span', null, tx(s, 'label') || 'Label')
      ),
      s.meta ? h('span', { class: 'mono-label' }, tx(s, 'meta')) : null
    );
    var head = h(
      'div',
      { class: 'event-card-head' },
      s.day
        ? h(
            'span',
            { class: 'date-badge', 'aria-hidden': 'true' },
            h('span', { class: 'date-badge-month' }, tx(s, 'month')),
            h('span', { class: 'date-badge-day' }, s.day)
          )
        : null,
      h(
        'div',
        null,
        h('h2', null, tx(s, 'title') || 'Title'),
        (s.lines || []).map(function (l) {
          return tx(l, 'text') ? h('p', { class: 'event-card-when' }, tx(l, 'text')) : null;
        })
      )
    );
    var body = h(
      'div',
      { class: 'event-card-body' },
      top,
      head,
      s.summary ? h('p', { class: 'event-card-summary' }, tx(s, 'summary')) : null,
      s.notice ? h('p', { class: 'note-orange' }, tx(s, 'notice')) : null,
      s.details_link ? linkTo(s.details_link, 'text-link', tx(s, 'details_text')) : null
    );
    var actions =
      s.primary_link || s.secondary_link
        ? h(
            'div',
            { class: 'event-card-actions' },
            s.primary_link
              ? linkTo(s.primary_link, 'event-card-primary', tx(s, 'primary_text'))
              : null,
            s.secondary_link
              ? linkTo(s.secondary_link, 'event-card-secondary', tx(s, 'secondary_text'))
              : null
          )
        : null;
    return h('article', { class: 'event-card' }, body, actions);
  }

  /** A preview box for one item; drawn now and on every change. */
  function preview(obj, render, what) {
    var box = h('div', { class: 'hl-preview' + (obj.on ? '' : ' is-off') });
    var entry = {
      box: box,
      render: function () {
        M.clear(box);
        box.className = 'hl-preview' + (obj.on ? '' : ' is-off');
        box.appendChild(
          h(
            'span',
            { class: 'hl-preview-label' },
            obj.on ? 'Preview' : 'Preview: off, not on the site'
          )
        );
        box.appendChild(render(obj));
      },
    };
    entry.render();
    previews.push(entry);
    return h('div', { class: 'hl-preview-wrap hl-preview-' + what }, box);
  }

  function refreshPreviews() {
    previews.forEach(function (p) {
      if (document.body.contains(p.box)) p.render();
    });
  }

  document.querySelectorAll('#previewLang button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      previewLang = btn.getAttribute('data-lang');
      document.querySelectorAll('#previewLang button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      refreshPreviews();
    });
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Fields ──────────────────────────────────────────────────────────────

  /** An input bound to obj[key]; `path` names it for the server's errors. */
  function field(obj, key, label, path, opts) {
    opts = opts || {};
    var attrs = {
      class: 'form-input is-compact' + (opts.long ? ' is-short' : ''),
      id: 'f-' + path.replace(/\./g, '-'),
      'data-field': path,
      value: obj[key] || '',
      placeholder: opts.placeholder || '',
      oninput: function (e) {
        obj[key] = e.target.value;
        changed();
        if (opts.onInput) opts.onInput();
      },
    };
    var input = opts.long ? h('textarea', attrs, obj[key] || '') : h('input', attrs);
    return h(
      'div',
      { class: 'hl-field' + (opts.wide ? ' is-wide' : '') },
      h('label', { class: 'form-label', for: attrs.id }, label),
      input
    );
  }

  /** The English and Italian versions of one text, side by side. */
  function pair(obj, key, label, path, opts) {
    return [
      field(obj, key, label, path + '.' + key, opts),
      field(obj, key + '_it', label + ' (Italian)', path + '.' + key + '_it', opts),
    ];
  }

  function onSwitch(obj, label) {
    var input = h('input', {
      type: 'checkbox',
      role: 'switch',
      class: 'fe-switch-input',
      checked: obj.on ? true : null,
      onchange: function (e) {
        obj.on = e.target.checked;
        changed();
        draw();
      },
    });
    input.checked = Boolean(obj.on);
    return h('label', { class: 'fe-switch hl-switch' }, h('span', null, label), input);
  }

  /** Move up, move down, remove: on the list the item is in. */
  function tools(list, i, what) {
    function move(by) {
      var j = i + by;
      var item = list.splice(i, 1)[0];
      list.splice(j, 0, item);
      changed();
      draw();
    }
    return h(
      'span',
      { class: 'hl-tools' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          'aria-label': 'Move up',
          title: 'Move up',
          disabled: i === 0 ? true : null,
          onclick: function () {
            move(-1);
          },
        },
        '↑'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          'aria-label': 'Move down',
          title: 'Move down',
          disabled: i === list.length - 1 ? true : null,
          onclick: function () {
            move(1);
          },
        },
        '↓'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger-outline btn-sm',
          onclick: function () {
            if (!window.confirm('Remove this ' + what + '? It goes once you save.')) return;
            list.splice(i, 1);
            changed();
            draw();
          },
        },
        'Remove'
      )
    );
  }

  // ── Banners ─────────────────────────────────────────────────────────────

  function bannerItem(b, i) {
    var path = 'banners.' + i;
    return h(
      'div',
      { class: 'hl-item' + (b.on ? ' is-on' : '') },
      h(
        'div',
        { class: 'hl-item-head' },
        h('strong', null, 'Banner ' + (i + 1)),
        h(
          'span',
          { class: 'badge ' + (b.on ? 'badge-open' : 'badge-closed') },
          b.on ? 'On the site' : 'Off'
        ),
        onSwitch(b, 'On'),
        tools(data.banners, i, 'banner')
      ),
      preview(b, bannerPreview, 'banner'),
      h(
        'div',
        { class: 'hl-grid' },
        pair(b, 'text', 'Text', path, { wide: true }),
        field(b, 'link', 'Link', path + '.link', {
          placeholder: '/mentorship/ or https://…',
          wide: true,
        }),
        pair(b, 'link_text', 'Link text', path)
      )
    );
  }

  // ── Spotlight ───────────────────────────────────────────────────────────

  function lineFields(s, path) {
    s.lines = s.lines || [];
    var box = h('div', { class: 'hl-lines is-wide' });
    function drawLines() {
      M.clear(box);
      box.appendChild(h('span', { class: 'form-label' }, 'Lines under the title (dates, place)'));
      s.lines.forEach(function (line, j) {
        box.appendChild(
          h(
            'div',
            { class: 'hl-line' },
            field(line, 'text', 'Line ' + (j + 1), path + '.lines.' + j + '.text'),
            field(line, 'text_it', 'Italian', path + '.lines.' + j + '.text_it'),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                'aria-label': 'Remove line ' + (j + 1),
                onclick: function () {
                  s.lines.splice(j, 1);
                  changed();
                  drawLines();
                },
              },
              '×'
            )
          )
        );
      });
      if (s.lines.length < data.limits.lines) {
        box.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              onclick: function () {
                s.lines.push({ text: '', text_it: '' });
                changed();
                drawLines();
              },
            },
            '+ Add a line'
          )
        );
      }
    }
    drawLines();
    return box;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_IT = [
    'Gen',
    'Feb',
    'Mar',
    'Apr',
    'Mag',
    'Giu',
    'Lug',
    'Ago',
    'Set',
    'Ott',
    'Nov',
    'Dic',
  ];

  function plain(markdown) {
    var s = String(markdown || '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_#>`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > 300 ? s.slice(0, 297).replace(/\s+\S*$/, '') + '…' : s;
  }

  /** Fills a box from a published event or seminar. */
  function fillFrom(s, id) {
    return M.api('GET', '/api/app/content?id=' + encodeURIComponent(id)).then(function (item) {
      var f = item.form;
      var day = new Date(f.day + 'T12:00:00');
      var when = function (lang) {
        var d = day.toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        return f.time ? d + (lang === 'it' ? ', ore ' : ', ') + f.time : d;
      };
      s.title = f.title;
      s.title_it = f.title_it;
      s.day = String(day.getDate());
      s.month = MONTHS[day.getMonth()];
      s.month_it = MONTHS_IT[day.getMonth()];
      s.lines = [{ text: when('en'), text_it: when('it') }];
      if (f.speaker) {
        s.lines.push({
          text: 'With ' + f.speaker + (f.speaker_affiliation ? ', ' + f.speaker_affiliation : ''),
          text_it: 'Con ' + f.speaker + (f.speaker_affiliation ? ', ' + f.speaker_affiliation : ''),
        });
      }
      s.summary = plain(f.description_md);
      s.summary_it = plain(f.description_md_it);
      if (f.register_link) {
        s.primary_text = f.register_text || 'Register';
        s.primary_text_it = f.register_text_it || 'Iscriviti';
        s.primary_link = f.register_link;
      }
      changed();
      draw();
    });
  }

  function fillPicker(s) {
    if (s.kind !== 'event' && s.kind !== 'seminar') return null;
    var list = upcoming[s.kind];
    if (!list || !list.length) return null;
    var select = h(
      'select',
      {
        class: 'form-input is-compact',
        'aria-label': 'Fill from a published ' + s.kind,
        onchange: function (e) {
          if (!e.target.value) return;
          if (s.title && !window.confirm('Replace what this box says with that ' + s.kind + '?')) {
            e.target.value = '';
            return;
          }
          fillFrom(s, e.target.value).catch(M.appError);
        },
      },
      h('option', { value: '' }, 'Fill from a published ' + s.kind + '…'),
      list.map(function (i) {
        return h('option', { value: i.id }, M.fmtDayIso(i.day) + ' · ' + i.title);
      })
    );
    return h('div', { class: 'hl-fill' }, select);
  }

  function spotItem(s, i) {
    var path = 'spotlights.' + i;
    return h(
      'div',
      { class: 'hl-item' + (s.on ? ' is-on' : '') },
      h(
        'div',
        { class: 'hl-item-head' },
        h('strong', null, s.title || 'New box'),
        h('span', { class: 'badge badge-scheduled' }, KIND_LABELS[s.kind] || 'Other'),
        h(
          'span',
          { class: 'badge ' + (s.on ? 'badge-open' : 'badge-closed') },
          s.on ? 'On the site' : 'Off'
        ),
        onSwitch(s, 'On'),
        tools(data.spotlights, i, 'box')
      ),
      fillPicker(s),
      h(
        'div',
        { class: 'hl-body' },
        h(
          'div',
          { class: 'hl-grid' },
          pair(s, 'label', 'Label (red, top left)', path, { placeholder: 'Open call' }),
          pair(s, 'meta', 'Top right', path, { placeholder: 'Free · Online' }),
          pair(s, 'title', 'Title', path),
          lineFields(s, path),
          pair(s, 'summary', 'Summary', path, { long: true }),
          pair(s, 'notice', 'Notice (orange, optional)', path),
          h(
            'div',
            { class: 'hl-date is-wide' },
            field(s, 'day', 'Calendar badge: day', path + '.day', { placeholder: '5' }),
            field(s, 'month', 'Month', path + '.month', { placeholder: 'Dec' }),
            field(s, 'month_it', 'Month (Italian)', path + '.month_it', { placeholder: 'Dic' })
          ),
          h('h4', { class: 'hl-sub is-wide' }, 'Link under the text'),
          pair(s, 'details_text', 'Text', path),
          field(s, 'details_link', 'Link', path + '.details_link', { wide: true }),
          h('h4', { class: 'hl-sub is-wide' }, 'Buttons'),
          pair(s, 'primary_text', 'First button (dark)', path),
          field(s, 'primary_link', 'First button: link', path + '.primary_link', {
            wide: true,
            placeholder: '/form/?f=… or https://…',
          }),
          pair(s, 'secondary_text', 'Second button', path),
          field(s, 'secondary_link', 'Second button: link', path + '.secondary_link', {
            wide: true,
          })
        ),
        preview(s, spotPreview, 'spot')
      )
    );
  }

  // ── The page ────────────────────────────────────────────────────────────

  function draw() {
    previews = [];
    M.clear(bannersBox);
    M.clear(spotsBox);
    data.banners.forEach(function (b, i) {
      bannersBox.appendChild(bannerItem(b, i));
    });
    if (!data.banners.length)
      bannersBox.appendChild(h('p', { class: 'panel-note' }, 'No banners.'));
    data.spotlights.forEach(function (s, i) {
      spotsBox.appendChild(spotItem(s, i));
    });
    if (!data.spotlights.length) spotsBox.appendChild(h('p', { class: 'panel-note' }, 'No boxes.'));
    document.getElementById('addBanner').disabled = data.banners.length >= data.limits.banners;
    document.getElementById('addSpotlight').disabled =
      data.spotlights.length >= data.limits.spotlights;
  }

  function savedNote() {
    saveNote.textContent = data.updatedBy
      ? 'Last saved by ' + data.updatedBy + ', ' + M.fmtWhen(data.updatedAt) + '.'
      : 'As the site shows them now. Saving updates the site in about 3 minutes.';
  }

  document.getElementById('addBanner').addEventListener('click', function () {
    if (data.banners.length >= data.limits.banners) return;
    data.banners.push({ on: false, text: '', text_it: '' });
    changed();
    draw();
    var last = bannersBox.querySelector('.hl-item:last-child input:not([type=checkbox])');
    if (last) last.focus();
  });

  document.getElementById('addSpotlight').addEventListener('click', function () {
    if (data.spotlights.length >= data.limits.spotlights) return;
    var kind = document.getElementById('addKind').value;
    var t = TEMPLATES[kind] || {};
    var s = { on: false, kind: kind, lines: [] };
    Object.keys(t).forEach(function (k) {
      s[k] = t[k];
    });
    data.spotlights.push(s);
    changed();
    draw();
    var items = spotsBox.querySelectorAll('.hl-item');
    if (items.length)
      items[items.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formError.hidden = true;
    saveBtn.disabled = true;
    M.api('PUT', API, {
      banners: data.banners,
      spotlights: data.spotlights,
      updatedAt: data.updatedAt,
    })
      .then(function (saved) {
        data.banners = saved.banners;
        data.spotlights = saved.spotlights;
        data.updatedAt = saved.updatedAt;
        data.updatedBy = saved.updatedBy;
        dirty = false;
        draw();
        savedNote();
        M.toast(M.publishNote({ build: saved.build }));
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        formError.textContent = err.message;
        formError.hidden = false;
        var input = err.field && form.querySelector('[data-field="' + err.field + '"]');
        if (input) {
          input.focus();
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      })
      .then(function () {
        saveBtn.disabled = false;
      });
  });

  /** The events and seminars still to come, to fill a box from. */
  function loadUpcoming(perms) {
    var today = new Date().toISOString().slice(0, 10);
    ['event', 'seminar'].forEach(function (type) {
      if (perms.indexOf(type) === -1) return;
      M.api('GET', '/api/app/content?type=' + type)
        .then(function (r) {
          upcoming[type] = r.items.filter(function (i) {
            return !i.deleted && i.day >= today;
          });
          if (data) draw();
        })
        .catch(function () {
          /* no list: the boxes are filled by hand */
        });
    });
  }

  formState.appendChild(M.loading());
  Promise.all([M.api('GET', API), M.permissions])
    .then(function (r) {
      data = r[0];
      M.clear(formState);
      form.hidden = false;
      draw();
      savedNote();
      loadUpcoming(r[1]);
    })
    .catch(function (err) {
      M.clear(formState);
      if (err.status === 403) {
        formState.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'No access'),
            h('p', null, 'Your roles do not include “Banners & spotlight”.')
          )
        );
        return;
      }
      M.appError(err);
    });
})();
