#!/usr/bin/env node
/**
 * Chambers Finder CLI
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * cli.mjs
 * Finds the courts and the barristers' chambers nearest an England and Wales postcode, from the two data files the
 * Chambers Finder page itself uses (finder-data.json and postcode-districts.json), with the page's own pure
 * functions (finder-core.js): the same postcode lookup, the same distances and the same ranking. No network, no
 * browser. Nothing about a search is kept: the only inputs are the request and the two data files.
 *
 *   chambers-finder [--json] --postcode <postcode> [--courts N] [--chambers N] [--radius-miles N|all]
 *                   [--court-id ID] [--measure-from court|postcode]
 *   chambers-finder [--json] --request <request.json | ->
 *
 * The command line contract (exit codes, --json, error codes) is the one the other CaseForge command line tools
 * keep: see scripts/cli-contract.mjs and README.md here.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { EXIT, CliError, parseArgs, readName, readVersion, runCli, helpResult, readStdinText } from '../scripts/cli-contract.mjs';
import { checkRequest, RequestError, SCHEMA_VERSION, MAX_BATCH, LIMITS, MEASURE_FROM } from './request.mjs';

const TOOL = readName(new URL('./package.json', import.meta.url));
const VERSION = readVersion(new URL('./package.json', import.meta.url));
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_DATA_BYTES = 20 * 1024 * 1024;
const core = createRequire(import.meta.url)('../assets/finder/js/finder-core.js');
const DEFAULT_FINDER_DATA = new URL('../static/finder-data.json', import.meta.url).pathname;
const DEFAULT_POSTCODE_DATA = new URL('../assets/finder/data/postcode-districts.json', import.meta.url).pathname;

/** The tool's description of itself (help, topics, README tables): docs.mjs. */
const buildHelpDoc = async () => (await import('./docs.mjs')).buildDoc({ version: VERSION });

const OUTSIDE_CODE = {
  invalid: 'postcode_invalid', unknown: 'postcode_unknown_area', outside: 'postcode_outside_england_wales',
  'special-gir': 'postcode_special_gir', 'special-bfpo': 'postcode_special_bfpo',
};

const round = (n) => Math.round(n * 100) / 100;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '').map((k) => [k, obj[k]]));

async function readJsonFile(file, what, code) {
  const path = resolve(file);
  let text;
  try {
    if ((await stat(path)).size > MAX_DATA_BYTES) throw new CliError('data_invalid', `${what} is larger than ${MAX_DATA_BYTES / 1024 / 1024} MB.`, { details: { file } });
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('data_file_not_found', `${what} ${file} could not be read (${err.code ?? 'error'}).`, { details: { file } });
  }
  try { return JSON.parse(text); } catch { throw new CliError(code, `${what} is not valid JSON.`, { details: { file } }); }
}

/** Reads both data files and refuses to go on if either fails its checks. */
async function loadData(finderFile, postcodeFile) {
  const data = await readJsonFile(finderFile, 'The finder data', 'data_invalid');
  const table = await readJsonFile(postcodeFile, 'The postcode data', 'data_invalid');
  const problems = [...core.validateFinderData(data).map((p) => `finder data: ${p}`), ...core.validatePostcodeTable(table).map((p) => `postcode data: ${p}`)];
  if (problems.length) {
    throw new CliError('data_invalid', `The data files failed their checks (${problems.length}): ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '; ...' : ''}`, { details: { problems: problems.slice(0, 20) } });
  }
  return { data, table };
}

