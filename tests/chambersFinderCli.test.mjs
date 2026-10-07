/**
 * The Chambers Finder command line (chambers-finder-cli/cli.mjs), run for real as a child process: the contract
 * (exit codes, --json, error codes, schemaVersion), rankings against the page's own functions on the real data,
 * the shared ranking function against an independent reference with saved preferences, edge postcodes,
 * batches with a bad item, and refusal of damaged data. Only invented or public postcodes appear here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import core from '../assets/finder/js/finder-core.js';
import { REQUEST_KEYS, LIMITS, checkRequest, RequestError } from '../chambers-finder-cli/request.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CLI = path.join(root, 'chambers-finder-cli', 'cli.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(root, 'chambers-finder-cli', 'package.json'), 'utf8'));
const REQ_SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'chambers-finder-cli', 'request.schema.json'), 'utf8'));
const RES_SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'chambers-finder-cli', 'response.schema.json'), 'utf8'));
const DATA = JSON.parse(fs.readFileSync(path.join(root, 'static', 'finder-data.json'), 'utf8'));
const TABLE = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'finder', 'data', 'postcode-districts.json'), 'utf8'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfcli-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function cli(args, { input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const ask = (postcode, extra = []) => cli(['--json', '--postcode', postcode, ...extra]);
const round2 = (n) => Math.round(n * 100) / 100;

// Public places and invented postcodes only.
const POSTCODES = ['SW1A 2AA', 'M1 1AE', 'LS1 4AP', 'BS1 5AA', 'CF10 3AT', 'NE1 4XF', 'PL1 2AA', 'SK10 9ZZ', 'B2 4QA', 'TR21 0AA'];

// ── The contract ────────────────────────────────────────────────────────────

test('--version and --help; usage mistakes exit 2 with a stable code, plain and as JSON', () => {
  const v = cli(['--version']);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), PKG.version);
  assert.equal(cli(['--json', '--version']).json.version, PKG.version);
  const h = cli(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^Exit codes:\n  0  Done\.\n  1  .*\n  2  The command line was wrong\.\n  3  The input was rejected/m);
  for (const [args, code] of [
    [[], 'usage_missing_arguments'], [['SK10'], 'usage_too_many_arguments'], [['--no-such-flag'], 'usage_unknown_option'],
    [['--postcode'], 'usage_bad_option'], [['--postcode', 'SK10', '--request', 'x.json'], 'usage_conflicting_options'],
    [['--postcode', 'SK10', '--courts', 'many'], 'usage_bad_option'], [['--version=1'], 'usage_bad_option'],
  ]) {
    const plain = cli(args);
    assert.equal(plain.status, 2, args.join(' '));
    assert.match(plain.stderr, new RegExp(`failed \\(${code}\\)`), args.join(' '));
    const j = cli(['--json', ...args]);
    assert.equal(j.status, 2);
    assert.equal(j.json.error.code, code);
    assert.equal(j.stderr, '');
  }
});

test('--json: one JSON object on stdout, nothing on stderr; the shape matches the schema files', () => {
  const r = ask('M1 1AE');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tool, 'chambers-finder-cli');
  assert.equal(r.json.cliVersion, PKG.version);
  assert.equal(r.json.schemaVersion, 1);
  assert.deepEqual(r.json.warnings, []);
  for (const k of RES_SCHEMA.required) assert.ok(k in r.json, `the answer has ${k}`);
  for (const k of Object.keys(r.json)) assert.ok(k in RES_SCHEMA.properties, `${k} is described in response.schema.json`);
  for (const c of r.json.chambers) for (const k of RES_SCHEMA.properties.chambers.items.required) assert.ok(k in c, `a chambers row has ${k}`);
  for (const c of r.json.courts) for (const k of RES_SCHEMA.properties.courts.items.required) assert.ok(k in c, `a court row has ${k}`);
  for (const k of RES_SCHEMA.properties.location.required) assert.ok(k in r.json.location, `location has ${k}`);
  assert.equal(r.json.data.finderDataSchemaVersion, DATA.schemaVersion);
});

test('the request schema and the code accept exactly the same keys', () => {
  assert.deepEqual(Object.keys(REQ_SCHEMA.properties).sort(), [...REQUEST_KEYS].sort());
  assert.equal(REQ_SCHEMA.properties.courts.maximum, LIMITS.courts.max);
  assert.equal(REQ_SCHEMA.properties.chambers.maximum, LIMITS.chambers.max);
  assert.equal(REQ_SCHEMA.properties.courts.default, LIMITS.courts.default);
  assert.equal(REQ_SCHEMA.properties.chambers.default, LIMITS.chambers.default);
  assert.equal(REQ_SCHEMA.additionalProperties, false);
  assert.equal(PKG.bin['chambers-finder'], 'cli.mjs');
  assert.equal(PKG.engines.node, '>=22');
});

// ── Rankings agree with the page's own functions ────────────────────────────

test('the courts and chambers come out in the order the page ranks them, for many postcodes, both ways of measuring', () => {
  for (const pc of POSTCODES) {
    const located = core.locatePostcode(pc, TABLE).result;
    const point = { lat: located.lat, lon: located.lon };
    const courts = core.courtsByDistance(DATA.courts, point);
    for (const measureFrom of ['court', 'postcode']) {
      const from = measureFrom === 'postcode' ? point : courts[0].court;
      // The ranking, restated independently: nearest branch, then name.
      const expected = DATA.chambers
        .map((ch) => ({ ch, d: Math.min(...ch.branches.map((b) => core.haversine(from.lat, from.lon, b.lat, b.lon))) }))
        .sort((a, b) => a.d - b.d || a.ch.name.localeCompare(b.ch.name))
        .slice(0, 8);
      const r = ask(pc, ['--chambers', '8', '--courts', '5', '--measure-from', measureFrom]);
      assert.equal(r.status, 0, `${pc} ${r.stdout}`);
      assert.deepEqual(r.json.courts.map((c) => c.id), courts.slice(0, 5).map((c) => c.court.id), `${pc}: courts`);
      assert.equal(r.json.chosenCourt.id, courts[0].court.id);
      assert.deepEqual(r.json.chambers.map((c) => c.id), expected.map((e) => e.ch.id), `${pc} ${measureFrom}: chambers`);
      assert.deepEqual(r.json.chambers.map((c) => c.distanceMiles), expected.map((e) => round2(e.d)));
      assert.equal(r.json.chambers[0].rank, 1);
    }
  }
});

test('the shared ranking function equals an independent reference ranking, with starred and hidden preferences applied', () => {
  // A reference ranking written separately from finder-core.js: hidden last, then starred, then nearest, then name.
  const reference = (court, prefs, branchKey) => DATA.chambers.map((ch) => {
    const cp = prefs[ch.id] || {};
    let minDist = Infinity; let nearestBranch = null;
    const visibleBranches = ch.branches.filter((b) => !(prefs[branchKey(ch.id, b)] || {}).hidden);
    visibleBranches.forEach((b) => { const d = core.haversine(court.lat, court.lon, b.lat, b.lon); if (d < minDist) { minDist = d; nearestBranch = b; } });
    return { chambers: ch, distance: minDist, nearestBranch, starred: !!cp.starred, hidden: !!cp.hidden || !visibleBranches.length };
  }).sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.chambers.name.localeCompare(b.chambers.name);
  });
  const branchKey = (id, b) => `${id}::${b.name}`;
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let round = 0; round < 12; round++) {
    const prefs = {};
    for (const ch of DATA.chambers) {
      if (rnd() < 0.15) prefs[ch.id] = { starred: true };
      if (rnd() < 0.1) prefs[ch.id] = { ...(prefs[ch.id] || {}), hidden: true };
      for (const b of ch.branches) if (rnd() < 0.2) prefs[branchKey(ch.id, b)] = { hidden: true };
    }
    const court = DATA.courts[Math.floor(rnd() * DATA.courts.length)];
    const got = core.rankChambersFromPoint(DATA.chambers, court, {
      isBranchHidden: (ch, b) => !!(prefs[branchKey(ch.id, b)] || {}).hidden,
      isChambersHidden: (ch) => !!(prefs[ch.id] || {}).hidden,
      isStarred: (ch) => !!(prefs[ch.id] || {}).starred,
    });
    assert.deepEqual(got, reference(court, prefs, branchKey), `round ${round}`);
  }
  // With no preferences nothing is hidden or starred, so the command line sees every chambers.
  const plain = core.rankChambersFromPoint(DATA.chambers, DATA.courts[0]);
  assert.ok(plain.every((r) => !r.hidden && !r.starred));
});

test('--court-id measures from that court; a wrong id is refused; the radius marks chambers but does not drop them', () => {
  const r = ask('SK10 9ZZ', ['--court-id', 'central-family-court', '--chambers', '5']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.chosenCourt.id, 'central-family-court');
  assert.equal(r.json.chosenCourt.source, 'court_id');
  const central = DATA.courts.find((c) => c.id === 'central-family-court');
  const expected = core.rankChambersFromPoint(DATA.chambers, central).slice(0, 5);
  assert.deepEqual(r.json.chambers.map((c) => c.id), expected.map((e) => e.chambers.id));
  const bad = ask('SK10 9ZZ', ['--court-id', 'no-such-court']);
  assert.equal(bad.status, 3);
  assert.equal(bad.json.error.code, 'court_not_found');
  const tight = ask('PL1 2AA', ['--radius-miles', '1', '--chambers', '10']);
  assert.equal(tight.json.radiusMiles, 1);
  assert.equal(tight.json.chambers.length, 10);
  assert.ok(tight.json.chambers.some((c) => c.withinRadius === false), 'beyond the radius is marked, not removed');
  assert.equal(tight.json.chambersWithinRadius, tight.json.chambers.filter((c) => c.withinRadius).length);
  const all = ask('SW1A 2AA', ['--radius-miles', 'all', '--chambers', '50']);
  assert.equal(all.json.radiusMiles, null);
  assert.ok(all.json.chambers.every((c) => c.withinRadius));
  assert.equal(ask('SW1A 2AA').json.radiusMiles, DATA.defaultTravelMiles);
});

test('chambers rows carry what the data file has, and nothing from the page\'s saved state', () => {
  const r = ask('M1 1AE', ['--chambers', '3']);
  for (const c of r.json.chambers) {
    const src = DATA.chambers.find((x) => x.id === c.id);
    assert.equal(c.name, src.name);
    if (src.email) assert.equal(c.email, src.email);
    if (src.phone) assert.equal(c.phone, src.phone);
    if (src.website) assert.equal(c.website, src.website);
    assert.ok(src.branches.some((b) => b.address === c.branch.address), 'the branch is one of the chambers\' own');
    for (const banned of ['starred', 'hidden', 'contacted', 'notes', 'seen']) assert.ok(!(banned in c), `no ${banned}`);
  }
});

// ── Postcodes ───────────────────────────────────────────────────────────────

test('postcodes: any case, spacing or an outward code alone; England and Wales located; everything else refused politely', () => {
  const same = ['SW1A 2AA', 'sw1a2aa', ' Sw1A   2aA '].map((p) => ask(p).json);
  assert.deepEqual(same.map((j) => j.location.outcode), ['SW1A', 'SW1A', 'SW1A']);
  assert.deepEqual(same.map((j) => j.chosenCourt.id), [same[0].chosenCourt.id, same[0].chosenCourt.id, same[0].chosenCourt.id]);
  const outward = ask('cf10');
  assert.equal(outward.json.location.postcode, null);
  assert.equal(outward.json.location.nation, 'Wales');
  assert.equal(ask('M1 1AE').json.location.nation, 'England');
  const refused = {
    'EH1 1YZ': ['postcode_outside_england_wales', 'Scotland'], 'BT1 1AA': ['postcode_outside_england_wales', 'Northern Ireland'],
    'JE2 3AB': ['postcode_outside_england_wales', 'Jersey'], 'GY1 1AA': ['postcode_outside_england_wales', 'Guernsey'],
    'IM1 1AA': ['postcode_outside_england_wales', 'the Isle of Man'], 'TD12 5AA': ['postcode_outside_england_wales', 'Scotland'],
    'GIR 0AA': ['postcode_special_gir'], 'BFPO 1': ['postcode_special_bfpo'], 'ZZ9 9ZZ': ['postcode_unknown_area'],
    'hello': ['postcode_invalid'], '12345': ['postcode_invalid'], 'SW1A 1': ['postcode_invalid'],
  };
  for (const [pc, [code, place]] of Object.entries(refused)) {
    const r = ask(pc);
    assert.equal(r.status, 3, pc);
    assert.equal(r.json.error.code, code, pc);
    assert.equal(r.stderr, '');
    if (place) {
      assert.equal(r.json.error.details.place, place);
      assert.match(r.json.error.message, /England and Wales only/);
    }
  }
  assert.equal(ask('x'.repeat(30)).json.error.code, 'postcode_invalid');
});

// ── Requests and batches ────────────────────────────────────────────────────

test('--request: a file, standard input, a batch with one bad item, and the checks on the request', () => {
  const d = tmp();
  try {
    const file = path.join(d, 'r.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, postcode: 'LS1 4AP', chambers: 2, courts: 1 }));
    const one = cli(['--json', '--request', file]);
    assert.equal(one.status, 0, one.stdout);
    assert.equal(one.json.mode, 'single');
    assert.equal(one.json.chambers.length, 2);
    assert.equal(one.json.courts.length, 1);
    assert.equal(cli(['--json', '--request', '-'], { input: JSON.stringify({ postcode: 'LS1 4AP' }) }).json.mode, 'single');
    const batch = cli(['--json', '--request', '-'], { input: JSON.stringify([{ postcode: 'M1 1AE' }, { postcode: 'EH1 1YZ' }, { postcode: 'BS1 5AA', chambers: 1 }, { postcode: 'M1 1AE', evil: 1 }]) });
    assert.equal(batch.status, 3);
    assert.equal(batch.json.error.code, 'items_failed');
    assert.equal(batch.json.mode, 'batch');
    assert.equal(batch.json.succeeded, 2);
    assert.equal(batch.json.failed, 2);
    assert.deepEqual(batch.json.items.map((i) => i.ok), [true, false, true, false]);
    assert.equal(batch.json.items[1].error.code, 'postcode_outside_england_wales');
    assert.equal(batch.json.items[3].error.code, 'unknown_key');
    assert.equal(batch.json.items[2].chambers.length, 1);
    const allGood = cli(['--json', '--request', '-'], { input: JSON.stringify([{ postcode: 'M1 1AE' }, { postcode: 'LS1 4AP' }]) });
    assert.equal(allGood.status, 0);
    assert.equal(allGood.json.succeeded, 2);
    for (const [req, code] of [
      ['not json', 'invalid_json'], ['[]', 'invalid_request'], ['42', 'invalid_request'], ['{}', 'missing_postcode'],
      [{ postcode: 5 }, 'invalid_field_type'], [{ postcode: 'M1', courts: 0 }, 'invalid_field_value'], [{ postcode: 'M1', courts: 21 }, 'invalid_field_value'],
      [{ postcode: 'M1', chambers: 51 }, 'invalid_field_value'], [{ postcode: 'M1', chambers: 2.5 }, 'invalid_field_type'],
      [{ postcode: 'M1', radiusMiles: 0 }, 'invalid_field_value'], [{ postcode: 'M1', radiusMiles: 'far' }, 'invalid_field_type'],
      [{ postcode: 'M1', measureFrom: 'moon' }, 'invalid_field_value'], [{ postcode: 'M1', schemaVersion: 2 }, 'unsupported_schema_version'],
      [{ postcode: 'M1', courtId: 7 }, 'invalid_field_type'],
    ]) {
      const r = cli(['--json', '--request', '-'], { input: typeof req === 'string' ? req : JSON.stringify(req) });
      assert.equal(r.status, 3, JSON.stringify(req));
      assert.equal(r.json.error.code, code, JSON.stringify(req));
    }
    assert.equal(cli(['--json', '--request', path.join(d, 'missing.json')]).json.error.code, 'request_not_found');
    assert.throws(() => checkRequest({ postcode: 'M1', bogus: 1 }, 35), RequestError);
  } finally { rm(d); }
});

// ── The data files ──────────────────────────────────────────────────────────

test('damaged or missing data files are refused before any answer', () => {
  const d = tmp();
  try {
    const finder = path.join(d, 'finder.json');
    const table = path.join(d, 'table.json');
    fs.writeFileSync(table, JSON.stringify(TABLE));
    const broken = JSON.parse(JSON.stringify(DATA));
    broken.chambers[0].branches[0].lat = 'north';
    broken.courts[1].id = broken.courts[0].id;
    fs.writeFileSync(finder, JSON.stringify(broken));
    const r = cli(['--json', '--postcode', 'M1 1AE', '--finder-data', finder, '--postcode-data', table]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'data_invalid');
    assert.ok(r.json.error.details.problems.length >= 2);
    assert.equal(cli(['--json', '--postcode', 'M1', '--finder-data', path.join(d, 'nope.json')]).json.error.code, 'data_file_not_found');
    fs.writeFileSync(finder, '{"schemaVersion": 3');
    assert.equal(cli(['--json', '--postcode', 'M1', '--finder-data', finder]).json.error.code, 'data_invalid');
    fs.writeFileSync(finder, JSON.stringify(DATA));
    fs.writeFileSync(table, JSON.stringify({ d: { M1: [200, 0, 'X', 'E'] } }));
    assert.equal(cli(['--json', '--postcode', 'M1', '--finder-data', finder, '--postcode-data', table]).json.error.code, 'data_invalid');
    // The real files pass their own checks.
    assert.deepEqual(core.validateFinderData(DATA), []);
    assert.deepEqual(core.validatePostcodeTable(TABLE), []);
  } finally { rm(d); }
});

test('the plain text answer (no --json) names the court and the chambers', () => {
  const r = cli(['--postcode', 'M1 1AE', '--chambers', '2']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Nearest court: Manchester Family Court/);
  assert.match(r.stdout, /1\. /);
  assert.match(cli(['--postcode', 'EH1 1YZ']).stderr, /failed \(postcode_outside_england_wales\)/);
});
