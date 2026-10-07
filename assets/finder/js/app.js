"use strict";

const PREFS_KEY    = "cf3_prefs";
const CONTACTED_KEY = "cf8_contacted";
const ACTIVITY_KEY  = "cf9_activity";

let RADII        = [20, 35, 50];
let RADIUS_LABELS = ["20 mi", "35 mi", "50 mi"];
const MAX_SEARCH_RESULTS_PER_GROUP = 8;
const BALANCED_SEARCH_RESULTS_PER_GROUP = 6;
const NOTES_MAX_LENGTH = 500;
const RECENT_SEARCHES_KEY = "cf_recent";
const MAX_RECENT_SEARCHES = 10;

const state = {
  data:               null,
  searchResults:      [],
  view:               "none",
  selectedCourt:      null,
  selectedChamber:    null,
  fromCourt:          null,
  lastOpenedChamberId: null,
  radiusMiles:        35,
  showHidden:         false,
};

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Material Symbols as inline SVG (static/js/shared/icons.js, loaded ahead of this
// script). "icon-fill" asks for the filled form, which only star has.
function icon(name, extraClass = "") {
  return window.cfIcon(extraClass === "icon-fill" ? name + "-fill" : name, "ms");
}

// Distances live in finder-core.js so they can be tested with the search and radius logic.
const haversine = (...a) => window.CFCore.haversine(...a);

// Matching, ranking, postcode answers and share-link merging live in finder-core.js
// (window.CFCore), which the tests load directly.
const Core = window.CFCore;
const looksLikePostcode = Core.looksLikePostcode;
const looksLikeOutcode  = Core.looksLikeOutcode;

// A typed postcode is placed on the map from a table of postcode districts that loads with
// the page (scripts/build-postcode-districts.mjs makes it; see Core.locatePostcode). Nothing
// about a postcode leaves the device, and the answer is instant: no request to wait for.
const POSTCODE_TABLE_URL = document.getElementById("postcode-data")?.href || "postcode-districts.json";
let _postcodeTable = null;
let _postcodeTableLoad = null;

function loadPostcodeTable() {
  if (_postcodeTable) return Promise.resolve(_postcodeTable);
  if (!_postcodeTableLoad) {
    _postcodeTableLoad = fetch(POSTCODE_TABLE_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (!j || typeof j.d !== "object") throw new Error("bad postcode table"); _postcodeTable = j; return _postcodeTable; })
      .catch(err => { _postcodeTableLoad = null; throw err; });
  }
  return _postcodeTableLoad;
}

// The pseudo-court a postcode search is measured from: it goes through the same distance,
// radius and ranking code as a real court, but is never stored, starred or noted.
function _locationToCourt(result) {
  return {
    id:       `postcode:${(result.postcode || result.outcode).replace(/\s+/g, "").toLowerCase()}`,
    name:     `Near ${result.label} (${result.outcode})`,
    location: result.postcode ? `${result.postcode}, measured from the middle of ${result.outcode}` : `Measured from the middle of ${result.outcode}`,
    lat:      result.lat,
    lon:      result.lon,
    aliases:  [],
  };
}

function normalizePrefs(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = {};
  Object.entries(source).forEach(([id, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entry = {};
    if (raw.starred) entry.starred = true;
    if (raw.hidden) entry.hidden = true;
    if (raw.seen === true || (typeof raw.seen === "number" && Number.isFinite(raw.seen) && raw.seen > 0)) entry.seen = raw.seen;
    if (typeof raw.notes === "string" && raw.notes.trim()) entry.notes = raw.notes.slice(0, NOTES_MAX_LENGTH);
    if (Object.keys(entry).length) next[id] = entry;
  });
  return next;
}

function getPrefs() {
  try { return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); }
  catch { return {}; }
}

function setPrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(normalizePrefs(p)));
}

function _hasMeaningfulPrefs(prefs) {
  return Object.values(prefs).some(p => p.starred || p.hidden || p.notes || p.seen);
}

function getChamberPrefs(id) {
  const p = getPrefs();
  return Object.assign(
    { starred: false, hidden: false, seen: false, notes: "" },
    p[id] || {}
  );
}

function setChamberPrefs(id, updates) {
  const p = getPrefs();
  const existing = getChamberPrefs(id);
  const merged = { ...existing, ...updates };

  const isEmpty =
    !merged.starred &&
    !merged.hidden &&
    !merged.seen &&
    !merged.notes;
  if (isEmpty) delete p[id]; else p[id] = merged;
  setPrefs(p);
  touchActivity(id, "lastPrefsChange");
  updatePrefsBar();

  if (state.data) renderStatusStrip();
}

function _courtPrefKey(id) { return "court:" + id; }
function getCourtPrefs(id) { return getChamberPrefs(_courtPrefKey(id)); }
function setCourtPrefs(id, updates) { setChamberPrefs(_courtPrefKey(id), updates); }

function _branchPrefKey(chambersId, branch) { return "branch:" + chambersId + "||" + _branchKey(branch); }
function getBranchPrefs(chambersId, branch) { return getChamberPrefs(_branchPrefKey(chambersId, branch)); }
function setBranchPrefs(chambersId, branch, updates) { setChamberPrefs(_branchPrefKey(chambersId, branch), updates); }
function isBranchHidden(chambersId, branch) { return !!(getPrefs()[_branchPrefKey(chambersId, branch)] || {}).hidden; }

function getContacted() {
  // Read through the same check a shared link gets: a corrupt value (an array,
  // records without times) must not show up as "3 contacted" with blank rows.
  try { return _sanitizeContactedImport(JSON.parse(localStorage.getItem(CONTACTED_KEY) || "{}")) || {}; }
  catch { return {}; }
}

function setContacted(data) {
  localStorage.setItem(CONTACTED_KEY, JSON.stringify(data));

  updatePrefsBar();
}

function _normalizeContactRec(rec) {
  if (!rec || rec.ts === undefined) return rec;
  return { [rec.via || "phone"]: { ts: rec.ts, chamberName: rec.chamberName || "" } };
}

function markContacted(chambersId, branchCity, chambersName, via) {
  const data = getContacted();
  const key  = chambersId + "||" + (branchCity || "");
  data[key] = _normalizeContactRec(data[key]) || {};
  data[key][via || "phone"] = { ts: Date.now(), chamberName: chambersName || "" };
  setContacted(data);
  updateContactedBar();
  if (state.data) renderStatusStrip();
}

function isContacted(chambersId, branchCity) {
  return _normalizeContactRec(getContacted()[chambersId + "||" + (branchCity || "")]) || null;
}

function _contactedMarkInner(rec) {
  if (!rec) return "";
  const parts = [];
  if (rec.phone) parts.push({ ts: rec.phone.ts, html: `${icon("call")} Called ${_formatContactTime(rec.phone.ts)}` });
  if (rec.email) parts.push({ ts: rec.email.ts, html: `${icon("mail")} Emailed ${_formatContactTime(rec.email.ts)}` });
  return parts.sort((a, b) => b.ts - a.ts).map(p => p.html).join("<br>");
}

function _buildContactedMark(contRecord) {
  const inner = _contactedMarkInner(contRecord);
  return inner ? `<div class="branch-contacted-mark">${inner}</div>` : "";
}

function resetSession() {
  if (!confirm("Clear the contacted list?\n\nYour stars, notes and other preferences are kept.")) return;
  localStorage.removeItem(CONTACTED_KEY);
  updateContactedBar();
  if (state.data) renderStatusStrip();
  if (state.view !== "none") renderSelection();
  showToast("Contacted list cleared");
}

function _formatContactTime(ts) {
  if (!ts) return "";
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
           " on " + d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) +
         " at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateContactedBar() {
  const data    = getContacted();
  const entries = Object.keys(data);
  const bar     = document.getElementById("contacted-bar");
  const info    = document.getElementById("contacted-bar-info");
  if (!bar || !info) return;

  if (!entries.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const chamberIds = new Set(entries.map(k => k.split("||")[0]));
  info.innerHTML =
    `<strong>${entries.length}</strong> branch${entries.length === 1 ? "" : "es"} contacted ` +
    `at <strong>${chamberIds.size}</strong> set${chamberIds.size === 1 ? "" : "s"}`;
}

function _b64EncodeUtf8(str) {
  let bin = "";
  new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function _b64DecodeUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

function _sanitizeContactedImport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (!key.includes("||")) return;
    const rec = _normalizeContactRec(value);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
    const entry = {};
    ["phone", "email"].forEach(via => {
      const v = rec[via];
      if (v && typeof v === "object" && typeof v.ts === "number" && isFinite(v.ts)) {
        entry[via] = { ts: v.ts, chamberName: typeof v.chamberName === "string" ? v.chamberName : "" };
      }
    });
    if (Object.keys(entry).length) clean[key] = entry;
  });
  return Object.keys(clean).length ? clean : null;
}

async function _encodeSavePayload(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === "function") {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
      const bytes  = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = "";
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      return "1" + btoa(bin);
    } catch {  }
  }
  return "0" + _b64EncodeUtf8(json);
}

// A link is a few KB; what it unpacks to is a few dozen KB at most. Reading
// stops at this size so a small crafted link cannot inflate to megabytes.
const MAX_PAYLOAD_BYTES = 256 * 1024;

async function _decodeSavePayload(str) {
  const marker = str[0];
  const body   = str.slice(1);
  if (marker === "1") {
    const bytes  = Uint8Array.from(atob(body), c => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PAYLOAD_BYTES) { await reader.cancel(); throw new Error("link too large"); }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    chunks.forEach(c => { all.set(c, at); at += c.length; });
    return new TextDecoder().decode(all);
  }
  const text = _b64DecodeUtf8(body);
  if (text.length > MAX_PAYLOAD_BYTES) throw new Error("link too large");
  return text;
}

function _sanitizeRecentsImport(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  raw.forEach(r => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return;
    if (r.type !== "court" && r.type !== "chambers") return;
    if (typeof r.id !== "string" || !r.id) return;
    clean.push({
      type:     r.type,
      id:       r.id,
      label:    typeof r.label === "string" ? r.label : "",
      sublabel: typeof r.sublabel === "string" ? r.sublabel : "",
    });
  });
  return clean.slice(0, MAX_RECENT_SEARCHES);
}

function _sanitizeFullImport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const contacted = _sanitizeContactedImport(raw.contacted) || {};
  const prefs     = normalizePrefs(raw.prefs);
  const recents   = _sanitizeRecentsImport(raw.recents);
  if (!Object.keys(contacted).length && !Object.keys(prefs).length && !recents.length) return null;
  return { contacted, prefs, recents };
}

/**
 * Narrows the saved state to what the share modal has ticked.
 *
 * prefs is one object per chambers carrying starred/hidden/seen/notes
 * together, so a per-FIELD selection has to rebuild each entry rather than
 * filter the list: unticking Notes must keep a starred chambers in the link
 * without its note, not drop the chambers. An entry that ends up empty is
 * removed, which is the same shape normalizePrefs() produces and what
 * _sanitizeFullImport() expects at the other end.
 */
function _selectShareData(sel) {
  const prefs = {};
  Object.entries(getPrefs()).forEach(([id, p]) => {
    const entry = {};
    if (sel.starred && p.starred) entry.starred = true;
    if (sel.hidden  && p.hidden)  entry.hidden  = true;
    if (sel.seen    && p.seen)    entry.seen    = p.seen;
    if (sel.notes   && p.notes)   entry.notes   = p.notes;
    if (Object.keys(entry).length) prefs[id] = entry;
  });
  return {
    prefs,
    contacted: sel.contacted ? getContacted() : {},
    recents:   sel.recents   ? getRecentSearches() : [],
  };
}

