/**
 * Builds Chambers Finder's postcode-district table: every outward code in England and Wales
 * (M1, SW1A, HA7, CF10 ...) with a centre point, a short label and the nation it is in, so a
 * typed postcode is placed on the map on the device, with no lookup service.
 *
 * Chambers Finder covers ENGLAND AND WALES ONLY. Scotland, Northern Ireland, Jersey, Guernsey
 * (with Alderney and Sark) and the Isle of Man are not located: the table holds no coordinates
 * for them at all. It carries only a name-only list (`x`) of the postcode areas and districts
 * that lie outside England and Wales, so that a typed postcode there can be answered with
 * "Chambers Finder covers England and Wales only" instead of "not recognised".
 *
 * Writes assets/finder/data/postcode-districts.json (committed; Hugo fingerprints it)
 * and, with --fixture, tests/fixtures/postcodes/known-postcodes.json (the accuracy test's truth).
 *
 * SOURCE (download once; not committed)
 *   The ONS Postcode Directory (ONSPD), Open Government Licence v3.0. Every live unit postcode
 *   has a latitude and longitude derived from OS Code-Point Open. Only England and Wales rows
 *   (country codes E92000001 and W92000004) are used for a coordinate. The other rows are read
 *   for one thing only, the country of the outward code (S92000003 Scotland, N92000002 Northern
 *   Ireland, L93000001 Channel Islands, M83000003 Isle of Man), and their coordinates are ignored.
 *   Download: https://www.arcgis.com/sharing/rest/content/items/9e5a92a3cfb14dc7ad43d6ea7a7b8c7f/data
 *   (ONSPD_AUG_2026.zip, item "ONS Postcode Directory (August 2026) CSV Collection", 254 MB).
 *
 * WHICH DISTRICTS ARE IN
 *   A district is in the table when most of its live postcodes are in England or Wales
 *   (border districts follow the majority: TD15 Berwick and CH1 Chester are in; TD12 and
 *   DG16 are out). Its centre is the mean of its England and Wales postcodes, after dropping
 *   any point further than max(3 km, 3 x the median distance) from their median (mis-geocoded
 *   strays). Mean over unit postcodes, not the middle of the map shape, so the point sits where
 *   the addresses are. The label is the local authority most of the district's postcodes fall
 *   in. Districts mostly in Scotland, Northern Ireland, the Channel Islands or the Isle of
 *   Man are left out and listed by name only, as below.
 *
 * THE NAME-ONLY LIST (`x`, no coordinates)
 *   nation codes: S Scotland, N Northern Ireland, J Jersey, G Guernsey, I Isle of Man.
 *   - A postcode area whose every district is outside England and Wales (AB, EH, BT, JE, GY,
 *     IM ...) is listed once by its area letters: "EH": "S".
 *   - In a mixed area (TD, DG, CA, CH, LD ...) only the outward codes that are outside England
 *     and Wales are listed: "TD12": "S".
 *   Any outward code not in `d` or `x` is "not recognised".
 *
 * RUN
 *   node scripts/build-postcode-districts.mjs --onspd ONSPD_AUG_2026.zip [--fixture]
 *   --onspd     the zip above, or a directory holding the unzipped Data/multi_csv/*.csv files
 *   --lad       optional: the "LAD ... names and codes" CSV (default: read from the zip's Documents)
 *
 * OUTPUT SHAPE
 *   { meta: {...}, d: { "M1": [lat, lon, "Manchester", "E"], ... }, x: { "EH": "S", "TD12": "S", ... } }
 *   nation in `d`: E England, W Wales.
 */
import { createReadStream, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const onspd = opt('--onspd'), ladArg = opt('--lad');
const wantFixture = args.includes('--fixture');
if (!onspd) {
  console.error('usage: node scripts/build-postcode-districts.mjs --onspd <zip|dir> [--lad file] [--fixture]');
  process.exit(2);
}

// ONS country codes. England and Wales get coordinates; the others are counted, never located.
const NATION = { E92000001: 'E', W92000004: 'W', S92000003: 'S', N92000002: 'N', L93000001: 'C', M83000003: 'I' };
const rad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(h));
}
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const cells = (line) => line.split(',').map((c) => (c.startsWith('"') ? c.slice(1, -1) : c));

