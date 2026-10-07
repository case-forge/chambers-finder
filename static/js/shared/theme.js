/* CaseForge theme picker, shared by the homepage, Contact, Privacy, Envelope
 * Guide and Chambers Finder (BundleTool can opt out and keep its own, via
 * Settings' "Same theme everywhere"). One three-state pattern and one storage key, so a visitor's choice
 * follows them from page to page rather than being asked twice. The favicon swap uses the
 * clone-and-replace trick: Chromium does not re-fetch an icon when you
 * mutate an existing link's href in place.
 */
(function () {
  var KEY = 'cf_theme';
  // The favicon colour can be locked independently of the page theme
  // (Settings, "Lock favicon"): locked freezes the icon at whatever it showed
  // the moment it was locked; unlocked always follows the live theme. Exposed
  // as window.cfApplyFavicon so the Settings modal can re-run it the instant
  // the lock changes, without a reload.
  function faviconMode(pageMode) {
    var locked;
    try { locked = localStorage.getItem('cf_favicon_locked'); } catch (e) {}
    if (locked !== 'true') return pageMode;
    var frozen;
    try { frozen = localStorage.getItem('cf_favicon_frozen'); } catch (e) {}
    return (frozen === 'light' || frozen === 'dark') ? frozen : pageMode;
  }

  function setBrowserUI(mode) {
    var favMode = faviconMode(mode);
    var link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    if (link) {
      var next = favMode === 'dark' ? link.dataset.dark : link.dataset.light;
      if (next && link.href.indexOf(next) === -1) {
        var clone = link.cloneNode();
        clone.href = next;
        link.replaceWith(clone);
      }
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === 'dark' ? '#0e1014' : '#f0ebe1';
  }

  function apply(pref) {
    var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var mode = pref === 'auto' ? (systemDark ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', mode);
    setBrowserUI(mode);
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      var active = b.dataset.t === pref;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  window.cfApplyFavicon = function () {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    setBrowserUI(current);
  };

  var stored;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  apply(stored || 'auto');

  document.querySelectorAll('.theme-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      try { localStorage.setItem(KEY, b.dataset.t); } catch (e) {}
      apply(b.dataset.t);
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    var pref;
    try { pref = localStorage.getItem(KEY); } catch (e) {}
    if ((pref || 'auto') === 'auto') apply('auto');
  });
})();
