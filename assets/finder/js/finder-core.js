/*
 * Chambers Finder's testable logic, kept apart from the page code in app.js:
 * how a typed query is matched and ranked against courts and chambers, what a
 * postcode lookup's answer means, and how a shared link's contents are merged
 * with what a person already has saved. No DOM and no storage in here.
 *
 * Loaded as a plain script (it sets window.CFCore) and, for the tests, with
 * require/import (it sets module.exports).
 */
(function (root) {
  "use strict";

  // ── Postcodes ────────────────────────────────────────────────────────────

  // Full UK postcode, tolerant of a missing or extra space and of case.
  const POSTCODE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/i;
  // Outward code alone, such as "HA7" or "SW1A".
  const OUTCODE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/i;

  function looksLikePostcode(str) { return POSTCODE_RE.test(String(str).trim()); }
  function looksLikeOutcode(str) { return OUTCODE_RE.test(String(str).trim()); }

  // The table holds England and Wales only. Postcode areas outside them are listed by name
  // (table.x, no coordinates) so they can be told apart from a mistyped area.
  const NATIONS = { E: "England", W: "Wales" };
  const OUTSIDE_PLACES = {
    S: "Scotland", N: "Northern Ireland", J: "Jersey", G: "Guernsey", I: "the Isle of Man",
  };

  /**
   * Splits what was typed into the outward code (M3, SW1A) and, when given, the inward code
   * (3FX). Case, spaces and a missing space do not matter ("sw1a1aa" is SW1A 1AA). Returns
   * null when it is not shaped like a UK postcode or outward code.
   */
  function parsePostcode(raw) {
    const spaced = String(raw == null ? "" : raw).toUpperCase().trim().split(/\s+/);
    // A typed space marks where the outward code ends, so a half-typed "M3 3" must never be read
    // as M33: with a valid outward code before the space and an unfinished inward code after it,
    // there is nothing to look up yet.
    if (spaced.length === 2 && OUTCODE_RE.test(spaced[0]) && /^[0-9][A-Z]{0,1}$/.test(spaced[1])) return null;
    const t = spaced.join("");
    const full = t.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/);
    if (full) return { outcode: full[1], incode: full[2], postcode: full[1] + " " + full[2] };
    if (OUTCODE_RE.test(t)) return { outcode: t, incode: null, postcode: null };
    return null;
  }

  /**
   * Where a typed postcode is, from the table built by scripts/build-postcode-districts.mjs
   * (`table` is its file's contents: `d` maps an outward code to [lat, lon, label, nation] for
   * England and Wales, and `x` lists, by name only, the postcode areas or districts outside
   * them). Nothing is fetched: the point is the middle of the postcode district, a few
   * kilometres at most from any address in it. Returns {result}, or {error: "invalid" |
   * "unknown" | "outside" | ...}; "outside" carries `place`, such as "Scotland".
   */
  function locatePostcode(raw, table) {
    const compact = String(raw == null ? "" : raw).toUpperCase().replace(/\s+/g, "");
    // Real postcodes that name no place: the old Girobank code, and forces post office boxes.
    if (compact === "GIR0AA") return { error: "special-gir" };
    if (/^BFPO[0-9]{1,4}$/.test(compact)) return { error: "special-bfpo" };
    const p = parsePostcode(raw);
    if (!p) return { error: "invalid" };
    const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
    const d = table && table.d;
    if (has(d, p.outcode)) {
      const [lat, lon, label, nation] = d[p.outcode];
      return {
        result: { outcode: p.outcode, postcode: p.postcode, lat, lon, label, nation, nationName: NATIONS[nation] || "" },
      };
    }
    const x = table && table.x;
    const area = p.outcode.match(/^[A-Z]+/)[0];
    const code = has(x, p.outcode) ? x[p.outcode] : has(x, area) ? x[area] : null;
    if (code && has(OUTSIDE_PLACES, code)) return { error: "outside", outcode: p.outcode, place: OUTSIDE_PLACES[code] };
    return { error: "unknown", outcode: p.outcode };
  }

  const LOOKUP_MESSAGES = {
    invalid: "That does not look like a UK postcode. Check it and try again.",
    unknown: "That postcode area was not recognised. Check it and try again.",
    unavailable: "The postcode data could not be loaded. Reload the page and try again.",
    "special-gir": "GIR 0AA is a real postcode, but it belongs to no place, so a distance cannot be measured from it. Search by a court or a chambers instead.",
    "special-bfpo": "BFPO numbers are forces post office addresses with no place on the map, so a distance cannot be measured from one. Search by a court or a chambers instead.",
  };
  /** The message for a failed lookup; `place` is the outside place for kind "outside". */
  function lookupMessage(kind, place) {
    if (kind === "outside") {
      const name = place || "That place";
      return `Chambers Finder covers England and Wales only. ${name.charAt(0).toUpperCase() + name.slice(1)} has its own courts.`;
    }
    return LOOKUP_MESSAGES[kind] || LOOKUP_MESSAGES.unknown;
  }

  // ── Distances from a point (a court, or a located postcode) ──────────────

  /** Great-circle distance in miles. */
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  /** Every court with its distance from `loc`, nearest first (all of them, or the nearest `limit`). */
  function courtsByDistance(courts, loc, limit) {
    const all = courts
      .map(c => ({ court: c, distance: haversine(loc.lat, loc.lon, c.lat, c.lon) }))
      .sort((a, b) => a.distance - b.distance);
    return limit ? all.slice(0, limit) : all;
  }

  /** A chambers' distance from `loc`: its nearest branch (Infinity with none). */
  function nearestBranchDistance(chambers, loc) {
    return (chambers.branches || []).reduce((best, b) => Math.min(best, haversine(loc.lat, loc.lon, b.lat, b.lon)), Infinity);
  }

  /**
   * Every chambers ranked by its distance from `loc` (a court, or a located postcode): visible ones first, then
   * starred, then the nearest branch, then the name. `opts` says what the page's saved preferences hide or star
   * (all optional; without them nothing is hidden or starred): isBranchHidden(chambers, branch),
   * isChambersHidden(chambers), isStarred(chambers). A chambers with no visible branch is hidden and has no
   * distance (Infinity). The page and the command line both rank through this one function.
   */
  function rankChambersFromPoint(chambers, loc, opts) {
    const o = opts || {};
    const branchHidden = o.isBranchHidden || (() => false);
    const chambersHidden = o.isChambersHidden || (() => false);
    const starred = o.isStarred || (() => false);
    return chambers.map(ch => {
      let minDist = Infinity;
      let nearestBranch = null;
      const visibleBranches = ch.branches.filter(b => !branchHidden(ch, b));
      visibleBranches.forEach(b => {
        const d = haversine(loc.lat, loc.lon, b.lat, b.lon);
        if (d < minDist) { minDist = d; nearestBranch = b; }
      });
      return {
        chambers:      ch,
        distance:      minDist,
        nearestBranch,
        starred:       !!starred(ch),
        hidden:        !!chambersHidden(ch) || !visibleBranches.length,
      };
    }).sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.chambers.name.localeCompare(b.chambers.name);
    });
  }

  /** Splits rows carrying a `distance` into those inside the travel radius and those beyond it (null radius: all inside). */
  function splitByRadius(rows, radius) {
    if (radius === null || radius === undefined) return { near: rows.slice(), far: [] };
    return { near: rows.filter(r => r.distance <= radius), far: rows.filter(r => r.distance > radius) };
  }

  // ── Search matching and ranking ──────────────────────────────────────────

  function normalise(s) {
    return String(s == null ? "" : s)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[’'`´.]/g, "")      // St. Albans = St Albans, King's = Kings
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function editDistance(a, b) {
    const m = a.length, n = b.length;
    const row = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = row[j];
        row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = tmp;
      }
    }
    return row[n];
  }

  function fuzzyWord(qw, tw) {
    if (qw.length < 3 || tw.length < 3) return false;
    if (qw[0] !== tw[0]) return false;                 // a typo rarely changes the first letter
    return editDistance(qw, tw) <= Math.max(1, Math.floor(qw.length / 4));
  }

  // Tiers, lower is better. There is deliberately no "the query contains the
  // target word" rule: "manchester" contains "chester", so such a rule would
  // put Chester Family Court first for a search for Manchester.
  const TIER = { exact: 0, prefixWords: 1, prefixPartial: 2, phrase: 3, wordPrefixes: 4, substring: 5, fuzzy: 6 };

  /** How well `target` matches what was typed, or null for no match. Lower is better. */
  function scoreText(query, target) {
    const q = normalise(query), t = normalise(target);
    if (!q || !t) return null;
    if (t === q) return TIER.exact;
    if (t.startsWith(q + " ")) return TIER.prefixWords;
    if (t.startsWith(q)) return TIER.prefixPartial;
    if ((" " + t + " ").includes(" " + q + " ")) return TIER.phrase;
    const qWords = q.split(" "), tWords = t.split(" ");
    if (qWords.every(qw => tWords.some(tw => tw.startsWith(qw)))) return TIER.wordPrefixes;
    if (t.includes(q)) return TIER.substring;
    if (qWords.every(qw => tWords.some(tw => tw.startsWith(qw) || fuzzyWord(qw, tw)))) return TIER.fuzzy;
    return null;
  }

  function matches(query, target) { return typeof target === "string" && scoreText(query, target) !== null; }

  const min = (list) => list.reduce((best, v) => (v !== null && v < best ? v : best), Infinity);

  // Words spread across several fields ("central london": name and place).
  function scoreSpread(query, fields) {
    const text = fields.filter(f => typeof f === "string").join(" ");
    const s = scoreText(query, text);
    if (s === null) return null;
    return 7 + Math.min(s, 2) * 0.1;
  }

  /** A court's score for the query, or null. Name first, then aliases, then where it is. */
  function scoreCourt(query, court) {
    const aliases = Array.isArray(court.aliases) ? court.aliases : [];
    const s = min([
      scoreText(query, court.name),
      ...aliases.map(a => { const v = scoreText(query, a); return v === null ? null : v + 0.5; }),
      (() => { const v = scoreText(query, court.location); return v === null ? null : v + 10; })(),
      scoreSpread(query, [court.name, court.location, ...aliases]),
    ]);
    return s === Infinity ? null : s;
  }

  /** A chambers' score for the query, or null. Name, aliases, then its branches. */
  function scoreChambers(query, ch) {
    const aliases = Array.isArray(ch.aliases) ? ch.aliases : [];
    const branches = Array.isArray(ch.branches) ? ch.branches : [];
    const branchScores = [];
    branches.forEach(b => {
      [b.city, b.name].forEach(f => { const v = scoreText(query, f); if (v !== null) branchScores.push(v + 8); });
      const a = scoreText(query, b.address); if (a !== null) branchScores.push(a + 10);
    });
    const s = min([
      scoreText(query, ch.name),
      ...aliases.map(a => { const v = scoreText(query, a); return v === null ? null : v + 0.5; }),
      ...branchScores,
    ]);
    return s === Infinity ? null : s;
  }

  /** Best match first; ties in alphabetical order. Entries carry a numeric `score`. */
  function rankEntries(entries) {
    return entries.slice().sort((a, b) => a.score - b.score || String(a.label).localeCompare(String(b.label)));
  }

  // ── Checking the two data files ──────────────────────────────────────────

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isText = (v) => typeof v === "string" && v.trim() !== "";
  const inUk = (lat, lon) => isNum(lat) && isNum(lon) && lat >= 49 && lat <= 61 && lon >= -9 && lon <= 2.5;

  /** What is wrong with a finder-data.json, as a list of short sentences (empty when it is sound). */
  function validateFinderData(data) {
    const problems = [];
    if (!isObj(data)) return ["the file is not a JSON object"];
    if (!Number.isInteger(data.schemaVersion)) problems.push("schemaVersion is not a whole number");
    if (!Array.isArray(data.courts) || !data.courts.length) problems.push("courts is not a list with entries");
    if (!Array.isArray(data.chambers) || !data.chambers.length) problems.push("chambers is not a list with entries");
    if (data.defaultTravelMiles !== undefined && !(isNum(data.defaultTravelMiles) && data.defaultTravelMiles > 0)) problems.push("defaultTravelMiles is not a positive number");
    const seen = new Set();
    (Array.isArray(data.courts) ? data.courts : []).forEach((c, i) => {
      const at = `courts[${i}]`;
      if (!isObj(c)) { problems.push(`${at} is not an object`); return; }
      if (!isText(c.id)) problems.push(`${at} has no id`);
      else if (seen.has("court:" + c.id)) problems.push(`${at} repeats the id ${c.id}`); else seen.add("court:" + c.id);
      if (!isText(c.name)) problems.push(`${at} has no name`);
      if (!inUk(c.lat, c.lon)) problems.push(`${at} has no usable position`);
    });
    (Array.isArray(data.chambers) ? data.chambers : []).forEach((ch, i) => {
      const at = `chambers[${i}]`;
      if (!isObj(ch)) { problems.push(`${at} is not an object`); return; }
      if (!isText(ch.id)) problems.push(`${at} has no id`);
      else if (seen.has("chambers:" + ch.id)) problems.push(`${at} repeats the id ${ch.id}`); else seen.add("chambers:" + ch.id);
      if (!isText(ch.name)) problems.push(`${at} has no name`);
      if (!Array.isArray(ch.branches) || !ch.branches.length) { problems.push(`${at} has no branches`); return; }
      ch.branches.forEach((b, j) => {
        if (!isObj(b) || !inUk(b.lat, b.lon)) problems.push(`${at}.branches[${j}] has no usable position`);
      });
    });
    return problems;
  }

  /** What is wrong with a postcode-districts.json, as a list of short sentences (empty when it is sound). */
  function validatePostcodeTable(table) {
    const problems = [];
    if (!isObj(table)) return ["the file is not a JSON object"];
    if (!isObj(table.d) || !Object.keys(table.d).length) problems.push("d (the located districts) is not an object with entries");
    if (table.x !== undefined && !isObj(table.x)) problems.push("x (the outside areas) is not an object");
    Object.entries(isObj(table.d) ? table.d : {}).forEach(([k, v]) => {
      if (!Array.isArray(v) || v.length < 4 || !inUk(v[0], v[1]) || !isText(v[2]) || !NATIONS[v[3]]) problems.push(`district ${k} is not [lat, lon, label, nation]`);
    });
    return problems.slice(0, 20);
  }

  // ── Merging a shared link into what is already saved ─────────────────────

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  /**
   * Prefs are one object per court or chambers with starred, hidden, seen and notes.
   * Your own entry wins: if you already have a star, a hide or a "seen" mark on it,
   * the link's markers for it are ignored; a note of yours is never replaced.
   * Anything you have nothing for is added.
   */
  function mergePrefs(local, incoming) {
    const out = {};
    Object.entries(isObj(local) ? local : {}).forEach(([id, p]) => { out[id] = { ...p }; });
    Object.entries(isObj(incoming) ? incoming : {}).forEach(([id, inc]) => {
      const loc = out[id];
      if (!loc) { out[id] = { ...inc }; return; }
      const hasState = !!(loc.starred || loc.hidden || loc.seen);
      const src = hasState ? loc : inc;
      const merged = {};
      ["starred", "hidden", "seen"].forEach(k => { if (src[k]) merged[k] = src[k]; });
      const notes = loc.notes || inc.notes;
      if (notes) merged.notes = notes;
      if (Object.keys(merged).length) out[id] = merged; else delete out[id];
    });
    return out;
  }

  /** Contacted records are per branch, with the latest phone and email time each. The later time wins. */
  function mergeContacted(local, incoming) {
    const out = {};
    Object.entries(isObj(local) ? local : {}).forEach(([k, v]) => { out[k] = isObj(v) ? { ...v } : v; });
    Object.entries(isObj(incoming) ? incoming : {}).forEach(([k, inc]) => {
      const loc = out[k];
      if (!isObj(loc)) { out[k] = inc; return; }
      const merged = { ...loc };
      ["phone", "email"].forEach(via => {
        if (isObj(inc[via]) && (!isObj(merged[via]) || inc[via].ts > merged[via].ts)) merged[via] = inc[via];
      });
      out[k] = merged;
    });
    return out;
  }

  /** Your own recent searches stay first; the link's follow, without repeats. */
  function mergeRecents(local, incoming, max) {
    const out = (Array.isArray(local) ? local : []).slice();
    (Array.isArray(incoming) ? incoming : []).forEach(r => {
      if (!out.some(o => o.type === r.type && o.id === r.id)) out.push(r);
    });
    return out.slice(0, max || 10);
  }

  /** Counts for the question asked before anything is written. */
  function summariseImport(incoming, local) {
    const prefs = Object.values(incoming.prefs || {});
    const localPrefs = local.prefs || {};
    return {
      starred: prefs.filter(p => p.starred).length,
      hidden: prefs.filter(p => p.hidden).length,
      seen: prefs.filter(p => p.seen).length,
      notes: prefs.filter(p => p.notes).length,
      contacted: Object.keys(incoming.contacted || {}).length,
      recents: (incoming.recents || []).length,
      have: {
        prefs: Object.keys(localPrefs).length,
        contacted: Object.keys(local.contacted || {}).length,
        recents: (local.recents || []).length,
        notes: Object.values(localPrefs).filter(p => p.notes).length,
      },
    };
  }

  const api = {
    looksLikePostcode, looksLikeOutcode, parsePostcode, locatePostcode, lookupMessage, NATIONS, OUTSIDE_PLACES,
    normalise, scoreText, matches, scoreCourt, scoreChambers, rankEntries, TIER,
    mergePrefs, mergeContacted, mergeRecents, summariseImport,
    haversine, courtsByDistance, nearestBranchDistance, splitByRadius, rankChambersFromPoint,
    validateFinderData, validatePostcodeTable,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFCore = api;
})(typeof window !== "undefined" ? window : globalThis);
