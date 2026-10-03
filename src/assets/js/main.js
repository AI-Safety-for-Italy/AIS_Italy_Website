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
  // body::after holds the brighter dot grid the mask reveals.
  function initDotSpotlight() {
    if (reduceMotion || !canHover) return;

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
        root.style.setProperty('--spot-x' + i, p.x.toFixed(1) + 'px');
        root.style.setProperty('--spot-y' + i, p.y.toFixed(1) + 'px');
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
        document.body.classList.add('spotlight-on');
        if (!frame) frame = requestAnimationFrame(step);
      },
      { passive: true }
    );

    // Leaving the window fades the tail out via the CSS opacity transition.
    document.addEventListener('pointerleave', function () {
      document.body.classList.remove('spotlight-on');
    });
    window.addEventListener('blur', function () {
      document.body.classList.remove('spotlight-on');
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

  initMenu();
  initThemeToggle();
  initAnnouncements();
  initScrollReveal();
  initCountUp();
  initHeroGlow();
  initDotSpotlight();
  initConsent();
})();