/** What is actually available to share, for the counts beside each tick box. */
function _shareCounts() {
  const prefs = Object.values(getPrefs());
  return {
    starred:   prefs.filter(p => p.starred).length,
    hidden:    prefs.filter(p => p.hidden).length,
    seen:      prefs.filter(p => p.seen).length,
    notes:     prefs.filter(p => p.notes).length,
    contacted: Object.keys(getContacted()).length,
    recents:   getRecentSearches().length,
  };
}

const SHARE_FIELDS = ["starred", "hidden", "seen", "contacted", "recents", "notes"];

function _shareSelection() {
  const sel = {};
  SHARE_FIELDS.forEach(k => {
    const el = document.getElementById(`share-${k}`);
    sel[k] = !!(el && el.checked && !el.disabled);
  });
  return sel;
}

async function _shareUrl(sel) {
  const data = _selectShareData(sel);
  const encoded = await _encodeSavePayload(data);
  return location.origin + location.pathname + "#cfx=" + encoded;
}

/**
 * Keeps the link, the length readout and the QR code live as the ticks
 * change. A link is not refused for being long (browsers handle far more
 * than this produces), but a reader deserves to see what they are about to
 * send, and Notes is the setting that moves the number.
 */
async function _updateShareSize() {
  const linkEl = document.getElementById("share-link");
  const sel = _shareSelection();
  if (!SHARE_FIELDS.some(k => sel[k])) {
    if (linkEl) linkEl.value = "";
    await _updateShareQr(null, 0);
    return;
  }
  let linkLength = 0;
  try {
    const url = await _shareUrl(sel);
    if (linkEl) linkEl.value = url;
    linkLength = url.length;
  } catch {
    if (linkEl) linkEl.value = "";
  }
  // The QR is built from its own selection, Notes forced off regardless of
  // the tick: it is the one form of this link meant for
  // someone else's camera, a higher bar than a link you copy yourself.
  await _updateShareQr({ ...sel, notes: false }, linkLength);
}

function openShareModal() {
  const modal = document.getElementById("share-modal");
  if (!modal) { buildSaveLink(); return; }

  const counts = _shareCounts();
  const total = SHARE_FIELDS.reduce((n, k) => n + counts[k], 0);
  if (!total) { showToast("Star or note something first"); return; }

  // A tick box for something you have none of is a control that does nothing.
  // Disabled and zeroed rather than hidden, so the list does not reshuffle
  // between openings and you can see what a link COULD carry.
  SHARE_FIELDS.forEach(k => {
    const box   = document.getElementById(`share-${k}`);
    const label = document.getElementById(`share-count-${k}`);
    const n = counts[k];
    if (label) label.textContent = n ? String(n) : "none";
    if (box) {
      box.disabled = !n;
      if (!n) box.checked = false;
      box.closest("li")?.classList.toggle("share-empty", !n);
    }
  });

  _updateShareSize();
  modal.showModal();
}

function copyShareLink() {
  const url = document.getElementById("share-link")?.value;
  if (!url) { showToast("Tick something to share"); return; }
  const sel = _shareSelection();
  const done = () => {
    document.getElementById("share-modal")?.close();
    showToast(sel.notes ? "Link copied, notes included" : "Link copied");
  };
  window.cfCopy(url).then((ok) => {
    if (!ok) prompt("Copy this save link:", url);
    done();
  });
}

// ── QR ────────────────────────────────────────────────────────────────────
// Same pattern as BundleTool's: vendored, loaded as a <script> tag (not an
// import) so the ~57KB is fetched only the first time someone asks for a
// QR code, not on every page load.
let _qrLib = null;
function _loadQrLib() {
  if (_qrLib) return Promise.resolve(_qrLib);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "/vendor/qrcode.js";
    el.onload = () => {
      _qrLib = window.qrcode;
      _qrLib ? resolve(_qrLib) : reject(new Error("qrcode global missing"));
    };
    el.onerror = () => reject(new Error("could not load the QR library"));
    document.head.appendChild(el);
  });
}

/**
 * Redraws the QR for a given selection (already Notes-forced-off by the
 * caller). Called on every tick change and on open, not behind a button:
 * generating one is a millisecond, pure-JS operation, so there is nothing
 * to gate behind a click.
 */
async function _updateShareQr(sel, linkLength) {
  const host = document.getElementById("share-code-canvas");
  const note = document.getElementById("share-code-note");
  if (!host || !note) return;

  if (!sel || !SHARE_FIELDS.some(k => sel[k])) {
    host.innerHTML = "";
    note.textContent = "Nothing ticked.";
    return;
  }

  // A library that will not load is a fault to report, not "too long for a QR code",
  // which is what the catch below says about a link that will not fit.
  let qrcode;
  try {
    qrcode = await _loadQrLib();
  } catch (err) {
    const code = "CF-QR-01";
    host.innerHTML = "";
    note.textContent = withCode("The QR code could not be made on this page.", code);
    window.cfBugReport?.report({ error: err, title: "QR code library did not load", code });
    return;
  }

  try {
    const url = await _shareUrl(sel);
    const qr = qrcode(0, "L"); // 0 = smallest version that fits
    qr.addData(url);
    qr.make();
    host.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
    const svg = host.querySelector("svg");
    if (svg) { svg.style.width = "100%"; svg.style.height = "auto"; svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "QR code for this share link"); }
    note.textContent = `QR: ${qr.getModuleCount()}×${qr.getModuleCount()} · Link: ${linkLength.toLocaleString()} characters`;
  } catch {
    host.innerHTML = "";
    note.textContent = `Too long for a QR code. Link: ${linkLength.toLocaleString()} characters.`;
  }
}

/** The fallback when the share picker is not available: a link that carries everything. */
async function buildSaveLink() {
  const contacted = getContacted();
  const prefs     = getPrefs();
  const recents   = getRecentSearches();
  if (!Object.keys(contacted).length && !_hasMeaningfulPrefs(prefs) && !recents.length) {
    showToast("Star or note something first");
    return;
  }
  try {
    const encoded = await _encodeSavePayload({ contacted, prefs, recents });
    const url     = location.origin + location.pathname + "#cfx=" + encoded;
    if (await window.cfCopy(url)) showToast("Save link copied, notes included");
    else prompt("Copy this save link:", url);
  } catch { showErrorToast("CF-LINK-01", "Could not build save link"); }
}

// ── Opening a share link (or a saved .json) ────────────────────────────────
//
// What a link carries is somebody else's stars, notes and contacts, so it is
// never written silently. The person is asked, in words, to merge it with
// their own, replace their own with it, or cancel; whichever they choose, the
// state from before is kept once so that it can be undone from the bar.

const IMPORT_BACKUP_KEY = "cf_import_backup";
const STATE_KEYS = { prefs: PREFS_KEY, contacted: CONTACTED_KEY, recents: RECENT_SEARCHES_KEY };

function _currentSaved() {
  return { prefs: getPrefs(), contacted: getContacted(), recents: getRecentSearches() };
}

function _readRawState() {
  const raw = {};
  Object.entries(STATE_KEYS).forEach(([name, key]) => { raw[name] = localStorage.getItem(key); });
  return raw;
}

function _writeRawState(raw) {
  Object.entries(STATE_KEYS).forEach(([name, key]) => {
    if (raw[name] == null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw[name]);
  });
}

function _refreshAfterImport() {
  updateContactedBar();
  updatePrefsBar();
  if (state.data) renderStatusStrip();
  if (state.view !== "none") renderSelection();
}

function updateUndoImportButton() {
  const btn = document.getElementById("undo-import-btn");
  if (btn) btn.hidden = !localStorage.getItem(IMPORT_BACKUP_KEY);
}

function undoImport() {
  let backup;
  try { backup = JSON.parse(localStorage.getItem(IMPORT_BACKUP_KEY) || "null"); } catch { backup = null; }
  if (!backup || !backup.raw) { updateUndoImportButton(); return; }
  _writeRawState(backup.raw);
  localStorage.removeItem(IMPORT_BACKUP_KEY);
  updateUndoImportButton();
  _refreshAfterImport();
  showToast("Put back what you had before the link");
}

function _applyImport(parsed, mode) {
  const before = _readRawState();
  const local  = _currentSaved();
  const next = {};
  if (mode === "merge") {
    if (Object.keys(parsed.prefs).length)     next.prefs     = Core.mergePrefs(local.prefs, parsed.prefs);
    if (Object.keys(parsed.contacted).length) next.contacted = Core.mergeContacted(local.contacted, parsed.contacted);
    if (parsed.recents.length)                next.recents   = Core.mergeRecents(local.recents, parsed.recents, MAX_RECENT_SEARCHES);
  } else {
    if (Object.keys(parsed.prefs).length)     next.prefs     = parsed.prefs;
    if (Object.keys(parsed.contacted).length) next.contacted = parsed.contacted;
    if (parsed.recents.length)                next.recents   = parsed.recents;
  }
  // Every value is turned into text first and the backup is written before
  // anything changes, so a full disk leaves what was there exactly as it was.
  const written = {};
  Object.entries(next).forEach(([name, value]) => { written[name] = JSON.stringify(value); });
  try {
    localStorage.setItem(IMPORT_BACKUP_KEY, JSON.stringify({ ts: Date.now(), raw: before }));
    Object.entries(written).forEach(([name, text]) => localStorage.setItem(STATE_KEYS[name], text));
  } catch {
    try { _writeRawState(before); localStorage.removeItem(IMPORT_BACKUP_KEY); } catch {  }
    showErrorToast("CF-STORE-01", "Could not save that (this browser's storage is full)");
    updateUndoImportButton();
    return false;
  }
  touchPreferenceActivity();
  updateUndoImportButton();
  _refreshAfterImport();
  return true;
}

function _importSummaryText(parsed) {
  const s = Core.summariseImport(parsed, _currentSaved());
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [];
  if (s.starred)   parts.push(n(s.starred, "star", "stars"));
  if (s.hidden)    parts.push(`${s.hidden} hidden`);
  if (s.notes)     parts.push(n(s.notes, "note", "notes"));
  if (s.contacted) parts.push(`${s.contacted} contacted`);
  if (s.recents)   parts.push(n(s.recents, "recent search", "recent searches"));
  const has = s.have.prefs + s.have.contacted + s.have.recents;
  const carries = parts.length ? parts.join(", ") : `${Object.keys(parsed.prefs).length} saved items`;
  const yours = has
    ? ` You already have ${has} saved item${has === 1 ? "" : "s"} on this device${s.have.notes ? `, including ${n(s.have.notes, "note", "notes")} of your own` : ""}.`
    : " You have nothing saved on this device yet.";
  return `This link carries ${carries}.${yours}`;
}

function _askImport(parsed) {
  const modal = document.getElementById("import-modal");
  if (!modal || typeof modal.showModal !== "function") return Promise.resolve("merge");
  document.getElementById("import-summary").textContent = _importSummaryText(parsed);
  return new Promise(resolve => {
    modal.addEventListener("close", () => resolve(modal.returnValue || "cancel"), { once: true });
    modal.returnValue = "";
    modal.showModal();
  });
}

// One entry point for both routes in: a link opened, a .json file dropped.
async function _offerImport(parsed, sourceLabel) {
  const choice = await _askImport(parsed);
  if (choice !== "merge" && choice !== "replace") { showToast("Nothing was changed"); return false; }
  if (!_applyImport(parsed, choice)) return false;
  showToast(choice === "merge"
    ? `Added what was new from the ${sourceLabel}. Yours are unchanged`
    : `Replaced your saved items with the ${sourceLabel}`, 4500);
  return true;
}