async function readOnspd(handle) {
  const stats = new Map();   // outward code -> { pts: [[lat,lon]] (England and Wales only), ctry: {E:n,...}, lad: {code:n} }
  const fixtureRows = [];
  const process = async (stream) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let idx = null;
    for await (const line of rl) {
      if (!line) continue;
      if (line.startsWith('pcd7')) { const h = cells(line); idx = Object.fromEntries(h.map((n, i) => [n, i])); continue; }
      if (!idx) continue;
      const c = cells(line);
      const pcds = c[idx.pcds]; const doterm = c[idx.doterm];
      if (doterm) continue;                                   // terminated postcode
      const out = pcds.split(' ')[0];
      const nat = NATION[c[idx.ctry26cd]] || '?';
      let s = stats.get(out);
      if (!s) stats.set(out, (s = { pts: [], ctry: {}, lad: {} }));
      s.ctry[nat] = (s.ctry[nat] || 0) + 1;
      if (nat !== 'E' && nat !== 'W') continue;               // outside England and Wales: counted, never located
      const lat = Number(c[idx.lat]), lon = Number(c[idx.long]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || lat === 0) continue;
      s.pts.push([lat, lon]);
      s.lad[c[idx.lad26cd]] = (s.lad[c[idx.lad26cd]] || 0) + 1;
      if (wantFixture) fixtureRows.push([pcds, lat, lon]);
    }
  };
  if (handle.kind === 'dir') {
    for (const f of readdirSync(handle.dir).filter((n) => /ONSPD_.*_UK_.*\.csv$/i.test(n)).sort()) {
      await process(createReadStream(path.join(handle.dir, f)));
    }
  } else {
    const ls = execFileSync('unzip', ['-Z1', handle.zip], { encoding: 'utf8' }).split('\n').filter((n) => /Data\/multi_csv\/.*\.csv$/i.test(n));
    for (const f of ls) {
      const p = spawn('unzip', ['-p', handle.zip, f], { stdio: ['ignore', 'pipe', 'inherit'] });
      await process(p.stdout);
    }
  }
  return { stats, fixtureRows };
}

