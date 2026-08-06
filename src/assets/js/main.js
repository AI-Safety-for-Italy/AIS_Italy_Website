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
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;

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
  }

  // ── Scroll reveal — animate elements with .reveal as they enter view ───
  function initScrollReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

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
          el.style.transitionDelay = idx * 80 + 'ms';
          el.classList.add('is-visible');
          observer.unobserve(el);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    Array.prototype.forEach.call(items, function (el) {
      observer.observe(el);
    });
  }

  // ── Hero glows drift away from the cursor ──────────────────────────────
  function initHeroGlow() {
    var hero = document.querySelector('.hero');
    if (!hero || reduceMotion || !canHover) return;

    var TRAVEL = 110; // furthest a glow will move, in px
    var RANGE = 900; // radius of the cursor's influence, in px
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

  initMenu();
  initThemeToggle();
  initScrollReveal();
  initHeroGlow();
  initDotSpotlight();
})();