let _importing = false;
async function loadFromHash() {
  const hash = location.hash;
  const isFull = hash.startsWith("#cfx=");
  if ((!isFull && !hash.startsWith("#cf8=")) || _importing) return;
  _importing = true;
  try {
    let parsed = null;
    try {
      if (isFull) {
        parsed = _sanitizeFullImport(JSON.parse(await _decodeSavePayload(hash.slice(5))));
      } else {
        const contacted = _sanitizeContactedImport(JSON.parse(_b64DecodeUtf8(hash.slice(5))));
        parsed = contacted ? { contacted, prefs: {}, recents: [] } : null;
      }
    } catch { parsed = null; }
    // The link is dealt with either way: left in the address it would ask again on every refresh.
    history.replaceState(null, "", location.pathname + location.search);
    if (!parsed) { showErrorToast("CF-LINK-02", "That link does not contain anything Chambers Finder can use"); return; }
    await _offerImport(parsed, "link");
  } finally {
    _importing = false;
  }
}

function getActivity() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "{}"); }
  catch { return {}; }
}

function touchActivity(chambersId, type) {
  const data = getActivity();
  if (!data[chambersId]) data[chambersId] = {};
  data[chambersId][type] = Date.now();
  touchPreferenceActivity(data);
}

function touchPreferenceActivity(existingData) {
  const data = existingData || getActivity();
  if (!data._meta) data._meta = {};
  data._meta.lastModified = Date.now();
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
}

function _relativeTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)    return "just now";
  if (mins < 60)   return `${mins} min ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days === 1)  return "yesterday";
  if (days < 30)   return `${days} days ago`;
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

function updatePrefsBar() {
  updateUndoImportButton();
  const prefs = getPrefs();
  const entries = Object.entries(prefs);
  const bar  = document.getElementById("prefs-bar");
  const info = document.getElementById("prefs-bar-info");

  const nothingSaved =
    !_hasMeaningfulPrefs(prefs) &&
    !Object.keys(getContacted()).length &&
    !getRecentSearches().length;
  if (nothingSaved) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");

  if (entries.length === 0) {
    info.textContent = "Saved on this device";
    return;
  }

  const actMeta    = getActivity()._meta || {};
  const lastChange = actMeta.lastModified ? _relativeTime(actMeta.lastModified) : "";
  info.innerHTML = lastChange
    ? `Local preferences changed <strong>${escapeHtml(lastChange)}</strong>`
    : "Local preferences saved on this device";
}

let _toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("visible"), duration);
}

// A message with its error code after it (error-codes.js); the message alone if that file did not load.
function withCode(msg, code) {
  return window.CFErrorCodes ? window.CFErrorCodes.withCode(msg, code) : msg;
}

// A toast that says something failed, with its error code, up a little longer than a plain one.
function showErrorToast(code, msg, duration = 4000) {
  showToast(withCode(msg, code), duration);
}

async function copyToClipboard(value, label) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (await window.cfCopy(text)) {
    showToast(`${label} copied`);
    return true;
  }
  prompt(`Copy ${label.toLowerCase()}:`, text);
  return false;
}

function _matchesSearchText(query, value) {
  return typeof value === "string" && !!value.trim() && Core.matches(query, value);
}

function _branchCountLabel(ch) {
  return `${ch.branches.length} branch${ch.branches.length === 1 ? "" : "es"}`;
}

function _matchingBranchLabels(query, ch) {
  const labels = [];
  ch.branches.forEach(branch => {
    const fields = [branch.city, branch.name, branch.address].filter(Boolean);
    if (!fields.some(field => _matchesSearchText(query, field))) return;
    const label = branch.city || branch.name || branch.address;
    if (label && !labels.includes(label)) labels.push(label);
  });
  return labels;
}

function _courtSearchEntry(court, query) {
  const score = Core.scoreCourt(query, court);
  if (score === null) return null;
  return {
    type:     "court",
    label:    court.name,
    sublabel: court.location || "",
    obj:      court,
    score,
  };
}

function _chamberSearchEntry(ch, query) {
  const score = Core.scoreChambers(query, ch);
  if (score === null) return null;
  const branchMatches = _matchingBranchLabels(query, ch);

  let sublabel = _branchCountLabel(ch);
  if (branchMatches.length) {
    const visibleBranches = branchMatches.slice(0, 2).join(", ");
    const moreBranches = branchMatches.length > 2 ? ` +${branchMatches.length - 2}` : "";
    sublabel = `${visibleBranches}${moreBranches} · ${sublabel}`;
  }

  return {
    type:     "chambers",
    label:    ch.name,
    sublabel,
    obj:      ch,
    score,
  };
}

function getRecentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function _pushRecentSearch(entry) {
  const id = entry.obj?.id;
  if (!id) return;
  const recents = getRecentSearches().filter(r => !(r.type === entry.type && r.id === id));
  recents.unshift({ type: entry.type, id, label: entry.label, sublabel: entry.sublabel || "" });
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recents.slice(0, MAX_RECENT_SEARCHES)));
  updatePrefsBar();
}

function _removeRecentSearch(type, id) {
  const recents = getRecentSearches().filter(r => !(r.type === type && r.id === id));
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recents));
  updatePrefsBar();
  renderRecentSearches();
}

// Recent searches are ordinary options in the suggestion list, so the arrow
// keys and Enter reach them like any other. The little cross is a mouse
// convenience only (hidden from assistive technology, out of the tab order):
// with a recent highlighted, the Delete key removes it.
function renderRecentSearches() {
  const el = document.getElementById("search-results");
  const recents = getRecentSearches().map(r => {
    const source = r.type === "court" ? state.data?.courts : state.data?.chambers;
    const obj = source?.find(o => o.id === r.id);
    // The name shown comes from the data file, not from what was saved, so a shared link cannot put its own words
    // in the list under a real court's or chambers' identity.
    return obj ? { type: r.type, label: obj.name, sublabel: r.type === "court" ? (obj.location || "") : _branchCountLabel(obj), obj } : null;
  }).filter(Boolean);
  el.innerHTML = "";
  _searchActiveIndex = -1;
  state.searchResults = recents;

  if (!recents.length) { _closeSearchResults(); return; }

  const header = document.createElement("div");
  header.className = "search-group-label";
  header.textContent = "Recent";
  header.setAttribute("role", "presentation");
  el.appendChild(header);

  recents.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "search-item-recent";
    row.setAttribute("role", "presentation");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-item";
    btn.id = `search-option-${i}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", "false");
    btn.tabIndex = -1;
    btn.innerHTML =
      `<strong>${escapeHtml(entry.label)}</strong>` +
      `<small>${escapeHtml(entry.sublabel)}</small>`;
    btn.addEventListener("click", () => chooseResult(entry));

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "search-item-remove";
    rm.tabIndex = -1;
    rm.setAttribute("aria-hidden", "true");
    rm.title = "Remove from recent searches";
    rm.innerHTML = icon("close");
    rm.addEventListener("click", e => {
      e.stopPropagation();
      _removeRecentSearch(entry.type, entry.obj.id);
    });

    row.appendChild(btn);
    row.appendChild(rm);
    el.appendChild(row);
  });

  el.setAttribute("aria-label", "Recent searches. Press Delete to remove the highlighted one");
  el.style.display = "block";
  _setSearchExpanded(true);
}

function doSearch(query) {
  if (!state.data || !query.trim()) {
    state.searchResults = [];
    renderRecentSearches();
    return;
  }
  const q = query.toLowerCase();

  const prefs = getPrefs();
  // Best match first (exact name, then the name's start, then words inside it,
  // then looser matches), so Enter takes the court that was meant.
  const courts = Core.rankEntries(state.data.courts
    .filter(c => !(prefs[_courtPrefKey(c.id)] || {}).hidden)
    .map(c => _courtSearchEntry(c, q))
    .filter(Boolean));

  const chambers = Core.rankEntries(state.data.chambers
    .filter(ch => !(prefs[ch.id] || {}).hidden)
    .map(ch => _chamberSearchEntry(ch, q))
    .filter(Boolean));

  const perGroupLimit = courts.length && chambers.length
    ? BALANCED_SEARCH_RESULTS_PER_GROUP
    : MAX_SEARCH_RESULTS_PER_GROUP;

  // GIR 0AA and BFPO numbers are real postcodes with no place: say so instead of listing nothing.
  const special = Core.locatePostcode(query, {}).error;
  if (special && special.indexOf("special-") === 0) _renderLookupProblem(special, true);
  const pp = Core.parsePostcode(query);
  const shown = pp ? (pp.postcode || pp.outcode) : "";
  const postcode = pp
    ? [
        {
          type:     "postcode",
          label:    `Search chambers near ${shown}`,
          sublabel: "Chambers close to this postcode",
          obj:      { raw: query.trim(), mode: "chambers" },
        },
        {
          type:     "postcode",
          label:    `Search courts near ${shown}`,
          sublabel: "Courts close to this postcode",
          obj:      { raw: query.trim(), mode: "courts" },
        },
      ]
    : [];
  // A complete postcode is shown at once (chambers near it), as it is typed; the two
  // "search near" entries stay in the list for switching to courts.
  if (pp && pp.incode && _postcodeTable) {
    const located = Core.locatePostcode(query, _postcodeTable);
    if (located.result) {
      _runPostcodeLookup({ obj: { raw: query.trim(), mode: "chambers" } }, true);
    } else if (located.error && state.selectedCourt && String(state.selectedCourt.id || "").startsWith("postcode:")) {
      // A complete postcode that is not recognised must not leave the previous postcode's results on screen.
      _renderLookupProblem(located.error, true, located.place);
    }
  }

  state.searchResults = [
    ...postcode,
    ...courts.slice(0, perGroupLimit),
    ...chambers.slice(0, perGroupLimit),
  ];
  renderSearchResults();

  // A postcode or outcode only offers "Search near ..." in the list. It is
  // never resolved on its own: choosing it (click, or Enter on it) is the
  // deliberate step, the same as picking a court or chambers from the list.
}

let _searchActiveIndex = -1;

function _setSearchExpanded(expanded) {
  const input = document.getElementById("search-input");
  input.setAttribute("aria-expanded", String(expanded));
  if (!expanded) input.removeAttribute("aria-activedescendant");
}

function _closeSearchResults() {
  document.getElementById("search-results").style.display = "none";
  _searchActiveIndex = -1;
  _setSearchExpanded(false);
}