function ladNames(handle) {
  let text = '';
  if (ladArg) text = readFileSync(ladArg, 'utf8');
  else if (handle.kind === 'zip') {
    const name = execFileSync('unzip', ['-Z1', handle.zip], { encoding: 'utf8' }).split('\n').find((n) => /^Documents\/LAD .*names and codes.*\.csv$/i.test(n));
    if (name) text = execFileSync('unzip', ['-p', handle.zip, name], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } else {
    const dir = path.join(handle.dir, '..', '..', 'Documents');
    try { const f = readdirSync(dir).find((n) => /^LAD .*names and codes.*\.csv$/i.test(n)); if (f) text = readFileSync(path.join(dir, f), 'utf8'); } catch { /* no names: labels fall back */ }
  }
  const names = {};
  for (const row of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = row.match(/^"?([EW]\d{8})"?,(?:"([^"]+)"|([^,]+))/);   // a name may hold a comma inside quotes
    if (m) names[m[1]] = (m[2] || m[3]).replace(/, (City|County) of$/, '');   // "Bristol, City of" reads Bristol
  }
  return names;
}

const areaOf = (out) => out.match(/^[A-Z]+/)[0];
// Jersey and Guernsey share one ONS country code (Channel Islands); their postcode area tells them apart.
const outsideNation = (out, ctry) => {
  const a = areaOf(out);
  if (a === 'JE') return 'J';
  if (a === 'GY') return 'G';
  return ['S', 'N', 'I', 'C'].sort((p, q) => (ctry[q] || 0) - (ctry[p] || 0))[0];
};

const handle = onspd.toLowerCase().endsWith('.zip') ? { kind: 'zip', zip: onspd } : { kind: 'dir', dir: onspd };
const { stats, fixtureRows } = await readOnspd(handle);
const names = ladNames(handle);

const d = {};
const audit = {}; // outward code -> { n, r90 } for the report, not shipped
const outside = new Map(); // outward code -> nation, for districts mostly outside England and Wales
for (const [out, s] of stats) {
  const total = Object.values(s.ctry).reduce((a, b) => a + b, 0);
  const ewShare = ((s.ctry.E || 0) + (s.ctry.W || 0)) / total;
  if (ewShare < 0.5) { outside.set(out, outsideNation(out, s.ctry)); continue; }
  if (s.pts.length === 0) continue;                       // English or Welsh but no coordinate (non-geographic, e.g. a bank's own code): not placed
  const med = [median(s.pts.map((p) => p[0])), median(s.pts.map((p) => p[1]))];
  const dist = s.pts.map((p) => km(p, med));
  const cutoff = Math.max(3, 3 * median(dist));
  const kept = s.pts.filter((_, i) => dist[i] <= cutoff);
  const lat = kept.reduce((a, p) => a + p[0], 0) / kept.length;
  const lon = kept.reduce((a, p) => a + p[1], 0) / kept.length;
  const nation = (s.ctry.W || 0) > (s.ctry.E || 0) ? 'W' : 'E';
  const topLad = Object.entries(s.lad).sort((a, b) => b[1] - a[1])[0][0];
  const label = names[topLad] || out;
  d[out] = [Number(lat.toFixed(3)), Number(lon.toFixed(3)), label, nation];
  audit[out] = { n: s.pts.length, r90: quantile(s.pts.map((p) => km(p, [lat, lon])), 0.9) };
}

// Name-only list: a whole area when every district in it is outside England and Wales, else the outside districts.
const areasInD = new Set(Object.keys(d).map(areaOf));
const x = {};
const areaNations = new Map();
for (const [out, nat] of outside) {
  const a = areaOf(out);
  if (areasInD.has(a)) { x[out] = nat; continue; }
  (areaNations.get(a) || areaNations.set(a, new Set()).get(a)).add(nat);
}
for (const [a, nats] of areaNations) {
  if (nats.size !== 1) throw new Error(`area ${a} is outside England and Wales but spans ${[...nats]}`);
  x[a] = [...nats][0];
}

const nationNames = { E: 'England', W: 'Wales' };
const meta = {
  built: new Date().toISOString().slice(0, 10),
  count: Object.keys(d).length,
  sources: ['England and Wales: ONS Postcode Directory, August 2026 (Open Government Licence v3.0)'],
  nations: nationNames,
  outside: { S: 'Scotland', N: 'Northern Ireland', J: 'Jersey', G: 'Guernsey', I: 'the Isle of Man' },
};
const byKey = ([a], [b]) => a.localeCompare(b, 'en');
const outFile = path.join(root, 'assets/finder/data/postcode-districts.json');
mkdirSync(path.dirname(outFile), { recursive: true });
const json = JSON.stringify({ meta, d: Object.fromEntries(Object.entries(d).sort(byKey)), x: Object.fromEntries(Object.entries(x).sort(byKey)) });
writeFileSync(outFile, json + '\n');
console.log(`districts: ${meta.count}, outside list: ${Object.keys(x).length} entries, ${json.length} bytes -> ${path.relative(root, outFile)}`);
console.log('outside list:', JSON.stringify(Object.fromEntries(Object.entries(x).sort(byKey))));

// Accuracy report: how far the district centre is from each unit postcode.
const errs = [];
for (const [out, a] of Object.entries(audit)) errs.push([a.r90, out, a.n]);
errs.sort((a, b) => b[0] - a[0]);
const allR = errs.map((e) => e[0]);
console.log(`districts: ${errs.length}; 90th-percentile unit-postcode distance from its district centre: median ${median(allR).toFixed(1)} km, 90th ${quantile(allR, 0.9).toFixed(1)} km, worst ${errs[0][0].toFixed(0)} km (${errs[0][1]})`);

if (wantFixture) {
  // A repeatable sample of unit postcodes with their true coordinates for the accuracy test.
  const want = readFileSync(path.join(root, 'tests/fixtures/postcodes/wanted.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const truth = {};
  const byPc = new Map(fixtureRows.map((r) => [r[0], r]));
  for (const w of want) { const r = byPc.get(w); if (r) truth[w] = [r[1], r[2]]; }
  const fx = path.join(root, 'tests/fixtures/postcodes/known-postcodes.json');
  writeFileSync(fx, JSON.stringify({ source: 'ONS Postcode Directory, August 2026 (OGL v3.0), unit postcode coordinates, England and Wales', truth }, null, 1) + '\n');
  console.log(`fixture: ${Object.keys(truth).length} of ${want.length} wanted postcodes found -> ${path.relative(root, fx)}`);
}
