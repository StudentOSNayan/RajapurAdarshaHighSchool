/* Rajapur Adarsha High School — v2
   Vanilla JS only: mobile menu, header shadow, scroll reveal,
   back-to-top, footer year. No dependencies. Keep tiny. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reduced = function () {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };

  /* ---------- mobile menu ---------- */
  var toggle = document.getElementById('navToggle');
  var menu = document.getElementById('mobileMenu');
  var header = document.getElementById('siteHeader');

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
    }
  }

  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeMenu);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1019) closeMenu();
    }, { passive: true });
  }

  /* ---------- back to top ---------- */
  var toTop = document.getElementById('toTop');
  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    });
  }

  function onScroll() {
    if (header) header.classList.toggle('scrolled', window.scrollY > 8);
    if (toTop) toTop.classList.toggle('show', window.scrollY > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- scroll reveal ---------- */
  var reveals = document.querySelectorAll('.reveal');
  if (reveals.length) {
    if ('IntersectionObserver' in window && !reduced()) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      reveals.forEach(function (el) { io.observe(el); });
    } else {
      reveals.forEach(function (el) { el.classList.add('in-view'); });
    }
  }

  /* ---------- image fallback: clean placeholder if a photo file is missing ---------- */
  document.querySelectorAll('.photo img, .event-media img').forEach(function (img) {
    img.addEventListener('error', function () {
      var holder = img.closest('.event-media') || img.closest('figure') || img.parentElement;
      if (!holder) return;
      var ph = document.createElement('div');
      ph.className = 'photo-pending';
      ph.setAttribute('role', 'img');
      ph.setAttribute('aria-label', img.getAttribute('alt') || 'Photo coming soon');
      var label = document.createElement('span');
      label.textContent = 'Photo coming soon';
      ph.appendChild(label);
      img.replaceWith(ph);
    });
  });

  /* ---------- footer year ---------- */
  var y = document.getElementById('year');
  if (y) y.textContent = String(new Date().getFullYear());
})();