function _updateSearchActive() {
  const options = document.querySelectorAll("#search-results .search-item");
  options.forEach((opt, i) => {
    const active = i === _searchActiveIndex;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-selected", String(active));
  });
  const input    = document.getElementById("search-input");
  const activeEl = options[_searchActiveIndex];
  if (activeEl) {
    input.setAttribute("aria-activedescendant", activeEl.id);
    activeEl.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function _moveSearchActive(delta) {
  const n = state.searchResults.length;
  if (!n) return;

  _searchActiveIndex = _searchActiveIndex === -1
    ? (delta > 0 ? 0 : n - 1)
    : (_searchActiveIndex + delta + n) % n;
  _updateSearchActive();
}

function renderSearchResults() {
  const el = document.getElementById("search-results");
  el.innerHTML = "";
  el.setAttribute("aria-label", "Search suggestions");
  _searchActiveIndex = -1;
  if (!state.searchResults.length) {
    const query = document.getElementById("search-input")?.value.trim();
    if (query) {
      const empty = document.createElement("div");
      empty.className = "search-empty-state";
      empty.setAttribute("role", "presentation");
      empty.textContent = `No courts or chambers found for "${query}".`;
      el.appendChild(empty);
      el.style.display = "block";
      _setSearchExpanded(true);
      return;
    }
    _closeSearchResults();
    return;
  }

  const postcode = state.searchResults.filter(e => e.type === "postcode");
  const courts   = state.searchResults.filter(e => e.type === "court");
  const chambers = state.searchResults.filter(e => e.type === "chambers");

  let optIndex = 0;
  function addGroup(label, items) {
    if (!items.length) return;
    const header = document.createElement("div");
    header.className = "search-group-label";
    header.textContent = label;
    header.setAttribute("role", "presentation");
    el.appendChild(header);
    items.forEach(entry => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      btn.id = `search-option-${optIndex++}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      btn.tabIndex = -1;
      btn.innerHTML =
        `<strong>${escapeHtml(entry.label)}</strong>` +
        `<small>${escapeHtml(entry.sublabel)}</small>`;
      btn.addEventListener("click", () => chooseResult(entry));
      el.appendChild(btn);
    });
  }

  addGroup("Your postcode", postcode);
  addGroup("Courts", courts);
  addGroup("Chambers", chambers);
  el.style.display = "block";
  _setSearchExpanded(true);
}

// Locating a postcode is instant and local. `auto` is a complete postcode typed into the box:
// the chambers list appears at once, without touching what is being typed or closing the list.
async function _runPostcodeLookup(entry, auto = false) {
  const raw = entry.obj.raw;
  let table;
  try { table = await loadPostcodeTable(); }
  catch { if (!auto) _renderLookupProblem("unavailable"); return; }
  const answer = Core.locatePostcode(raw, table);
  if (answer.error) { if (!auto) _renderLookupProblem(answer.error, false, answer.place); return; }
  const result = answer.result;
  if (!auto) document.getElementById("search-input").value = result.postcode || result.outcode;
  state.view            = "court";
  state.selectedCourt   = _locationToCourt(result);
  state.selectedCourt.searchMode = entry.obj.mode || "chambers";
  state.selectedChamber = null;
  state.fromCourt       = null;
  if (auto) {
    // Keep the caret in the box: showing the list must not take focus from what is being typed.
    const before = _keepFocus;
    _keepFocus = true;
    try { renderSelection(); } finally { _keepFocus = before; }
    _closeSearchResults();
  } else {
    renderSelection();
  }
}

// The postcode was not recognised, is outside England and Wales, or the table did not load: say which, in the results area.
// Never ranks anything from a made-up place.
function _renderLookupProblem(kind, quiet = false, place = "") {
  state.view = "none";
  state.selectedCourt = null;
  syncStatusHighlight();
  const el = document.getElementById("results");
  // A postcode outside England and Wales is not an error: a plain note, no alert styling, no toast.
  if (kind === "outside") {
    el.innerHTML = `
    <div class="lookup-problem lookup-info" role="status">
      <p>${escapeHtml(Core.lookupMessage(kind, place))}</p>
    </div>`;
    return;
  }
  // The table not loading is an error, with a code; a postcode that is not recognised is an answer, with none.
  const code = kind === "unavailable" ? "CF-POSTCODE-01" : null;
  el.innerHTML = `
    <div class="lookup-problem" role="alert">
      <p>${escapeHtml(withCode(Core.lookupMessage(kind), code))}</p>
    </div>`;
  if (!quiet) showToast(withCode(code ? "Postcode data did not load" : "Postcode not recognised", code), 3000);
}

async function chooseResult(entry) {
  document.getElementById("search-input").value = entry.label;
  document.getElementById("search-clear-btn").style.display = "flex";
  _closeSearchResults();
  state.searchResults = [];

  if (entry.type === "postcode") {
    // Not pushed to Recent: recents are looked up by id against
    // state.data.courts and state.data.chambers, and a located postcode is in
    // neither. Typing the same postcode again finds it just as fast.
    await _runPostcodeLookup(entry);
    return;
  }

  _pushRecentSearch(entry);

  if (entry.type === "court") {
    state.view           = "court";
    state.selectedCourt  = entry.obj;
    state.selectedChamber = null;
    state.fromCourt      = null;
  } else {
    state.view            = "chamber";
    state.selectedChamber = entry.obj;
    state.selectedCourt   = null;
    state.fromCourt       = null;
  }
  renderSelection();
}

function renderRadiusButtons() {
  const group = document.getElementById("radius-group");

  const label = group.querySelector(".radius-label");
  group.innerHTML = "";
  if (label) group.appendChild(label);

  RADII.forEach((r, i) => {
    const btn = document.createElement("button");
    btn.className = "radius-btn" + (state.radiusMiles === r ? " active" : "");
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(state.radiusMiles === r));
    btn.textContent = RADIUS_LABELS[i];
    btn.addEventListener("click", () => {
      state.radiusMiles = r;
      renderRadiusButtons();
      if (state.view !== "none") renderSelection();
    });
    group.appendChild(btn);
  });
}

function chambersForCourt(court) {
  const prefs = getPrefs();
  return Core.rankChambersFromPoint(state.data.chambers, court, {
    isBranchHidden: (ch, b) => !!(prefs[_branchPrefKey(ch.id, b)] || {}).hidden,
    isChambersHidden: (ch) => !!(prefs[ch.id] || {}).hidden,
    isStarred: (ch) => !!(prefs[ch.id] || {}).starred,
  });
}

// Focus moves to the results when what they show changes (a new court, a
// chambers, a list). Starring or hiding something re-draws the same view and
// must leave focus on the button that was pressed: see _withKeptFocus.
let _keepFocus = false;
function _focusResults() {
  if (_keepFocus) return;
  document.getElementById("results")?.focus({ preventScroll: true });
}

function _focusKey(el) {
  if (!el || !el.closest || !el.closest("#results")) return null;
  const branch = el.getAttribute("data-branch-key");
  const extra = branch != null ? `[data-branch-key="${CSS.escape(branch)}"]` : "";
  for (const attr of ["data-star", "data-eye", "data-branch-star", "data-branch-eye", "data-pref-star", "data-pref-hide",
                      "data-clear-court", "data-clear-chamber", "data-clear-contact-key", "id"]) {
    const v = el.getAttribute(attr);
    if (v) return `[${attr}="${CSS.escape(v)}"]${extra}`;
  }
  return null;
}

// Runs a re-draw and puts focus back on the same control, so a keyboard user
// can press Star again or Tab on, instead of being sent to the top of the list.
function _withKeptFocus(redraw) {
  const key = _focusKey(document.activeElement);
  _keepFocus = true;
  try { redraw(); } finally { _keepFocus = false; }
  if (!key) return;
  const again = document.querySelector(key);
  if (again) again.focus({ preventScroll: true });
  else document.getElementById("results")?.focus({ preventScroll: true });
}

function renderSelection() {
  const prefs = getPrefs();
  if      (state.view === "court")          renderCourt(state.selectedCourt);
  else if (state.view === "chamber")        renderChamber(state.selectedChamber);
  else if (state.view === "all-chambers")   renderBrowseChambers(state.data.chambers.filter(ch => !(prefs[ch.id]||{}).hidden).sort((a,b)=>a.name.localeCompare(b.name)), null, "visibility_off", "Chambers you hide won't appear in this list.");
  else if (state.view === "all-courts")     renderBrowseCourts(state.data.courts.filter(c => !(prefs[_courtPrefKey(c.id)]||{}).hidden).sort((a,b)=>a.name.localeCompare(b.name)));
  else if (state.view === "starred")        renderStarredHidden("starred");
  else if (state.view === "hidden")         renderStarredHidden("hidden");
  else if (state.view === "noted")          renderStarredHidden("noted");
  else if (state.view === "contacted")      renderContactedList();
}

function renderStarredHidden(kind) {
  const prefs = getPrefs();

  const field = kind === "noted" ? "notes" : kind;
  const has   = entry => !!(entry || {})[field];

  const courts = state.data.courts
    .filter(c => has(prefs[_courtPrefKey(c.id)]))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chambers = state.data.chambers
    .filter(ch => has(prefs[ch.id]))
    .sort((a, b) => a.name.localeCompare(b.name));

  const branches = [];
  state.data.chambers.forEach(ch => {
    (ch.branches || []).forEach(b => {
      if (has(prefs[_branchPrefKey(ch.id, b)])) branches.push({ chambers: ch, branch: b });
    });
  });
  branches.sort((a, b) =>
    (a.branch.city || "").localeCompare(b.branch.city || "") ||
    a.chambers.name.localeCompare(b.chambers.name));

  const el = document.getElementById("results");
  if (!courts.length && !chambers.length && !branches.length) {
    const emptyIcon = kind === "starred" ? "star" : kind === "noted" ? "edit_note" : "visibility_off";
    const emptyText = kind === "starred"
      ? "Courts and chambers you star will appear here."
      : kind === "noted"
        ? "Anything you write a note on will appear here."
        : "Courts and chambers you hide will appear here.";
    el.innerHTML = `<div class="results-placeholder"><div class="big-icon">${icon(emptyIcon)}</div><p>${escapeHtml(emptyText)}</p></div>`;
    _focusResults();
    return;
  }

  const metaFor = (entry, fallback) =>
    kind === "noted" ? escapeHtml((entry || {}).notes || "") : fallback;

  const label = kind === "starred" ? "Starred" : kind === "noted" ? "Noted" : "Hidden";

  const courtRows = courts.map(court => `
    <div class="browse-row" data-court-id="${escapeHtml(court.id)}"><button type="button" class="browse-row-open" title="View ${escapeHtml(court.name)}">
      <span class="browse-row-content">
        <span class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(court.name)}</span>
        </span>
        <span class="browse-row-meta">${metaFor(prefs[_courtPrefKey(court.id)], escapeHtml(court.location || ""))}</span>
      </span></button>
      <button type="button" class="search-item-remove" data-clear-court="${escapeHtml(court.id)}" aria-label="Remove ${escapeHtml(court.name)} from ${label}">${icon("close")}</button>
    </div>`).join("");

  const chamberRows = chambers.map(ch => {
    const branchList = (ch.branches || []).map(b => escapeHtml(b.city || b.name)).join(" · ");
    const fallback = `${(ch.branches || []).length} branch${(ch.branches || []).length === 1 ? "" : "es"}${branchList ? ` · ${branchList}` : ""}`;
    return `
    <div class="browse-row" data-ch-id="${escapeHtml(ch.id)}"><button type="button" class="browse-row-open" title="View ${escapeHtml(ch.name)}">
      <span class="browse-row-content">
        <span class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(ch.name)}</span>
        </span>
        <span class="browse-row-meta">${metaFor(prefs[ch.id], fallback)}</span>
      </span></button>
      <button type="button" class="search-item-remove" data-clear-chamber="${escapeHtml(ch.id)}" aria-label="Remove ${escapeHtml(ch.name)} from ${label}">${icon("close")}</button>
    </div>`;
  }).join("");

  const branchRows = branches.map(({ chambers: ch, branch }) => `
    <div class="browse-row" data-ch-id="${escapeHtml(ch.id)}"><button type="button" class="browse-row-open" title="View ${escapeHtml(ch.name)}">
      <span class="browse-row-content">
        <span class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(branch.city || branch.name || "Branch")}</span>
          <span class="badge">${escapeHtml(ch.name)}</span>
        </span>
        <span class="browse-row-meta">${metaFor(prefs[_branchPrefKey(ch.id, branch)], escapeHtml(branch.address || ""))}</span>
      </span></button>
      <button type="button" class="search-item-remove" data-clear-branch-ch="${escapeHtml(ch.id)}" data-clear-branch-key="${escapeHtml(_branchKey(branch))}" aria-label="Remove ${escapeHtml(branch.city || branch.name || "branch")} from ${label}">${icon("close")}</button>
    </div>`).join("");

  el.innerHTML = `
    ${courts.length ? `
    <div class="card card-flush card-flush-gap">
      <div class="browse-header">${label} Courts (${courts.length})</div>
      <div class="browse-list">${courtRows}</div>
    </div>` : ""}
    ${chambers.length ? `
    <div class="card card-flush card-flush-gap">
      <div class="browse-header">${label} Chambers (${chambers.length})</div>
      <div class="browse-list">${chamberRows}</div>
    </div>` : ""}
    ${branches.length ? `
    <div class="card card-flush">
      <div class="browse-header">${label} Branches (${branches.length})</div>
      <div class="browse-list">${branchRows}</div>
    </div>` : ""}`;

  el.querySelectorAll("[data-court-id]").forEach(row => {
    const open = () => {
      const court = state.data.courts.find(c => c.id === row.dataset.courtId);
      if (court) { state.view = "court"; state.selectedCourt = court; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
  });
  el.querySelectorAll("[data-ch-id]").forEach(row => {
    const open = () => {
      const ch = state.data.chambers.find(c => c.id === row.dataset.chId);
      if (ch) {
        if (!getChamberPrefs(ch.id).seen) { setChamberPrefs(ch.id, { seen: Date.now() }); updatePrefsBar(); }
        state.view = "chamber"; state.selectedChamber = ch; state.fromCourt = null; renderSelection(); syncStatusHighlight();
      }
    };
    row.addEventListener("click", open);
  });

  const clearValue = field === "notes" ? "" : false;
  const afterClear = () => {
    showToast(`Removed from ${label}`);
    _withKeptFocus(() => renderStarredHidden(kind));
    renderStatusStrip();
  };
  el.querySelectorAll("[data-clear-court]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      setCourtPrefs(btn.dataset.clearCourt, { [field]: clearValue });
      afterClear();
    });
  });
  el.querySelectorAll("[data-clear-chamber]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      setChamberPrefs(btn.dataset.clearChamber, { [field]: clearValue });
      afterClear();
    });
  });
  el.querySelectorAll("[data-clear-branch-ch]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const ch = state.data.chambers.find(c => c.id === btn.dataset.clearBranchCh);
      const branch = ch?.branches.find(b => _branchKey(b) === btn.dataset.clearBranchKey);
      if (!branch) return;
      setBranchPrefs(ch.id, branch, { [field]: clearValue });
      afterClear();
    });
  });

  _focusResults();
}

// Real courts near a location, sorted by distance: the same haversine sort as
// chambersForCourt, but over state.data.courts instead of the chambers. Used
// only for a synthetic postcode "court" (see _locationToCourt): a real selected
// court has no reason to show "courts near this court", only a postcode does.
function courtsForLocation(loc, limit) {
  return Core.courtsByDistance(state.data.courts, loc, limit);
}

function renderCourt(court) {
  const all          = chambersForCourt(court);
  const hiddenRows   = all.filter(r => r.hidden);

  const visibleRows  = state.showHidden ? all : all.filter(r => !r.hidden);
  const inRadius     = state.radiusMiles === null
    ? visibleRows
    : visibleRows.filter(r => r.distance <= state.radiusMiles);
  const outOfRadius  = state.radiusMiles === null
    ? []
    : visibleRows.filter(r => r.distance > state.radiusMiles);
  const radiusLabel  = state.radiusMiles ? `${state.radiusMiles} mi` : "all distances";
  const hiddenNote   = hiddenRows.length
    ? ` · ${hiddenRows.length} hidden <button type="button" class="link-btn" id="toggle-hidden-btn">${state.showHidden ? "hide" : "show"}</button>`
    : "";
  // A postcode search builds a synthetic, unstored "court" (see
  // _locationToCourt) purely to reuse this render and radius-search path. It
  // is not in state.data.courts, so star, hide and notes would silently write
  // prefs that renderStarredHidden() can never find again (that view only
  // iterates the real court list). The actions row and notes are left out
  // entirely rather than shown as controls that look as if they work.
  const isPostcodeCourt = court.id.startsWith("postcode:");
  // A postcode search is either "chambers near" or "courts near" (the two
  // dropdown entries); each shows only its own list.
  const courtsOnly   = isPostcodeCourt && court.searchMode === "courts";
  const chambersOnly = isPostcodeCourt && !courtsOnly;
  const courtPrefs   = isPostcodeCourt ? {} : getCourtPrefs(court.id);
  const courtStarClass = courtPrefs.starred ? "pref-toggle-btn on-star" : "pref-toggle-btn";
  const courtHideClass = courtPrefs.hidden  ? "pref-toggle-btn on-hide" : "pref-toggle-btn";
  const courtStarLabel = courtPrefs.starred
    ? `${icon("star", "icon-fill")} Starred`
    : `${icon("star")} Star this court`;
  const courtHideLabel = courtPrefs.hidden
    ? `${icon("visibility_off")} Hidden`
    : `${icon("visibility")} Hide this court`;
  const courtActionsHtml = isPostcodeCourt ? "" : `
      <div class="court-actions-row">
        <button class="${courtStarClass}" id="court-star-btn">${courtStarLabel}</button>
        <button class="${courtHideClass}" id="court-hide-btn">${courtHideLabel}</button>
      </div>
      ${_notesSectionHtml("court-" + escapeHtml(court.id), courtPrefs.notes)}`;

  let html = `
    <div class="court-header">
      <h2>${icon("account_balance")} ${escapeHtml(court.name)}</h2>
      <div class="court-meta">${escapeHtml(court.location || "")}</div>
      ${isPostcodeCourt ? `<div class="pc-mode" role="group" aria-label="Show chambers or courts near this postcode">
        <button type="button" class="radius-btn${courtsOnly ? "" : " active"}" data-pc-mode="chambers" aria-pressed="${!courtsOnly}">Chambers</button>
        <button type="button" class="radius-btn${courtsOnly ? " active" : ""}" data-pc-mode="courts" aria-pressed="${courtsOnly}">Courts</button>
      </div>` : ""}
      <div class="court-stats">
        ${courtsOnly
          ? (() => {
              const cs = courtsForLocation(court);
              const split = Core.splitByRadius(cs, state.radiusMiles);
              const within = split.near.length;
              const further = split.far.length;
              return `${within} court${within === 1 ? "" : "s"} within ${radiusLabel}${further ? ` · ${further} further away` : ""}`;
            })()
          : `${inRadius.length} chambers within ${radiusLabel}${outOfRadius.length ? ` · ${outOfRadius.length} further away` : ""}${hiddenNote}`}
      </div>
      ${courtActionsHtml}
    </div>
  `;

  // A postcode is measured from like a court: the courts near it are listed the same way
  // as the chambers (inside the travel radius first, the rest beyond it), and a chambers
  // search also shows the courts nearest the postcode, each opening that court.
  const placeName = court.name.replace(/^Near /, "");
  const courtRowHtml = ({ court: c, distance }, far) => `
        <div class="browse-row${far ? " browse-row--far" : ""}" data-nearby-court-id="${escapeHtml(c.id)}"><button type="button" class="browse-row-open"
             title="View ${escapeHtml(c.name)}">
          <span class="browse-row-content">
            <span class="browse-row-main">
              <span class="browse-row-name">${escapeHtml(c.name)}</span>
              <span class="badge orange">${distance.toFixed(1)} mi</span>
            </span>
            <span class="browse-row-meta">${escapeHtml(c.location || "")}</span>
          </span></button>
        </div>`;
  if (courtsOnly) {
    const all = courtsForLocation(court);
    const { near, far } = Core.splitByRadius(all, state.radiusMiles);
    html += `<div class="browse-header browse-header--standalone">Courts near ${escapeHtml(placeName)}</div>`;
    html += `<div class="chambers-list" id="courts-list-inner">`;
    if (!near.length) {
      html += `<div class="empty-msg">No courts within ${radiusLabel}. Try a wider travel radius.</div>`;
    }
    near.forEach(r => { html += courtRowHtml(r, false); });
    if (far.length) {
      const shown = far.slice(0, 8);
      html += `<div class="outside-radius-header">Beyond ${state.radiusMiles} miles · ${far.length} more court${far.length === 1 ? "" : "s"}${far.length > shown.length ? `, nearest ${shown.length} shown` : ""}</div>`;
      shown.forEach(r => { html += courtRowHtml(r, true); });
    }
    html += `</div>`;
  } else if (chambersOnly) {
    const nearest = courtsForLocation(court, 3);
    html += `<div class="browse-header browse-header--standalone">Nearest courts to ${escapeHtml(placeName)}</div>`;
    html += `<div class="chambers-list" id="courts-list-inner">${nearest.map(r => courtRowHtml(r, false)).join("")}</div>`;
    html += `<div class="browse-header browse-header--standalone">Chambers near ${escapeHtml(placeName)}</div>`;
  }

  if (courtsOnly) {
    document.getElementById("results").innerHTML = html;
    _bindNearbyCourtRows();
    _bindPostcodeMode(court);
    _focusResults();
    return;
  }

  html += `<div class="chambers-list" id="chambers-list-inner">`;

  if (inRadius.length === 0 && outOfRadius.length === 0) {
    html += `<div class="empty-msg">Try a wider travel radius, or check back as more data is added.</div>`;
  } else if (inRadius.length === 0 && isPostcodeCourt) {
    html += `<div class="empty-msg">No chambers within ${radiusLabel}. Try a wider travel radius.</div>`;
  }

  inRadius.forEach(row => { html += _chamberListItemHtml(row, false); });

  // A postcode search lists only the nearest chambers beyond the radius (the rest is a long tail
  // that is no help).
  const farRows = isPostcodeCourt ? outOfRadius.slice(0, 10) : outOfRadius;
  if (farRows.length > 0) {
    html += `<div class="outside-radius-header">Beyond ${state.radiusMiles} miles · ${outOfRadius.length} more chamber${outOfRadius.length === 1 ? "" : "s"}${farRows.length < outOfRadius.length ? `, nearest ${farRows.length} shown` : ""}</div>`;
    farRows.forEach(row => { html += _chamberListItemHtml(row, true); });
  }

  html += `</div>`;
  document.getElementById("results").innerHTML = html;
  _bindListItemEvents(court);
  _bindNearbyCourtRows();
  _bindPostcodeMode(court);
  if (!isPostcodeCourt) {
    document.getElementById("court-star-btn").addEventListener("click", () => {
      const cp = getCourtPrefs(court.id);
      setCourtPrefs(court.id, { starred: !cp.starred });
      showToast(cp.starred ? "Removed from starred" : "Starred");
      _withKeptFocus(() => renderCourt(court));
      renderStatusStrip();
    });
    document.getElementById("court-hide-btn").addEventListener("click", () => {
      const cp = getCourtPrefs(court.id);
      setCourtPrefs(court.id, { hidden: !cp.hidden });
      showToast(cp.hidden ? "Court is now visible again" : "Court will now be hidden");
      _withKeptFocus(() => renderCourt(court));
      renderStatusStrip();
    });
    _bindNotesInput("court-" + court.id, val => setCourtPrefs(court.id, { notes: val }));
  }
  document.getElementById("toggle-hidden-btn")?.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    _withKeptFocus(() => renderCourt(court));
  });
  _focusResults();
}

// Rows under "Courts near X" open the real court they name.
// Chambers or courts near a postcode: one search, two views, switched here.
function _bindPostcodeMode(court) {
  document.querySelectorAll("[data-pc-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      court.searchMode = btn.dataset.pcMode;
      _withKeptFocus(() => renderCourt(court));
    });
  });
}

function _bindNearbyCourtRows() {
  document.querySelectorAll("[data-nearby-court-id]").forEach(row => {
    const open = () => {
      const real = state.data.courts.find(c => c.id === row.dataset.nearbyCourtId);
      if (real) { state.view = "court"; state.selectedCourt = real; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
  });
}

function _branchKey(branch) {
  return branch?.city || branch?.name || "";
}

function _contactValue(ch, branch, via) {
  if (via === "phone") return branch?.phone || ch?.phone || "";
  if (via === "email") return ch?.email || "";
  if (via === "address") return branch?.address || "";
  return "";
}

function _contactLabel(via) {
  if (via === "phone") return "Phone";
  if (via === "email") return "Email";
  if (via === "address") return "Address";
  return "Value";
}

function _contactIcon(via) {
  if (via === "phone") return "call";
  if (via === "email") return "mail";
  if (via === "address") return "location_on";
  return "content_copy";
}

function _copyContactButtonHtml(ch, branch, via, compact = false) {
  const value = _contactValue(ch, branch, via);
  if (!value) return "";
  const label = _contactLabel(via);
  const iconName = _contactIcon(via);
  return `
    <button class="copy-contact-btn${compact ? " compact" : ""}" type="button"
      data-copy-contact="1"
      data-contact-id="${escapeHtml(ch.id)}"
      data-contact-branch="${escapeHtml(_branchKey(branch))}"
      data-contact-name="${escapeHtml(ch.name)}"
      data-contact-via="${escapeHtml(via)}"
      data-contact-value="${escapeHtml(value)}"
      title="Copy ${escapeHtml(label.toLowerCase())}${via === "address" ? "" : " and update contacted tracking"}">
      ${icon(iconName)}
      <span class="contact-value">${escapeHtml(value)}</span>
    </button>`;
}

function _branchActionsHtml(ch, branch) {
  const bp  = getBranchPrefs(ch.id, branch);
  const key = escapeHtml(_branchKey(branch));
  const id  = escapeHtml(ch.id);
  return `
    <div class="branch-actions">
      <button class="eye-btn${bp.hidden ? " on-hide" : ""}" data-branch-eye="${id}" data-branch-key="${key}"
        title="${bp.hidden ? "Unhide this branch" : "Hide this branch"}"
        aria-label="${bp.hidden ? "Unhide branch" : "Hide branch"}">${bp.hidden ? icon("visibility_off") : icon("visibility")}</button>
      <button class="star-btn${bp.starred ? " starred" : ""}" data-branch-star="${id}" data-branch-key="${key}"
        title="${bp.starred ? "Remove star" : "Star this branch"}"
        aria-label="${bp.starred ? "Unstar branch" : "Star branch"}">${bp.starred ? icon("star", "icon-fill") : icon("star")}</button>
    </div>`;
}

function _bindBranchActions(rerender) {
  document.querySelectorAll("[data-branch-eye]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const ch = state.data.chambers.find(c => c.id === btn.dataset.branchEye);
      const branch = ch?.branches.find(b => _branchKey(b) === btn.dataset.branchKey);
      if (!branch) return;
      const bp = getBranchPrefs(ch.id, branch);
      setBranchPrefs(ch.id, branch, { hidden: !bp.hidden });
      showToast(bp.hidden ? "Branch is now visible again" : "Branch hidden");
      renderStatusStrip();
      _withKeptFocus(rerender);
    });
  });
  document.querySelectorAll("[data-branch-star]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const ch = state.data.chambers.find(c => c.id === btn.dataset.branchStar);
      const branch = ch?.branches.find(b => _branchKey(b) === btn.dataset.branchKey);
      if (!branch) return;
      const bp = getBranchPrefs(ch.id, branch);
      setBranchPrefs(ch.id, branch, { starred: !bp.starred });
      showToast(bp.starred ? "Removed from starred" : "Branch starred");
      renderStatusStrip();
      _withKeptFocus(rerender);
    });
  });
}

function _branchContactButtonsHtml(ch, branch, compact = false) {
  const buttons = [
    _copyContactButtonHtml(ch, branch, "phone", compact),
    _copyContactButtonHtml(ch, branch, "email", compact),
    _copyContactButtonHtml(ch, branch, "address", compact),
    ch.website && !compact && /^https?:\/\//i.test(ch.website)
      ? `<a class="website-link" href="${escapeHtml(ch.website)}" target="_blank" rel="noopener noreferrer">${icon("language")} Website</a>`
      : "",
  ].filter(Boolean).join("");
  return buttons ? `<div class="branch-contact${compact ? " compact-contact" : ""}">${buttons}</div>` : "";
}

function _chamberListItemHtml(row, dimmed) {
  const cp        = getChamberPrefs(row.chambers.id);
  const starClass = cp.starred ? "star-btn starred" : "star-btn";
  const itemClass = "chambers-item" + (row.hidden ? " hidden-item" : "") + (cp.seen ? " seen-item" : "");
  const inR       = !dimmed && (state.radiusMiles === null || row.distance <= state.radiusMiles);
  const distLabel = row.distance === Infinity ? "n/a" : row.distance.toFixed(1) + " mi";

  const metaParts = [];
  if (row.nearestBranch) {
    const loc = row.nearestBranch.city || row.nearestBranch.address || "";
    if (loc) metaParts.push(escapeHtml(loc));
  }
  if (cp.starred) metaParts.push(`<span class="badge starred">${icon("star", "icon-fill")} Starred</span>`);
  if (row.hidden) metaParts.push(`<span class="badge hidden-badge">Hidden</span>`);
  if (row.chambers.branches.length > 1) {
    metaParts.push(`<span class="badge">${row.chambers.branches.length} branches</span>`);
  }

  const contData = getContacted();
  const contactedVias = { phone: false, email: false };
  row.chambers.branches.forEach(b => {
    const rec = _normalizeContactRec(contData[row.chambers.id + "||" + (b.city || b.name || "")]);
    if (rec?.phone) contactedVias.phone = true;
    if (rec?.email) contactedVias.email = true;
  });
  if (contactedVias.phone) metaParts.push(`<span class="badge contacted">${icon("call")} Called</span>`);
  if (contactedVias.email) metaParts.push(`<span class="badge contacted emailed">${icon("mail")} Emailed</span>`);
  return `
    <div class="${itemClass}" data-id="${escapeHtml(row.chambers.id)}" data-court-item="1">
      <div class="chambers-item-main">
        <button type="button" class="chambers-item-open" data-open-chambers="${escapeHtml(row.chambers.id)}">
          <span class="chambers-item-name">${escapeHtml(row.chambers.name)}</span>
          <span class="chambers-item-meta">${metaParts.join("")}</span>
        </button>
        ${row.nearestBranch ? _branchContactButtonsHtml(row.chambers, row.nearestBranch, true) : ""}
      </div>
      <div class="chambers-item-actions">
        <span class="badge ${inR ? "orange" : ""}">${distLabel}</span>
        <button class="eye-btn${cp.hidden ? " on-hide" : ""}" data-eye="${escapeHtml(row.chambers.id)}"
          title="${cp.hidden ? "Unhide this chambers" : "Hide this chambers"}"
          aria-label="${cp.hidden ? "Unhide" : "Hide"}">
          ${cp.hidden ? icon("visibility_off") : icon("visibility")}
        </button>
        <button class="${starClass}" data-star="${escapeHtml(row.chambers.id)}"
          title="${cp.starred ? "Remove star" : "Star this chambers"}"
          aria-label="${cp.starred ? "Unstar" : "Star"}">${cp.starred ? icon("star", "icon-fill") : icon("star")}</button>
      </div>
    </div>
  `;
}

function _bindListItemEvents(court) {
  const list = document.getElementById("chambers-list-inner");
  if (!list) return;

  list.querySelectorAll("[data-star]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.star;
      const cp = getChamberPrefs(id);
      setChamberPrefs(id, { starred: !cp.starred });
      showToast(cp.starred ? "Removed from starred" : "Starred");
      _withKeptFocus(() => renderCourt(court));
      renderStatusStrip();
    });
  });

  list.querySelectorAll("[data-eye]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.eye;
      const cp = getChamberPrefs(id);
      setChamberPrefs(id, { hidden: !cp.hidden });
      showToast(cp.hidden ? "Chambers is now visible again" : "Chambers hidden");
      _withKeptFocus(() => renderCourt(court));
      renderStatusStrip();
    });
  });

  _bindContactButtons();

  list.querySelectorAll("[data-court-item]").forEach(item => {
    const open = () => {
      const id = item.dataset.id;
      const ch = state.data.chambers.find(c => c.id === id);
      if (ch) {
        if (!getChamberPrefs(id).seen) { setChamberPrefs(id, { seen: Date.now() }); updatePrefsBar(); }
        state.selectedChamber = ch;
        state.fromCourt = court;
        state.lastOpenedChamberId = id;
        renderChamberDetail(ch, court);
      }
    };
    // The name is a real button (Enter and Space work natively); a click anywhere
    // else on the row that is not one of its own controls opens it too.
    item.addEventListener("click", e => {
      if (e.target.closest("[data-star]") || e.target.closest("[data-eye]") || e.target.closest("[data-copy-contact]")) return;
      open();
    });
  });
}

function renderChamberDetail(ch, court) {
  const cp = getChamberPrefs(ch.id);
  const sortedBranches = _branchesSortedByDistance(ch, court);

  let branchesHtml = "";
  sortedBranches.forEach(b => {
    let distHtml = "";
    if (court) {
      const d   = haversine(court.lat, court.lon, b.lat, b.lon);
      const inR = state.radiusMiles === null || d <= state.radiusMiles;
      distHtml  = `<span class="badge ${inR ? "orange" : ""}">${isFinite(d) ? d.toFixed(1) + " mi" : "n/a"}</span>`;
    }
    const contRecord = isContacted(ch.id, b.city || b.name || "");
    const contactedHtml = _buildContactedMark(contRecord);
    const bp = getBranchPrefs(ch.id, b);
    branchesHtml += `
      <div class="branch-item${bp.hidden ? " hidden-item" : ""}">
        <div class="branch-item-header">
          <div class="branch-city">${escapeHtml(b.city || "Branch")}${bp.starred ? ` <span class="badge starred">${icon("star", "icon-fill")} Starred</span>` : ""}${bp.hidden ? ` <span class="badge hidden-badge">Hidden</span>` : ""}</div>
          <div class="branch-item-right">${distHtml}${_branchActionsHtml(ch, b)}</div>
        </div>
        <div class="branch-address">${escapeHtml(b.address || "")}</div>
        ${_branchContactButtonsHtml(ch, b)}
        ${contactedHtml}
      </div>`;
  });

  document.getElementById("results").innerHTML = `
    <div class="chamber-detail-wrap" id="chamber-detail">
      <div class="chamber-detail-header">
        <h3>${icon("gavel")} ${escapeHtml(ch.name)}</h3>
        <button class="chamber-back-btn" id="chamber-back-btn">← Back to ${escapeHtml(court ? court.name : "court")}</button>
      </div>
      ${_chamberPrefsHeaderHtml(ch.id, cp)}
      <div class="branches-list">${branchesHtml}</div>
    </div>`;

  document.getElementById("chamber-back-btn").addEventListener("click", () => {
    if (court) {
      state.view = "court";
      renderCourt(court);
      const item = document.querySelector(`[data-court-item][data-id="${ch.id}"]`);
      if (item) item.scrollIntoView({ block: "center" });
    }
    else renderPlaceholder();
  });

  _bindPrefsActions(ch.id, court,  true);
  _bindContactButtons();
  _bindBranchActions(() => renderChamberDetail(ch, court));
  _focusResults();
}

function renderChamber(ch) {
  const cp = getChamberPrefs(ch.id);
  const sortedBranches = _branchesSortedByDistance(ch, null);

  let branchesHtml = "";
  sortedBranches.forEach(b => {
    const contRecord    = isContacted(ch.id, b.city || b.name || "");
    const contactedHtml = _buildContactedMark(contRecord);
    const bp = getBranchPrefs(ch.id, b);
    branchesHtml += `
      <div class="branch-item${bp.hidden ? " hidden-item" : ""}">
        <div class="branch-item-header">
          <div class="branch-city">${escapeHtml(b.city || "Branch")}${bp.starred ? ` <span class="badge starred">${icon("star", "icon-fill")} Starred</span>` : ""}${bp.hidden ? ` <span class="badge hidden-badge">Hidden</span>` : ""}</div>
          <div class="branch-item-right">${_branchActionsHtml(ch, b)}</div>
        </div>
        <div class="branch-address">${escapeHtml(b.address || "")}</div>
        ${_branchContactButtonsHtml(ch, b)}
        ${contactedHtml}
      </div>`;
  });

  document.getElementById("results").innerHTML = `
    <div class="chamber-detail-wrap">
      <div class="chamber-detail-header">
        <h3>${icon("gavel")} ${escapeHtml(ch.name)}</h3>
      </div>
      ${_chamberPrefsHeaderHtml(ch.id, cp)}
      <div class="branches-list">${branchesHtml}</div>
    </div>`;

  _bindPrefsActions(ch.id, null,  false);
  _bindContactButtons();
  _bindBranchActions(() => renderChamber(ch));
  _focusResults();
}

function _branchesSortedByDistance(ch, court) {
  return [...ch.branches].sort((a, b) => {
    if (court) {
      return haversine(court.lat, court.lon, a.lat, a.lon) -
             haversine(court.lat, court.lon, b.lat, b.lon);
    }
    return (a.city || "").localeCompare(b.city || "");
  });
}

function _bindContactButtons() {
  document.querySelectorAll("[data-copy-contact]").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const via = button.dataset.contactVia;
      const value = button.dataset.contactValue || "";
      const label = _contactLabel(via);
      await copyToClipboard(value, label);

      if (via !== "phone" && via !== "email") return;

      const branch = button.dataset.contactBranch;
      const name   = button.dataset.contactName;
      markContacted(button.dataset.contactId, branch, name, via);

      const branchHost = button.closest(".branch-item");
      if (branchHost) {
        const markHtml = _contactedMarkInner(isContacted(button.dataset.contactId, branch));
        let mark = branchHost.querySelector(".branch-contacted-mark");
        if (!mark) {
          mark = document.createElement("div");
          mark.className = "branch-contacted-mark";
          branchHost.appendChild(mark);
        }
        mark.innerHTML = markHtml;
      }

      const listMeta = button.closest(".chambers-item-main")?.querySelector(".chambers-item-meta");
      if (listMeta) {
        const already = via === "email"
          ? listMeta.querySelector(".badge.contacted.emailed")
          : listMeta.querySelector(".badge.contacted:not(.emailed)");
        if (!already) {
          const badge = document.createElement("span");
          badge.className = via === "email" ? "badge contacted emailed" : "badge contacted";
          badge.innerHTML = via === "email" ? `${icon("mail")} Emailed` : `${icon("call")} Called`;
          listMeta.appendChild(badge);
        }
      }
    });
  });
}

function _chamberPrefsHeaderHtml(id, cp) {
  const eid       = escapeHtml(id);
  const starClass = cp.starred ? "pref-toggle-btn on-star" : "pref-toggle-btn";
  const hideClass = cp.hidden  ? "pref-toggle-btn on-hide" : "pref-toggle-btn";
  const starLabel = cp.starred
    ? `${icon("star", "icon-fill")} Starred`
    : `${icon("star")} Star this chambers`;
  const hideLabel = cp.hidden
    ? `${icon("visibility_off")} Hidden`
    : `${icon("visibility")} Hide this chambers`;

  return `
    <div class="chamber-prefs-header" id="prefs-panel-${eid}">
      <div class="prefs-actions-row">
        <button class="${starClass}" data-pref-star="${eid}">${starLabel}</button>
        <button class="${hideClass}" data-pref-hide="${eid}">${hideLabel}</button>
      </div>
      ${_notesSectionHtml(eid, cp.notes)}
    </div>`;
}

function _notesSectionHtml(domId, notes) {
  return `
    <div class="notes-section">
      <label for="notes-${domId}">${icon("edit_note")} Notes</label>
      <textarea class="notes-area" id="notes-${domId}" maxlength="${NOTES_MAX_LENGTH}" placeholder="Add a note…">${escapeHtml(notes || "")}</textarea>
      <p class="notes-char-hint"><span id="notes-char-count-${domId}">${(notes || "").length}</span> / ${NOTES_MAX_LENGTH}</p>
    </div>`;
}

function _bindNotesInput(domId, onSave) {
  const notesEl    = document.getElementById(`notes-${domId}`);
  const notesCount = document.getElementById(`notes-char-count-${domId}`);
  let notesTimer;
  notesEl?.addEventListener("input", () => {
    if (notesCount) notesCount.textContent = notesEl.value.length;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      onSave(notesEl.value);
      showToast("Notes saved");
    }, 800);
  });
}

function _bindPrefsActions(id, court, detailMode) {
  document.querySelector(`[data-pref-star="${id}"]`)?.addEventListener("click", () => {
    const cp = getChamberPrefs(id);
    setChamberPrefs(id, { starred: !cp.starred });
    showToast(cp.starred ? "Removed from starred" : "Starred");
    _withKeptFocus(() => _rerender(id, court, detailMode));
  });

  document.querySelector(`[data-pref-hide="${id}"]`)?.addEventListener("click", () => {
    const cp = getChamberPrefs(id);
    setChamberPrefs(id, { hidden: !cp.hidden });
    showToast(cp.hidden ? "Chambers is now visible again" : "Chambers will now be hidden");
    _withKeptFocus(() => _rerender(id, court, detailMode));
  });

  _bindNotesInput(id, val => setChamberPrefs(id, { notes: val }));
}

function _rerender(id, court, detailMode) {
  const ch = state.data.chambers.find(c => c.id === id);
  if (!ch) return;
  if (detailMode && court) renderChamberDetail(ch, court);
  else renderChamber(ch);
  renderStatusStrip();
}

function renderPlaceholder() {
  document.getElementById("results").innerHTML = `
    <div class="results-placeholder">
      <div class="big-icon">${icon("balance")}</div>
      <p>Search for a court to see nearby chambers, or search for a chambers to see all its branches.</p>
    </div>`;
  _focusResults();
}

function renderContactedList() {
  const data    = getContacted();
  const entries = Object.entries(data);
  const el      = document.getElementById("results");

  if (!entries.length) {
    el.innerHTML = `
      <div class="results-placeholder">
        <div class="big-icon">${icon("call")}</div>
        <p>Chambers you call or email will appear here.</p>
      </div>`;
    _focusResults();
    return;
  }

  entries.sort((a, b) => {
    const lastTs = rec => { const n = _normalizeContactRec(rec); return Math.max(n?.phone?.ts || 0, n?.email?.ts || 0); };
    return lastTs(b[1]) - lastTs(a[1]);
  });

  const rows = entries.map(([key, val]) => {
    const [chambersId, branchCity] = key.split("||");
    const ch = state.data?.chambers.find(c => c.id === chambersId);
    const norm = _normalizeContactRec(val);
    if (!norm || typeof norm !== "object") return "";
    const name   = norm.phone?.chamberName || norm.email?.chamberName || ch?.name || chambersId;
    const badges = [
      norm.phone ? `<span class="badge contacted">${icon("call")} Called</span>` : "",
      norm.email ? `<span class="badge contacted emailed">${icon("mail")} Emailed</span>` : "",
    ].filter(Boolean).join(" ");

    const timeParts = [
      norm.phone ? `Called ${_formatContactTime(norm.phone.ts)}` : "",
      norm.email ? `Emailed ${_formatContactTime(norm.email.ts)}` : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="browse-row" data-ch-id="${escapeHtml(chambersId)}"><button type="button" class="browse-row-open">
        <span class="browse-row-content">
          <span class="browse-row-main">
            <span class="browse-row-name">${escapeHtml(name)}</span>
            ${badges}
          </span>
          <span class="browse-row-meta">${escapeHtml(branchCity)}${timeParts ? " · " + escapeHtml(timeParts) : ""}</span>
        </span></button>
        <button type="button" class="search-item-remove" data-clear-contact-key="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(name)} from Contacted">${icon("close")}</button>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="card card-flush">
      <div class="browse-header">${icon("call")} Contacted (${entries.length})</div>
      <div class="browse-list">${rows}</div>
    </div>`;

  el.querySelectorAll("[data-ch-id]").forEach(row => {
    const open = () => {
      const ch = state.data?.chambers.find(c => c.id === row.dataset.chId);
      if (ch) {
        if (!getChamberPrefs(ch.id).seen) { setChamberPrefs(ch.id, { seen: Date.now() }); updatePrefsBar(); }
        state.view = "chamber"; state.selectedChamber = ch; state.fromCourt = null; renderSelection(); syncStatusHighlight();
      }
    };
    row.addEventListener("click", open);
  });
  el.querySelectorAll("[data-clear-contact-key]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const current = getContacted();
      delete current[btn.dataset.clearContactKey];
      setContacted(current);
      updateContactedBar();
      showToast("Removed from Contacted");
      _withKeptFocus(renderContactedList);
      renderStatusStrip();
    });
  });
  _focusResults();
}