/** Answers one checked request. Throws RequestError (input problems the caller can fix). */
function answer({ data, table }, req) {
  const located = core.locatePostcode(req.postcode, table);
  if (located.error) {
    const err = new RequestError(OUTSIDE_CODE[located.error] ?? 'postcode_invalid', core.lookupMessage(located.error, located.place), 'postcode');
    if (located.place) err.place = located.place;
    throw err;
  }
  const r = located.result;
  const point = { lat: r.lat, lon: r.lon };
  const byDistance = core.courtsByDistance(data.courts, point);
  let chosen; let source;
  if (req.courtId) {
    const found = byDistance.find((row) => row.court.id === req.courtId);
    if (!found) throw new RequestError('court_not_found', `No court has the id ${JSON.stringify(req.courtId.slice(0, 60))}.`, 'courtId');
    chosen = found; source = 'court_id';
  } else { chosen = byDistance[0]; source = 'nearest'; }
  const from = req.measureFrom === 'postcode' ? point : chosen.court;
  const courtRow = (row, i) => ({ rank: i + 1, id: row.court.id, name: row.court.name, ...pick(row.court, ['location']), lat: row.court.lat, lon: row.court.lon, distanceMiles: round(row.distance) });
  const ranked = core.rankChambersFromPoint(data.chambers, from).filter((row) => !row.hidden);
  const within = ranked.filter((row) => req.radiusMiles === null || row.distance <= req.radiusMiles).length;
  const chambers = ranked.slice(0, req.chambers).map((row, i) => ({
    rank: i + 1,
    id: row.chambers.id,
    name: row.chambers.name,
    ...pick(row.chambers, ['website', 'email', 'phone']),
    distanceMiles: round(row.distance),
    distanceFromPostcodeMiles: round(core.haversine(point.lat, point.lon, row.nearestBranch.lat, row.nearestBranch.lon)),
    withinRadius: req.radiusMiles === null || row.distance <= req.radiusMiles,
    branch: pick(row.nearestBranch, ['name', 'city', 'address', 'phone', 'lat', 'lon']),
  }));
  return {
    query: { postcode: req.postcode.trim(), outcode: r.outcode },
    location: { outcode: r.outcode, postcode: r.postcode ?? null, label: r.label, nation: r.nationName, lat: r.lat, lon: r.lon, precision: 'postcode_district_centre' },
    radiusMiles: req.radiusMiles,
    measureFrom: req.measureFrom,
    chosenCourt: { ...courtRow(chosen, 0), source },
    courts: byDistance.slice(0, req.courts).map(courtRow),
    chambers,
    chambersWithinRadius: within,
    chambersConsidered: ranked.length,
  };
}

const dataInfo = ({ data, table }) => ({ finderDataSchemaVersion: data.schemaVersion, finderDataUpdatedOn: data.updatedOn ?? null, postcodeDataBuilt: table.meta?.built ?? null });

function humanText(a) {
  const lines = [`${a.query.postcode}: ${a.location.label}, ${a.location.nation} (${a.location.outcode})`, `Nearest court: ${a.chosenCourt.name} (${a.chosenCourt.distanceMiles} miles)`];
  a.courts.forEach((c) => lines.push(`  court ${c.rank}. ${c.name}, ${c.distanceMiles} miles`));
  lines.push(`Chambers ${a.measureFrom === 'court' ? `nearest ${a.chosenCourt.name}` : 'nearest the postcode'} (${a.chambersWithinRadius} within ${a.radiusMiles ?? 'any'} miles):`);
  a.chambers.forEach((c) => lines.push(`  ${c.rank}. ${c.name}, ${c.distanceMiles} miles${c.withinRadius ? '' : ' (beyond the radius)'}${c.email ? `, ${c.email}` : ''}${c.phone ? `, ${c.phone}` : ''}`));
  return lines.join('\n');
}

