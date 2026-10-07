/**
 * The postcode-district table (assets/finder/data/postcode-districts.json, built by
 * scripts/build-postcode-districts.mjs) against known unit postcodes: how far a district's
 * centre is from a real address in it, in miles. Chambers Finder covers England and Wales only,
 * so the truth is the ONS Postcode Directory for England and Wales
 * (fixtures/postcodes/known-postcodes.json), and the table holds no coordinates for Scotland,
 * Northern Ireland, Jersey, Guernsey or the Isle of Man, only their postcode areas by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import core from '../assets/finder/js/finder-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'assets', 'finder', 'data', 'postcode-districts.json');
const table = JSON.parse(fs.readFileSync(file, 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'postcodes', 'known-postcodes.json'), 'utf8')).truth;
const finder = JSON.parse(fs.readFileSync(path.join(root, 'static', 'finder-data.json'), 'utf8'));

const MILES_PER_KM = 0.621371;
function miles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(h)) * MILES_PER_KM;
}
const locate = (pc) => core.locatePostcode(pc, table).result;

test('the table covers England and Wales and stays small enough to load with the page', () => {
  assert.ok(table.meta.count > 2300 && table.meta.count < 2600, `${table.meta.count} districts`);
  assert.equal(Object.keys(table.d).length, table.meta.count);
  assert.ok(fs.statSync(file).size < 110 * 1024, 'under 110 KB raw');
  const nations = new Set(Object.values(table.d).map((r) => r[3]));
  assert.deepEqual([...nations].sort(), ['E', 'W'], 'only England and Wales are located');
  for (const [k, r] of Object.entries(table.d)) {
    assert.ok(/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(k), `${k} is an outward code`);
    assert.equal(r.length, 4, `${k} is [lat, lon, label, nation]`);
    assert.ok(r[0] > 49.8 && r[0] < 55.9 && r[1] > -6.5 && r[1] < 1.8, `${k} is inside England and Wales (Isles of Scilly included): ${r}`);
    assert.ok(r[2] && r[2] !== k, `${k} has a label`);
  }
});

test('no coordinates, place names or licence text for anywhere outside England and Wales are shipped', () => {
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /geonames|creative commons/i);
  assert.ok(Object.values(table.x).every((v) => ['S', 'N', 'J', 'G', 'I'].includes(v)), 'the outside list holds nation codes only');
  for (const k of Object.keys(table.x)) assert.ok(!(k in table.d), `${k} is either located or outside, never both`);
  assert.ok(Object.keys(table.x).length < 60, 'the outside list is a short list of areas');
});

test('every postcode area letter combination is classified: England and Wales, outside, or not recognised', () => {
  // Postcode areas that lie wholly outside England and Wales (Royal Mail postcode areas).
  const scotland = 'AB DD DG EH FK G HS IV KA KW KY ML PA PH ZE'.split(' ');
  const ni = ['BT'], jersey = ['JE'], guernsey = ['GY'], man = ['IM'];
  const wholly = Object.fromEntries([...scotland.map((a) => [a, 'Scotland']), ...ni.map((a) => [a, 'Northern Ireland']),
    ...jersey.map((a) => [a, 'Jersey']), ...guernsey.map((a) => [a, 'Guernsey']), ...man.map((a) => [a, 'the Isle of Man'])]);
  const areasInD = new Set(Object.keys(table.d).map((k) => k.match(/^[A-Z]+/)[0]));
  assert.equal(areasInD.size + Object.keys(wholly).length, 124, 'the 124 UK postcode areas: each is located or outside');
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const combos = [...letters, ...letters.flatMap((a) => letters.map((b) => a + b))];
  let outside = 0, located = 0, unknown = 0;
  for (const area of combos) {
    for (const pc of [`${area}1 1AA`, `${area}9 9ZZ`]) {
      const a = core.locatePostcode(pc, table);
      if (wholly[area]) {
        assert.equal(a.error, 'outside', pc);
        assert.equal(a.place, wholly[area], pc);
        assert.equal(a.result, undefined, `${pc} has no point`);
        outside++;
      } else if (a.result) {
        assert.ok(areasInD.has(area), `${pc} is in a listed area`);
        located++;
      } else {
        assert.ok(['unknown', 'outside'].includes(a.error), `${pc}: ${a.error}`);
        if (a.error === 'unknown') unknown++;
        else assert.equal(area, 'TD', `${pc}: only the mixed TD area has outside districts`);
      }
    }
  }
  assert.equal(outside, Object.keys(wholly).length * 2);
  assert.ok(located > 100 && unknown > 1000, `${located} located, ${outside} outside, ${unknown} not recognised`);
  // Every located district answers; every outside area is not in the located table.
  for (const k of Object.keys(table.d)) assert.ok(core.locatePostcode(`${k} 1AA`, table).result, k);
  for (const a of Object.keys(wholly)) assert.ok(!areasInD.has(a), `${a} has no located districts`);
  // A mistyped area is not mistaken for a place outside England and Wales.
  for (const pc of ['ZZ1 1AA', 'QQ1 1AA', 'XX9 9ZZ']) assert.equal(core.locatePostcode(pc, table).error, 'unknown', pc);
});

test('a unit postcode is placed within a few miles of where it really is', (t) => {
  const rows = [];
  for (const [pc, pt] of Object.entries(truth)) {
    const r = locate(pc);
    assert.ok(r, `${pc} is located`);
    rows.push([pc, r.label, miles([r.lat, r.lon], pt)]);
  }
  assert.ok(rows.length >= 25, `${rows.length} postcodes sampled`);
  t.diagnostic(rows.map(([pc, label, e]) => `${pc.padEnd(9)} ${label.padEnd(22)} ${e.toFixed(1)} mi`).join('\n'));
  for (const [pc, , e] of rows) assert.ok(e <= 12, `${pc} is ${e.toFixed(1)} miles from its district centre`);
  const errs = rows.map((r) => r[2]).sort((a, b) => a - b);
  assert.ok(errs[Math.floor(errs.length / 2)] <= 3, `median error ${errs[Math.floor(errs.length / 2)].toFixed(1)} mi`);
});

test('every chambers branch address postcode lands near the branch itself', (t) => {
  let n = 0, worst = 0, worstName = '';
  const errs = [];
  for (const ch of finder.chambers) {
    for (const b of ch.branches || []) {
      const m = String(b.address || '').match(/([A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2})\s*$/i);
      if (!m || !Number.isFinite(b.lat)) continue;
      const r = locate(m[1]);
      assert.ok(r, `${m[1]} (${ch.name}, ${b.city}) is located`);
      const e = miles([r.lat, r.lon], [b.lat, b.lon]);
      n++; errs.push(e);
      if (e > worst) { worst = e; worstName = `${ch.name} ${m[1]}`; }
      assert.ok(e <= 15, `${ch.name} ${m[1]} is ${e.toFixed(1)} miles from its branch`);
    }
  }
  errs.sort((a, b) => a - b);
  t.diagnostic(`${n} branches: median ${errs[n >> 1].toFixed(1)} mi, 90th percentile ${errs[Math.floor(n * 0.9)].toFixed(1)} mi, worst ${worst.toFixed(1)} mi (${worstName})`);
  assert.ok(n >= 60, `${n} branches checked`);
});

test('edge cases: non-geographic and unusual postcodes', () => {
  assert.ok(locate('EC1A 1BB'), 'EC1A');
  assert.ok(locate('W1A 1AA'), 'W1A');
  assert.equal(core.locatePostcode('GIR 0AA', table.d).error, 'special-gir', 'Girobank names no place');
  assert.equal(core.locatePostcode('BFPO 1', table.d).error, 'special-bfpo', 'forces post names no place');
  assert.equal(core.locatePostcode('CF10 1AA', {}).error, 'unknown');
});

test('nations: Wales is Wales, the border follows the majority, and places outside England and Wales are never located', () => {
  for (const [pc, nation] of [['CF10 1AA', 'W'], ['LL55 4AA', 'W'], ['SA1 1AA', 'W'], ['NP20 1AA', 'W'], ['SW1A 1AA', 'E']]) {
    assert.equal(locate(pc).nation, nation, pc);
  }
  assert.equal(locate('TD15 1AA').label, 'Northumberland', 'Berwick is in England');
  assert.equal(locate('CH1 1AA').nation, 'E', 'Chester is in England');
  assert.equal(core.locatePostcode('TD12 5AA', table).error, 'outside', 'TD12 is mostly in Scotland');
  for (const [pc, place] of [['BT1 1AA', 'Northern Ireland'], ['EH1 1AA', 'Scotland'], ['JE2 3AB', 'Jersey'], ['GY1 1AA', 'Guernsey'], ['IM1 1AA', 'the Isle of Man']]) {
    const a = core.locatePostcode(pc, table);
    assert.equal(a.error, 'outside', pc);
    assert.equal(a.place, place, pc);
    assert.equal(a.result, undefined, `${pc} is not placed on the map`);
  }
});

test('the finder never asks a service for a postcode', () => {
  const app = fs.readFileSync(path.join(root, 'assets', 'finder', 'js', 'app.js'), 'utf8');
  const coreJs = fs.readFileSync(path.join(root, 'assets', 'finder', 'js', 'finder-core.js'), 'utf8');
  for (const src of [app, coreJs]) assert.doesNotMatch(src, /postcodes\.io|api\.postcodes/i);
  assert.doesNotMatch(app, /fetch\(`?https?:/, 'no fetch to another site');
});

// ── A postcode is measured from like a court: ranking and the travel radius ─────

const origin = (pc) => { const r = locate(pc); return { lat: r.lat, lon: r.lon }; };
function chambersRows(loc) {
  return finder.chambers.map((c) => ({ name: c.name, distance: core.nearestBranchDistance(c, loc) })).sort((a, b) => a.distance - b.distance);
}

test('courts are ranked by distance from the postcode and the radius splits them', () => {
  const loc = origin('M3 3FX');
  const courts = core.courtsByDistance(finder.courts, loc);
  assert.equal(courts.length, finder.courts.length);
  assert.equal(courts[0].court.name, 'Manchester Family Court');
  for (let i = 1; i < courts.length; i++) assert.ok(courts[i].distance >= courts[i - 1].distance, 'nearest first');
  assert.equal(core.courtsByDistance(finder.courts, loc, 3).length, 3);
  let previous = -1;
  for (const r of [20, 35, 50]) {
    const { near, far } = core.splitByRadius(courts, r);
    assert.equal(near.length + far.length, courts.length, `${r} mi loses nothing`);
    assert.ok(near.every((c) => c.distance <= r) && far.every((c) => c.distance > r), `${r} mi splits cleanly`);
    assert.ok(near.length >= previous, 'a wider radius never shows fewer');
    previous = near.length;
  }
  assert.deepEqual(core.splitByRadius(courts, null).far, [], 'no radius: everything is inside');
});

test('chambers near a postcode are ranked by nearest branch and the radius changes the set', () => {
  const loc = origin('M3 3FX');
  const rows = chambersRows(loc);
  assert.ok(rows[0].distance < 1, `${rows[0].name} is within a mile of the middle of M3`);
  const counts = [20, 35, 50].map((r) => core.splitByRadius(rows, r).near.length);
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2], `20, 35 and 50 mi give different lists: ${counts}`);
  const [c20, c35, c50] = counts;
  assert.ok(c20 >= 5 && c50 <= rows.length, `${c20}, ${c35}, ${c50} of ${rows.length}`);
});

test('a postcode near a border ranks the English courts nearby', () => {
  const near = core.courtsByDistance(finder.courts, origin('TD15 1AA'), 3);
  assert.ok(near[0].distance < 60, `${near[0].court.name} is ${near[0].distance.toFixed(0)} mi from Berwick`);
  assert.equal(locate('TD15 1AA').nation, 'E');
});
