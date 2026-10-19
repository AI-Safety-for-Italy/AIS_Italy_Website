/* ==========================================================================
   Site behaviour — loaded once, cached across pages, deferred.
   Runs after the document is parsed (see the `defer` on the <script> tag in
   components/base.njk), so there is no DOM-ready guard here.

   Two things deliberately do NOT live in this file:
     * the theme bootstrap, which has to run before first paint and so stays
       inline in the <head>. This file only handles the toggle click.
     * language, which is not client-side state at all — each language is its
       own set of static pages. Scripts read document.documentElement.lang.
   ========================================================================== */
(function () {
  'use strict';

  var THEME_KEY = 'theme';
  var CONSENT_KEY = 'analytics-consent';
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canHover = window.matchMedia('(hover: hover)').matches;

  // ── Mobile menu ────────────────────────────────────────────────────────
  function initMenu() {
    var menu = document.getElementById('mobileMenu');
    var btn = document.getElementById('menuToggle');
    if (!menu || !btn) return;

    function setOpen(open) {
      menu.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var first = menu.querySelector('a, button, input');
        if (first) first.focus();
      } else {
        btn.focus();
      }
    }

    btn.addEventListener('click', function () {
      setOpen(menu.classList.contains('hidden'));
    });

    // Clicking anywhere outside closes it, without stealing focus back.
    document.addEventListener('click', function (e) {
      if (menu.classList.contains('hidden')) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) setOpen(false);
    });
  }

  // ── Theme toggle ───────────────────────────────────────────────────────
  // The <head> bootstrap has already applied the right theme; this only
  // flips it. Which icon shows is decided in CSS off [data-theme], so there
  // is nothing to swap here and nothing to flash.
  function initThemeToggle() {
    // One button in the header, one in the mobile menu.
    var btns = document.querySelectorAll('[data-theme-toggle]');
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener('click', function () {
        var toDark = root.getAttribute('data-theme') !== 'dark';
        if (toDark) {
          root.setAttribute('data-theme', 'dark');
        } else {
          root.removeAttribute('data-theme');
        }
        try {
          localStorage.setItem(THEME_KEY, toDark ? 'dark' : 'light');
        } catch (e) {
          /* Safari private mode and friends: the theme still applies for this page. */
        }
      });
    });
  }

  // ── Scroll reveal — animate elements with .reveal as they enter view ───
  function initScrollReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;
    // CSS only hides .reveal under html.js-reveal, so without this script
    // (or before it runs) every section is simply visible.

    if (reduceMotion || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

    root.classList.add('js-reveal');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          // Stagger siblings within the same parent for a cascade effect
          var siblings = Array.prototype.slice.call(
            el.parentElement.querySelectorAll(':scope > .reveal')
          );
          var idx = Math.max(0, siblings.indexOf(el));
          el.style.transitionDelay = idx * 70 + 'ms';
          el.classList.add('is-visible');
          observer.unobserve(el);
        });
      },
      { threshold: 0.05, rootMargin: '0px 0px 10% 0px' }
    );

    Array.prototype.forEach.call(items, function (el) {
      observer.observe(el);
    });
  }

  // ── Hero glows drift away from the cursor ──────────────────────────────
  function initHeroGlow() {
    var hero = document.querySelector('.home-hero');
    if (!hero || reduceMotion || !canHover) return;

    var TRAVEL = 70; // furthest a glow will move, in px
    var RANGE = 700; // radius of the cursor's influence, in px
    var EASE = 0.035; // lower = lazier follow, so the glow drags a tail

    // ax/ay are each glow's resting position as a fraction of the hero box,
    // matching where .hero::before and .hero::after actually sit.
    var glows = [
      { xVar: '--glow-a-x', yVar: '--glow-a-y', ax: 0.06, ay: 0.1, x: 0, y: 0, tx: 0, ty: 0 },
      { xVar: '--glow-b-x', yVar: '--glow-b-y', ax: 0.94, ay: 0.92, x: 0, y: 0, tx: 0, ty: 0 },
    ];
    var frame = null;

    function step() {
      var moving = false;
      glows.forEach(function (g) {
        g.x += (g.tx - g.x) * EASE;
        g.y += (g.ty - g.y) * EASE;
        if (Math.abs(g.tx - g.x) > 0.1 || Math.abs(g.ty - g.y) > 0.1) moving = true;
        hero.style.setProperty(g.xVar, g.x.toFixed(1) + 'px');
        hero.style.setProperty(g.yVar, g.y.toFixed(1) + 'px');
      });
      frame = moving ? requestAnimationFrame(step) : null;
    }

    function nudge() {
      if (!frame) frame = requestAnimationFrame(step);
    }

    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      var mx = e.clientX - r.left;
      var my = e.clientY - r.top;
      glows.forEach(function (g) {
        // Push along the cursor -> glow vector, fading out past RANGE
        var dx = r.width * g.ax - mx;
        var dy = r.height * g.ay - my;
        var dist = Math.hypot(dx, dy) || 1;
        var force = Math.max(0, 1 - dist / RANGE);
        g.tx = (dx / dist) * TRAVEL * force;
        g.ty = (dy / dist) * TRAVEL * force;
      });
      nudge();
    });

    hero.addEventListener('pointerleave', function () {
      glows.forEach(function (g) {
        g.tx = 0;
        g.ty = 0;
      });
      nudge();
    });
  }

  // ── Cursor spotlight over the dot texture ──────────────────────────────
  // Three mask circles chase each other: the first follows the cursor, each
  // next one follows the previous with a lazier ease. That lag is the tail.
  // .dot-spotlight holds the brighter dot grid the mask reveals. The circles'
  // positions are set on it alone, so each frame restyles one element, not
  // the whole page.
  function initDotSpotlight() {
    if (reduceMotion || !canHover) return;

    var spot = document.createElement('div');
    spot.className = 'dot-spotlight';
    spot.setAttribute('aria-hidden', 'true');
    document.body.prepend(spot);

    var pts = [
      { x: 0, y: 0, ease: 0.3 },
      { x: 0, y: 0, ease: 0.14 },
      { x: 0, y: 0, ease: 0.07 },
    ];
    var cx = 0;
    var cy = 0;
    var frame = null;
    var seeded = false;

    function step() {
      var moving = false;
      pts.forEach(function (p, i) {
        // Head chases the cursor; every other link chases the one before it.
        var tx = i === 0 ? cx : pts[i - 1].x;
        var ty = i === 0 ? cy : pts[i - 1].y;
        p.x += (tx - p.x) * p.ease;
        p.y += (ty - p.y) * p.ease;
        if (Math.abs(tx - p.x) > 0.3 || Math.abs(ty - p.y) > 0.3) moving = true;
        spot.style.setProperty('--spot-x' + i, p.x.toFixed(1) + 'px');
        spot.style.setProperty('--spot-y' + i, p.y.toFixed(1) + 'px');
      });
      frame = moving ? requestAnimationFrame(step) : null;
    }

    document.addEventListener(
      'pointermove',
      function (e) {
        if (e.pointerType === 'touch') return;
        // Mask circles sit on a position:fixed layer, so viewport coords line up.
        cx = e.clientX;
        cy = e.clientY;
        if (!seeded) {
          // Drop the whole chain on the cursor so it doesn't fly in from 0,0.
          pts.forEach(function (p) {
            p.x = cx;
            p.y = cy;
          });
          seeded = true;
          step();
        }
        spot.classList.add('is-on');
        if (!frame) frame = requestAnimationFrame(step);
      },
      { passive: true }
    );

    // Leaving the window fades the tail out via the CSS opacity transition.
    document.addEventListener('pointerleave', function () {
      spot.classList.remove('is-on');
    });
    window.addEventListener('blur', function () {
      spot.classList.remove('is-on');
    });
  }

  // ── Announcement ticker ────────────────────────────────────────────────
  // Messages follow one another from right to left, a fixed gap apart. Each
  // message exists once in the page, so it can only come back in at the right
  // after it has fully left at the left: on a wide screen the bar waits rather
  // than ever showing the same text twice. Hovering or focusing holds it.
  function initAnnouncements() {
    var bar = document.querySelector('.announce-bar.is-ticker');
    if (!bar || reduceMotion) return;
    var viewport = bar.querySelector('.announce-viewport');
    var items = Array.prototype.slice.call(bar.querySelectorAll('.announce-item'));
    var SPEED = 55; // px per second
    var GAP = 96; // px between the end of one message and the next
    var state = items.map(function () {
      return { x: 0, on: false };
    });
    var lastStarted = 0;
    var last = null;
    var held = false;

    function setOn(i, on) {
      state[i].on = on;
      var el = items[i];
      el.classList.toggle('is-current', on);
      if (on) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', 'true');
      var link = el.querySelector('a');
      if (link) {
        if (on) link.removeAttribute('tabindex');
        else link.setAttribute('tabindex', '-1');
      }
    }

    function frame(t) {
      if (last === null) last = t;
      var dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      if (!held) {
        var width = viewport.offsetWidth;
        items.forEach(function (el, i) {
          if (!state[i].on) return;
          state[i].x -= SPEED * dt;
          if (state[i].x < -el.offsetWidth) setOn(i, false);
        });
        // Bring in the next message once the last one has cleared the gap,
        // but only if that message isn't still crossing the bar.
        var prev = state[lastStarted];
        var prevEnd = prev.x + items[lastStarted].offsetWidth;
        var next = (lastStarted + 1) % items.length;
        if ((!prev.on || prevEnd <= width - GAP) && !state[next].on) {
          state[next].x = prev.on ? Math.max(width, prevEnd + GAP) : width;
          setOn(next, true);
          lastStarted = next;
        }
        items.forEach(function (el, i) {
          if (state[i].on) el.style.transform = 'translateX(' + state[i].x.toFixed(1) + 'px)';
        });
      }
      requestAnimationFrame(frame);
    }

    bar.classList.add('ticker-on');
    items.forEach(function (el, i) {
      setOn(i, false);
    });
    // The first message starts already in view so the bar is never empty.
    state[0].x = Math.max(16, (viewport.offsetWidth - items[0].offsetWidth) / 2);
    setOn(0, true);
    items[0].style.transform = 'translateX(' + state[0].x.toFixed(1) + 'px)';

    bar.addEventListener('mouseenter', function () {
      held = true;
    });
    bar.addEventListener('mouseleave', function () {
      held = false;
    });
    bar.addEventListener('focusin', function () {
      held = true;
    });
    bar.addEventListener('focusout', function () {
      held = false;
    });
    requestAnimationFrame(frame);
  }

  // ── Stats count up from zero the first time they scroll into view ─────
  function initCountUp() {
    var nums = document.querySelectorAll('[data-count]');
    if (!nums.length || reduceMotion || !('IntersectionObserver' in window)) return;

    function run(el) {
      var target = parseInt(el.getAttribute('data-count'), 10);
      // A year counts the last few steps only; counting 0 → 2026 reads as noise.
      var from = target > 1000 ? target - 12 : 0;
      var start = null;
      var DURATION = 1100;
      function frame(t) {
        if (start === null) start = t;
        var p = Math.min(1, (t - start) / DURATION);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (target - from) * eased);
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          run(entry.target);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.6 }
    );
    Array.prototype.forEach.call(nums, function (el) {
      observer.observe(el);
    });
  }

  // ── Analytics consent ─────────────────────────────────────────────────
  // GA4 in basic consent mode: gtag.js is not even requested until the visitor
  // accepts, so a "reject" (or no answer) means no request to Google at all.
  // The choice is kept in localStorage; the footer button reopens the banner
  // so consent can be withdrawn as easily as it was given.
  function initConsent() {
    var banner = document.getElementById('consentBanner');
    if (!banner) return;
    var gaId = banner.getAttribute('data-ga-id');
    var loaded = false;

    function readChoice() {
      try {
        return localStorage.getItem(CONSENT_KEY);
      } catch (e) {
        return null;
      }
    }

    function loadAnalytics() {
      if (loaded) {
        window.gtag('consent', 'update', { analytics_storage: 'granted' });
        return;
      }
      loaded = true;
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () {
        window.dataLayer.push(arguments);
      };
      window.gtag('consent', 'default', {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
      window.gtag('js', new Date());
      window.gtag('config', gaId, { allow_google_signals: false });
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
      document.head.appendChild(s);
    }

    // Withdrawing consent: stop storage and drop the cookies GA already set.
    function stopAnalytics() {
      if (loaded) window.gtag('consent', 'update', { analytics_storage: 'denied' });
      document.cookie.split(';').forEach(function (c) {
        var name = c.split('=')[0].trim();
        if (name.indexOf('_ga') !== 0) return;
        var host = location.hostname.replace(/^www\./, '');
        ['', '; domain=' + host, '; domain=.' + host].forEach(function (d) {
          document.cookie = name + '=; Max-Age=0; path=/' + d;
        });
      });
    }

    function choose(value) {
      try {
        localStorage.setItem(CONSENT_KEY, value);
      } catch (e) {
        /* Storage blocked: the choice holds for this page only. */
      }
      banner.hidden = true;
      if (value === 'granted') loadAnalytics();
      else stopAnalytics();
    }

    Array.prototype.forEach.call(banner.querySelectorAll('[data-consent]'), function (btn) {
      btn.addEventListener('click', function () {
        choose(btn.getAttribute('data-consent'));
      });
    });

    var reopen = document.getElementById('consentReopen');
    if (reopen) {
      reopen.addEventListener('click', function () {
        banner.hidden = false;
        banner.querySelector('[data-consent]').focus();
      });
    }

    var choice = readChoice();
    if (choice === 'granted') loadAnalytics();
    else if (choice !== 'denied') banner.hidden = false;
  }

  // ── Seminar calendar (components/seminar-calendar.njk) ─────────────────
  // The page is static, so "today" is only known here: mark it, dim the
  // seminars already held, then show one month at a time, opening on the
  // month of the next seminar.
  function initSeminarCalendar() {
    var cal = document.querySelector('[data-seminar-cal]');
    if (!cal) return;

    var now = new Date();
    var today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');

    cal.querySelectorAll('[data-day]').forEach(function (el) {
      var day = el.getAttribute('data-day');
      if (day === today) el.classList.add('is-today');
      if (day < today) el.classList.add('is-past');
    });

    var items = cal.querySelectorAll('.cal-list__item');
    var next = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-day') >= today) {
        next = items[i];
        break;
      }
    }
    if (next) next.classList.add('is-next');

    var months = Array.prototype.slice.call(cal.querySelectorAll('.cal-month'));
    if (!months.length) return;
    var target = (next ? next.getAttribute('data-day') : today).slice(0, 7);
    var current = months.length - 1;
    months.forEach(function (m, idx) {
      if (m.getAttribute('data-month') === target) current = idx;
    });
    if (target < months[0].getAttribute('data-month')) current = 0;

    function show(idx) {
      current = Math.max(0, Math.min(months.length - 1, idx));
      months.forEach(function (m, n) {
        m.classList.toggle('is-current', n === current);
        m.querySelector('[data-cal-prev]').disabled = n === 0;
        m.querySelector('[data-cal-next]').disabled = n === months.length - 1;
      });
    }

    months.forEach(function (m) {
      var prev = m.querySelector('[data-cal-prev]');
      var nextBtn = m.querySelector('[data-cal-next]');
      prev.hidden = false;
      nextBtn.hidden = false;
      prev.addEventListener('click', function () {
        show(current - 1);
        months[current].querySelector('[data-cal-prev]').focus();
      });
      nextBtn.addEventListener('click', function () {
        show(current + 1);
        months[current].querySelector('[data-cal-next]').focus();
      });
    });

    cal.classList.add('is-paged');
    show(current);
  }

  // ── Hero map: city names on hover/focus; regions drift apart on scroll ──
  function initHeroMap() {
    var map = document.querySelector('.home-hero-map');
    if (!map) return;
    var hero = map.closest('.home-hero');
    var wrapper = map.parentElement;
    var tooltip = wrapper.querySelector('.city-tooltip');
    var cities = Array.prototype.slice.call(map.querySelectorAll('.city'));
    var activeCity = null;

    function hideName() {
      tooltip.hidden = true;
      activeCity = null;
    }

    function showName(city) {
      if (!city || map.classList.contains('is-faded')) return;
      activeCity = city;
      tooltip.textContent = city.getAttribute('aria-label');
      tooltip.hidden = false;
      var dot = city.querySelector('.city-hit').getBoundingClientRect();
      var box = wrapper.getBoundingClientRect();
      var left = dot.left + dot.width / 2 - box.left - tooltip.offsetWidth / 2;
      tooltip.style.left = Math.max(0, Math.min(box.width - tooltip.offsetWidth, left)) + 'px';
      tooltip.style.top = dot.top - box.top - tooltip.offsetHeight - 6 + 'px';
    }

    cities.forEach(function (city) {
      city.addEventListener('pointerenter', function () {
        showName(city);
      });
      city.addEventListener('pointerleave', function () {
        if (document.activeElement !== city) hideName();
      });
      city.addEventListener('focus', function () {
        showName(city);
      });
      city.addEventListener('blur', hideName);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideName();
    });
    window.addEventListener('resize', function () {
      if (activeCity) showName(activeCity);
    });

    if (reduceMotion) return;

    // All geometry uses one eased progress value, so pins stay on their regions
    // and every arc remains attached to its pins throughout the drift. Regions
    // move on the tilted plane; pins and arcs are placed in screen space above it.
    var tilt = map.querySelector('.map-plane').transform.baseVal.consolidate().matrix;
    var regions = Array.prototype.map.call(map.querySelectorAll('.rg'), function (el) {
      var box = el.getBBox();
      return {
        el: el,
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        dx: Number(el.style.getPropertyValue('--dx')),
        dy: Number(el.style.getPropertyValue('--dy')),
        spin: ((Number(el.style.getPropertyValue('--rnd')) - 0.5) * Math.PI) / 3,
      };
    });
    var points = cities.map(function (el) {
      return {
        x: Number(el.dataset.x),
        y: Number(el.dataset.y),
        h: Number(el.dataset.h),
        region: Number(el.dataset.region),
      };
    });
    var shadows = map.querySelectorAll('.map-shadows path');
    var links = Array.prototype.map.call(map.querySelectorAll('.map-links .link'), function (el) {
      return {
        paths: el.querySelectorAll('path'),
        from: Number(el.dataset.from),
        to: Number(el.dataset.to),
        bend: Number(el.dataset.bend),
      };
    });
    var cityLayer = map.querySelector('.map-cities');

    // Same as arc() in scripts/build-italy-map.py.
    function arc(from, to, length, bend) {
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var bow = Math.min(0.14, 18 / (Math.hypot(dx, dy) || 1)) * bend;
      var lift = Math.min(26, 0.14 * length);
      return {
        x: (from.x + to.x) / 2 - dy * bow,
        y: (from.y + to.y) / 2 + dx * bow - 2 * lift,
      };
    }

    function xy(point) {
      return point.x.toFixed(1) + ',' + point.y.toFixed(1);
    }

    function render(p) {
      map.style.setProperty('--p', p.toFixed(4));
      var matrices = regions.map(function (r) {
        var a = Math.cos(r.spin * p);
        var b = Math.sin(r.spin * p);
        var tx = r.cx - a * r.cx + b * r.cy + r.dx * p * 120;
        var ty = r.cy - b * r.cx - a * r.cy + r.dy * p * 120;
        var matrix = [a, b, -b, a, tx, ty];
        r.el.setAttribute('transform', 'matrix(' + matrix.join(' ') + ')');
        return matrix;
      });
      var moved = points.map(function (point, i) {
        var m = matrices[point.region];
        var x = m[0] * point.x + m[2] * point.y + m[4];
        var y = m[1] * point.x + m[3] * point.y + m[5];
        var foot = {
          x: tilt.a * x + tilt.c * y + tilt.e,
          y: tilt.b * x + tilt.d * y + tilt.f,
        };
        cities[i].setAttribute('transform', 'translate(' + xy(foot) + ')');
        return { plane: { x: x, y: y }, foot: foot, head: { x: foot.x, y: foot.y - point.h } };
      });
      links.forEach(function (link, k) {
        var from = moved[link.from];
        var to = moved[link.to];
        var length = Math.hypot(to.plane.x - from.plane.x, to.plane.y - from.plane.y);
        var c = arc(from.head, to.head, length, link.bend);
        var d = 'M' + xy(from.head) + ' Q' + xy(c) + ' ' + xy(to.head);
        for (var i = 0; i < link.paths.length; i++) link.paths[i].setAttribute('d', d);
        shadows[k].setAttribute('d', 'M' + xy(from.foot) + ' L' + xy(to.foot));
      });
      var faded = p >= 0.6;
      if (faded !== map.classList.contains('is-faded')) {
        map.classList.toggle('is-faded', faded);
        cityLayer.setAttribute('aria-hidden', faded ? 'true' : 'false');
        cities.forEach(function (city) {
          city.setAttribute('tabindex', faded ? '-1' : '0');
        });
      }
    }

    var frame = null;
    var progress = 0;
    var target = 0;
    var dirty = true;
    var lastTime = null;
    var lastRendered = null;
    var heroHeight = hero.getBoundingClientRect().height;
    function step(time) {
      frame = null;
      if (dirty) {
        // Home hero starts immediately below the header: fade from the first scroll.
        target = Math.min(1, Math.max(0, window.scrollY / (heroHeight * 0.6)));
        dirty = false;
        if (target > 0) hideName();
      }
      var dt = lastTime === null ? 16 : Math.min(64, time - lastTime);
      progress += (target - progress) * (1 - Math.exp(-dt / 55));
      var moving = Math.abs(target - progress) > 0.0001;
      if (!moving) progress = target;
      if (progress !== lastRendered) {
        render(progress);
        lastRendered = progress;
      }
      lastTime = moving ? time : null;
      if (moving) frame = requestAnimationFrame(step);
    }
    function schedule() {
      dirty = true;
      if (frame === null) frame = requestAnimationFrame(step);
    }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () {
      heroHeight = hero.getBoundingClientRect().height;
      schedule();
    });
    schedule();
  }

  initMenu();
  initThemeToggle();
  initSeminarCalendar();
  initAnnouncements();
  initScrollReveal();
  initCountUp();
  initHeroGlow();
  initDotSpotlight();
  initConsent();
  initHeroMap();
})();
