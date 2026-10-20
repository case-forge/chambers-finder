/* Sets data-theme before first paint so there is no flash of the wrong theme; theme.js then wires
 * the buttons. Loaded synchronously in <head> (no defer), and an external file rather than inline
 * so the pages' Content-Security-Policy can forbid inline script. */
(function () {
  // Two separate tries: with site storage blocked the saved choice is unreadable, but the device's
  // own light or dark setting still is, and a light-mode visitor must not get a dark first paint.
  var pref = 'auto';
  try { pref = localStorage.getItem('cf_theme') || 'auto'; } catch (e) {}
  try {
    var dark = pref === 'dark' || (pref === 'auto' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();