function renderBrowseChambers(list, heading, emptyIcon = "star", emptyText = "None here yet.") {
  const el = document.getElementById("results");
  if (!list.length) {
    el.innerHTML = `<div class="results-placeholder"><div class="big-icon">${icon(emptyIcon)}</div><p>${escapeHtml(emptyText)}</p></div>`;
    _focusResults();
    return;
  }
  const title = heading || `All Chambers (${list.length})`;
  const rows = list.map(ch => {
    const cp = (getPrefs()[ch.id] || {});
    const badges = [
      cp.starred ? `<span class="badge starred">${icon("star", "icon-fill")} Starred</span>` : "",
      cp.hidden  ? `<span class="badge hidden-badge">Hidden</span>` : "",
    ].filter(Boolean).join("");
    const branchList = (ch.branches||[]).map(b => escapeHtml(b.city||b.name)).join(" · ");
    return `
      <div class="browse-row" data-ch-id="${escapeHtml(ch.id)}"><button type="button" class="browse-row-open"
           title="View ${escapeHtml(ch.name)}">
        <span class="browse-row-content">
          <span class="browse-row-main">
            <span class="browse-row-name">${escapeHtml(ch.name)}</span>
            ${badges}
          </span>
          <span class="browse-row-meta">
            ${(ch.branches||[]).length} branch${(ch.branches||[]).length===1?'':'es'}
            ${branchList ? ` · ${branchList}` : ""}
          </span>
        </span></button>
      </div>`;
  }).join("");
  el.innerHTML = `
    <div class="card card-flush">
      <div class="browse-header">${escapeHtml(title)}</div>
      <div class="browse-list">${rows}</div>
    </div>`;
  el.querySelectorAll(".browse-row").forEach(row => {
    const open = () => {
      const ch = state.data.chambers.find(c => c.id === row.dataset.chId);
      if (ch) {
        if (!getChamberPrefs(ch.id).seen) { setChamberPrefs(ch.id, { seen: Date.now() }); updatePrefsBar(); }
        state.view = "chamber"; state.selectedChamber = ch; state.fromCourt = null; renderSelection(); syncStatusHighlight();
      }
    };
    row.addEventListener("click", open);
  });
  _focusResults();
}

