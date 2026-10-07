/**
 * Chambers Finder's error codes. Every error the page shows carries one, after its message and in the bug report, so
 * a report points straight at the place that raised it: `CF-<AREA>-<NN>`, where the area is DATA (the chambers and
 * court data), POSTCODE (the postcode table), QR (the share QR code), LINK (share and save links), STORE (this
 * browser's storage), PREFS (a preferences file) or PAGE (anything no handler caught).
 *
 * A code never changes meaning once it is given out; one that is no longer raised moves to RETIRED_CODES and is never
 * used for anything else. Each code is raised from exactly one place. A code is a fixed string in the source: nothing
 * typed and no file name ever goes into one. A postcode that is not recognised, or is outside England and Wales, is an
 * answer about what was typed, not an error, and carries none.
 *
 * A plain script, loaded before app.js (which reads window.CFErrorCodes), and a CommonJS module for the tests
 * (a scan of the source in the test suite keeps all of this true).
 */
(function (root) {
  "use strict";

  var ERROR_CODES = Object.freeze({
    "CF-DATA-01": "The chambers and court data did not load, so nothing can be searched.",
    "CF-POSTCODE-01": "The postcode table did not load, so a postcode cannot be placed.",
    "CF-QR-01": "The QR code library did not load, so the share link has no QR code.",
    "CF-LINK-01": "A save link could not be built.",
    "CF-LINK-02": "A link that was opened holds nothing Chambers Finder can use.",
    "CF-STORE-01": "This browser's storage is full, so the change was not saved.",
    "CF-PREFS-01": "A file dropped on the page is not a preferences .json file.",
    "CF-PREFS-02": "A preferences file could not be read.",
    "CF-PREFS-03": "A preferences file holds no preferences.",
    "CF-PAGE-01": "Something failed on the page that no other check caught.",
  });

  /** Codes no longer raised. Each keeps its meaning above and is never given to anything else. */
  var RETIRED_CODES = Object.freeze([]);

  var FORMAT = /^CF-[A-Z]{2,8}-\d{2}$/;

  /** The code as it is shown, or "" for anything that is not a registered code. */
  function shownCode(code) {
    return typeof code === "string" && FORMAT.test(code) && Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? code : "";
  }

  /** A message with its code after it, the way the page shows both. */
  function withCode(message, code) {
    var shown = shownCode(code);
    return shown ? message + " Error code " + shown + "." : message;
  }

  var api = { ERROR_CODES: ERROR_CODES, RETIRED_CODES: RETIRED_CODES, shownCode: shownCode, withCode: withCode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFErrorCodes = api;
})(typeof window !== "undefined" ? window : globalThis);