async function run(ctx, argv) {
  const args = parseArgs(argv, {
    flags: ['--json', '--help', '--version', '--schema'],
    options: ['--postcode', '--courts', '--chambers', '--radius-miles', '--court-id', '--measure-from', '--request', '--finder-data', '--postcode-data'],
    short: { h: '--help', V: '--version' },
  });
  if (args.flags.version) return { body: { version: VERSION, schemaVersion: SCHEMA_VERSION }, text: VERSION };
  const help = await helpResult(args, buildHelpDoc);
  if (help) return help;
  if (args.positionals.length) throw new CliError('usage_too_many_arguments', 'Takes no positional arguments: use --postcode or --request. Run with --help.', { exit: EXIT.USAGE });
  const o = args.options;
  const byFlags = ['postcode', 'courts', 'chambers', 'radius-miles', 'court-id', 'measure-from'].some((k) => o[k] !== undefined);
  if (o.request !== undefined && byFlags) throw new CliError('usage_conflicting_options', '--request cannot be combined with --postcode and the other request options.', { exit: EXIT.USAGE });
  if (o.request === undefined && o.postcode === undefined) throw new CliError('usage_missing_arguments', 'Needs --postcode or --request. Run with --help.', { exit: EXIT.USAGE });

  let raw;
  if (o.request !== undefined) {
    let text;
    if (o.request === '-') text = await readStdinText(MAX_REQUEST_BYTES);
    else {
      try {
        if ((await stat(resolve(o.request))).size > MAX_REQUEST_BYTES) throw new CliError('request_too_large', 'The request is larger than 2 MB.');
        text = await readFile(resolve(o.request), 'utf8');
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError('request_not_found', `The request ${o.request} could not be read (${err.code ?? 'error'}).`);
      }
    }
    try { raw = JSON.parse(text); } catch { throw new CliError('invalid_json', 'The request is not valid JSON.'); }
  } else {
    const number = (v, name) => {
      if (v === undefined) return undefined;
      if (name === 'radius-miles' && v === 'all') return 'all';
      if (!/^\d+(\.\d+)?$/.test(v)) throw new CliError('usage_bad_option', `--${name} needs a number.`, { exit: EXIT.USAGE });
      return Number(v);
    };
    raw = { postcode: o.postcode, courts: number(o.courts, 'courts'), chambers: number(o.chambers, 'chambers'), radiusMiles: number(o['radius-miles'], 'radius-miles'), courtId: o['court-id'], measureFrom: o['measure-from'] };
    for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  }
  const batch = Array.isArray(raw);
  if (batch && (raw.length === 0 || raw.length > MAX_BATCH)) throw new CliError('invalid_request', `A batch holds 1 to ${MAX_BATCH} requests; this has ${raw.length}.`);

  const loaded = await loadData(o['finder-data'] ?? DEFAULT_FINDER_DATA, o['postcode-data'] ?? DEFAULT_POSTCODE_DATA);
  const defaultRadius = loaded.data.defaultTravelMiles ?? null;
  const one = (item) => {
    try { return answer(loaded, checkRequest(item, defaultRadius)); } catch (err) {
      if (err instanceof RequestError) {
        const e = new CliError(err.code, err.message, { details: { ...(err.path ? { path: err.path } : {}), ...(err.place ? { place: err.place } : {}) } });
        if (!Object.keys(e.details).length) e.details = null;
        throw e;
      }
      throw err;
    }
  };

  if (!batch) {
    const a = one(raw);
    return { body: { schemaVersion: SCHEMA_VERSION, mode: 'single', ...a, data: dataInfo(loaded) }, text: humanText(a) };
  }
  const items = raw.map((item, index) => {
    try { return { index, ok: true, ...one(item) }; } catch (err) {
      return { index, ok: false, error: { code: err.code ?? 'internal_error', message: err.message, ...(err.details ? { details: err.details } : {}) } };
    }
  });
  const failed = items.filter((i) => !i.ok).length;
  const body = { schemaVersion: SCHEMA_VERSION, mode: 'batch', succeeded: items.length - failed, failed, items, data: dataInfo(loaded) };
  if (!failed) return { body };
  return { exit: EXIT.INPUT, body, error: { code: 'items_failed', message: `${failed} of ${items.length} requests failed; the others were answered. See items.` } };
}

const argv = process.argv.slice(2);
await runCli({ tool: TOOL, version: VERSION, json: argv.includes('--json'), main: (ctx) => run(ctx, argv) });