function renderBrowseCourts(list, heading) {
  const el = document.getElementById("results");
  if (!list.length) {
    el.innerHTML = `<div class="results-placeholder"><div class="big-icon">${icon("account_balance")}</div><p>No courts to show.</p></div>`;
    _focusResults();
    return;
  }
  const rows = list.map(court => {
    const cp = getCourtPrefs(court.id);
    const badges = [
      cp.starred ? `<span class="badge starred">${icon("star", "icon-fill")} Starred</span>` : "",
      cp.hidden  ? `<span class="badge hidden-badge">Hidden</span>` : "",
    ].filter(Boolean).join("");
    return `
    <div class="browse-row" data-court-id="${escapeHtml(court.id)}"><button type="button" class="browse-row-open"
         title="View ${escapeHtml(court.name)}">
      <span class="browse-row-content">
        <span class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(court.name)}</span>
          ${badges}
        </span>
        <span class="browse-row-meta">${escapeHtml(court.location||"")}</span>
      </span></button>
    </div>`;
  }).join("");
  el.innerHTML = `
    <div class="card card-flush">
      <div class="browse-header">${escapeHtml(heading || `All Courts (${list.length})`)}</div>
      <div class="browse-list">${rows}</div>
    </div>`;
  el.querySelectorAll(".browse-row").forEach(row => {
    const open = () => {
      const court = state.data.courts.find(c => c.id === row.dataset.courtId);
      if (court) { state.view = "court"; state.selectedCourt = court; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
  });
  _focusResults();
}

function syncStatusHighlight() {
  document.querySelectorAll(".status-block").forEach(b => {
    const active = b.dataset.view === state.view;
    b.classList.toggle("active-view", active);
    if (b.dataset.view) b.setAttribute("aria-pressed", String(active));
  });
}

function renderStatusStrip() {
  const { courts, chambers } = state.data;
  const prefs       = getPrefs();
  const contacted   = getContacted();
  const starred     = Object.values(prefs).filter(p => p.starred).length;
  const hidden      = Object.values(prefs).filter(p => p.hidden).length;

  const visibleChambers = chambers.filter(ch => !(prefs[ch.id] || {}).hidden);
  const visibleCourts   = courts.filter(c => !(prefs[_courtPrefKey(c.id)] || {}).hidden);
  const noted       = Object.values(prefs).filter(p => p.notes).length;
  const contactedN  = Object.keys(contacted).length;

  const interactive = `role="button" tabindex="0"`;

  const hiddenBlock = `
      <div class="status-block hidden-block" data-view="hidden" ${interactive} title="Click to see hidden courts and chambers">
        <strong>${hidden}</strong><small>hidden</small>
      </div>`;

  document.getElementById("status-strip").innerHTML = `
    <div class="status-block" data-view="all-chambers" ${interactive} title="Click to browse all chambers">
      <strong>${visibleChambers.length}</strong><small>chambers</small>
    </div>
    <div class="status-block" data-view="all-courts" ${interactive} title="Click to browse all courts">
      <strong>${visibleCourts.length}</strong><small>courts</small>
    </div>
    <div class="status-block noted-block" data-view="noted" ${interactive} title="Click to see everything you've written a note on">
      <strong>${noted}</strong><small>noted</small>
    </div>
    <div class="status-block starred-block" data-view="starred" ${interactive} title="Click to see your starred courts and chambers">
      <strong>${starred}</strong><small>starred</small>
    </div>
    <div class="status-block contacted-block" data-view="contacted" ${interactive} title="Click to see contacted chambers">
      <strong>${contactedN}</strong><small>contacted</small>
    </div>
    ${hiddenBlock}`;

  document.querySelectorAll(".status-block").forEach(block => {
    const open = () => {
      const view = block.dataset.view;
      if (!view) return;

      if (state.view === view) {
        state.view = "none";
        renderPlaceholder();
      } else {
        state.view = view;
        renderSelection();
      }
      syncStatusHighlight();
    };
    block.addEventListener("click", open);
    block.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  syncStatusHighlight();
}

function _initLegacyFileImport() {
  const prevent = e => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter", "dragover", "dragleave", "drop"].forEach(evt =>
    document.addEventListener(evt, prevent, false));

  document.addEventListener("dragover", () => document.body.classList.add("drag-active"));
  document.addEventListener("dragleave", () => document.body.classList.remove("drag-active"));

  document.addEventListener("drop", e => {
    document.body.classList.remove("drag-active");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.json$/i.test(file.name)) { showErrorToast("CF-PREFS-01", "Not a preferences .json"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let parsed = null;
      try {
        const raw = JSON.parse(reader.result);
        const looksWrapped = raw && typeof raw === "object" && !Array.isArray(raw) &&
          (raw.prefs || raw.contacted || raw.recents);
        parsed = _sanitizeFullImport(looksWrapped ? raw : { prefs: raw });
      } catch {
        showErrorToast("CF-PREFS-02", "Could not read that file");
        return;
      }
      if (!parsed) { showErrorToast("CF-PREFS-03", "No preferences in that file"); return; }
      _offerImport(parsed, "file");
    };
    reader.readAsText(file);
  });
}

async function init() {
  _initLegacyFileImport();

  renderRadiusButtons();

  const searchInput = document.getElementById("search-input");
  const searchClearBtn = document.getElementById("search-clear-btn");
  const _syncClearBtn = () => { searchClearBtn.style.display = searchInput.value ? "flex" : "none"; };
  searchInput.addEventListener("input", () => { doSearch(searchInput.value); _syncClearBtn(); });
  searchClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    _syncClearBtn();
    doSearch("");
    searchInput.focus();
  });
  _syncClearBtn();
  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim() && state.searchResults.length) {
      document.getElementById("search-results").style.display = "block";
      _setSearchExpanded(true);
    } else if (searchInput.value.trim()) {
      doSearch(searchInput.value);
    } else {
      renderRecentSearches();
    }
  });

  searchInput.addEventListener("keydown", e => {
    const isOpen = document.getElementById("search-results").style.display === "block";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) {
        if (!searchInput.value.trim()) return;
        doSearch(searchInput.value);
        if (!state.searchResults.length) return;
      }
      _moveSearchActive(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      // Typing and pressing Enter, with nothing highlighted by the arrow keys,
      // takes the top suggestion, as in any other combobox: it is the most
      // natural way to use this box (typing a postcode and pressing Enter,
      // for example). Postcode results sort first in state.searchResults, so
      // this is also the postcode match when one is present.
      // With the box empty the list is the recent searches: Enter opens one only
      // once it has been highlighted with the arrow keys.
      const idx = _searchActiveIndex >= 0 ? _searchActiveIndex : (searchInput.value.trim() ? 0 : -1);
      if (isOpen && idx >= 0 && state.searchResults[idx]) {
        e.preventDefault();
        chooseResult(state.searchResults[idx]);
      }
    } else if (e.key === "Delete" && isOpen && !searchInput.value && _searchActiveIndex >= 0) {
      const entry = state.searchResults[_searchActiveIndex];
      if (entry) {
        e.preventDefault();
        const keep = _searchActiveIndex;
        _removeRecentSearch(entry.type, entry.obj.id);
        showToast("Removed from recent searches");
        if (state.searchResults.length) { _searchActiveIndex = Math.min(keep, state.searchResults.length - 1); _updateSearchActive(); }
      }
    } else if (e.key === "Escape") {
      if (isOpen) { e.preventDefault(); _closeSearchResults(); }
    } else if (e.key === "Tab") {
      if (isOpen) _closeSearchResults();
    }
  });

  document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap")) _closeSearchResults();
  });

  document.getElementById("save-link-btn").addEventListener("click", openShareModal);
  document.getElementById("share-copy")?.addEventListener("click", copyShareLink);
  SHARE_FIELDS.forEach(k => {
    document.getElementById(`share-${k}`)?.addEventListener("change", _updateShareSize);
  });
  document.getElementById("clear-prefs-btn").addEventListener("click", () => {
    if (!confirm("Clear ALL your saved preferences? This cannot be undone.")) return;

    setPrefs({});
    localStorage.removeItem(RECENT_SEARCHES_KEY);
    updatePrefsBar();
    if (state.data) renderStatusStrip();
    showToast("All preferences cleared");
    state.showHidden = false;
    if (state.view !== "none") renderSelection();
  });

  document.getElementById("reset-session-btn").addEventListener("click", resetSession);
  document.getElementById("undo-import-btn")?.addEventListener("click", undoImport);
  updateUndoImportButton();

  setInterval(() => {
    if (!document.getElementById("prefs-bar").classList.contains("hidden")) updatePrefsBar();
  }, 60000);

  try {
    // Relative, not root-absolute: the page can be served from a subpath
    // (caseforge.uk/chambers-finder/), where a root-absolute fetch would
    // reach for the site root's finder-data.json instead. A relative fetch()
    // resolves against document.baseURI, which is why a page served from a
    // subpath must be addressed with its trailing slash.
    const resp = await fetch("finder-data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    state.data = await resp.json();

    if (!Array.isArray(state.data.courts) || !Array.isArray(state.data.chambers)) {
      throw new Error("finder-data.json is missing 'courts' or 'chambers' arrays");
    }

    if (Array.isArray(state.data.travelRadiusOptions) && state.data.travelRadiusOptions.length) {
      RADII        = state.data.travelRadiusOptions.map(Number).filter(r => r > 0 && r <= 50);
      if (!RADII.length) RADII = [20, 35, 50];
      RADIUS_LABELS = RADII.map(r => `${r} mi`);
    }
    const defaultRadius = Number(state.data.defaultTravelMiles) || 35;
    state.radiusMiles = RADII.includes(defaultRadius) ? defaultRadius : RADII[1] || 35;
    renderRadiusButtons();

    loadPostcodeTable().catch(() => {});   // starts now so a postcode is instant when it is typed
    renderStatusStrip();
    updatePrefsBar();
    updateContactedBar();
    await loadFromHash();
    // A link opened in a tab that is already on this page only changes the address.
    window.addEventListener("hashchange", loadFromHash);

    if (searchInput.value.trim()) doSearch(searchInput.value);

  } catch (err) {
    const code = "CF-DATA-01";
    const errEl = document.getElementById("load-error");
    errEl.style.display = "block";
    errEl.innerHTML =
      `<strong>Data could not be loaded.</strong> ` +
      `Ensure <code>finder-data.json</code> is served from the site root. ` +
      `<br><small class="text-muted">${escapeHtml(err.message)}</small>` +
      `<br><small class="text-muted">${escapeHtml(withCode("", code).trim())}</small>`;
    window.cfBugReport?.report({ error: err, title: "Chambers data did not load", code });
  }
}

document.addEventListener("DOMContentLoaded", init);
