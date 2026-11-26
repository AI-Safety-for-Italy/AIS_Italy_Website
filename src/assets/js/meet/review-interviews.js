/* /app/review/interviews/: the interviews of the mentee selection, after the
 * shortlist (server/crm/interviews.js).
 *
 * Two faces, on one page so the rest of the selection stays as it is:
 *   My interviews  for the interviewers: the shortlists given to them. For a
 *                  project they may prepare their questions once (which, in
 *                  what order, their own): every interview of it starts from
 *                  that. An interview: a bar with the timer, the questions
 *                  (to tick as asked, with notes under each, or to reorder
 *                  and change for this interview), notes, the transcript and
 *                  the application in tabs, and on the side the grid. All
 *                  saved as it is typed.
 *   Organise       for the admins of the selection: who interviews which
 *                  project's shortlist (all of it or some), the questions
 *                  (by choice, in every interview, in some projects'), the
 *                  grid, its weight in the total and the planned length, the
 *                  interviewers, and how far each interview is.
 * The hash says where one is: #admin/<tab>, #plan/<project>,
 * #s/<project>/<key>[/<interviewer>]. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/crm/interviews';
  var root = document.getElementById('ivPage');

  var view = {
    me: null,
    overview: null, // GET: { admin, interviewer, duration, assignments }
    admin: null, // GET ?action=admin
    adminTab: 'assign',
    session: null, // GET ?action=session
    plan: null, // GET ?action=plan
  };

  var STATES = {
    todo: 'To do',
    started: 'Started',
    done: 'Done',
    conflict: 'Stepped aside',
  };
  var REQUIRED = {
    none: 'By choice',
    all: 'Every interview',
    projects: 'Some projects',
  };
  var STATUS = {
    applied: 'Applied',
    shortlisted: 'Shortlisted',
    interview: 'Interview',
    selected: 'Selected',
    matched: 'Matched',
    declined: 'Rejected',
  };

  // ── Small things ─────────────────────────────────────────────────────────

  function empty(title, text, extra) {
    return h('div', { class: 'empty-state' }, h('h3', null, title), h('p', null, text), extra);
  }

  function fail(err) {
    if (err.status === 401) return M.appError(err);
    if (err.status === 403 || err.status === 503) {
      M.clear(root).appendChild(
        empty(err.status === 403 ? 'No access' : 'Not set up yet', err.message)
      );
      return;
    }
    M.appError(err);
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function num(n) {
    return n === null || n === undefined ? '–' : Number(n).toFixed(2);
  }

  function statePill(state) {
    return h('span', { class: 'iv-state is-' + state }, STATES[state] || state);
  }

  function statusOf(status) {
    if (!status) return h('span', { class: 'panel-note' }, 'Not on the board');
    return h(
      'span',
      { class: 'rv-status' },
      h('span', { class: 'crm-dot', style: '--crm-dot:var(--crm-st-' + status + ')' }),
      STATUS[status] || status
    );
  }

  /** A day, 'YYYY-MM-DD', as the browser writes it. */
  function day(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function today() {
    var d = new Date();
    var p = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** Seconds as 12:34, or 1:02:03 past the hour. */
  function clock(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    var hh = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var two = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return (hh ? hh + ':' + two(mm) : String(mm)) + ':' + two(ss);
  }

  function minutes(seconds) {
    if (!seconds) return '';
    var m = Math.round(seconds / 60);
    return m < 1 ? '<1 min' : m + ' min';
  }

  function remember(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* not remembered: fine */
    }
  }

  function recall(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /** A textarea that grows with what is written in it. */
  function grow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }

  function textarea(attrs, value, autoGrow) {
    var el = h('textarea', attrs);
    el.value = value || '';
    if (autoGrow) {
      el.classList.add('iv-grow');
      el.addEventListener('input', function () {
        grow(el);
      });
    }
    return el;
  }

  function growAll() {
    window.requestAnimationFrame(function () {
      root.querySelectorAll('textarea.iv-grow').forEach(grow);
    });
  }

  function input(attrs, value) {
    var el = h('input', attrs);
    el.value = value === null || value === undefined ? '' : String(value);
    return el;
  }

  function moveIn(list, from, to) {
    if (to < 0 || to >= list.length) return false;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    return true;
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function initial(name) {
    return h('span', { class: 'iv-avatar', 'aria-hidden': 'true' }, (name || '?').charAt(0));
  }

  function mentorNames(project) {
    return (project.mentors || [])
      .map(function (m) {
        return m.name;
      })
      .join(', ');
  }

  function progressBar(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    return h(
      'span',
      { class: 'iv-bar', title: done + ' of ' + total },
      h('span', { style: 'width:' + pct + '%' })
    );
  }

  // ── Saving as one goes ───────────────────────────────────────────────────
  // What changed and is not sent yet, merged; sent shortly after the last
  // change (typing pauses), one request at a time. `target` says where.

  var saver = {
    target: null, // { url, base: {…}, onSaved(response) }
    patch: null,
    timer: null,
    inflight: null,
    error: null,
    savedAt: null,
  };

  function startSaving(target) {
    clearTimeout(saver.timer);
    saver.target = target;
    saver.patch = null;
    saver.error = null;
    saver.savedAt = null;
  }

  // The keys whose value is a map of their own (a note per question, a score
  // per criterion, a tick per question): merged one level deep.
  var DEEP = ['notesByItem', 'scores', 'asked'];

  /** `older` with `newer` over it; what is in both, newer wins. */
  function merged(older, newer) {
    var out = Object.assign({}, older || {});
    Object.keys(newer || {}).forEach(function (k) {
      out[k] = DEEP.indexOf(k) !== -1 ? Object.assign({}, out[k] || {}, newer[k]) : newer[k];
    });
    return out;
  }

  function queue(patch, delay) {
    if (!saver.target) return;
    saver.patch = merged(saver.patch, patch);
    showSaveState();
    clearTimeout(saver.timer);
    saver.timer = setTimeout(send, delay === undefined ? 800 : delay);
  }

  function send() {
    clearTimeout(saver.timer);
    if (saver.inflight) return saver.inflight.then(send);
    if (!saver.patch || !saver.target) return Promise.resolve();
    var target = saver.target;
    var patch = saver.patch;
    saver.patch = null;
    showSaveState('saving');
    saver.inflight = M.api('PUT', target.url, Object.assign({}, target.base, patch))
      .then(function (r) {
        saver.error = null;
        saver.savedAt = new Date();
        if (saver.target === target && target.onSaved) target.onSaved(r);
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        if (refused(err)) {
          // The server will not take this change as it is: sent again it would
          // fail again and hold back everything after it. Each part is tried
          // on its own, so only what is refused is left out.
          return sendApart(target, patch, err);
        }
        // The network, or the server for a moment: put it back, under what
        // came since, and try again shortly.
        saver.error = err.message;
        if (saver.target === target) {
          saver.patch = merged(patch, saver.patch);
          clearTimeout(saver.timer);
          saver.timer = setTimeout(send, 5000);
        }
      })
      .then(function () {
        saver.inflight = null;
        showSaveState();
      });
    return saver.inflight;
  }

  function refused(err) {
    return err.status >= 400 && err.status < 500 && [401, 408, 429].indexOf(err.status) === -1;
  }

  /** Sends each part of a refused change alone; what is refused again is dropped. */
  function sendApart(target, patch, err) {
    var keys = Object.keys(patch);
    if (keys.length === 1) {
      saver.error = err.message;
      return Promise.resolve();
    }
    var errors = [];
    var chain = Promise.resolve();
    keys.forEach(function (k) {
      chain = chain.then(function () {
        var one = {};
        one[k] = patch[k];
        return M.api('PUT', target.url, Object.assign({}, target.base, one)).then(
          function (r) {
            if (saver.target === target && target.onSaved) target.onSaved(r);
          },
          function (e) {
            if (e.status === 401) return M.appError(e);
            errors.push(e.message);
          }
        );
      });
    });
    return chain.then(function () {
      saver.error = errors.length ? errors[0] : null;
      if (!errors.length) saver.savedAt = new Date();
    });
  }

  function flush() {
    if (!saver.patch && !saver.inflight) return Promise.resolve(true);
    return send().then(function () {
      if (!saver.error) return true;
      var ok = window.confirm(
        'Your last change could not be saved (' + saver.error + '). Leave anyway?'
      );
      if (ok) {
        saver.patch = null;
        saver.error = null;
      }
      return ok;
    });
  }

  M.unsaved(function () {
    return Boolean(saver.patch || saver.inflight || saver.error);
  });

  function showSaveState(now) {
    root.querySelectorAll('.rv-save-state').forEach(function (el) {
      var text;
      var cls = '';
      var s = view.session;
      if (s && s.readOnly) text = 'Read only';
      else if (now === 'saving' || saver.inflight) text = 'Saving…';
      else if (saver.error) {
        text = 'Not saved: ' + saver.error;
        cls = ' is-error';
      } else if (saver.patch) text = 'Unsaved…';
      else if (saver.savedAt) text = 'Saved ' + M.fmtTime(saver.savedAt.toISOString());
      else if (s && s.interview.updatedAt) text = 'Saved ' + M.fmtDateTime(s.interview.updatedAt);
      else text = 'Saved as you go';
      el.className = 'rv-save-state' + cls;
      el.textContent = text;
    });
  }

  // ── Where one is ─────────────────────────────────────────────────────────

  function parseHash() {
    var raw = (window.location.hash || '').replace(/^#/, '');
    var parts = raw.split('/').map(function (p) {
      return decodeURIComponent(p);
    });
    if (parts[0] === 's' && parts[1] && parts[2])
      return { page: 'session', project: parts[1], key: parts[2], interviewer: parts[3] || null };
    if (parts[0] === 'plan' && parts[1]) return { page: 'plan', project: parts[1] };
    if (parts[0] === 'admin') return { page: 'admin', tab: parts[1] || null };
    return { page: 'home' };
  }

  function sessionHash(project, key, interviewer) {
    return (
      '#s/' +
      encodeURIComponent(project) +
      '/' +
      encodeURIComponent(key) +
      (interviewer ? '/' + encodeURIComponent(interviewer) : '')
    );
  }

  function go(hash) {
    if (window.location.hash === hash) route();
    else window.location.hash = hash;
  }

  window.addEventListener('hashchange', function () {
    // Something still being sent: wait for it, then go.
    flush().then(route);
  });

  var ticker = null;

  function route() {
    clearInterval(ticker);
    ticker = null;
    var at = parseHash();
    if (at.page === 'session') return openSession(at);
    view.session = null;
    startSaving(null);
    if (at.page === 'plan') return openPlan(at.project);
    if (at.page === 'admin' || (!view.overview.interviewer && view.overview.admin)) {
      if (!view.overview.admin) return go('#');
      if (at.tab) view.adminTab = at.tab;
      return loadAdmin();
    }
    reloadOverview().then(renderHome, fail);
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function start() {
    M.clear(root).appendChild(M.loading());
    Promise.all([M.me, M.api('GET', API)])
      .then(function (r) {
        view.me = r[0];
        view.overview = r[1];
        route();
      })
      .catch(fail);
  }

  function reloadOverview() {
    return M.api('GET', API).then(function (o) {
      view.overview = o;
    });
  }

  function faceTabs(current) {
    if (!(view.overview.admin && view.overview.interviewer)) return null;
    return h(
      'div',
      { class: 'fr-views iv-faces', role: 'tablist', 'aria-label': 'Interviews' },
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': current === 'home' ? 'true' : 'false',
          onclick: function () {
            go('#');
          },
        },
        'My interviews'
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': current === 'admin' ? 'true' : 'false',
          onclick: function () {
            go('#admin/' + view.adminTab);
          },
        },
        'Organise'
      )
    );
  }

  // ── My interviews ────────────────────────────────────────────────────────

  function renderHome() {
    M.clear(root);
    var tabs = faceTabs('home');
    if (tabs) root.appendChild(tabs);
    var list = view.overview.assignments || [];
    if (!list.length) {
      root.appendChild(
        empty(
          'No interviews for you yet',
          'The admins of the selection give each interviewer a project’s shortlist: it will show here.',
          view.overview.admin
            ? h(
                'p',
                null,
                h('a', { href: '#admin/assign' }, 'Give out the shortlists'),
                ' (you can give one to yourself, once you are among the interviewers).'
              )
            : null
        )
      );
      return;
    }
    root.appendChild(
      h(
        'p',
        { class: 'panel-note iv-intro' },
        'Prepare your questions once for each project, then open a mentee to run the interview: the timer, your questions and notes, and the grid are all on one page.'
      )
    );
    list.forEach(function (a) {
      var done = a.people.filter(function (p) {
        return p.state === 'done' || p.state === 'conflict';
      }).length;
      var next = a.people.filter(function (p) {
        return p.state === 'todo' || p.state === 'started';
      })[0];
      root.appendChild(
        h(
          'section',
          { class: 'rv-card iv-project' },
          h(
            'div',
            { class: 'iv-project-head' },
            h(
              'div',
              { class: 'iv-project-title' },
              h('h2', null, a.project.label),
              h(
                'p',
                { class: 'panel-note' },
                'Mentors: ' + mentorNames(a.project) + ' · ' + a.duration + ' min each'
              )
            ),
            h(
              'div',
              { class: 'iv-project-side' },
              h('span', { class: 'iv-progress-label' }, done + ' of ' + a.people.length + ' done'),
              progressBar(done, a.people.length),
              h(
                'a',
                {
                  class: 'btn btn-sm ' + (a.prepared ? 'btn-outline' : 'btn-primary'),
                  href: '#plan/' + encodeURIComponent(a.project.id),
                },
                a.prepared ? 'Edit my questions' : 'Prepare my questions'
              )
            )
          ),
          a.people.length
            ? h(
                'ul',
                { class: 'iv-people' },
                a.people.map(function (p) {
                  return h(
                    'li',
                    null,
                    h(
                      'a',
                      {
                        class: 'iv-person' + (next && next.key === p.key ? ' is-next' : ''),
                        href: sessionHash(a.project.id, p.key),
                      },
                      initial(p.name),
                      h(
                        'span',
                        { class: 'iv-person-name' },
                        h('strong', null, p.name),
                        p.org ? h('small', null, p.org) : null
                      ),
                      h(
                        'span',
                        { class: 'iv-person-meta' },
                        p.heldOn ? h('span', null, day(p.heldOn)) : null,
                        p.seconds ? h('span', null, minutes(p.seconds)) : null,
                        p.mean !== null ? h('strong', null, num(p.mean)) : null
                      ),
                      statePill(p.state),
                      h('span', { class: 'iv-chevron', 'aria-hidden': 'true' }, '›')
                    )
                  );
                })
              )
            : h('p', { class: 'panel-note' }, 'Nobody on this shortlist yet.')
        )
      );
    });
  }

  // ── The questions: one editor for a project's plan and for one interview ──
  // Two columns: the list in its order (drag, arrows, leave out; the required
  // ones stay) and what can be added (the setup's questions not in it, and a
  // question of one's own). `ctx`: { items, own, bank, limits, changed() }.

  function questionEditor(ctx) {
    var el = h('div', { class: 'iv-editor' });
    function changed() {
      ctx.changed();
      draw();
    }
    function draw() {
      M.clear(el);
      var dragFrom = null;
      var list = h('ol', { class: 'iv-ed-list' });
      ctx.items.forEach(function (item, i) {
        var li = h(
          'li',
          {
            class:
              'iv-ed-item' + (item.required ? ' is-required' : '') + (item.own ? ' is-own' : ''),
            draggable: 'true',
            ondragstart: function (e) {
              dragFrom = i;
              li.classList.add('is-dragging');
              e.dataTransfer.effectAllowed = 'move';
              try {
                e.dataTransfer.setData('text/plain', item.id);
              } catch (err) {
                /* fine without */
              }
            },
            ondragend: function () {
              li.classList.remove('is-dragging');
            },
            ondragover: function (e) {
              if (dragFrom === null) return;
              e.preventDefault();
              li.classList.add('is-over');
            },
            ondragleave: function () {
              li.classList.remove('is-over');
            },
            ondrop: function (e) {
              e.preventDefault();
              li.classList.remove('is-over');
              if (dragFrom === null || dragFrom === i) return;
              moveIn(ctx.items, dragFrom, i);
              dragFrom = null;
              changed();
            },
          },
          h('span', { class: 'iv-grip', 'aria-hidden': 'true', title: 'Drag to move' }, '⠿'),
          h('span', { class: 'iv-ed-num' }, String(i + 1)),
          h(
            'span',
            { class: 'iv-ed-text' },
            item.text,
            item.required
              ? h(
                  'span',
                  {
                    class: 'iv-tag is-required',
                    title: 'Asked in every interview of this project',
                  },
                  'Required'
                )
              : item.own
              ? h('span', { class: 'iv-tag' }, 'Yours')
              : null
          ),
          h(
            'span',
            { class: 'iv-q-moves' },
            h(
              'button',
              {
                type: 'button',
                class: 'iv-icon',
                title: 'Move up',
                'aria-label': 'Move up: ' + item.text,
                disabled: i === 0 ? true : null,
                onclick: function () {
                  if (moveIn(ctx.items, i, i - 1)) changed();
                },
              },
              '↑'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'iv-icon',
                title: 'Move down',
                'aria-label': 'Move down: ' + item.text,
                disabled: i === ctx.items.length - 1 ? true : null,
                onclick: function () {
                  if (moveIn(ctx.items, i, i + 1)) changed();
                },
              },
              '↓'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'iv-icon is-remove',
                title: item.required ? 'Required: it stays' : 'Leave this question out',
                'aria-label': 'Leave out: ' + item.text,
                disabled: item.required ? true : null,
                onclick: function () {
                  if (
                    item.note &&
                    !window.confirm('Leave this question out? Its notes go with it.')
                  )
                    return;
                  ctx.items.splice(i, 1);
                  if (item.own) {
                    ctx.own.splice(
                      ctx.own.findIndex(function (q) {
                        return q.id === item.id;
                      }),
                      1
                    );
                  }
                  if (ctx.dropped) ctx.dropped(item);
                  changed();
                },
              },
              '×'
            )
          )
        );
        list.appendChild(li);
      });

      var inList = {};
      ctx.items.forEach(function (i) {
        inList[i.id] = true;
      });
      var left = ctx.bank.filter(function (q) {
        return !inList[q.id];
      });
      var own = input({
        class: 'form-input is-compact',
        maxlength: String(ctx.limits.question),
        placeholder: 'Write a question of your own…',
        'aria-label': 'A question of your own',
        onkeydown: function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            addOwn();
          }
        },
      });
      function addOwn() {
        var text = own.value.trim();
        if (!text) return own.focus();
        if (ctx.own.length >= ctx.limits.own) {
          M.toast('At most ' + ctx.limits.own + ' questions of your own');
          return;
        }
        var id = newId('own_');
        ctx.own.push({ id: id, text: text });
        ctx.items.push({ id: id, text: text, help: '', required: false, own: true, note: '' });
        changed();
        var field = el.querySelector('.iv-ed-own input');
        if (field) field.focus();
      }
      el.appendChild(
        h(
          'div',
          { class: 'iv-ed-col' },
          h(
            'h3',
            { class: 'iv-ed-title' },
            'In this order',
            h('small', null, ' ' + ctx.items.length)
          ),
          ctx.items.length
            ? list
            : h('p', { class: 'panel-note' }, 'Nothing yet: add questions from the right.')
        )
      );
      el.appendChild(
        h(
          'div',
          { class: 'iv-ed-col iv-ed-bank' },
          h('h3', { class: 'iv-ed-title' }, 'Add'),
          left.length
            ? h(
                'ul',
                { class: 'iv-bank-pick' },
                left.map(function (q) {
                  return h(
                    'li',
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        title: 'Add to the list',
                        onclick: function () {
                          ctx.items.push({
                            id: q.id,
                            text: q.text,
                            help: q.help,
                            required: false,
                            own: false,
                            note: '',
                          });
                          changed();
                        },
                      },
                      h('span', { class: 'iv-plus', 'aria-hidden': 'true' }, '+'),
                      h(
                        'span',
                        null,
                        q.text,
                        q.help ? h('small', { class: 'rv-help' }, q.help) : null
                      )
                    )
                  );
                })
              )
            : h('p', { class: 'panel-note' }, 'Every question of the list is in.'),
          h(
            'div',
            { class: 'iv-ed-own' },
            own,
            h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: addOwn }, 'Add')
          )
        )
      );
    }
    draw();
    return el;
  }

  // ── A project's plan ─────────────────────────────────────────────────────

  function openPlan(project) {
    M.clear(root).appendChild(M.loading());
    M.api('GET', API + '?action=plan&project=' + encodeURIComponent(project))
      .then(function (p) {
        view.plan = p;
        startSaving({
          url: API + '?action=plan',
          base: { project: project },
        });
        renderPlan();
      })
      .catch(function (err) {
        if (err.status === 403) {
          M.clear(root).appendChild(empty('Not yours', err.message, backLink()));
          return;
        }
        fail(err);
      });
  }

  function planPatch() {
    var p = view.plan;
    return {
      plan: p.items.map(function (i) {
        return i.id;
      }),
      own: p.own,
      duration: p.duration || null,
    };
  }

  function renderPlan() {
    var p = view.plan;
    M.clear(root);
    root.appendChild(
      h(
        'div',
        { class: 'iv-pagehead' },
        backLink(),
        h('h2', null, 'Your questions'),
        h(
          'p',
          { class: 'panel-note' },
          h('strong', null, p.project ? p.project.label : ''),
          p.project && p.project.mentors.length ? ' · Mentors: ' + mentorNames(p.project) : ''
        ),
        h(
          'p',
          { class: 'iv-explain' },
          'Pick the questions you will ask and put them in order. Every interview of this project starts from this list, and you can still change a single interview on its own. The required ones are set by the admins and stay.',
          p.changed
            ? h(
                'span',
                { class: 'iv-explain-note' },
                ' ' +
                  p.changed +
                  (p.changed === 1 ? ' interview where you' : ' interviews where you') +
                  ' already changed the questions keep their own.'
              )
            : null
        ),
        h('span', { class: 'rv-save-state', role: 'status', 'aria-live': 'polite' })
      )
    );
    var length = input(
      {
        type: 'number',
        class: 'form-input is-compact iv-num',
        id: 'ivPlanLength',
        min: String(p.limits.duration[0]),
        max: String(p.limits.duration[1]),
        step: '5',
        placeholder: String(p.defaultDuration),
        oninput: function () {
          var n = Number(length.value);
          var bad = !Number.isInteger(n) || n < p.limits.duration[0] || n > p.limits.duration[1];
          length.classList.toggle('is-invalid', Boolean(length.value) && bad);
          // Whole minutes within the limits only; anything else waits for a fix.
          if (length.value && bad) return;
          p.duration = length.value ? n : null;
          queue(planPatch(), 600);
        },
      },
      p.duration
    );
    root.appendChild(
      h(
        'section',
        { class: 'rv-card iv-length' },
        h('label', { class: 'form-label', for: 'ivPlanLength' }, 'Length of these interviews'),
        h('div', { class: 'iv-length-row' }, length, h('span', null, 'minutes')),
        h(
          'small',
          { class: 'rv-help' },
          'For the timer. Leave it empty for the admins’ length (' +
            p.defaultDuration +
            ' min). You can still change it in a single interview.'
        )
      )
    );
    root.appendChild(
      h(
        'section',
        { class: 'rv-card' },
        questionEditor({
          items: p.items,
          own: p.own,
          bank: p.bank,
          limits: p.limits,
          changed: function () {
            queue(planPatch(), 300);
          },
        })
      )
    );
    showSaveState();
  }

  // ── One interview ────────────────────────────────────────────────────────

  function openSession(at) {
    M.clear(root).appendChild(M.loading());
    var url =
      API +
      '?action=session&project=' +
      encodeURIComponent(at.project) +
      '&key=' +
      encodeURIComponent(at.key) +
      (at.interviewer ? '&interviewer=' + encodeURIComponent(at.interviewer) : '');
    M.api('GET', url)
      .then(function (s) {
        s.interview.state = s.interview.conflict
          ? 'conflict'
          : s.interview.done
          ? 'done'
          : s.interview.updatedAt
          ? 'started'
          : 'todo';
        s.timer.at = Date.now();
        view.session = s;
        startSaving(
          s.readOnly
            ? null
            : {
                url: API + '?action=session',
                base: { project: s.project.id, key: s.person.key },
                onSaved: function (r) {
                  s.interview.mean = r.mean;
                  s.interview.state = r.state;
                  // A click on the timer still to be sent wins over this answer.
                  if (r.timer && !(saver.patch && saver.patch.timer !== undefined)) {
                    s.timer = {
                      seconds: r.timer.seconds,
                      running: r.timer.running,
                      at: Date.now(),
                    };
                  }
                  renderStatus();
                },
              }
        );
        renderSession();
      })
      .catch(function (err) {
        if (err.status === 403 || err.status === 404) {
          M.clear(root).appendChild(
            empty('Cannot open this interview', err.message, backLink(at.interviewer))
          );
          return;
        }
        fail(err);
      });
  }

  function backLink(fromAdmin) {
    return h(
      'a',
      { href: fromAdmin ? '#admin/progress' : '#', class: 'iv-back' },
      fromAdmin ? '← Progress' : '← My interviews'
    );
  }

  /** The mentees before and after this one, in the interviewer's list. */
  function neighbours() {
    var s = view.session;
    if (!view.overview || s.readOnly) return null;
    var a = (view.overview.assignments || []).filter(function (x) {
      return x.project.id === s.project.id;
    })[0];
    if (!a) return null;
    var at = a.people.findIndex(function (p) {
      return p.key === s.person.key;
    });
    if (at === -1) return null;
    return {
      prev: a.people[at - 1] || null,
      next: a.people[at + 1] || null,
      at: at,
      of: a.people.length,
    };
  }

  function seconds() {
    var t = view.session.timer;
    return t.seconds + (t.running ? (Date.now() - t.at) / 1000 : 0);
  }

  function renderSession() {
    var s = view.session;
    var ro = s.readOnly;
    M.clear(root);
    var nb = neighbours();
    root.appendChild(
      h(
        'div',
        { class: 'iv-top' },
        h(
          'div',
          { class: 'iv-top-who' },
          h(
            'div',
            { class: 'iv-top-nav' },
            backLink(ro),
            nb
              ? h(
                  'span',
                  { class: 'iv-top-step' },
                  h(
                    'a',
                    {
                      class: 'iv-icon',
                      href: nb.prev ? sessionHash(s.project.id, nb.prev.key) : null,
                      'aria-disabled': nb.prev ? null : 'true',
                      title: nb.prev ? 'Previous: ' + nb.prev.name : '',
                    },
                    '‹'
                  ),
                  h('small', null, nb.at + 1 + ' of ' + nb.of),
                  h(
                    'a',
                    {
                      class: 'iv-icon',
                      href: nb.next ? sessionHash(s.project.id, nb.next.key) : null,
                      'aria-disabled': nb.next ? null : 'true',
                      title: nb.next ? 'Next: ' + nb.next.name : '',
                    },
                    '›'
                  )
                )
              : null
          ),
          h(
            'div',
            { class: 'iv-top-name' },
            initial(s.person.name),
            h(
              'div',
              null,
              h('h2', null, s.person.name),
              h(
                'p',
                { class: 'panel-note' },
                s.person.org ? s.person.org + ' · ' : '',
                h('strong', null, s.project.label),
                s.project.mentors.length ? ' · ' + mentorNames(s.project) : ''
              )
            )
          )
        ),
        timerWidget(),
        h(
          'div',
          { class: 'iv-top-status' },
          h('span', { class: 'iv-top-state' }),
          h('span', { class: 'rv-save-state', role: 'status', 'aria-live': 'polite' }),
          ro ? h('span', { class: 'panel-note' }, s.interview.interviewer + '’s interview') : null
        )
      )
    );
    var main = h('div', { class: 'rv-main iv-main' }, questionsCard(), tabsCard());
    var panel = h(
      'aside',
      { class: 'rv-panel iv-panel', 'aria-label': 'Your evaluation' },
      h(
        'div',
        { class: 'rv-panel-head' },
        h('strong', null, 'Evaluation'),
        h('span', { class: 'iv-mean' })
      ),
      gridBody(),
      panelFoot()
    );
    root.appendChild(h('div', { class: 'rv-layout iv-layout' }, main, panel));
    renderStatus();
    tick();
    ticker = setInterval(tick, 1000);
    offsets();
    if (ro)
      root
        .querySelectorAll('.iv-main input, .iv-main textarea, .iv-panel input, .iv-panel textarea')
        .forEach(function (el) {
          el.disabled = true;
        });
    growAll();
  }

  // The bar on top sticks under the app's own bar, and the grid under both.
  function offsets() {
    var head = document.querySelector('.ap-top');
    var top = root.querySelector('.iv-top');
    root.style.setProperty('--iv-head', (head ? head.offsetHeight : 0) + 'px');
    root.style.setProperty('--iv-bar', (top ? top.offsetHeight : 0) + 'px');
  }
  window.addEventListener('resize', function () {
    if (view.session) offsets();
  });

  function renderStatus() {
    var s = view.session;
    if (!s) return;
    var state = root.querySelector('.iv-top-state');
    if (state) M.clear(state).appendChild(statePill(s.interview.state));
    var mean = root.querySelector('.iv-mean');
    if (mean) {
      M.clear(mean);
      if (s.interview.mean !== null && s.interview.mean !== undefined)
        mean.appendChild(h('span', { class: 'rv-pill is-on' }, num(s.interview.mean)));
    }
    var done = root.querySelector('.iv-done-btn');
    if (done) updateDoneButton(done);
    var toggle = root.querySelector('.iv-timer-toggle');
    if (toggle) {
      toggle.textContent = s.timer.running ? '❚❚' : '▶';
      toggle.title = s.timer.running ? 'Pause' : seconds() ? 'Go on' : 'Start the interview';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.classList.toggle('is-running', s.timer.running);
    }
    showSaveState();
  }

  // ── The timer ──

  function timerWidget() {
    var s = view.session;
    var ro = s.readOnly;
    return h(
      'div',
      { class: 'iv-timer' },
      h(
        'div',
        { class: 'iv-timer-row' },
        h('span', { class: 'iv-timer-time', 'aria-live': 'off' }, clock(seconds())),
        ro
          ? h('span', { class: 'iv-timer-plan' }, '/ ' + s.duration + ' min')
          : h(
              'button',
              {
                type: 'button',
                class: 'iv-timer-plan is-edit',
                title: 'Change the planned length',
                onclick: function (e) {
                  e.stopPropagation();
                  lengthPopover(e.currentTarget);
                },
              },
              '/ ' + s.duration + ' min ✎'
            ),
        ro
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'iv-timer-toggle',
                onclick: function () {
                  var running = !s.timer.running;
                  s.timer = { seconds: seconds(), running: running, at: Date.now() };
                  var patch = { timer: running ? 'start' : 'pause' };
                  // The interview starts today, unless a day was set.
                  if (running && !s.interview.heldOn) {
                    s.interview.heldOn = today();
                    patch.heldOn = s.interview.heldOn;
                    var held = root.querySelector('#ivHeld');
                    if (held) held.value = s.interview.heldOn;
                  }
                  queue(patch, 0);
                  renderStatus();
                  tick();
                },
              },
              '▶'
            ),
        ro
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'iv-icon',
                title: 'Reset the timer',
                'aria-label': 'Reset the timer',
                onclick: function () {
                  if (!seconds() || !window.confirm('Reset the timer to 0:00?')) return;
                  s.timer = { seconds: 0, running: false, at: Date.now() };
                  queue({ timer: 'reset' }, 0);
                  renderStatus();
                  tick();
                },
              },
              '↺'
            )
      ),
      h('span', { class: 'iv-timer-bar' }, h('span'))
    );
  }

  // The planned length of this interview: a number, or back to the default.
  function lengthPopover(anchor) {
    var s = view.session;
    var old = root.querySelector('.iv-pop');
    if (old) return old.remove();
    var box = input(
      {
        type: 'number',
        class: 'form-input is-compact iv-num',
        min: String(s.limits.duration[0]),
        max: String(s.limits.duration[1]),
        step: '5',
        'aria-label': 'Minutes',
        onkeydown: function (e) {
          if (e.key === 'Enter') set(Number(box.value));
          if (e.key === 'Escape') pop.remove();
        },
      },
      s.duration
    );
    function set(n) {
      if (
        n !== null &&
        !(Number.isInteger(n) && n >= s.limits.duration[0] && n <= s.limits.duration[1])
      ) {
        M.toast('Whole minutes, from ' + s.limits.duration[0] + ' to ' + s.limits.duration[1]);
        return;
      }
      s.duration = n === null ? s.durationDefault : n;
      s.durationFrom = n === null ? 'default' : 'interview';
      queue({ duration: n }, 0);
      anchor.textContent = '/ ' + s.duration + ' min ✎';
      pop.remove();
      tick();
    }
    var pop = h(
      'div',
      { class: 'iv-pop', role: 'dialog', 'aria-label': 'Planned length' },
      h('label', { class: 'form-label' }, 'Planned length'),
      h(
        'div',
        { class: 'iv-length-row' },
        box,
        h('span', null, 'min'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            onclick: function () {
              set(Number(box.value));
            },
          },
          'Set'
        )
      ),
      s.durationFrom === 'interview'
        ? h(
            'button',
            {
              type: 'button',
              class: 'rv-link-btn',
              onclick: function () {
                set(null);
              },
            },
            'Back to ' + s.durationDefault + ' min (your default for this project)'
          )
        : h('small', { class: 'rv-help' }, 'For this interview only.')
    );
    anchor.parentNode.appendChild(pop);
    box.focus();
    box.select();
    setTimeout(function () {
      document.addEventListener('click', function close(e) {
        if (!pop.contains(e.target)) {
          pop.remove();
          document.removeEventListener('click', close);
        }
      });
    });
  }

  function tick() {
    var s = view.session;
    if (!s) return;
    var now = seconds();
    var planned = s.duration * 60;
    var t = root.querySelector('.iv-timer');
    if (!t) return;
    t.querySelector('.iv-timer-time').textContent = clock(now);
    t.querySelector('.iv-timer-bar > span').style.width =
      Math.min(100, (now / planned) * 100) + '%';
    t.classList.toggle('is-warn', now >= planned * 0.8 && now < planned);
    t.classList.toggle('is-over', now >= planned);
    t.classList.toggle('is-running', s.timer.running);
  }

  // ── The questions ──

  function questionsCard() {
    var s = view.session;
    var mode = s.readOnly ? 'interview' : recall('iv-q-mode', 'interview');
    var open = recall('iv-questions-open', '1') === '1';
    var body = h('div', { class: 'iv-q-body', hidden: open ? null : true });
    var count = h('small', { class: 'iv-q-count' });
    function counts() {
      var asked = s.items.filter(function (i) {
        return s.asked[i.id];
      }).length;
      M.clear(count).appendChild(
        document.createTextNode(asked + ' of ' + s.items.length + ' asked')
      );
    }
    function draw() {
      M.clear(body);
      if (mode === 'edit') {
        body.appendChild(
          h(
            'p',
            { class: 'panel-note iv-q-hint' },
            'Changes here are for this interview only. ',
            h(
              'button',
              {
                type: 'button',
                class: 'rv-link-btn',
                onclick: function () {
                  M.api('PUT', API + '?action=plan', {
                    project: s.project.id,
                    plan: s.items
                      .filter(function (i) {
                        return !i.removed;
                      })
                      .map(function (i) {
                        return i.id;
                      }),
                    own: s.own,
                  })
                    .then(function () {
                      M.toast('Saved as your list for ' + s.project.label);
                    })
                    .catch(function (err) {
                      M.toast(err.message);
                    });
                },
              },
              'Use this list for all my interviews of this project'
            )
          )
        );
        body.appendChild(
          questionEditor({
            items: s.items,
            own: s.own,
            bank: s.bank,
            limits: s.limits,
            dropped: function (item) {
              var patch = {};
              if (item.note) {
                patch.notesByItem = {};
                patch.notesByItem[item.id] = '';
              }
              if (s.asked[item.id]) {
                delete s.asked[item.id];
                patch.asked = {};
                patch.asked[item.id] = false;
              }
              if (Object.keys(patch).length) queue(patch, 300);
            },
            changed: function () {
              s.order = 'interview';
              queue(
                {
                  plan: s.items.map(function (i) {
                    return i.id;
                  }),
                  own: s.own,
                },
                300
              );
              counts();
            },
          })
        );
      } else {
        body.appendChild(askList(counts));
      }
      counts();
      growAll();
    }
    var seg = s.readOnly
      ? null
      : h(
          'div',
          { class: 'fr-views iv-seg', role: 'tablist', 'aria-label': 'Questions' },
          [
            ['interview', 'Interview'],
            ['edit', 'Edit the list'],
          ].map(function (m) {
            return h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': mode === m[0] ? 'true' : 'false',
                onclick: function (e) {
                  mode = m[0];
                  remember('iv-q-mode', mode);
                  e.currentTarget.parentNode.querySelectorAll('button').forEach(function (b) {
                    b.setAttribute('aria-selected', b === e.currentTarget ? 'true' : 'false');
                  });
                  if (body.hidden) toggleOpen();
                  draw();
                },
              },
              m[1]
            );
          })
        );
    var toggle = h(
      'button',
      {
        type: 'button',
        class: 'iv-collapse',
        'aria-expanded': open ? 'true' : 'false',
        onclick: function () {
          toggleOpen();
        },
      },
      h('span', { class: 'iv-caret', 'aria-hidden': 'true' }),
      h('strong', null, 'Questions'),
      count
    );
    function toggleOpen() {
      var now = body.hidden;
      body.hidden = !now;
      toggle.setAttribute('aria-expanded', now ? 'true' : 'false');
      remember('iv-questions-open', now ? '1' : '0');
      if (now) growAll();
    }
    draw();
    return h(
      'section',
      { class: 'rv-card iv-card iv-questions' },
      h('div', { class: 'iv-card-bar' }, toggle, seg),
      body
    );
  }

  // The questions as they are asked: tick each when asked (with the time on
  // the timer), notes under it; the next one to ask is marked.
  function askList(counts) {
    var s = view.session;
    if (!s.items.length) {
      return h(
        'p',
        { class: 'panel-note' },
        'No questions yet. ',
        s.readOnly ? '' : 'Open “Edit the list” to add some.'
      );
    }
    var list = h('ol', { class: 'iv-ask' });
    function markNext() {
      var next = null;
      list.querySelectorAll('.iv-q').forEach(function (li) {
        li.classList.remove('is-next');
        if (!next && !li.classList.contains('is-asked')) next = li;
      });
      if (next) next.classList.add('is-next');
    }
    s.items.forEach(function (item, i) {
      var when = h('span', { class: 'iv-when' });
      var li;
      function showAsked() {
        var v = s.asked[item.id];
        li.classList.toggle('is-asked', Boolean(v));
        check.setAttribute('aria-pressed', v ? 'true' : 'false');
        when.textContent = typeof v === 'number' ? 'at ' + clock(v) : '';
      }
      var check = h('button', {
        type: 'button',
        class: 'iv-check',
        title: 'Asked',
        'aria-label': 'Asked: ' + item.text,
        disabled: s.readOnly ? true : null,
        onclick: function () {
          var on = !s.asked[item.id];
          var t = Math.floor(seconds());
          if (on) s.asked[item.id] = t > 0 ? t : true;
          else delete s.asked[item.id];
          var p = {};
          p[item.id] = on ? s.asked[item.id] : false;
          queue({ asked: p }, 300);
          showAsked();
          markNext();
          counts();
        },
      });
      var note = textarea(
        {
          class: 'form-input iv-q-note',
          rows: '1',
          maxlength: String(s.limits.itemNote),
          placeholder: 'Notes on the answer…',
          'aria-label': 'Notes on: ' + item.text,
          oninput: function () {
            item.note = note.value;
            var p = {};
            p[item.id] = note.value;
            queue({ notesByItem: p });
          },
        },
        item.note,
        true
      );
      li = h(
        'li',
        { class: 'iv-q' + (item.required ? ' is-required' : '') },
        check,
        h(
          'div',
          { class: 'iv-q-main' },
          h(
            'div',
            { class: 'iv-q-text' },
            h('span', { class: 'iv-ed-num' }, String(i + 1)),
            h('span', null, item.text),
            item.required ? h('span', { class: 'iv-tag is-required' }, 'Required') : null,
            item.own ? h('span', { class: 'iv-tag' }, 'Yours') : null,
            when
          ),
          item.help ? h('small', { class: 'rv-help' }, item.help) : null,
          note
        )
      );
      showAsked();
      list.appendChild(li);
    });
    markNext();
    return list;
  }

  // ── Notes, transcript, application: tabs ──

  function tabsCard() {
    var tab = recall('iv-tab', 'notes');
    var bodies = {
      notes: notesPane(),
      transcript: transcriptPane(),
      application: applicationPane(),
    };
    var labels = { notes: 'Notes', transcript: 'Transcript', application: 'Application' };
    var tabs = h(
      'div',
      { class: 'iv-tabbar', role: 'tablist' },
      Object.keys(labels).map(function (k) {
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'data-tab': k,
            'aria-selected': k === tab ? 'true' : 'false',
            onclick: function () {
              tab = k;
              remember('iv-tab', k);
              tabs.querySelectorAll('button').forEach(function (b) {
                b.setAttribute(
                  'aria-selected',
                  b.getAttribute('data-tab') === k ? 'true' : 'false'
                );
              });
              Object.keys(bodies).forEach(function (x) {
                bodies[x].hidden = x !== k;
              });
              growAll();
            },
          },
          labels[k]
        );
      })
    );
    Object.keys(bodies).forEach(function (x) {
      bodies[x].hidden = x !== tab;
    });
    return h(
      'section',
      { class: 'rv-card iv-card iv-tabs-card' },
      tabs,
      bodies.notes,
      bodies.transcript,
      bodies.application
    );
  }

  function notesPane() {
    var s = view.session;
    var notes = textarea(
      {
        class: 'form-input iv-notes',
        id: 'ivNotes',
        rows: '6',
        maxlength: String(s.limits.notes),
        placeholder: 'Impressions, doubts, what to check…',
        'aria-label': 'Notes',
        oninput: function () {
          queue({ notes: notes.value });
        },
      },
      s.interview.notes,
      true
    );
    var stamp = s.readOnly
      ? null
      : h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            title: 'Writes the timer’s time where the cursor is',
            onclick: function () {
              var mark = '[' + clock(seconds()) + '] ';
              var at = notes.selectionStart || notes.value.length;
              var before = notes.value.slice(0, at);
              var lead = before && !/\n$/.test(before) ? '\n' : '';
              notes.value = before + lead + mark + notes.value.slice(at);
              var pos = at + lead.length + mark.length;
              notes.focus();
              notes.setSelectionRange(pos, pos);
              grow(notes);
              queue({ notes: notes.value });
            },
          },
          '⏱ Insert the time'
        );
    return h(
      'div',
      { class: 'iv-pane' },
      stamp ? h('div', { class: 'iv-pane-tools' }, stamp) : null,
      notes
    );
  }

  function transcriptPane() {
    var s = view.session;
    var max = s.limits.transcript;
    var info = h('small', { class: 'panel-note' });
    var area = textarea(
      {
        class: 'form-input iv-transcript',
        id: 'ivTranscript',
        rows: '10',
        maxlength: String(max),
        placeholder: 'Paste the transcript, drop a file here, or load one (.txt, .vtt, .srt, .md).',
        'aria-label': 'Transcript',
        oninput: function () {
          showInfo();
          queue({ transcript: area.value }, 1200);
        },
      },
      s.interview.transcript
    );
    function showInfo() {
      var n = area.value.length;
      info.textContent = n
        ? n.toLocaleString() +
          ' characters' +
          (n > max * 0.9 ? ' (at most ' + max.toLocaleString() + ')' : '')
        : '';
    }
    showInfo();
    function load(f) {
      if (!f) return;
      if (!/\.(txt|vtt|srt|md)$/i.test(f.name) && !/^text\//.test(f.type || '')) {
        M.toast('A text file, please: .txt, .vtt, .srt or .md');
        return;
      }
      if (f.size > max * 4) {
        M.toast('This file is too long for a transcript');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '').replace(/\r\n?/g, '\n');
        if (text.length > max) {
          M.toast('The transcript is cut at ' + max.toLocaleString() + ' characters');
          text = text.slice(0, max);
        }
        if (area.value.trim() && !window.confirm('Replace the transcript with ' + f.name + '?'))
          return;
        area.value = text;
        showInfo();
        queue({ transcript: text }, 0);
        M.toast('Loaded ' + f.name);
      };
      reader.onerror = function () {
        M.toast('Could not read the file');
      };
      reader.readAsText(f);
    }
    var file = h('input', {
      type: 'file',
      class: 'iv-file',
      accept: '.txt,.vtt,.srt,.md,text/plain,text/vtt,text/markdown',
      'aria-label': 'Load a transcript file',
      onchange: function () {
        var f = file.files && file.files[0];
        file.value = '';
        load(f);
      },
    });
    if (!s.readOnly) {
      area.addEventListener('dragover', function (e) {
        e.preventDefault();
        area.classList.add('is-drop');
      });
      area.addEventListener('dragleave', function () {
        area.classList.remove('is-drop');
      });
      area.addEventListener('drop', function (e) {
        e.preventDefault();
        area.classList.remove('is-drop');
        load(e.dataTransfer.files && e.dataTransfer.files[0]);
      });
    }
    return h(
      'div',
      { class: 'iv-pane' },
      s.readOnly
        ? null
        : h(
            'div',
            { class: 'iv-pane-tools' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  file.click();
                },
              },
              'Load a file'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: function () {
                  if (!area.value || !window.confirm('Clear the transcript?')) return;
                  area.value = '';
                  showInfo();
                  queue({ transcript: '' }, 0);
                },
              },
              'Clear'
            ),
            file
          ),
      area,
      info
    );
  }

  function applicationPane() {
    var s = view.session;
    return h(
      'div',
      { class: 'iv-pane iv-app' },
      s.application.length
        ? s.application.map(function (sec) {
            return h(
              'div',
              { class: 'iv-app-section' },
              h('h3', null, sec.label),
              h(
                'dl',
                { class: 'iv-app-list' },
                sec.items.map(function (item) {
                  return h('div', null, h('dt', null, item.label), h('dd', null, answerOf(item)));
                })
              )
            );
          })
        : h('p', { class: 'panel-note' }, 'Their application is not found.')
    );
  }

  function answerOf(item) {
    if (item.links && item.links.length && item.onlyLinks) {
      return h(
        'ul',
        { class: 'iv-links' },
        item.links.map(function (l) {
          return h(
            'li',
            null,
            l.url
              ? h(
                  'a',
                  { href: l.url, target: '_blank', rel: 'noopener noreferrer' },
                  l.text || l.url
                )
              : l.text
          );
        })
      );
    }
    var el = h('div', { class: 'rv-answer-text' });
    el.textContent = item.text;
    return el;
  }

  // ── The grid ──

  function gridBody() {
    var s = view.session;
    var body = h('div', { class: 'rv-panel-body' });
    var held = input(
      {
        type: 'date',
        class: 'form-input is-compact',
        id: 'ivHeld',
        onchange: function () {
          s.interview.heldOn = held.value || null;
          queue({ heldOn: held.value || null }, 0);
        },
      },
      s.interview.heldOn
    );
    body.appendChild(
      h(
        'div',
        { class: 'iv-held' },
        h('label', { class: 'form-label', for: 'ivHeld' }, 'Held on'),
        held
      )
    );
    body.appendChild(h('div', { class: 'iv-grid' }, s.criteria.map(scaleRow)));
    var comment = textarea(
      {
        class: 'form-input',
        id: 'ivComment',
        rows: '3',
        maxlength: String(s.limits.comment),
        placeholder: 'In short: how did it go? (the admins read it)',
        oninput: function () {
          queue({ comment: comment.value });
        },
      },
      s.interview.comment,
      true
    );
    body.appendChild(
      h(
        'div',
        { class: 'rv-field' },
        h('label', { class: 'form-label', for: 'ivComment' }, 'Comment'),
        comment
      )
    );
    var conflict = h('input', {
      type: 'checkbox',
      checked: s.interview.conflict ? true : null,
      onchange: function () {
        s.interview.conflict = conflict.checked;
        body.querySelectorAll('.iv-grid input').forEach(function (i) {
          i.disabled = conflict.checked || s.readOnly;
        });
        queue({ conflict: conflict.checked }, 0);
      },
    });
    body.appendChild(
      h(
        'label',
        { class: 'check-row' },
        conflict,
        h('span', null, 'I know them personally: I step aside')
      )
    );
    return body;
  }

  function scaleRow(criterion) {
    var s = view.session;
    var value = s.interview.scores[criterion.key];
    var options = [];
    var row;
    for (var n = s.scale.min; n <= s.scale.max; n++) {
      (function (n) {
        var radio = h('input', {
          type: 'radio',
          name: 'iv-' + criterion.key,
          value: String(n),
          checked: value === n ? true : null,
          disabled: s.interview.conflict ? true : null,
          onchange: function () {
            s.interview.scores[criterion.key] = n;
            row.classList.add('is-scored');
            var p = {};
            p[criterion.key] = n;
            queue({ scores: p }, 300);
          },
        });
        options.push(
          h('label', { class: 'rv-dot', title: String(n) }, radio, h('span', null, String(n)))
        );
      })(n);
    }
    row = h(
      'fieldset',
      { class: 'rv-criterion' + (Number.isInteger(value) ? ' is-scored' : '') },
      h(
        'legend',
        null,
        h('strong', null, criterion.label),
        criterion.weight !== 1
          ? h('span', { class: 'rv-weight-tag', title: 'Weight' }, '×' + criterion.weight)
          : null
      ),
      criterion.help ? h('small', { class: 'rv-help' }, criterion.help) : null,
      h('div', { class: 'rv-scale' }, options)
    );
    return row;
  }

  function panelFoot() {
    var s = view.session;
    if (s.readOnly) return h('div', { class: 'rv-panel-foot' }, backLink(true));
    var button = h('button', {
      type: 'button',
      class: 'btn btn-sm iv-done-btn',
      onclick: function () {
        var done = !s.interview.done;
        if (done && !s.interview.conflict) {
          var missing = s.criteria.filter(function (c) {
            return !Number.isInteger(s.interview.scores[c.key]);
          });
          if (missing.length) {
            M.toast('Score every criterion first (' + missing.length + ' left)');
            return;
          }
        }
        s.interview.done = done;
        s.interview.state = s.interview.conflict ? 'conflict' : done ? 'done' : 'started';
        if (done && s.timer.running)
          s.timer = { seconds: seconds(), running: false, at: Date.now() };
        queue({ done: done }, 0);
        renderStatus();
        tick();
        if (done) {
          send()
            .then(reloadOverview)
            .then(function () {
              var nb = neighbours();
              if (nb && nb.next) M.toast('Done. Next: ' + nb.next.name);
              else M.toast('Done');
            })
            .catch(function () {});
        }
      },
    });
    updateDoneButton(button);
    return h('div', { class: 'rv-panel-foot' }, button);
  }

  function updateDoneButton(button) {
    var done = view.session && view.session.interview.done;
    button.className = 'btn btn-sm iv-done-btn ' + (done ? 'btn-outline' : 'btn-primary');
    button.textContent = done ? 'Done ✓ · reopen' : 'Mark the interview as done';
  }

  // ── Organise (admins) ────────────────────────────────────────────────────

  var ADMIN_TABS = [
    { key: 'assign', label: 'Who interviews whom' },
    { key: 'questions', label: 'Questions' },
    { key: 'grid', label: 'Grid & interviewers' },
    { key: 'progress', label: 'Progress' },
  ];

  var drafts = { questions: null, grid: null };

  function loadAdmin() {
    M.clear(root).appendChild(M.loading());
    return M.api('GET', API + '?action=admin')
      .then(setAdmin)
      .catch(fail);
  }

  function setAdmin(d) {
    view.admin = d;
    drafts.questions = copy(d.settings.questions);
    drafts.grid = {
      criteria: copy(d.settings.criteria),
      weight: d.settings.weight,
      duration: d.settings.duration,
    };
    renderAdmin();
  }

  function adminUnsaved() {
    if (!view.admin || !drafts.questions) return false;
    var s = view.admin.settings;
    return (
      JSON.stringify(drafts.questions) !== JSON.stringify(s.questions) ||
      JSON.stringify(drafts.grid.criteria) !== JSON.stringify(s.criteria) ||
      Number(drafts.grid.weight) !== Number(s.weight) ||
      Number(drafts.grid.duration) !== Number(s.duration)
    );
  }
  M.unsaved(adminUnsaved);

  function renderAdmin() {
    if (
      !ADMIN_TABS.some(function (t) {
        return t.key === view.adminTab;
      })
    )
      view.adminTab = 'assign';
    M.clear(root);
    var faces = faceTabs('admin');
    if (faces) root.appendChild(faces);
    root.appendChild(
      h(
        'div',
        { class: 'fr-views iv-tabs', role: 'tablist', 'aria-label': 'Organise the interviews' },
        ADMIN_TABS.map(function (t) {
          return h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': t.key === view.adminTab ? 'true' : 'false',
              onclick: function () {
                view.adminTab = t.key;
                // The address follows without reloading the page.
                if (window.history.replaceState)
                  window.history.replaceState(null, '', '#admin/' + t.key);
                renderAdmin();
              },
            },
            t.label
          );
        })
      )
    );
    var body = h('div', { class: 'iv-admin' });
    root.appendChild(body);
    if (view.adminTab === 'assign') renderAssign(body);
    else if (view.adminTab === 'questions') renderQuestionBank(body);
    else if (view.adminTab === 'grid') renderGrid(body);
    else renderProgress(body);
  }

  function post(action, payload) {
    return M.api('POST', API + '?action=' + action, payload).then(function (d) {
      var keepQ = drafts.questions;
      var keepG = drafts.grid;
      var dirty = adminUnsaved();
      view.admin = d;
      // Unsaved edits to the questions or the grid stay while one assigns.
      if (dirty) {
        drafts.questions = keepQ;
        drafts.grid = keepG;
      } else {
        drafts.questions = copy(d.settings.questions);
        drafts.grid = {
          criteria: copy(d.settings.criteria),
          weight: d.settings.weight,
          duration: d.settings.duration,
        };
      }
      renderAdmin();
      return reloadOverview();
    });
  }

  function errorToast(err) {
    if (err.status === 401) return M.appError(err);
    M.toast(err.message);
  }

  // Who interviews whom: a card per project, its shortlist and its interviewers.
  function renderAssign(body) {
    var d = view.admin;
    body.appendChild(
      h(
        'p',
        { class: 'panel-note iv-intro' },
        'Each project’s shortlist comes from ',
        h('a', { href: '/app/review/matching/' }, 'Matching'),
        '. Give it to one or more interviewers, whole or in part: they will see those mentees, with their application.'
      )
    );
    if (!d.projects.length) {
      body.appendChild(
        empty(
          'No projects yet',
          'Interviews follow the shortlists: first map each project to its mentors and shortlist the mentees in Matching.',
          h('p', null, h('a', { href: '/app/review/matching/' }, 'Open Matching'))
        )
      );
      return;
    }
    if (!d.interviewers.length) {
      body.appendChild(
        h(
          'p',
          { class: 'iv-warn' },
          'Nobody interviews yet: add the interviewers in ',
          h('a', { href: '#admin/grid' }, 'Grid & interviewers'),
          '.'
        )
      );
    }
    d.projects.forEach(function (p) {
      body.appendChild(projectCard(p));
    });
  }

  function projectCard(p) {
    var d = view.admin;
    var shortlist = h(
      'table',
      { class: 'iv-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Mentee'),
          h('th', null, 'Status'),
          h('th', null, 'Interviewers'),
          h('th', null, 'Interviews')
        )
      ),
      h(
        'tbody',
        null,
        p.shortlist.map(function (m) {
          return h(
            'tr',
            null,
            h(
              'td',
              null,
              h('strong', null, m.name),
              m.org ? h('small', { class: 'iv-sub' }, m.org) : null
            ),
            h('td', null, statusOf(m.status)),
            h(
              'td',
              null,
              m.interviewers.length
                ? m.interviewers.map(function (i) {
                    return h('span', { class: 'rv-pill' }, i.name);
                  })
                : h('span', { class: 'iv-warn-text' }, 'Nobody')
            ),
            h(
              'td',
              null,
              m.interviews.length
                ? m.interviews.map(function (iv) {
                    return h(
                      'a',
                      {
                        class: 'iv-chip',
                        href: sessionHash(p.id, m.key, iv.interviewerId),
                        title: iv.interviewer + ': ' + (STATES[iv.state] || iv.state),
                      },
                      iv.interviewer,
                      ' ',
                      statePill(iv.state),
                      iv.mean !== null ? ' ' + num(iv.mean) : ''
                    );
                  })
                : '–'
            )
          );
        })
      )
    );
    var assignments = p.assignments.length
      ? h(
          'ul',
          { class: 'iv-assignments' },
          p.assignments.map(function (a) {
            return h(
              'li',
              null,
              h('strong', null, a.interviewerName),
              ' · ',
              a.menteeKeys
                ? a.menteeKeys.length + ' of ' + p.shortlist.length + ' mentees'
                : 'the whole shortlist',
              h(
                'button',
                {
                  type: 'button',
                  class: 'rv-link-btn',
                  onclick: function () {
                    form.fill(a);
                  },
                },
                'Change'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'rv-link-btn iv-danger',
                  onclick: function () {
                    if (
                      !window.confirm(
                        'Take this shortlist back from ' +
                          a.interviewerName +
                          '? Interviews already written stay.'
                      )
                    )
                      return;
                    post('unassign', { id: a.id }).catch(errorToast);
                  },
                },
                'Take back'
              )
            );
          })
        )
      : h('p', { class: 'panel-note' }, 'Not given to anyone yet.');
    var form = assignForm(p);
    return h(
      'section',
      { class: 'rv-card iv-project' },
      h(
        'div',
        { class: 'rv-card-head' },
        h('h2', null, p.label),
        h('span', { class: 'rv-pill' }, p.shortlist.length + ' shortlisted'),
        h('p', { class: 'panel-note' }, 'Mentors: ' + mentorNames(p))
      ),
      p.shortlist.length
        ? shortlist
        : h('p', { class: 'panel-note' }, 'Nobody on its shortlist yet (Matching).'),
      h('h3', { class: 'iv-sub-title' }, 'Interviewers'),
      assignments,
      d.interviewers.length && p.shortlist.length ? form.el : null
    );
  }

  function assignForm(p) {
    var d = view.admin;
    var who = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Interviewer' },
      d.interviewers.map(function (i) {
        return h('option', { value: i.userId }, i.name);
      })
    );
    var name = 'iv-scope-' + p.id;
    var all = h('input', { type: 'radio', name: name, value: 'all', checked: true });
    var some = h('input', { type: 'radio', name: name, value: 'some' });
    var boxes = p.shortlist.map(function (m) {
      return { key: m.key, el: h('input', { type: 'checkbox', value: m.key }), name: m.name };
    });
    var picks = h(
      'div',
      { class: 'iv-picks', hidden: true },
      boxes.map(function (b) {
        return h('label', { class: 'check-row' }, b.el, h('span', null, b.name));
      })
    );
    function sync() {
      picks.hidden = !some.checked;
    }
    all.addEventListener('change', sync);
    some.addEventListener('change', sync);
    var button = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          var keys = null;
          if (some.checked) {
            keys = boxes
              .filter(function (b) {
                return b.el.checked;
              })
              .map(function (b) {
                return b.key;
              });
            if (!keys.length) return M.toast('Tick at least one mentee');
          }
          button.disabled = true;
          post('assign', { project: p.id, interviewerId: who.value, menteeKeys: keys })
            .then(function () {
              M.toast('Given to ' + who.options[who.selectedIndex].text);
            })
            .catch(errorToast)
            .then(function () {
              button.disabled = false;
            });
        },
      },
      'Give'
    );
    var el = h(
      'div',
      { class: 'iv-assign', 'data-unsaved-ignore': '' },
      h('span', null, 'Give to'),
      who,
      h('label', { class: 'check-row' }, all, h('span', null, 'the whole shortlist')),
      h('label', { class: 'check-row' }, some, h('span', null, 'only some')),
      button,
      picks
    );
    return {
      el: el,
      fill: function (a) {
        who.value = a.interviewerId;
        if (a.menteeKeys) {
          some.checked = true;
          boxes.forEach(function (b) {
            b.el.checked = a.menteeKeys.indexOf(b.key) !== -1;
          });
        } else all.checked = true;
        sync();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    };
  }

  // The questions: a list, each by choice, in every interview, or in some projects'.
  function renderQuestionBank(body) {
    var d = view.admin;
    var list = drafts.questions;
    body.appendChild(
      h(
        'p',
        { class: 'panel-note iv-intro' },
        'The questions the interviewers pick from. “Every interview” and “Some projects” put the question in every interview (of those projects), and the interviewer cannot leave it out; the others are by choice. Interviewers can also add their own.'
      )
    );
    var ol = h('ol', { class: 'iv-bank' });
    list.forEach(function (q, i) {
      var text = input(
        {
          class: 'form-input',
          maxlength: String(d.limits.question),
          'aria-label': 'Question ' + (i + 1),
          oninput: function () {
            q.text = text.value;
            bar();
          },
        },
        q.text
      );
      var help = input(
        {
          class: 'form-input is-compact',
          maxlength: String(d.limits.help),
          placeholder: 'A hint for the interviewer (optional)',
          'aria-label': 'Hint for question ' + (i + 1),
          oninput: function () {
            q.help = help.value;
            bar();
          },
        },
        q.help
      );
      var req = h(
        'select',
        {
          class: 'form-input is-compact',
          'aria-label': 'Asked',
          onchange: function () {
            q.required = req.value;
            if (q.required !== 'projects') q.projects = [];
            renderAdmin();
          },
        },
        Object.keys(REQUIRED).map(function (k) {
          return h('option', { value: k, selected: q.required === k ? true : null }, REQUIRED[k]);
        })
      );
      var projects =
        q.required === 'projects'
          ? h(
              'div',
              { class: 'iv-picks' },
              d.projects.length
                ? d.projects.map(function (p) {
                    var box = h('input', {
                      type: 'checkbox',
                      checked: (q.projects || []).indexOf(p.id) !== -1 ? true : null,
                      onchange: function () {
                        q.projects = (q.projects || []).filter(function (x) {
                          return x !== p.id;
                        });
                        if (box.checked) q.projects.push(p.id);
                        bar();
                      },
                    });
                    return h('label', { class: 'check-row' }, box, h('span', null, p.label));
                  })
                : h('span', { class: 'panel-note' }, 'No projects yet.')
            )
          : null;
      ol.appendChild(
        h(
          'li',
          { class: 'iv-bank-item' + (q.required !== 'none' ? ' is-required' : '') },
          h('div', { class: 'iv-bank-main' }, text, help, projects),
          h(
            'div',
            { class: 'iv-bank-side' },
            req,
            h(
              'span',
              { class: 'iv-q-moves' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  title: 'Move up',
                  'aria-label': 'Move up',
                  disabled: i === 0 ? true : null,
                  onclick: function () {
                    moveIn(list, i, i - 1);
                    renderAdmin();
                  },
                },
                '↑'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  title: 'Move down',
                  'aria-label': 'Move down',
                  disabled: i === list.length - 1 ? true : null,
                  onclick: function () {
                    moveIn(list, i, i + 1);
                    renderAdmin();
                  },
                },
                '↓'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  title: 'Remove',
                  'aria-label': 'Remove question ' + (i + 1),
                  onclick: function () {
                    list.splice(i, 1);
                    renderAdmin();
                  },
                },
                '×'
              )
            )
          )
        )
      );
    });
    body.appendChild(list.length ? ol : h('p', { class: 'panel-note' }, 'No questions yet.'));
    body.appendChild(
      h(
        'div',
        { class: 'iv-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            disabled: list.length >= d.limits.questions ? true : null,
            onclick: function () {
              list.push({ id: '', text: '', help: '', required: 'none', projects: [] });
              renderAdmin();
              var fields = root.querySelectorAll('.iv-bank-item input.form-input:not(.is-compact)');
              if (fields.length) fields[fields.length - 1].focus();
            },
          },
          '+ Add a question'
        )
      )
    );
    body.appendChild(saveBar());
  }

  // The grid, the interview's weight in the total, and who interviews.
  function renderGrid(body) {
    var d = view.admin;
    var g = drafts.grid;
    var card = h('section', { class: 'rv-card' });
    card.appendChild(
      h(
        'div',
        { class: 'rv-card-head' },
        h('h2', null, 'The grid'),
        h(
          'p',
          { class: 'panel-note' },
          'Each criterion is scored ' +
            d.scale.min +
            ' to ' +
            d.scale.max +
            ', with its weight in the interview’s score. A criterion renamed keeps its scores.'
        )
      )
    );
    var ol = h('ol', { class: 'iv-bank' });
    g.criteria.forEach(function (c, i) {
      var label = input(
        {
          class: 'form-input',
          maxlength: '80',
          'aria-label': 'Criterion ' + (i + 1),
          oninput: function () {
            c.label = label.value;
            bar();
          },
        },
        c.label
      );
      var help = input(
        {
          class: 'form-input is-compact',
          maxlength: String(d.limits.help),
          placeholder: 'What to look for (optional)',
          'aria-label': 'Help for criterion ' + (i + 1),
          oninput: function () {
            c.help = help.value;
            bar();
          },
        },
        c.help
      );
      var weight = input(
        {
          type: 'number',
          min: '0',
          max: '10',
          step: '0.5',
          class: 'form-input is-compact iv-num',
          'aria-label': 'Weight',
          oninput: function () {
            c.weight = Number(weight.value);
            bar();
          },
        },
        c.weight
      );
      ol.appendChild(
        h(
          'li',
          { class: 'iv-bank-item' },
          h('div', { class: 'iv-bank-main' }, label, help),
          h(
            'div',
            { class: 'iv-bank-side' },
            h('label', { class: 'iv-inline' }, 'Weight ', weight),
            h(
              'span',
              { class: 'iv-q-moves' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  'aria-label': 'Move up',
                  disabled: i === 0 ? true : null,
                  onclick: function () {
                    moveIn(g.criteria, i, i - 1);
                    renderAdmin();
                  },
                },
                '↑'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  'aria-label': 'Move down',
                  disabled: i === g.criteria.length - 1 ? true : null,
                  onclick: function () {
                    moveIn(g.criteria, i, i + 1);
                    renderAdmin();
                  },
                },
                '↓'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline btn-sm rv-icon-btn',
                  'aria-label': 'Remove criterion ' + (i + 1),
                  disabled: g.criteria.length === 1 ? true : null,
                  onclick: function () {
                    g.criteria.splice(i, 1);
                    renderAdmin();
                  },
                },
                '×'
              )
            )
          )
        )
      );
    });
    card.appendChild(ol);
    card.appendChild(
      h(
        'div',
        { class: 'iv-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            disabled: g.criteria.length >= d.limits.criteria ? true : null,
            onclick: function () {
              g.criteria.push({ label: '', help: '', weight: 1 });
              renderAdmin();
            },
          },
          '+ Add a criterion'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'rv-link-btn',
            onclick: function () {
              g.criteria = copy(d.defaults.criteria);
              renderAdmin();
            },
          },
          'Start from the default grid'
        )
      )
    );
    var w = input(
      {
        type: 'number',
        min: '0',
        max: String(d.limits.weight),
        step: '0.5',
        class: 'form-input is-compact iv-num',
        id: 'ivWeight',
        oninput: function () {
          g.weight = Number(w.value);
          bar();
        },
      },
      g.weight
    );
    card.appendChild(
      h(
        'div',
        { class: 'rv-field' },
        h(
          'label',
          { class: 'form-label', for: 'ivWeight' },
          'Weight of the interview in the total'
        ),
        w,
        h(
          'small',
          { class: 'rv-help' },
          'In the summary the interview has a column of its own; the total with the interview weighs the selection’s overall 1 and the interview this much. The overall and the matching stay as they are.'
        )
      )
    );
    var len = input(
      {
        type: 'number',
        min: String(d.limits.duration[0]),
        max: String(d.limits.duration[1]),
        step: '5',
        class: 'form-input is-compact iv-num',
        id: 'ivDuration',
        oninput: function () {
          g.duration = Number(len.value);
          bar();
        },
      },
      g.duration
    );
    card.appendChild(
      h(
        'div',
        { class: 'rv-field' },
        h('label', { class: 'form-label', for: 'ivDuration' }, 'Planned length (minutes)'),
        len,
        h(
          'small',
          { class: 'rv-help' },
          'The interviewers’ timer shows it, and turns orange near the end and red past it.'
        )
      )
    );
    body.appendChild(card);
    body.appendChild(saveBar());
    body.appendChild(interviewersCard());
  }

  function interviewersCard() {
    var d = view.admin;
    var pick = h(
      'select',
      { class: 'form-input is-compact', 'aria-label': 'Person to add' },
      h(
        'option',
        { value: '' },
        d.candidates.length
          ? 'Add someone who signed in with Discord…'
          : 'Nobody else has signed in'
      ),
      d.candidates.map(function (p) {
        return h('option', { value: p.userId }, p.name);
      })
    );
    pick.disabled = !d.candidates.length;
    return h(
      'section',
      { class: 'rv-card', 'data-unsaved-ignore': '' },
      h(
        'div',
        { class: 'rv-card-head' },
        h('h2', null, 'Interviewers'),
        h(
          'p',
          { class: 'panel-note' },
          'Who may interview: they see only the mentees of the shortlists given to them. A list of its own, apart from the reviewers. Someone removed gives their shortlists back; their interviews stay.'
        )
      ),
      d.interviewers.length
        ? h(
            'ul',
            { class: 'iv-team' },
            d.interviewers.map(function (i) {
              return h(
                'li',
                null,
                M.avatar ? M.avatar(i, 24) : null,
                h('span', null, i.name),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'rv-link-btn iv-danger',
                    onclick: function () {
                      if (!window.confirm('Remove ' + i.name + ' from the interviewers?')) return;
                      post('interviewers', { remove: i.userId }).catch(errorToast);
                    },
                  },
                  'Remove'
                )
              );
            })
          )
        : h('p', { class: 'panel-note' }, 'Nobody yet.'),
      h(
        'div',
        { class: 'iv-row' },
        pick,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: function () {
              if (!pick.value) return;
              post('interviewers', { add: pick.value }).catch(errorToast);
            },
          },
          'Add'
        )
      )
    );
  }

  var barEl = null;
  function bar() {
    if (!barEl) return;
    var dirty = adminUnsaved();
    barEl.querySelector('button').disabled = !dirty;
    barEl.querySelector('span').textContent = dirty ? 'Unsaved changes' : 'Saved';
  }

  function saveBar() {
    var button = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: function () {
          button.disabled = true;
          M.api('PUT', API + '?action=settings', {
            questions: drafts.questions,
            criteria: drafts.grid.criteria,
            weight: drafts.grid.weight,
            duration: drafts.grid.duration,
            version: view.admin.settings.version,
          })
            .then(function (d) {
              M.toast('Saved');
              setAdmin(d);
            })
            .catch(function (err) {
              errorToast(err);
              bar();
            });
        },
      },
      'Save'
    );
    barEl = h('div', { class: 'iv-savebar' }, h('span', { class: 'panel-note' }), button);
    setTimeout(bar);
    return barEl;
  }

  // How far each interview is: one row per mentee and interviewer.
  function renderProgress(body) {
    var d = view.admin;
    var rows = [];
    d.projects.forEach(function (p) {
      p.shortlist.forEach(function (m) {
        var by = {};
        m.interviews.forEach(function (iv) {
          by[iv.interviewerId] = iv;
        });
        var people = m.interviewers.slice();
        m.interviews.forEach(function (iv) {
          if (
            !people.some(function (x) {
              return x.id === iv.interviewerId;
            })
          )
            people.push({ id: iv.interviewerId, name: iv.interviewer });
        });
        if (!people.length) rows.push({ p: p, m: m, who: null, iv: null });
        people.forEach(function (w) {
          rows.push({ p: p, m: m, who: w, iv: by[w.id] || null });
        });
      });
    });
    var total = rows.filter(function (r) {
      return r.who;
    }).length;
    var done = rows.filter(function (r) {
      return r.iv && (r.iv.state === 'done' || r.iv.state === 'conflict');
    }).length;
    body.appendChild(
      h(
        'p',
        { class: 'panel-note iv-intro' },
        done + ' of ' + total + ' interviews done. Open one to read it.'
      )
    );
    if (!rows.length) {
      body.appendChild(empty('Nothing yet', 'Give the shortlists out first.'));
      return;
    }
    body.appendChild(
      h(
        'div',
        { class: 'iv-table-wrap' },
        h(
          'table',
          { class: 'iv-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              [
                'Project',
                'Mentee',
                'Interviewer',
                'State',
                'Score',
                'Held on',
                'Time',
                'Notes',
                '',
              ].map(function (t) {
                return h('th', null, t);
              })
            )
          ),
          h(
            'tbody',
            null,
            rows.map(function (r) {
              var iv = r.iv;
              return h(
                'tr',
                null,
                h('td', null, r.p.label),
                h('td', null, h('strong', null, r.m.name)),
                h('td', null, r.who ? r.who.name : h('span', { class: 'iv-warn-text' }, 'Nobody')),
                h('td', null, statePill(iv ? iv.state : 'todo')),
                h('td', null, iv && iv.mean !== null ? num(iv.mean) : '–'),
                h('td', null, iv && iv.heldOn ? day(iv.heldOn) : '–'),
                h('td', null, iv && iv.seconds ? minutes(iv.seconds) : '–'),
                h(
                  'td',
                  null,
                  iv
                    ? [
                        iv.hasNotes ? 'notes' : '',
                        iv.hasTranscript ? (iv.hasNotes ? ', ' : '') + 'transcript' : '',
                      ].join('') || '–'
                    : '–'
                ),
                h(
                  'td',
                  null,
                  iv ? h('a', { href: sessionHash(r.p.id, r.m.key, r.who.id) }, 'Open') : ''
                )
              );
            })
          )
        )
      )
    );
  }

  start();
})();
