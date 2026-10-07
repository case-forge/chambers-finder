/**
 * Chambers Finder CLI: the tool describing itself (`chambers-finder --help`, its topics, the README tables). One
 * description, built from the request module's own limits; only the one-line meaning of each field, option and
 * error is written here, and tests/cliHelp.test.mjs fails when a field, a thrown code or an
 * example is missing or out of date.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REQUEST_KEYS, LIMITS, MEASURE_FROM, MAX_BATCH } from './request.mjs';

export const ERRORS = [
  { code: 'usage_conflicting_options', exit: 2, meaning: '--request was combined with --postcode or another request option.' },
  { code: 'request_not_found', exit: 3, meaning: 'The --request file could not be read.' },
  { code: 'request_too_large', exit: 3, meaning: 'The request is over 2 MB.' },
  { code: 'invalid_json', exit: 3, meaning: 'The request, or a data file, is not valid JSON.' },
  { code: 'invalid_request', exit: 3, meaning: 'The request is not a JSON object (or a non-empty array of objects for a batch).' },
  { code: 'unknown_key', exit: 3, meaning: 'The request has a key this version does not know.' },
  { code: 'unsupported_schema_version', exit: 3, meaning: 'schemaVersion is present and is not 1.' },
  { code: 'invalid_field_type', exit: 3, meaning: 'A field has the wrong kind of value.' },
  { code: 'invalid_field_value', exit: 3, meaning: 'A field is outside its allowed range or list.' },
  { code: 'missing_postcode', exit: 3, meaning: 'The request has no postcode.' },
  { code: 'postcode_invalid', exit: 3, meaning: 'The postcode is not shaped like a UK postcode or outward code.' },
  { code: 'postcode_unknown_area', exit: 3, meaning: 'The postcode is shaped like one, but its postcode area is not recognised.' },
  { code: 'postcode_outside_england_wales', exit: 3, meaning: 'Scotland, Northern Ireland, Jersey, Guernsey or the Isle of Man: Chambers Finder covers England and Wales only. details.place names the place.' },
  { code: 'postcode_special_gir', exit: 3, meaning: 'GIR 0AA names no place, so no distance can be measured.' },
  { code: 'postcode_special_bfpo', exit: 3, meaning: 'A forces post office number names no place, so no distance can be measured.' },
  { code: 'court_not_found', exit: 3, meaning: 'No court in the data has the courtId given.' },
  { code: 'data_file_not_found', exit: 3, meaning: 'A data file (finder-data.json or postcode-districts.json) could not be read.' },
  { code: 'data_invalid', exit: 3, meaning: 'A data file failed its checks (schema version, ids, positions), so nothing was answered from it.' },
  { code: 'items_failed', exit: 3, meaning: 'A batch: at least one request failed. The others were still answered; items[] says which.' },
];
export const WARNINGS = [{ code: 'engine_warning', meaning: 'An unexpected note from the engine (none is raised today).' }];

const FIELD = {
  schemaVersion: ['number', 'Optional. 1.', '(none)'],
  _comment: ['text', 'Ignored. For your own notes.', '(none)'],
  postcode: ['text', 'Required. A full postcode ("M1 1AE", "m11ae") or an outward code ("LS1"). Case and spacing do not matter.', '(none)'],
  courts: [`whole number ${LIMITS.courts.min} to ${LIMITS.courts.max}`, 'How many nearest courts to list.', String(LIMITS.courts.default)],
  chambers: [`whole number ${LIMITS.chambers.min} to ${LIMITS.chambers.max}`, 'How many nearest chambers to list.', String(LIMITS.chambers.default)],
  radiusMiles: [`number ${LIMITS.radiusMiles.min} to ${LIMITS.radiusMiles.max}, or "all"`, 'The travel radius. Chambers beyond it are still listed but marked withinRadius false; "all" means no limit.', 'the data file\'s own default (usually 35)'],
  courtId: ['text', 'Measure the chambers from this court (an id in finder-data.json) instead of the court nearest the postcode.', 'the nearest court'],
  measureFrom: [`one of ${MEASURE_FROM.join(', ')}`, 'Where the chambers\' distances start: the chosen court, or the postcode itself.', 'court'],
};
const FLAG = { postcode: '--postcode', courts: '--courts', chambers: '--chambers', radiusMiles: '--radius-miles', courtId: '--court-id', measureFrom: '--measure-from' };

const readJson = (relative) => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

export const EXAMPLES = [
  { title: 'The nearest courts and chambers for a postcode', args: ['--json', '--postcode', 'M1 1AE'], files: {} },
  { title: 'The three nearest courts and ten chambers, measured from the postcode, for an outward code', args: ['--json', '--postcode', 'LS1', '--courts', '3', '--chambers', '10', '--measure-from', 'postcode'], files: {} },
  { title: 'A batch from standard input', args: ['--json', '--request', '-'], stdinFile: 'requests.json', files: { 'requests.json': [{ postcode: 'M1 1AE' }, { postcode: 'LS1 4AP', courts: 1 }] } },
  { title: 'A batch from a file, one answer per request', args: ['--json', '--request', 'requests.json'], files: { 'requests.json': [{ postcode: 'M1 1AE' }, { postcode: 'B1 1AA', chambers: 3 }] }, note: `A JSON array of up to ${MAX_BATCH} requests. Use --request - for standard input.` },
];

export function buildDoc({ version }) {
  const response = readJson('./response.schema.json');
  const requestRows = REQUEST_KEYS.map((k) => ({ name: k, text: `${FIELD[k][0]}. ${FIELD[k][1]}${FIELD[k][2] === '(none)' ? '' : ` Default: ${FIELD[k][2]}.`}${FLAG[k] ? ` Option: ${FLAG[k]}.` : ''}` }));
  const outputRows = Object.entries(response.properties ?? {}).map(([name, v]) => ({ name, text: v.description || '(see the response schema)' }));
  return {
    tool: 'chambers-finder', version,
    summary: ['the courts and the barristers\' chambers nearest an England and Wales postcode, as JSON',
      'The same postcode lookup, distances and ranking as the Chambers Finder page, from its own two data files: no network.'],
    usage: ['chambers-finder [--json] --postcode <postcode> [options]', 'chambers-finder [--json] --request <request.json | ->', 'chambers-finder --schema | --version', 'chambers-finder --help [topic]'],
    options: [
      ['--postcode <p>', 'A full postcode ("M1 1AE") or an outward code ("LS1").'],
      ['--courts <n>', `How many nearest courts to list, ${LIMITS.courts.min} to ${LIMITS.courts.max} (default ${LIMITS.courts.default}).`],
      ['--chambers <n>', `How many nearest chambers to list, ${LIMITS.chambers.min} to ${LIMITS.chambers.max} (default ${LIMITS.chambers.default}).`],
      ['--radius-miles <n|all>', 'The travel radius in miles, 1 to 500, or all for none. Chambers beyond it are listed but marked withinRadius false. Default: the data file\'s own travel radius (35 miles today); the answer\'s radiusMiles says which was used.'],
      ['--court-id <id>', 'Measure the chambers from this court instead of the nearest one.'],
      ['--measure-from <m>', '"court" (default) or "postcode".'],
      ['--request <file | ->', 'A JSON request, or an array of them (a batch), from a file or standard input. Not combined with the options above.'],
      ['--finder-data <file>', 'finder-data.json, if it is not beside the tool.'],
      ['--postcode-data <file>', 'postcode-districts.json, if it is not beside the tool.'],
      ['--json', 'Write exactly one JSON object to stdout, on success and on failure, and nothing else. Without it the answer is plain text for a person.'],
      ['--schema', 'Print the request\'s JSON Schema (the answer\'s is response.schema.json beside the tool).'],
      ['--help [topic]', `A short overview, or the detail of a topic: ${['request', 'output'].concat(['errors', 'examples', 'schema']).join(', ')}.`],
      ['--version', 'Print the version.'],
    ],
    inputs: [
      'A postcode in England or Wales. Scotland, Northern Ireland, the Channel Islands and the Isle of Man are refused (postcode_outside_england_wales).',
      'Distances are straight-line miles from the middle of the postcode district (a few kilometres of precision), not road distances. Nothing about a search is kept.',
    ],
    errors: ERRORS, warnings: WARNINGS,
    topics: {
      request: { title: 'The request fields (--request), with the matching options', rows: requestRows },
      output: { title: 'The answer (--json): top-level fields; the full format is response.schema.json', rows: outputRows },
    },
    examples: EXAMPLES,
    schema: readJson('./request.schema.json'),
    requestRows, outputRows,
  };
}
