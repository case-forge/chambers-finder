/**
 * Chambers Finder's search ranking, postcode lookup answers and share-link merging
 * (assets/finder/js/finder-core.js), against the real data file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import core from '../assets/finder/js/finder-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'static', 'finder-data.json'), 'utf8'));

function search(query) {
  const courts = data.courts
    .map((c) => ({ label: c.name, score: core.scoreCourt(query, c) })).filter((e) => e.score !== null);
  const chambers = data.chambers
    .map((c) => ({ label: c.name, score: core.scoreChambers(query, c) })).filter((e) => e.score !== null);
  return { courts: core.rankEntries(courts).map((e) => e.label), chambers: core.rankEntries(chambers).map((e) => e.label) };
}

// [what is typed, the court that must come first]
const COURT_FIRST = [
  ['Manchester', 'Manchester Family Court'],
  ['manchester family court', 'Manchester Family Court'],
  ['MANCHESTER', 'Manchester Family Court'],
  ['Chester', 'Chester Family Court'],
  ['Chester Family Court', 'Chester Family Court'],
  ['Winchester', 'Winchester Family Court'],
  ['Colchester', "Colchester Magistrates' Court"],
  ['Bristol', 'Bristol Family Court'],
  ['Newcastle', 'Newcastle upon Tyne Family Court'],
  ['Newcastle upon Tyne', 'Newcastle upon Tyne Family Court'],
  ['Brighton', 'Brighton Family Court'],
  ['Central', 'Central Family Court'],
  ['Central London', 'Central Family Court'],
  ['Kingston upon Hull', 'Kingston-Upon-Hull Family Court'],
  ['St Albans', "St Albans Magistrates' Court"],
  ['St. Albans', "St Albans Magistrates' Court"],
  ['Stoke', 'Stoke-on-Trent Family Court'],
  ['York', 'York Family Court'],
  ['Luton', 'Luton Family Court'],
  // misspellings
  ['Mancester', 'Manchester Family Court'],
  ['Manchestr', 'Manchester Family Court'],
  ['Bristal', 'Bristol Family Court'],
  ['Brigton', 'Brighton Family Court'],
  ['Newcastel', 'Newcastle upon Tyne Family Court'],
  // partial typing
  ['manch', 'Manchester Family Court'],
  ['manch fam', 'Manchester Family Court'],
];

for (const [typed, expected] of COURT_FIRST) {
  test(`typing "${typed}" puts ${expected} first`, () => {
    const { courts } = search(typed);
    assert.equal(courts[0], expected, `got ${courts.slice(0, 4).join(' | ')}`);
  });
}

test('an ambiguous name lists every court it could mean before anything else', () => {
  const { courts } = search('Kingston');
  assert.deepEqual(courts.slice(0, 2).sort(), ['Kingston-Upon-Hull Family Court', 'Kingston-Upon-Thames Family Court']);
});

test('Manchester never brings up Chester or Winchester, however the query is typed', () => {
  for (const q of ['Manchester', 'Manchester Family Court', 'manchester court']) {
    const { courts } = search(q);
    assert.ok(!courts.includes('Chester Family Court'), q);
    assert.ok(!courts.includes('Winchester Family Court'), q);
  }
});

test('exact and whole-word matches come before partial-word matches', () => {
  const { courts } = search('Chester');
  assert.equal(courts[0], 'Chester Family Court');
  assert.ok(courts.indexOf('Chester Family Court') < courts.indexOf('Chesterfield Justice Centre'));
  assert.ok(courts.indexOf('Chesterfield Justice Centre') < courts.indexOf('Winchester Family Court'));
});

test('a query that matches nothing matches nothing', () => {
  const { courts, chambers } = search('zzzzqqqq');
  assert.deepEqual(courts, []);
  assert.deepEqual(chambers, []);
});

test('a chambers is found by its name and by a city it has a branch in', () => {
  const byName = search('10KBW').chambers;
  assert.equal(byName[0], '10KBW');
  const city = data.chambers.find((c) => c.branches.length > 1).branches[1].city;
  assert.ok(search(city).chambers.length > 0);
});

test('every court and chambers is first for its own exact name', () => {
  for (const c of data.courts) assert.equal(search(c.name).courts[0], c.name);
  for (const c of data.chambers) assert.ok(search(c.name).chambers.slice(0, 2).includes(c.name), c.name);
});

test('punctuation and accents do not matter', () => {
  assert.equal(core.normalise("St. Albans' Court"), 'st albans court');
  assert.equal(core.normalise('Café'), 'cafe');
  assert.notEqual(core.scoreText("king's lynn", 'Kings Lynn'), null);
});

test('a postcode or an outcode is recognised as one, ordinary words are not', () => {
  for (const p of ['SW1A 1AA', 'sw1a1aa', 'HA7 3ND', 'JE2 3AB']) assert.ok(core.looksLikePostcode(p), p);
  for (const p of ['HA7', 'SW1A', 'M1']) assert.ok(core.looksLikeOutcode(p), p);
  for (const p of ['Manchester', 'Central Family Court', '10KBW']) {
    assert.ok(!core.looksLikePostcode(p), p);
  }
});

// A small table in the shape scripts/build-postcode-districts.mjs writes: England and Wales
// districts with coordinates (d), and the outside postcode areas by name only (x).
const TABLE = {
  d: {
    M3: [53.478, -2.236, 'Manchester', 'E'],
    SW1A: [51.505, -0.132, 'Westminster', 'E'],
    TD15: [55.764, -2.01, 'Northumberland', 'E'],
    CF10: [51.48, -3.18, 'Cardiff', 'W'],
  },
  x: { EH: 'S', BT: 'N', JE: 'J', GY: 'G', IM: 'I', TD12: 'S' },
};

test('a postcode is read the same however it is typed', () => {
  for (const t of ['SW1A 1AA', 'sw1a 1aa', 'SW1A1AA', ' sw1a1aa ', 'SW1A  1AA']) {
    const p = core.parsePostcode(t);
    assert.deepEqual([p.outcode, p.incode, p.postcode], ['SW1A', '1AA', 'SW1A 1AA'], t);
  }
  assert.deepEqual(core.parsePostcode('m3'), { outcode: 'M3', incode: null, postcode: null });
  for (const t of ['', 'hello', 'GIR 0AA', '12345', 'SW1A 1A', 'M3 3', 'SE1 9', 'E1 7', 'Manchester Family Court']) assert.equal(core.parsePostcode(t), null, t);
});

test('a district in the table is located locally, with its place and nation', () => {
  const r = core.locatePostcode('m33fx', TABLE).result;
  assert.deepEqual([r.outcode, r.postcode, r.label, r.nation], ['M3', 'M3 3FX', 'Manchester', 'E']);
  assert.ok(Math.abs(r.lat - 53.478) < 1e-9 && Math.abs(r.lon + 2.236) < 1e-9);
  assert.equal(core.locatePostcode('M3', TABLE).result.postcode, null, 'an outward code alone has no full postcode');
});

test('an unknown district or something that is not a postcode is an error, never a made-up place', () => {
  assert.equal(core.locatePostcode('ZZ9 9ZZ', TABLE).error, 'unknown');
  assert.equal(core.locatePostcode('hello', TABLE).error, 'invalid');
  assert.equal(core.locatePostcode('M3 3FX', null).error, 'unknown');
  assert.equal(core.locatePostcode('__proto__', TABLE).error, 'invalid');
  assert.equal(core.locatePostcode('CO1', { d: { CO1: TABLE.d.M3 } }).result.label, 'Manchester');
  assert.match(core.lookupMessage('unknown'), /postcode area was not recognised/);
});

test('a postcode outside England and Wales is not located: it is named as outside, with no point', () => {
  for (const [pc, place] of [['EH1 1AA', 'Scotland'], ['BT1 1AA', 'Northern Ireland'], ['JE2 3AB', 'Jersey'], ['GY1 1AA', 'Guernsey'], ['IM1 1AA', 'the Isle of Man'], ['TD12 5AA', 'Scotland']]) {
    const a = core.locatePostcode(pc, TABLE);
    assert.equal(a.result, undefined, `${pc} has no result`);
    assert.equal(a.error, 'outside', pc);
    assert.equal(a.place, place, pc);
    assert.equal(core.lookupMessage(a.error, a.place), `Chambers Finder covers England and Wales only. ${place[0].toUpperCase() + place.slice(1)} has its own courts.`);
  }
  assert.equal(core.locatePostcode('TD15 1AA', TABLE).result.label, 'Northumberland', 'a border district that is mostly English is located');
  assert.equal(core.locatePostcode('CF10 1AA', TABLE).result.nation, 'W');
  assert.equal(core.locatePostcode('ZZ9 9ZZ', TABLE).error, 'unknown', 'an area that does not exist is still not recognised');
  assert.equal(core.locatePostcode('TD13 1AA', TABLE).error, 'unknown', 'a name-only district is matched exactly, not by its area');
  assert.equal(core.locatePostcode('EH1 1AA', { x: { EH: 'Q' } }).error, 'unknown', 'an unrecognised nation code is never shown');
  assert.equal(core.locatePostcode('__proto__ 1AA', TABLE).error, 'invalid');
});

// ── merging a share link ────────────────────────────────────────────────────

test('merge keeps your own notes and markers, and adds what you had nothing for', () => {
  const local = { a: { starred: true, notes: 'mine' }, b: { notes: 'only a note' }, c: { hidden: true } };
  const incoming = { a: { hidden: true, notes: 'theirs' }, b: { starred: true, notes: 'theirs b' }, c: { starred: true }, d: { starred: true } };
  const out = core.mergePrefs(local, incoming);
  assert.deepEqual(out.a, { starred: true, notes: 'mine' });     // own marker kept, their hide ignored, own note kept
  assert.deepEqual(out.b, { starred: true, notes: 'only a note' }); // no marker of yours, so theirs added; your note kept
  assert.deepEqual(out.c, { hidden: true });                     // your hide stays
  assert.deepEqual(out.d, { starred: true });                    // new
});

test('merge never loses an entry of yours and does not change its inputs', () => {
  const local = { a: { starred: true }, z: { notes: 'z' } };
  const incoming = { a: { hidden: true } };
  const before = JSON.stringify({ local, incoming });
  const out = core.mergePrefs(local, incoming);
  assert.deepEqual(Object.keys(out).sort(), ['a', 'z']);
  assert.equal(JSON.stringify({ local, incoming }), before);
});

test('merged contacted records keep the later time for each of phone and email', () => {
  const local = { 'x||L': { phone: { ts: 5, chamberName: 'X' } } };
  const incoming = { 'x||L': { phone: { ts: 9, chamberName: 'X' }, email: { ts: 2, chamberName: 'X' } }, 'y||M': { email: { ts: 1, chamberName: 'Y' } } };
  const out = core.mergeContacted(local, incoming);
  assert.equal(out['x||L'].phone.ts, 9);
  assert.equal(out['x||L'].email.ts, 2);
  assert.ok(out['y||M']);
});

test('merged recent searches keep yours first, without repeats, up to the limit', () => {
  const mine = [{ type: 'court', id: 'a' }, { type: 'chambers', id: 'b' }];
  const theirs = [{ type: 'court', id: 'a' }, { type: 'court', id: 'c' }];
  assert.deepEqual(core.mergeRecents(mine, theirs, 10).map((r) => r.id), ['a', 'b', 'c']);
  const many = Array.from({ length: 30 }, (_, i) => ({ type: 'court', id: 'n' + i }));
  assert.equal(core.mergeRecents(mine, many, 10).length, 10);
});

test('the question before a link is applied counts what it carries and what you already have', () => {
  const s = core.summariseImport(
    { prefs: { a: { starred: true }, b: { notes: 'n', hidden: true } }, contacted: { 'x||L': {} }, recents: [{}] },
    { prefs: { a: { notes: 'mine' } }, contacted: {}, recents: [] });
  assert.equal(s.starred, 1); assert.equal(s.hidden, 1); assert.equal(s.notes, 1);
  assert.equal(s.contacted, 1); assert.equal(s.recents, 1);
  assert.equal(s.have.prefs, 1); assert.equal(s.have.notes, 1);
});

test('GIR 0AA and BFPO numbers are named as postcodes with no place, not called "not a UK postcode"', () => {
  const table = {};
  assert.equal(core.locatePostcode('GIR 0AA', table).error, 'special-gir');
  assert.equal(core.locatePostcode('gir0aa', table).error, 'special-gir');
  assert.equal(core.locatePostcode('BFPO 57', table).error, 'special-bfpo');
  assert.equal(core.locatePostcode('bfpo57', table).error, 'special-bfpo');
  assert.match(core.lookupMessage('special-gir'), /GIR 0AA is a real postcode/);
  assert.match(core.lookupMessage('special-bfpo'), /forces post office/);
  assert.equal(core.locatePostcode('hello', table).error, 'invalid', 'other text is still just not a postcode');
});
