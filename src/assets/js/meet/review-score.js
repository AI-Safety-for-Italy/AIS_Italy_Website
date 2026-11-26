/* /app/review/: the mentee selection, for a reviewer.
 *   #prescreen   the pre-screening, when the admins set one: a few answers
 *                (where someone lives, works) and one decision, pass or
 *                exclude with a reason, taken for every reviewer. Who is
 *                excluded there never reaches the sections.
 *   #<section>   the sections of the setup given to me (say the CV and the
 *                answers), each scored apart under its own code
 * The applications may still be coming in: every list puts what is left to
 * do first, those that came in since my last visit are marked New, and a
 * banner on top says how many there are.
 * The sections as tabs on top, then a bar to move between the applications
 * (previous, next, and every code in a panel that opens on demand, so the
 * list takes no room while reading). Below, the application on the left and,
 * on the right, my scores, which stay in view while I read and save as I go:
 * the criteria (grouped by question when each question has its own grid),
 * the reasons to exclude the section offers, a comment, stepping aside.
 * A link (a CV, a profile) opens in a viewer over the page, with buttons to
 * open it in a window of its own or a new tab; a site known to refuse being
 * shown inside another (LinkedIn, GitHub…) opens straight in a window, which
 * is the browser's own, signed in where I am.
 * Everything comes from /api/app/crm/review, which never sends a name or a
 * person key to a reviewer. What the applicants wrote goes on the page as
 * text (h() makes text nodes), never as HTML. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/review';
  var root = document.getElementById('rvPage');

  var view = {
    part: null,
    overview: null,
    list: null,
    open: null,
    app: null,
    filter: 'all',
    newsSeen: false, // the banner closed, for this page
  };

  var PRESCREEN = 'prescreen';

  function screening() {
    return view.part === PRESCREEN;
  }

  function sections() {
    return (view.overview && view.overview.sections) || [];
  }

  function sectionOf(key) {
    return (
      sections().filter(function (s) {
        return s.key === key;
      })[0] || null
    );
  }

  function partOfHash() {
    var p = decodeURIComponent(window.location.hash.replace('#', ''));
    if (sectionOf(p)) return p;
    return sections().length ? sections()[0].key : null;
  }

  // What a reviewer is told when the admins wrote nothing for a section.
  function noteOf(section) {
    if (section.note) return section.note;
    return section.anonymous
      ? 'Names, emails, links and phone numbers are taken out. If you recognise the person anyway, step aside.'
      : 'This section is not anonymous. Score on the merits, and step aside if you know the person.';
  }

  function empty(title, text, extra) {
    M.clear(root);
    root.appendChild(
      h('div', { class: 'empty-state' }, h('h3', null, title), h('p', null, text), extra)
    );
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      return empty(err.status === 403 ? 'No access' : 'Not set up yet', err.message);
    }
    M.appError(err);
  }

  // The first call only: refused there, they are no reviewer at all. Someone
  // who interviews but does not review has the interviews for a page.
  function failFirst(err) {
    if (err.status !== 403) return fail(err);
    return M.areas.then(function (areas) {
      if (areas && areas.interviews) window.location.replace('/app/review/interviews/');
      else fail(err);
    });
  }

  // ── Saving as I go ───────────────────────────────────────────────────────
  // Each change is sent shortly after it is made (a comment once typing
  // pauses). Moving to another application, or another section, first waits
  // for what is still being sent; leaving the page with something unsent asks.

  var saver = {
    timer: null,
    inflight: null, // the request being sent, a promise
    again: false, // changed while being sent: send once more after
    dirty: false,
    error: null,
    savedAt: null,
  };

  M.unsaved(function () {
    return saver.dirty || Boolean(saver.inflight) || Boolean(saver.error);
  });

  function schedule(delay) {
    saver.dirty = true;
    saver.error = null;
    showSaveState();
    clearTimeout(saver.timer);
    saver.timer = setTimeout(send, delay);
  }

  /** Sends the review of the open application now. Resolves once saved. */
  function send() {
    clearTimeout(saver.timer);
    saver.timer = null;
    if (saver.inflight) {
      saver.again = true;
      return saver.inflight;
    }
    if (!saver.dirty || !draft) return Promise.resolve();
    var app = view.app;
    var body = {
      part: app.part,
      code: app.code,
      scores: draft.conflict ? {} : draft.scores,
      conflict: draft.conflict,
      flags: draft.flags,
      comment: draft.comment,
    };
    saver.dirty = false;
    showSaveState('saving');
    saver.inflight = M.api('POST', API + '?action=score', body)
      .then(function (r) {
        saver.savedAt = new Date();
        setState(app.code, r.state);
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        saver.dirty = true;
        if (err.status === 409) {
          // The setup changed while the page was open: draw the new grid,
          // keeping what I gave on what is still in it, and send that.
          M.toast(err.message);
          return reloadKeeping(body).catch(function (e) {
            saver.error = e.message;
          });
        }
        saver.error = err.message;
      })
      .then(function () {
        saver.inflight = null;
        showSaveState();
        if (saver.again) {
          saver.again = false;
          return send();
        }
      });
    return saver.inflight;
  }

  /** Waits for what is being saved; if it cannot be saved, asks before going on. */
  function flush() {
    return send().then(function () {
      if (!saver.error) return true;
      return window.confirm(
        'Your last change could not be saved (' + saver.error + '). Go on anyway?'
      );
    });
  }

  function showSaveState(now) {
    var el = root.querySelector('.rv-save-state');
    if (!el) return;
    var text;
    var cls = '';
    if (now === 'saving' || saver.inflight) text = 'Saving…';
    else if (saver.error) {
      text = 'Not saved: ' + saver.error;
      cls = ' is-error';
    } else if (saver.dirty) text = 'Unsaved…';
    else if (saver.savedAt) text = 'Saved ' + M.fmtTime(saver.savedAt.toISOString());
    else if (view.app && view.app.mine && view.app.mine.updatedAt)
      text = 'Last saved ' + M.fmtDateTime(view.app.mine.updatedAt);
    else text = 'Saved as you go';
    el.className = 'rv-save-state' + cls;
    el.textContent = text;
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function start() {
    M.clear(root).appendChild(M.loading());
    var first = M.api('GET', API).catch(function (err) {
      err.first = true;
      throw err;
    });
    Promise.all([M.me, first])
      .then(function (r) {
        view.overview = r[1];
        view.part = partOfHash();
        if (!view.overview.reviewer) {
          return empty(
            'You are not a reviewer',
            'Only the reviewers score the applications.',
            view.overview.admin
              ? h(
                  'p',
                  null,
                  h('a', { href: '/app/review/settings/' }, 'Add yourself to the reviewers'),
                  ' to score, or read the ',
                  h('a', { href: '/app/review/summary/' }, 'summary'),
                  '.'
                )
              : null
          );
        }
        if (!view.part) {
          return empty(
            'Nothing to score',
            'No section of the selection is given to you: the admins choose who scores what.'
          );
        }
        return loadList();
      })
      .catch(function (err) {
        return err.first ? failFirst(err) : fail(err);
      });
  }

  function loadList() {
    return M.api('GET', API + '?part=' + view.part).then(function (list) {
      view.list = list;
      view.open = null;
      view.app = null;
      draft = null;
      render();
      var next = firstTodo();
      openItem(next ? next.code : list.items.length ? list.items[0].code : null);
    });
  }

  var TODO = ['todo', 'partial', 'update'];

  // The next step's word, in the pre-screening or a section.
  function verb() {
    return screening() ? 'screen' : 'score';
  }

  function firstTodo(after) {
    var items = view.list.items;
    var from = 0;
    if (after) {
      items.forEach(function (it, i) {
        if (it.code === after) from = i + 1;
      });
    }
    var rest = items.slice(from).concat(items.slice(0, from));
    return (
      rest.filter(function (it) {
        return TODO.indexOf(it.state) !== -1 && it.code !== after;
      })[0] || null
    );
  }

  function go(code) {
    if (!code || code === view.open) return;
    flush().then(function (ok) {
      if (ok) openItem(code);
    });
  }

  window.addEventListener('hashchange', function () {
    if (partOfHash() === view.part) return;
    flush().then(function (ok) {
      if (ok) start();
      else history.replaceState(null, '', '#' + view.part);
    });
  });

  // ── The page ─────────────────────────────────────────────────────────────

  var navEl, mainEl, panelEl, pickerEl;

  function counts() {
    var done = view.list.items.filter(function (it) {
      return TODO.indexOf(it.state) === -1;
    }).length;
    return { done: done, total: view.list.items.length };
  }

  function setState(code, state) {
    if (!view.list) return;
    view.list.items.forEach(function (it) {
      if (it.code === code) it.state = state;
    });
    if (view.app && view.app.code === code) view.app.state = state;
    renderNav();
    renderPicker();
    var pill = root.querySelector('.rv-panel-head .rv-pill');
    if (pill) {
      pill.className = 'rv-pill rv-tone is-' + state;
      pill.textContent = stateLabel(state);
    }
  }

  var STATE = {
    todo: 'To score',
    partial: 'Half done',
    update: 'New criterion',
    done: 'Scored',
    conflict: 'Stepped aside',
    excluded: 'Excluded',
    passed: 'Passed',
  };

  function stateLabel(state) {
    return screening() && state === 'todo' ? 'To screen' : STATE[state];
  }

  // The sections given to me, with how far I am in each.
  function sectionTabs() {
    return h(
      'nav',
      { class: 'fr-views rv-sections', 'aria-label': 'Sections' },
      sections().map(function (s) {
        var current = s.key === view.part;
        return h(
          'a',
          {
            href: '#' + encodeURIComponent(s.key),
            'aria-current': current ? 'page' : null,
          },
          s.label,
          h('small', null, ' ' + (current ? counts().done : s.done) + '/' + s.total),
          s.fresh
            ? h(
                'span',
                { class: 'rv-new-count', title: s.fresh + ' new since your last visit' },
                '+' + s.fresh
              )
            : null
        );
      })
    );
  }

  function indexOfOpen() {
    var at = -1;
    view.list.items.forEach(function (it, i) {
      if (it.code === view.open) at = i;
    });
    return at;
  }

  // The bar: previous, the code (opens every code), next, and how far I am.
  function renderNav() {
    if (!navEl) return;
    M.clear(navEl);
    var items = view.list.items;
    var at = indexOfOpen();
    var c = counts();
    var tab = root.querySelector('.rv-sections a[aria-current] small');
    if (tab) tab.textContent = ' ' + c.done + '/' + c.total;
    var current = at === -1 ? null : items[at];
    navEl.appendChild(
      h(
        'div',
        { class: 'rv-nav-moves' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm rv-icon-btn',
            'aria-label': 'Previous application',
            title: 'Previous (←)',
            disabled: at <= 0 ? true : null,
            onclick: function () {
              go(items[at - 1].code);
            },
          },
          '‹'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'rv-nav-current',
            'aria-expanded': pickerEl && !pickerEl.hidden ? 'true' : 'false',
            'aria-controls': 'rvPicker',
            onclick: function (e) {
              e.stopPropagation();
              togglePicker();
            },
          },
          h('span', { class: 'rv-code' }, current ? current.code : '—'),
          current && current.fresh ? h('span', { class: 'rv-new-tag' }, 'New') : null,
          h('small', null, items.length ? at + 1 + ' of ' + items.length : ''),
          h('span', { class: 'rv-caret', 'aria-hidden': 'true' }, '▾')
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm rv-icon-btn',
            'aria-label': 'Next application',
            title: 'Next (→)',
            disabled: at === -1 || at >= items.length - 1 ? true : null,
            onclick: function () {
              go(items[at + 1].code);
            },
          },
          '›'
        )
      )
    );
    navEl.appendChild(
      h(
        'div',
        { class: 'rv-progress' },
        h('span', null, h('strong', null, String(c.done)), ' of ' + c.total + ' done'),
        h(
          'span',
          { class: 'rv-bar', 'aria-hidden': 'true' },
          h('span', { style: 'width:' + (c.total ? (100 * c.done) / c.total : 0) + '%' })
        )
      )
    );
  }

  // Every code, as small tiles, in a panel under the bar.
  var FILTERS = [
    ['all', 'All'],
    ['todo', 'To do'],
    ['finished', 'Done'],
  ];

  function renderPicker() {
    if (!pickerEl) return;
    M.clear(pickerEl);
    var shown = view.list.items.filter(function (it) {
      if (view.filter === 'todo') return TODO.indexOf(it.state) !== -1;
      if (view.filter === 'finished') return TODO.indexOf(it.state) === -1;
      return true;
    });
    pickerEl.appendChild(
      h(
        'div',
        { class: 'rv-picker-head' },
        h(
          'div',
          { class: 'fr-views rv-seg', role: 'radiogroup', 'aria-label': 'Show' },
          FILTERS.map(function (f) {
            return h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(view.filter === f[0]),
                'aria-selected': String(view.filter === f[0]),
                onclick: function (e) {
                  e.stopPropagation();
                  view.filter = f[0];
                  renderPicker();
                },
              },
              f[1]
            );
          })
        ),
        h(
          'span',
          { class: 'rv-legend' },
          (screening()
            ? ['todo', 'passed', 'excluded']
            : ['todo', 'partial', 'done', 'excluded', 'conflict']
          )
            .map(function (s) {
              return h('span', { class: 'rv-legend-item rv-tone is-' + s }, stateLabel(s));
            })
            .concat(h('span', { class: 'rv-legend-item rv-legend-new' }, 'New'))
        )
      )
    );
    pickerEl.appendChild(
      shown.length
        ? h(
            'div',
            { class: 'rv-tiles', role: 'list' },
            shown.map(function (it) {
              return h(
                'button',
                {
                  type: 'button',
                  role: 'listitem',
                  class:
                    'rv-tile-code rv-tone is-' +
                    it.state +
                    (it.fresh ? ' is-fresh' : '') +
                    (it.code === view.open ? ' is-selected' : ''),
                  title:
                    stateLabel(it.state) +
                    (it.by ? ' by ' + it.by : '') +
                    (it.fresh ? ' · new since your last visit' : ''),
                  'aria-current': it.code === view.open ? 'true' : null,
                  onclick: function () {
                    closePicker();
                    go(it.code);
                  },
                },
                it.code
              );
            })
          )
        : h('p', { class: 'panel-note rv-pad' }, 'Nothing here.')
    );
  }

  function togglePicker() {
    if (pickerEl.hidden) {
      pickerEl.hidden = false;
      renderPicker();
      var sel = pickerEl.querySelector('.is-selected');
      if (sel) sel.focus();
    } else closePicker();
    renderNav();
  }

  function closePicker() {
    if (!pickerEl || pickerEl.hidden) return;
    pickerEl.hidden = true;
    renderNav();
  }

  document.addEventListener('click', function (e) {
    if (pickerEl && !pickerEl.hidden && !pickerEl.contains(e.target)) closePicker();
  });

  document.addEventListener('keydown', function (e) {
    // The viewer closes on Esc by itself; while open, the arrows are its own.
    if (viewerOpen()) return;
    if (e.key === 'Escape') return closePicker();
    // ← and → move between applications, unless typing.
    var t = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (
      t &&
      (t.tagName === 'TEXTAREA' ||
        (t.tagName === 'INPUT' && t.type !== 'radio' && t.type !== 'checkbox'))
    )
      return;
    if (t && t.type === 'radio') return; // arrows move between the scores
    if (!view.list || !view.list.items.length) return;
    var at = indexOfOpen();
    if (e.key === 'ArrowLeft' && at > 0) go(view.list.items[at - 1].code);
    if (e.key === 'ArrowRight' && at !== -1 && at < view.list.items.length - 1)
      go(view.list.items[at + 1].code);
  });

  // What came in since my last visit, while the applications are open.
  function newsBanner() {
    var news = view.overview.news;
    if (!news || !news.count || view.newsSeen) return null;
    var el = h(
      'div',
      { class: 'rv-news', role: 'status' },
      h('span', { class: 'rv-news-dot', 'aria-hidden': 'true' }),
      h(
        'p',
        null,
        h(
          'strong',
          null,
          news.count === 1 ? '1 new application' : news.count + ' new applications'
        ),
        ' since your last visit (' + M.fmtDateTime(news.since) + '), marked ',
        h('span', { class: 'rv-new-tag' }, 'New'),
        ' in the lists.'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'rv-news-close',
          'aria-label': 'Close',
          onclick: function () {
            view.newsSeen = true;
            el.remove();
          },
        },
        '×'
      )
    );
    return el;
  }

  function render() {
    M.clear(root);
    var banner = newsBanner();
    if (banner) root.appendChild(banner);
    navEl = h('div', { class: 'rv-nav' });
    pickerEl = h('div', { class: 'rv-picker', id: 'rvPicker', hidden: true });
    mainEl = h('div', { class: 'rv-main' });
    panelEl = h('aside', {
      class: 'rv-panel',
      'aria-label': screening() ? 'Your decision' : 'Your scores',
    });
    if (sections().length > 1) root.appendChild(sectionTabs());
    root.appendChild(h('div', { class: 'rv-navwrap' }, navEl, pickerEl));
    root.appendChild(h('div', { class: 'rv-layout' }, mainEl, panelEl));
    renderNav();
    renderDetail();
  }

  // ── One application ──────────────────────────────────────────────────────

  var draft = null;

  function openItem(code) {
    view.open = code;
    view.app = null;
    draft = null;
    saver.savedAt = null;
    saver.error = null;
    renderNav();
    renderPicker();
    if (!code) return renderDetail();
    M.clear(mainEl).appendChild(M.loading());
    M.clear(panelEl);
    M.api('GET', API + '?part=' + view.part + '&code=' + encodeURIComponent(code))
      .then(function (app) {
        if (view.open !== code) return;
        view.app = app;
        setDraft(app);
        renderDetail();
        window.scrollTo({ top: 0 });
      })
      .catch(function (err) {
        if (err.status === 404) {
          M.toast(err.message);
          return loadList();
        }
        fail(err);
      });
  }

  function setDraft(app) {
    var mine = app.mine || { scores: {}, conflict: false, comment: '', flags: [] };
    draft = {
      scores: Object.assign({}, mine.scores),
      conflict: Boolean(mine.conflict),
      flags: (mine.flags || []).slice(),
      comment: mine.comment || '',
    };
  }

  // The page fell behind the setup (a criterion or a reason changed): read
  // the application again, keep what I gave on what is still there, send it.
  function reloadKeeping(body) {
    return M.api('GET', API + '?part=' + body.part + '&code=' + encodeURIComponent(body.code)).then(
      function (app) {
        if (view.open !== body.code) return;
        view.app = app;
        var keys = app.grid.map(function (c) {
          return c.key;
        });
        var reasons = (app.section.exclusions || []).map(function (r) {
          return r.key;
        });
        draft = {
          scores: {},
          conflict: body.conflict,
          flags: body.flags.filter(function (k) {
            return reasons.indexOf(k) !== -1;
          }),
          comment: body.comment,
        };
        Object.keys(body.scores).forEach(function (k) {
          if (keys.indexOf(k) !== -1) draft.scores[k] = body.scores[k];
        });
        renderDetail();
        saver.dirty = true;
        saver.again = true;
      }
    );
  }

  // ── Links: a viewer over the page, or a window of their own ──────────────

  // Sites that refuse to be shown inside another (X-Frame-Options or CSP
  // frame-ancestors): they open straight in a window.
  var NO_FRAME = [
    'linkedin.com',
    'github.com',
    'gitlab.com',
    'scholar.google.com',
    'x.com',
    'twitter.com',
    'facebook.com',
    'instagram.com',
    'researchgate.net',
    'academia.edu',
    'orcid.org',
    'notion.so',
    'notion.site',
  ];

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function framable(url) {
    var host = hostOf(url);
    if (!host) return false;
    // A page over plain http inside this https one is blocked by the browser.
    if (/^http:/i.test(url) && window.location.protocol === 'https:') return false;
    if (/^scholar\.google\./.test(host)) return false;
    return !NO_FRAME.some(function (d) {
      return host === d || host.slice(-(d.length + 1)) === '.' + d;
    });
  }

  /**
   * The address to show in the viewer: Google Drive and Docs, and Dropbox,
   * have a preview made to be shown inside another page.
   */
  function embedUrl(url) {
    var m = url.match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/);
    if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    m = url.match(/^https:\/\/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]+)/);
    if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    m = url.match(
      /^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/
    );
    if (m) return 'https://docs.google.com/' + m[1] + '/d/' + m[2] + '/preview';
    if (/^https:\/\/(www\.)?dropbox\.com\//.test(url)) {
      var u = new URL(url);
      u.searchParams.delete('dl');
      u.searchParams.set('raw', '1');
      return u.href;
    }
    return url;
  }

  function isPdf(url) {
    try {
      return /\.pdf$/i.test(new URL(url).pathname);
    } catch (e) {
      return false;
    }
  }

  /** Opens a link in a window of its own, beside the page: the browser's, signed in. */
  function openWindow(url) {
    var w = Math.min(1100, Math.round(window.screen.availWidth * 0.7));
    var ht = Math.min(900, Math.round(window.screen.availHeight * 0.85));
    var left = Math.round((window.screen.availWidth - w) / 2);
    var top = Math.round((window.screen.availHeight - ht) / 2);
    var win = window.open(
      url,
      'rvLink',
      'popup,width=' + w + ',height=' + ht + ',left=' + left + ',top=' + top
    );
    if (win) {
      // The page opened never reaches back into this one.
      try {
        win.opener = null;
      } catch (e) {
        /* already cut */
      }
      win.focus();
    } else {
      // Popups blocked: a new tab, then.
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  var viewer = null;

  function closeViewer() {
    if (viewer && viewer.open) viewer.close();
  }

  function viewerOpen() {
    return Boolean(viewer && viewer.open);
  }

  /** Shows a link in the viewer over the page, or in a window when it cannot be shown there. */
  function openLink(url, label) {
    if (!framable(url)) return openWindow(url);
    if (!viewer) {
      viewer = h('dialog', { class: 'rv-viewer', 'aria-label': 'Link' });
      viewer.addEventListener('click', function (e) {
        // A click on the backdrop closes it.
        if (e.target === viewer) closeViewer();
      });
      viewer.addEventListener('close', function () {
        // Nothing keeps loading once it is closed.
        var frame = viewer.querySelector('iframe');
        if (frame) frame.src = 'about:blank';
      });
      document.body.appendChild(viewer);
    }
    M.clear(viewer);
    var src = embedUrl(url);
    var frame = h('iframe', {
      class: 'rv-viewer-frame',
      src: src,
      title: label,
      referrerpolicy: 'no-referrer',
      // Kept from steering this page; a PDF is left out of the sandbox,
      // where Chrome, Brave and Edge refuse to show it.
      sandbox: isPdf(src)
        ? null
        : 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
      allow: 'fullscreen',
    });
    viewer.append(
      h(
        'div',
        { class: 'rv-viewer-bar' },
        h('strong', null, label),
        h('span', { class: 'rv-viewer-host' }, hostOf(url)),
        h(
          'span',
          { class: 'rv-viewer-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              title: 'Not showing? Some sites refuse to be shown inside another page',
              onclick: function () {
                closeViewer();
                openWindow(url);
              },
            },
            'Open in a window'
          ),
          h(
            'a',
            {
              class: 'btn btn-outline btn-sm',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              onclick: closeViewer,
            },
            'New tab ↗'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm rv-ghost rv-viewer-close',
              'aria-label': 'Close (Esc)',
              title: 'Close (Esc)',
              onclick: closeViewer,
            },
            '×'
          )
        )
      ),
      h(
        'p',
        { class: 'rv-viewer-hint' },
        'Blank, refused, or asking you to sign in? The site does not allow being shown here, or your browser does not share your sign-in with pages shown inside others (Brave, Safari, Firefox): ',
        h(
          'button',
          {
            type: 'button',
            class: 'rv-link-btn',
            onclick: function () {
              closeViewer();
              openWindow(url);
            },
          },
          'open it in a window'
        ),
        '.'
      ),
      frame
    );
    viewer.showModal();
    frame.focus();
  }

  // One answer: a link to open, or the text as written (scrubbed when the
  // section is anonymous). With one grid per question, a mark of how many of
  // its criteria I scored, which takes me to them.
  // One link of an answer: its text as written, to read or copy, and the
  // buttons to open it; a piece that is no link says so.
  function linkRow(link, label) {
    var text = h('code', { class: 'rv-link-text' }, link.text);
    if (!link.url) {
      return h(
        'li',
        { class: 'rv-link-row is-broken' },
        text,
        h('span', { class: 'rv-link-host' }, 'not a link: copy it to check')
      );
    }
    var inside = framable(link.url);
    return h(
      'li',
      { class: 'rv-link-row' },
      text,
      h(
        'span',
        { class: 'rv-link-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            title: inside ? 'Open here, over the page' : 'Open in a window beside the page',
            onclick: function () {
              openLink(link.url, label);
            },
          },
          inside ? 'View' : 'View in a window'
        ),
        h(
          'a',
          {
            class: 'btn btn-outline btn-sm',
            href: link.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'New tab ↗'
        )
      )
    );
  }

  function renderItem(item, criteria) {
    var body;
    var links = item.links || [];
    var rows = links.length
      ? h(
          'ul',
          { class: 'rv-links' },
          links.map(function (l) {
            return linkRow(l, item.label);
          })
        )
      : null;
    if (item.onlyLinks) {
      body = rows;
    } else if (item.text.trim()) {
      body = [h('span', { class: 'rv-answer-text' }, item.text), rows];
    } else {
      body = h('span', { class: 'panel-note' }, 'No answer');
    }
    var mark = null;
    if (criteria && criteria.length) {
      var given = criteria.filter(function (c) {
        return Number.isInteger(draft.scores[c.key]);
      }).length;
      mark = h(
        'button',
        {
          type: 'button',
          class: 'rv-q-mark' + (given === criteria.length ? ' is-done' : ''),
          'data-q-mark': item.id,
          onclick: function () {
            var target = panelEl.querySelector('[data-q="' + item.id + '"]');
            if (target) {
              target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              var first = target.querySelector('input');
              if (first) first.focus({ preventScroll: true });
            }
          },
        },
        given + '/' + criteria.length + ' scored'
      );
    }
    return [
      h('dt', { id: 'rvq-' + item.id }, h('span', null, item.label), mark),
      h('dd', null, body),
    ];
  }

  function renderApplication(app) {
    var byQuestion = {};
    app.grid.forEach(function (c) {
      if (!c.question) return;
      (byQuestion[c.question] = byQuestion[c.question] || []).push(c);
    });
    var list = app.items.length
      ? h(
          'dl',
          { class: 'rv-answers' },
          app.items.map(function (item) {
            return renderItem(item, byQuestion[item.id]);
          })
        )
      : h('p', { class: 'panel-note' }, 'Nothing to show in this section.');
    return h(
      'article',
      { class: 'rv-card' },
      h(
        'div',
        { class: 'rv-card-head' },
        h('h2', null, app.code),
        h('p', { class: 'panel-note' }, noteOf(app.section))
      ),
      list
    );
  }

  function scaleRow(criterion) {
    var name = 'rv-' + criterion.key.replace(/\./g, '-');
    var options = [];
    var value = draft.scores[criterion.key];
    for (var n = view.app.scale.min; n <= view.app.scale.max; n++) {
      (function (n) {
        var input = h('input', {
          type: 'radio',
          name: name,
          value: String(n),
          disabled: draft.conflict ? true : null,
          onchange: function () {
            draft.scores[criterion.key] = n;
            row.classList.add('is-scored');
            refreshMarks();
            schedule(400);
          },
        });
        input.checked = value === n;
        options.push(
          h('label', { class: 'rv-dot', title: String(n) }, input, h('span', null, String(n)))
        );
      })(n);
    }
    var clear = h(
      'button',
      {
        type: 'button',
        class: 'rv-clear',
        title: 'Clear this score',
        'aria-label': 'Clear the score of ' + criterion.label,
        hidden: Number.isInteger(value) ? null : true,
        onclick: function () {
          delete draft.scores[criterion.key];
          row.querySelectorAll('input').forEach(function (i) {
            i.checked = false;
          });
          row.classList.remove('is-scored');
          clear.hidden = true;
          refreshMarks();
          schedule(400);
        },
      },
      '×'
    );
    var row = h(
      'fieldset',
      { class: 'rv-criterion' + (Number.isInteger(value) ? ' is-scored' : '') },
      h(
        'legend',
        null,
        h('strong', null, criterion.label),
        criterion.weight !== 1 && criterion.weight !== undefined
          ? h('span', { class: 'rv-weight-tag', title: 'Weight' }, '×' + criterion.weight)
          : null
      ),
      criterion.help ? h('small', { class: 'rv-help' }, criterion.help) : null,
      h('div', { class: 'rv-scale' }, options, clear)
    );
    row.addEventListener('change', function () {
      clear.hidden = false;
    });
    return row;
  }

  // The "n/m scored" marks next to the questions follow the scores.
  function refreshMarks() {
    var byQuestion = {};
    view.app.grid.forEach(function (c) {
      if (!c.question) return;
      (byQuestion[c.question] = byQuestion[c.question] || []).push(c);
    });
    mainEl.querySelectorAll('[data-q-mark]').forEach(function (el) {
      var list = byQuestion[el.getAttribute('data-q-mark')] || [];
      var given = list.filter(function (c) {
        return Number.isInteger(draft.scores[c.key]);
      }).length;
      el.textContent = given + '/' + list.length + ' scored';
      el.classList.toggle('is-done', given === list.length);
    });
  }

  // ── The pre-screening's decision ─────────────────────────────────────────

  function decide(app, decision, reasons, button) {
    if (button) button.disabled = true;
    return M.api('POST', API + '?action=prescreen', {
      code: app.code,
      decision: decision,
      reasons: reasons || [],
    })
      .then(function (r) {
        if (view.app !== app) return;
        app.decision = r.decision;
        app.state = r.state;
        setState(app.code, r.state);
        view.list.items.forEach(function (it) {
          if (it.code === app.code) it.by = r.decision ? r.decision.by : null;
        });
        if (decision === null) {
          renderDetail();
          return;
        }
        // Decided: on to the next one left.
        var to = firstTodo(app.code);
        if (to) openItem(to.code);
        else {
          M.toast('Nothing left to pre-screen');
          renderDetail();
        }
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
        if (err.status === 409) return openItem(app.code);
        if (button) button.disabled = false;
      });
  }

  function renderScreenPanel(app) {
    var d = app.decision;
    var ticked = d && d.decision === 'exclude' ? d.reasons.slice() : [];
    var exclude = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm rv-btn-exclude',
        disabled: ticked.length ? null : true,
        onclick: function () {
          decide(app, 'exclude', ticked, exclude);
        },
      },
      'Exclude'
    );
    var reasons = h(
      'div',
      { class: 'rv-exclude' },
      h('span', { class: 'rv-sub-title' }, 'Exclude, because…'),
      (app.section.exclusions || []).map(function (r) {
        var box = h('input', {
          type: 'checkbox',
          onchange: function () {
            if (box.checked) {
              if (ticked.indexOf(r.key) === -1) ticked.push(r.key);
            } else {
              ticked = ticked.filter(function (k) {
                return k !== r.key;
              });
            }
            row.classList.toggle('is-on', box.checked);
            exclude.disabled = !ticked.length;
          },
        });
        box.checked = ticked.indexOf(r.key) !== -1;
        var row = h(
          'label',
          { class: 'check-row rv-flag-row' + (box.checked ? ' is-on' : '') },
          box,
          h('span', null, r.label)
        );
        return row;
      }),
      h('div', null, exclude)
    );
    var pass = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary rv-btn-pass',
        onclick: function () {
          decide(app, 'pass', [], pass);
        },
      },
      '✓ Passes'
    );
    var status = d
      ? h(
          'p',
          { class: 'rv-decided rv-tone is-' + app.state },
          h('strong', null, d.decision === 'pass' ? 'Passed' : 'Excluded'),
          ' by ' + d.by + ', ' + M.fmtDateTime(d.at),
          d.decision === 'exclude' && d.reasonLabels.length
            ? ': ' + d.reasonLabels.join(', ')
            : null,
          ' · ',
          h(
            'button',
            {
              type: 'button',
              class: 'rv-link-btn',
              onclick: function () {
                decide(app, null);
              },
            },
            'Undo'
          )
        )
      : null;
    var next = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline btn-sm',
        onclick: function () {
          var to = firstTodo(app.code);
          if (to) openItem(to.code);
          else M.toast('Nothing left to pre-screen');
        },
      },
      'Skip to the next →'
    );
    return [
      h(
        'div',
        { class: 'rv-panel-head' },
        h('strong', { class: 'rv-code' }, app.code),
        h('span', { class: 'rv-pill rv-tone is-' + app.state }, stateLabel(app.state))
      ),
      h(
        'div',
        { class: 'rv-panel-body' },
        h(
          'p',
          { class: 'rv-scale-note' },
          'One decision for every reviewer: who is excluded here is shown in no section.'
        ),
        status,
        pass,
        reasons
      ),
      h('div', { class: 'rv-panel-foot' }, next),
    ];
  }

  function renderPanel(app) {
    if (app.part === PRESCREEN) return renderScreenPanel(app);
    var labels = {};
    app.items.forEach(function (it) {
      labels[it.id] = it.label;
    });

    // The criteria, for the whole section or grouped by question.
    var grid = h('div', { class: 'rv-grid' });
    var groups = [];
    app.grid.forEach(function (c) {
      var g = groups[groups.length - 1];
      if (!g || g.question !== (c.question || null)) {
        g = { question: c.question || null, list: [] };
        groups.push(g);
      }
      g.list.push(c);
    });
    groups.forEach(function (g) {
      if (!g.question) {
        g.list.forEach(function (c) {
          grid.appendChild(scaleRow(c));
        });
        return;
      }
      grid.appendChild(
        h(
          'div',
          { class: 'rv-group', 'data-q': g.question },
          h(
            'a',
            {
              class: 'rv-group-title',
              href: '#rvq-' + g.question,
              onclick: function (e) {
                e.preventDefault();
                var q = document.getElementById('rvq-' + g.question);
                if (q) q.scrollIntoView({ block: 'start', behavior: 'smooth' });
              },
            },
            labels[g.question] || g.question
          ),
          g.list.map(scaleRow)
        )
      );
    });

    // The reasons to exclude, if the section has any.
    var reasons = (app.section.exclusions || []).length
      ? h(
          'div',
          { class: 'rv-exclude' },
          h('span', { class: 'rv-sub-title' }, 'Exclude'),
          app.section.exclusions.map(function (r) {
            var box = h('input', {
              type: 'checkbox',
              onchange: function () {
                if (box.checked) {
                  if (draft.flags.indexOf(r.key) === -1) draft.flags.push(r.key);
                } else {
                  draft.flags = draft.flags.filter(function (k) {
                    return k !== r.key;
                  });
                }
                row.classList.toggle('is-on', box.checked);
                schedule(200);
              },
            });
            box.checked = draft.flags.indexOf(r.key) !== -1;
            var row = h(
              'label',
              { class: 'check-row rv-flag-row' + (box.checked ? ' is-on' : '') },
              box,
              h('span', null, r.label)
            );
            return row;
          })
        )
      : null;

    var comment = h('textarea', {
      class: 'form-input',
      id: 'rvComment',
      rows: '3',
      maxlength: '2000',
      placeholder: 'What stood out, for the discussion (only the admins read it).',
      oninput: function () {
        draft.comment = comment.value;
        schedule(1200);
      },
      onblur: function () {
        if (saver.dirty) send();
      },
    });
    comment.value = draft.comment;

    var conflict = h('input', {
      type: 'checkbox',
      onchange: function () {
        draft.conflict = conflict.checked;
        grid.classList.toggle('is-off', draft.conflict);
        grid.querySelectorAll('input').forEach(function (i) {
          i.disabled = draft.conflict;
        });
        schedule(200);
      },
    });
    conflict.checked = draft.conflict;
    if (draft.conflict) grid.classList.add('is-off');

    var next = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          var to = firstTodo(app.code);
          flush().then(function (ok) {
            if (!ok) return;
            if (to) openItem(to.code);
            else M.toast('Nothing left to ' + verb() + ' in this section');
          });
        },
      },
      'Next to score →'
    );

    var hasSectionGrid = app.grid.some(function (c) {
      return !c.question;
    });

    return [
      h(
        'div',
        { class: 'rv-panel-head' },
        h('strong', { class: 'rv-code' }, app.code),
        h('span', { class: 'rv-pill rv-tone is-' + app.state }, stateLabel(app.state)),
        h('span', { class: 'rv-save-state', role: 'status', 'aria-live': 'polite' })
      ),
      h(
        'div',
        { class: 'rv-panel-body' },
        h(
          'p',
          { class: 'rv-scale-note' },
          hasSectionGrid
            ? '1 = weak, 5 = excellent'
            : 'Each question has its criteria: 1 = weak, 5 = excellent'
        ),
        app.state === 'update'
          ? h(
              'p',
              { class: 'rv-hint-new' },
              'A criterion was added after you scored this one: give it a score too.'
            )
          : null,
        app.grid.length ? grid : h('p', { class: 'panel-note' }, 'Nothing to score here.'),
        reasons,
        h(
          'div',
          { class: 'rv-field' },
          h('label', { class: 'form-label', for: 'rvComment' }, 'Comment (optional)'),
          comment
        ),
        h(
          'label',
          { class: 'check-row rv-conflict' },
          conflict,
          h('span', null, 'I know who this is: I step aside')
        )
      ),
      h('div', { class: 'rv-panel-foot' }, next),
    ];
  }

  function emptyText() {
    var s = sectionOf(view.part);
    if (screening()) return 'No applications to pre-screen yet.';
    if (s && s.waiting)
      return (
        (s.waiting === 1 ? '1 application is' : s.waiting + ' applications are') +
        ' waiting for the pre-screening: they come here once they pass it.'
      );
    return 'No applications to score in this section yet.';
  }

  function renderDetail() {
    if (!mainEl) return;
    M.clear(mainEl);
    M.clear(panelEl);
    var app = view.app;
    if (!app) {
      if (!view.open) {
        mainEl.appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h('h3', null, 'Nothing yet'),
            h('p', null, emptyText())
          )
        );
      }
      return;
    }
    mainEl.appendChild(renderApplication(app));
    renderPanel(app).forEach(function (el) {
      panelEl.appendChild(el);
    });
    showSaveState();
  }

  start();
})();
