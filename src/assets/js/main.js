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
  initScrollReveal();
  initConsent();
})();
