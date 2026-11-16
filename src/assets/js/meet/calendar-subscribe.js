/* /app/calendar/subscribe/: the personal .ics link, what it carries, and
 * the reminders.
 *
 * What you follow, simple: one tick per calendar shows it on the dashboard
 * and puts it in the link. Per calendar: two switches each (dashboard, link),
 * with “all” and “none” per column. Going back to simple merges them, after
 * asking.
 * Reminders, per calendar: the event's (its organiser's: off, or on and on
 * which channel) and one's own (when and how, for each of its events).
 * Every change saves itself (server/calendars.js, savePrefs). */
(function () {
  'use strict';
  var M = window.Meet;
  var Cal = window.Cal;
  var h = M.h;

  var linkBody = document.getElementById('subLinkBody');
  var pickBody = document.getElementById('subPickBody');
  var savedEl = document.getElementById('subSaved');
  var modeNote = document.getElementById('subModeNote');
  var prefs = null;
  var saveTimer = null;
  var saving = Promise.resolve();

  var COLUMNS = [
    { key: 'dashboard', label: 'Dashboard', help: 'shown on the calendar page here' },
    { key: 'ics', label: 'Calendar link', help: 'in your Google, Outlook or Apple calendar' },
  ];
  var remBody = document.getElementById('subRemBody');

  function origin() {
    return window.location.origin;
  }

  function feedUrl() {
    return origin() + '/calendar/feed/' + prefs.feedToken + '.ics';
  }

  function webcal(url) {
    return url.replace(/^https?:\/\//, 'webcal://');
  }

  // ── The link ────────────────────────────────────────────────────────────

  function addButtons(url, name) {
    return h(
      'div',
      { class: 'cal-sub-apps' },
      h(
        'a',
        {
          class: 'cal-app-btn',
          href: 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal(url)),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        h('span', { class: 'cal-app-ico is-google', 'aria-hidden': 'true' }, 'G'),
        h(
          'span',
          null,
          h('strong', null, 'Google Calendar'),
          h('small', null, 'Opens Google, then “Add”')
        )
      ),
      h(
        'a',
        {
          class: 'cal-app-btn',
          href:
            'https://outlook.live.com/calendar/0/addfromweb?url=' +
            encodeURIComponent(url) +
            '&name=' +
            encodeURIComponent(name),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        h('span', { class: 'cal-app-ico is-outlook', 'aria-hidden': 'true' }, 'O'),
        h(
          'span',
          null,
          h('strong', null, 'Outlook'),
          h('small', null, 'Outlook.com or Microsoft 365')
        )
      ),
      h(
        'a',
        { class: 'cal-app-btn', href: webcal(url) },
        h('span', {
          class: 'cal-app-ico is-apple',
          'aria-hidden': 'true',
          html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
        }),
        h(
          'span',
          null,
          h('strong', null, 'Apple & others'),
          h('small', null, 'Opens your calendar app')
        )
      )
    );
  }

  function copyField(url) {
    var input = h('input', {
      class: 'form-input is-compact cal-copy-input',
      readonly: true,
      value: url,
      'aria-label': 'Calendar link',
      onfocus: function (e) {
        e.target.select();
      },
    });
    return h(
      'div',
      { class: 'cal-copy' },
      input,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          onclick: function () {
            M.copy(url, 'Link copied');
          },
        },
        'Copy'
      )
    );
  }

  function drawLink() {
    M.clear(linkBody);
    if (!prefs.feedToken) {
      linkBody.appendChild(
        h(
          'p',
          { class: 'form-note' },
          'The shared admin account has no calendar of its own: sign in with Discord to get your link.'
        )
      );
      return;
    }
    var url = feedUrl();
    linkBody.appendChild(
      h('p', { class: 'cal-step' }, h('span', null, '1'), 'Add it to your calendar app')
    );
    linkBody.appendChild(addButtons(url, 'AI Safety for Italy'));
    linkBody.appendChild(
      h(
        'p',
        { class: 'cal-step' },
        h('span', null, '2'),
        'Or copy the link and paste it as “From URL”'
      )
    );
    linkBody.appendChild(copyField(url));
    linkBody.appendChild(
      h(
        'div',
        { class: 'cal-sub-foot' },
        h(
          'p',
          { class: 'form-note' },
          'The link is yours: whoever has it sees what you see. Google reads it again every 12–24 hours, Outlook and Apple more often, so changes take a while to arrive there.'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: regenerate,
          },
          'Make a new link'
        )
      )
    );
  }

  function regenerate() {
    if (
      !window.confirm(
        'Make a new link? The old one stops working at once: you will need to add the new one to your calendar app again.'
      )
    )
      return;
    M.api('POST', Cal.API + '?action=regenerate-feed', {})
      .then(function (p) {
        prefs = p;
        drawLink();
        M.toast('New link ready: add it to your calendar app');
      })
      .catch(M.appError);
  }

  // ── What is followed ────────────────────────────────────────────────────

  function mode() {
    return prefs.advanced ? 'advanced' : 'simple';
  }

  function setSaved(text) {
    savedEl.textContent = text;
    savedEl.classList.toggle('is-on', Boolean(text));
  }

  function selection() {
    var out = {};
    prefs.calendars.forEach(function (c) {
      out[c.id] = {
        dashboard: c.choice.dashboard,
        ics: prefs.advanced ? c.choice.ics : c.choice.dashboard,
        // The reminders: chosen per calendar, in either mode.
        notify: Boolean(c.choice.notify),
        via: c.choice.via || null,
        own: c.choice.own || [],
      };
    });
    return out;
  }

  /** Saves a moment after the last change, one save at a time. */
  function save() {
    setSaved('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var body = { advanced: prefs.advanced, notify: prefs.notify, selection: selection() };
      saving = saving
        .then(function () {
          return M.api('POST', Cal.API + '?action=save-prefs', body);
        })
        .then(function () {
          setSaved('✓ Saved · your calendar app follows at its next read');
        })
        .catch(function (err) {
          setSaved('');
          M.appError(err);
        });
    }, 500);
  }

  function toggle(input, onChange) {
    input.addEventListener('change', function () {
      onChange(input.checked);
      save();
    });
    return input;
  }

  function nameCell(c) {
    return h(
      'span',
      { class: 'cal-sub-name' },
      h('span', { class: 'cal-dot', style: 'background:' + c.color, 'aria-hidden': 'true' }),
      h('span', { class: 'cal-sub-label' }, c.name),
      Cal.levelBadge(c.level)
    );
  }

  function simpleView() {
    var wrap = h('div', { class: 'cal-sub-simple' });
    var list = h('div', { class: 'cal-sub-list' });
    prefs.calendars.forEach(function (c) {
      var input = h('input', {
        type: 'checkbox',
        class: 'cal-check-input',
        style: '--cal-color:' + c.color,
      });
      input.checked = c.choice.dashboard;
      toggle(input, function (on) {
        c.choice.dashboard = on;
        c.choice.ics = on;
        drawCount();
      });
      list.appendChild(
        h(
          'label',
          { class: 'cal-sub-row' },
          input,
          nameCell(c),
          c.system ? h('span', { class: 'cal-tag' }, 'Site') : null
        )
      );
    });
    var count = h('span', { class: 'cal-sub-count' });
    function drawCount() {
      var n = prefs.calendars.filter(function (c) {
        return c.choice.dashboard;
      }).length;
      count.textContent = n + ' of ' + prefs.calendars.length + ' calendars, here and in your link';
    }
    drawCount();
    var bulk = function (on) {
      return function () {
        prefs.calendars.forEach(function (c) {
          c.choice.dashboard = on;
          c.choice.ics = on;
        });
        draw();
        save();
      };
    };
    wrap.appendChild(
      h(
        'div',
        { class: 'cal-sub-bar' },
        count,
        h(
          'span',
          { class: 'cal-sub-bulk' },
          h(
            'button',
            { type: 'button', class: 'btn btn-outline btn-sm', onclick: bulk(true) },
            'All'
          ),
          h(
            'button',
            { type: 'button', class: 'btn btn-outline btn-sm', onclick: bulk(false) },
            'None'
          )
        )
      )
    );
    wrap.appendChild(list);

    return wrap;
  }

  function advancedView() {
    var table = h('div', {
      class: 'cal-sub-table',
      role: 'table',
      'aria-label': 'What each calendar does',
    });
    var head = h(
      'div',
      { class: 'cal-sub-trow is-head', role: 'row' },
      h('span', { role: 'columnheader' }, 'Calendar')
    );
    COLUMNS.forEach(function (col) {
      var allOn = prefs.calendars.every(function (c) {
        return c.choice[col.key];
      });
      head.appendChild(
        h(
          'span',
          { role: 'columnheader', class: 'cal-sub-col' },
          h('span', { title: col.help }, col.label),
          h(
            'button',
            {
              type: 'button',
              class: 'cal-sub-colbtn',
              onclick: function () {
                prefs.calendars.forEach(function (c) {
                  c.choice[col.key] = !allOn;
                });
                draw();
                save();
              },
            },
            allOn ? 'None' : 'All'
          )
        )
      );
    });
    table.appendChild(head);
    prefs.calendars.forEach(function (c) {
      var r = h(
        'div',
        { class: 'cal-sub-trow', role: 'row' },
        h('span', { role: 'cell' }, nameCell(c))
      );
      COLUMNS.forEach(function (col) {
        var input = h('input', {
          type: 'checkbox',
          role: 'switch',
          class: 'fe-switch-input',
          'aria-label': col.label + ': ' + c.name,
        });
        input.checked = c.choice[col.key];
        toggle(input, function (on) {
          c.choice[col.key] = on;
        });
        r.appendChild(
          h('span', { role: 'cell', class: 'cal-sub-col', 'data-label': col.label }, input)
        );
      });
      table.appendChild(r);
    });
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'cal-sub-legend' },
        COLUMNS.map(function (col) {
          return h('span', null, h('strong', null, col.label), ' ', col.help);
        })
      ),
      table
    );
  }

  function draw() {
    document.querySelector('input[name="subMode"][value="' + mode() + '"]').checked = true;
    modeNote.textContent = prefs.advanced
      ? 'Each calendar on its own: on the dashboard, in your link, with reminders.'
      : 'Tick the calendars you follow: they show here and in your link together.';
    M.clear(pickBody);
    if (!prefs.calendars.length) {
      pickBody.appendChild(h('p', { class: 'form-note' }, 'No calendar is shared with you yet.'));
      return;
    }
    pickBody.appendChild(prefs.advanced ? advancedView() : simpleView());
    drawReminders();
  }

  // ── Reminders ────────────────────────────────────────────────────────────

  function drawReminders() {
    M.clear(remBody);
    var list = h('div', { class: 'cal-rem-list' });
    prefs.calendars.forEach(function (c) {
      var takes = h(
        'select',
        {
          class: 'form-input is-compact',
          'aria-label': 'The event’s reminders: ' + c.name,
          onchange: function () {
            c.choice.notify = takes.value !== 'off';
            c.choice.via = takes.value === 'off' || takes.value === '' ? null : takes.value;
            save();
          },
        },
        h('option', { value: 'off' }, 'Off'),
        Cal.VIA.map(function (v) {
          return h('option', { value: v[0] }, v[1]);
        })
      );
      takes.value = c.choice.notify ? c.choice.via || '' : 'off';
      var own = Cal.ownReminders({
        value: c.choice.own || [],
        onChange: function (value) {
          c.choice.own = value;
          save();
        },
      });
      list.appendChild(
        h(
          'div',
          { class: 'cal-rem-row' },
          h('div', { class: 'cal-rem-cal' }, nameCell(c)),
          h('label', { class: 'cal-rem-field' }, h('span', null, 'The event’s reminders'), takes),
          h('div', { class: 'cal-rem-field' }, h('span', null, 'Your own'), own.el)
        )
      );
    });
    remBody.appendChild(list);
  }

  /** Whether the per-calendar choices would change on going back to simple. */
  function wouldMerge() {
    return prefs.calendars.some(function (c) {
      var on = c.choice.dashboard || c.choice.ics;
      return c.choice.dashboard !== c.choice.ics && on;
    });
  }

  document.querySelectorAll('input[name="subMode"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var advanced = r.value === 'advanced';
      if (advanced === prefs.advanced) return;
      if (!advanced && wouldMerge()) {
        var ok = window.confirm(
          'Back to simple: a calendar on in the dashboard or in your link stays on in both. Your reminders do not change. Go on?'
        );
        if (!ok) {
          draw();
          return;
        }
        prefs.calendars.forEach(function (c) {
          var on = c.choice.dashboard || c.choice.ics;
          c.choice.dashboard = on;
          c.choice.ics = on;
        });
      }
      prefs.advanced = advanced;
      draw();
      save();
    });
  });

  function drawPublic() {
    var list = prefs.calendars.filter(function (c) {
      return c.isPublic;
    });
    var box = document.getElementById('subPublic');
    box.hidden = !list.length;
    var el = M.clear(document.getElementById('subPublicList'));
    list.forEach(function (c) {
      var url = origin() + '/calendar/' + c.slug + '.ics';
      el.appendChild(
        h(
          'div',
          { class: 'cal-public-row' },
          h(
            'span',
            { class: 'cal-sub-name' },
            h('span', { class: 'cal-dot', style: 'background:' + c.color }),
            h('strong', null, c.name)
          ),
          copyField(url)
        )
      );
    });
  }

  M.clear(linkBody).appendChild(M.loading());
  M.me
    .then(function () {
      return M.api('GET', Cal.API + '?prefs=1');
    })
    .then(function (p) {
      prefs = p;
      drawLink();
      draw();
      drawPublic();
    })
    .catch(function (err) {
      M.clear(linkBody).appendChild(h('p', { class: 'form-note' }, err.message));
      M.appError(err);
    });
})();
