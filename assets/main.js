/* SoloFleet landing page script. No external libraries.
   - Plays the hero entrance once (skipped under reduced motion: final state shown).
   - Reveals sections on scroll.
   - Consent: no analytics or ad tag loads until the visitor clicks Accept.
   - Sends a github_click event to the dataLayer; GitHub links open in a new tab,
     so this page stays open long enough for the event to be sent. */
(function () {
  'use strict';

  var GTM_ID = 'GTM-5WNMB6HC'; // replaced at deploy time, e.g. GTM-XXXXXXX
  var CONSENT_KEY = 'sf_consent';      // 'accept' | 'reject'
  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduced) root.classList.add('anim');

  /* ---------- storage (may be blocked; never break the page) ---------- */
  function getConsent() {
    try { return window.localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function setConsent(v) {
    try { window.localStorage.setItem(CONSENT_KEY, v); } catch (e) { /* ignore */ }
  }

  /* ---------- dataLayer + Google consent signals ---------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  // Everything denied by default, for every visitor, before any tag can run.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });

  var gtmLoaded = false;
  function loadGTM() {
    if (gtmLoaded) return;
    if (!GTM_ID || GTM_ID.indexOf('{{') === 0) {
      if (window.console) console.warn('GTM container ID not set; tags not loaded.');
      return;
    }
    gtmLoaded = true;
    gtag('consent', 'update', {
      ad_storage: 'granted',
      analytics_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'denied' // no ad personalisation is needed for this test
    });
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_ID);
    document.head.appendChild(s);
  }

  /* ---------- consent bar ---------- */
  var bar = document.getElementById('consent');
  function showBar() { if (bar) bar.hidden = false; }
  function hideBar() { if (bar) bar.hidden = true; }

  var current = getConsent();
  if (current === 'accept') loadGTM();
  else if (current !== 'reject') showBar();

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-consent],[data-consent-open],[data-cta]') : null;
    if (!t) return;

    if (t.hasAttribute('data-consent')) {
      var choice = t.getAttribute('data-consent');
      var wasAccepted = getConsent() === 'accept';
      setConsent(choice);
      hideBar();
      if (choice === 'accept') {
        loadGTM();
      } else if (wasAccepted || gtmLoaded) {
        // Withdrawal: signal denied, then reload so no tag stays in memory.
        gtag('consent', 'update', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
        window.location.reload();
      }
      return;
    }

    if (t.hasAttribute('data-consent-open')) {
      showBar();
      var first = bar && bar.querySelector('button');
      if (first) first.focus();
      return;
    }

    if (t.hasAttribute('data-cta')) {
      // Recorded only if tags were allowed; otherwise it just sits in the local array.
      window.dataLayer.push({
        event: 'github_click',
        cta_position: t.getAttribute('data-cta'),
        link_url: t.href
      });
    }
  });

  /* ---------- entrance: hero lines, then the Discord exhibit, played once ---------- */
  var lines = document.querySelectorAll('.brand-title .line');
  var chan = document.querySelector('.chan');
  var appr = document.querySelector('.appr');
  var reveals = document.querySelectorAll('.reveal');

  /* ---------- rotating provider name in the subhead ----------
     Claude stays longest and is what shows when nothing runs (no JS, reduced motion, screenshots).
     Others carry a "?" (untried / not recommended). Screen readers get a fixed sentence instead. */
  var rot = document.getElementById('rot');
  var rotToggle = document.getElementById('rot-toggle');
  if (rot && !reduced) {
    var words = rot.querySelectorAll('.rot-w');
    // Claude between every guest, so Claude is never more than ~1s away; one full loop is 15.2s.
    var seq = [['claude', 2800], ['gemini', 1000], ['claude', 2800], ['codex', 1000], ['claude', 2800], ['kimi', 1000], ['claude', 2800], ['glm', 1000]];
    var si = 0, rotTimer = null, rotPaused = false, heroVisible = true;
    var byName = {};
    for (var w = 0; w < words.length; w++) byName[words[w].getAttribute('data-word')] = words[w];
    function showWord(name) {
      for (var k in byName) {
        var el = byName[k];
        if (k === name) { el.classList.remove('is-out'); el.classList.add('is-on'); }
        else if (el.classList.contains('is-on')) { el.classList.remove('is-on'); el.classList.add('is-out'); }
        else { el.classList.remove('is-out'); }
      }
    }
    function tick() {
      clearTimeout(rotTimer);
      if (rotPaused || !heroVisible || document.hidden) return;
      rotTimer = setTimeout(function () {
        si = (si + 1) % seq.length;
        showWord(seq[si][0]);
        tick();
      }, seq[si][1]);
    }
    if (rotToggle) {
      rotToggle.hidden = false;
      rotToggle.addEventListener('click', function () {
        rotPaused = !rotPaused;
        rotToggle.textContent = rotPaused ? 'Play names' : 'Pause names';
        if (rotPaused) { si = 0; showWord('claude'); clearTimeout(rotTimer); } else { tick(); }
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { si = 0; showWord('claude'); }   // back to Claude when the tab is hidden, like scrolling away or pausing
      tick();
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { heroVisible = en[0].isIntersecting; if (!heroVisible) { si = 0; showWord('claude'); } tick(); }).observe(rot);
    }
    setTimeout(tick, 2600);   // start after the hero entrance
  }

  if (reduced) { return; }   // no .anim class: everything already visible

  function show(el) { if (el) el.classList.add('in'); }
  for (var i = 0; i < lines.length; i++) (function (el, d) { setTimeout(function () { show(el); }, d); })(lines[i], 120 + i * 80);
  // the hero exhibit shows almost at once (short 0.3 s entrance), never left half-built
  setTimeout(function () { show(chan); }, 60);
  setTimeout(function () { show(appr); }, 180);

  /* ---------- reveal on scroll, once ---------- */
  if (!('IntersectionObserver' in window)) {
    for (var j = 0; j < reveals.length; j++) show(reveals[j]);
  } else {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { show(en.target); ro.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    for (var k = 0; k < reveals.length; k++) ro.observe(reveals[k]);
  }
})();
