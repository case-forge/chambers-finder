# Chambers Finder CLI

Finds the courts and the barristers' chambers nearest an England and Wales postcode, and prints the answer as JSON. It reads the same two data files as the Chambers Finder page (`static/finder-data.json`, the courts and chambers, and `assets/finder/data/postcode-districts.json`, the postcode table) and calls the page's own functions (`assets/finder/js/finder-core.js`): the same postcode lookup, the same distances and the same ranking. It needs Node 22 or later, has no dependencies and makes no network request. Nothing about a search is kept.

```bash
node chambers-finder-cli/cli.mjs --json --postcode "M1 1AE"
node chambers-finder-cli/cli.mjs --postcode M1          # plain text for a person
```

`package.json` declares a `chambers-finder` bin, so an installed copy is `chambers-finder --json --postcode "M1 1AE"`.

## Built-in help

`chambers-finder` documents itself, so a person or a program needs no other file to use it. `chambers-finder --help` prints a short overview: what the tool does, its options, the inputs it accepts, the exit codes, and examples. `chambers-finder --help <topic>` gives the detail (`request`, `output`, `errors`, `examples`, `schema`). `chambers-finder --schema` prints the JSON Schema, and `chambers-finder --json --help [topic]` returns the same content as one JSON object. The help is generated from the tool's own tables (`chambers-finder-cli/docs.mjs`), and `node scripts/sync-cli-docs.mjs` keeps the generated tables in this file equal to it; the suite fails when a table, a field, an error code or an example is out of date. Help can be asked for as `--help`, `-h`, `-help`, `-?`, `/?`, `--usage` or the word `help` (`help <topic>` works too); a mistyped option such as `--hewlp` is refused with the nearest real option named.

## What it answers

For a postcode it returns:

1. **Where the postcode is.** The centre of its postcode district (about the middle of the outward code, a few kilometres at most from any address in it), with the district's place name and nation. This is the precision of the data: it is not a street position, and two postcodes in one district give the same point.
2. **The nearest courts** (`courts`, nearest first), with straight-line distance in miles. `chosenCourt` is the nearest one, or the court named by `--court-id`.
3. **The nearest chambers** (`chambers`, nearest first), measured from the chosen court (the ones a solicitor would instruct for a hearing at that court). With `--measure-from postcode` they are measured from the postcode itself, as the page's postcode search shows them. Each row gives the chambers' name, website, clerks' email and phone where the data file has them, `distanceMiles` (from the point measured from), `distanceFromPostcodeMiles`, `withinRadius`, and the chambers' nearest `branch` (name, city, address, phone, latitude, longitude).

Distances are great-circle miles rounded to two places; ranking uses the unrounded values. Chambers rank by distance to their nearest branch, then by name. The travel radius (default: the data file's `defaultTravelMiles`, 35) does not remove anything: chambers beyond it are listed with `withinRadius: false`, and `chambersWithinRadius` says how many chambers in all are inside it.

## Options

| Option | Meaning |
| --- | --- |
| `--postcode <p>` | A full postcode (`M1 1AE`, `m11ae`) or an outward code (`LS1`). Case and spacing do not matter. |
| `--courts <n>` | How many courts to list, 1 to 20 (default 3). |
| `--chambers <n>` | How many chambers to list, 1 to 50 (default 5). |
| `--radius-miles <n\|all>` | The travel radius, 1 to 500, or `all` for none. |
| `--court-id <id>` | Measure from this court (an `id` in `finder-data.json`) instead of the nearest one. |
| `--measure-from <court\|postcode>` | Where the chambers' distances start (default `court`). |
| `--request <file \| ->` | A JSON request, or an array of them (a batch), from a file or standard input. Cannot be combined with the options above. |
| `--finder-data <file>`, `--postcode-data <file>` | The data files, if they are not beside the tool. |
| `--json` | Write exactly one JSON object to stdout, on success and on failure, and nothing else. |
| `--version`, `--help` | |

A request file holds the same fields in camel case (`postcode`, `courts`, `chambers`, `radiusMiles`, `courtId`, `measureFrom`, and an optional `schemaVersion` of 1); see `request.schema.json`. Keys it does not list are refused with `unknown_key`. A JSON array is a batch of up to 500 requests: each is answered in `items` (`ok` true with the answer's fields, or `ok` false with an `error`), one bad request does not stop the others, and the exit code is 3 if any failed.

Every request field with its option (also `chambers-finder --help request`):

<!-- cli-docs:request -->
| Field | Kind and meaning |
| --- | --- |
| `schemaVersion` | number. Optional. 1. |
| `_comment` | text. Ignored. For your own notes. |
| `postcode` | text. Required. A full postcode ("M1 1AE", "m11ae") or an outward code ("LS1"). Case and spacing do not matter. Option: --postcode. |
| `courts` | whole number 1 to 20. How many nearest courts to list. Default: 3. Option: --courts. |
| `chambers` | whole number 1 to 50. How many nearest chambers to list. Default: 5. Option: --chambers. |
| `radiusMiles` | number 1 to 500, or "all". The travel radius. Chambers beyond it are still listed but marked withinRadius false; "all" means no limit. Default: the data file's own default (usually 35). Option: --radius-miles. |
| `courtId` | text. Measure the chambers from this court (an id in finder-data.json) instead of the court nearest the postcode. Default: the nearest court. Option: --court-id. |
| `measureFrom` | one of court, postcode. Where the chambers' distances start: the chosen court, or the postcode itself. Default: court. Option: --measure-from. |
<!-- /cli-docs:request -->

## Output

Under `--json` a successful single answer looks like this (with one court and one chambers row; the real answer lists as many as asked for):

```json
{"ok":true,"tool":"chambers-finder-cli","cliVersion":"1.0.0","schemaVersion":1,"mode":"single",
 "query":{"postcode":"M1 1AE","outcode":"M1"},
 "location":{"outcode":"M1","postcode":"M1 1AE","label":"Manchester","nation":"England","lat":53.478,"lon":-2.236,"precision":"postcode_district_centre"},
 "radiusMiles":35,"measureFrom":"court",
 "chosenCourt":{"rank":1,"id":"manchester-family-court","name":"Manchester Family Court","location":"Manchester","lat":53.4808,"lon":-2.2426,"distanceMiles":0.33,"source":"nearest"},
 "courts":[{"rank":1,"id":"manchester-family-court","name":"Manchester Family Court","location":"Manchester","lat":53.4808,"lon":-2.2426,"distanceMiles":0.33}],
 "chambers":[{"rank":1,"id":"3pb-barristers","name":"3PB Barristers","website":"https://3pb.co.uk","email":"family.clerks@3pb.co.uk","phone":"0330 332 0773",
   "distanceMiles":0,"distanceFromPostcodeMiles":0.33,"withinRadius":true,
   "branch":{"name":"Manchester","city":"Manchester","address":"First Floor, 11 York Street, Manchester M2 2AW","phone":"0161 359 5333","lat":53.4808,"lon":-2.2426}}],
 "chambersWithinRadius":15,"chambersConsidered":59,
 "data":{"finderDataSchemaVersion":3,"finderDataUpdatedOn":"2026-09-07","postcodeDataBuilt":"2026-09-25"},"warnings":[]}
```

The fields are described in `response.schema.json`. Take the chambers to write to from `chambers[].email` (the clerks) and `chambers[].branch.address`. `data.finderDataUpdatedOn` says how fresh the directory is.

The answer's top-level fields (also `chambers-finder --help output`):

<!-- cli-docs:output -->
| Field | Meaning |
| --- | --- |
| `ok` | true when the run succeeded. |
| `tool` | Always chambers-finder-cli. |
| `cliVersion` | The version of this tool. |
| `schemaVersion` | The version of this answer format (1). |
| `mode` | "single" for one request; "batch" for a batch, where items[] holds one answer or error per request. |
| `query` | The request as it was read: the postcode and its outward code. |
| `location` | Where the postcode was placed: the centre of its postcode district, a few kilometres at most from any address in it. |
| `radiusMiles` | The travel radius used, in miles; null when the request said "all". |
| `measureFrom` | "court" or "postcode": where the chambers' distances start. |
| `chosenCourt` | The court the chambers are measured from: the nearest one, or the one named by courtId. Has rank, id, name, location, lat, lon, distanceMiles and source (nearest or court_id). |
| `courts` | The nearest courts, nearest first: rank, id, name, location, lat, lon and distanceMiles. |
| `chambers` | The nearest chambers, nearest first: rank, id, name, website, email (the clerks), phone, distanceMiles, distanceFromPostcodeMiles, withinRadius, and the nearest branch (name, city, address, phone, lat, lon). |
| `chambersWithinRadius` | How many chambers in all lie within the radius (not only the ones listed). |
| `chambersConsidered` | How many chambers were ranked in all. |
| `data` | Which data the answer came from: the directory's schema version and updatedOn date, and when the postcode table was built. |
| `warnings` | Notes that did not stop the answer. |
<!-- /cli-docs:output -->

## Exit codes and errors

<!-- cli-docs:exit-codes -->
| Exit code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | The input was fine and the build or the write failed (an unexpected fault). |
| 2 | The command line was wrong. |
| 3 | The input was rejected: the request or manifest, a file it names, or a place to write. |
<!-- /cli-docs:exit-codes -->

With `--json` a failure is `{"ok":false,"error":{"code":"...","message":"...","details":{...}}}`. `error.code` is a stable lower case string, and the exit code says the kind:

<!-- cli-docs:errors -->
| Error code | Exit | Meaning |
| --- | --- | --- |
| `usage_missing_arguments` | 2 | A required argument is missing. |
| `usage_too_many_arguments` | 2 | More arguments were given than the tool takes. |
| `usage_unknown_option` | 2 | An option the tool does not have (a typo is never taken for a file name). |
| `usage_bad_option` | 2 | An option was given without a value, or with a value it does not take. |
| `usage_unknown_topic` | 2 | `--help` was asked for a topic the tool does not have. |
| `usage_conflicting_options` | 2 | --request was combined with --postcode or another request option. |
| `request_not_found` | 3 | The --request file could not be read. |
| `request_too_large` | 3 | The request is over 2 MB. |
| `invalid_json` | 3 | The request, or a data file, is not valid JSON. |
| `invalid_request` | 3 | The request is not a JSON object (or a non-empty array of objects for a batch). |
| `unknown_key` | 3 | The request has a key this version does not know. |
| `unsupported_schema_version` | 3 | schemaVersion is present and is not 1. |
| `invalid_field_type` | 3 | A field has the wrong kind of value. |
| `invalid_field_value` | 3 | A field is outside its allowed range or list. |
| `missing_postcode` | 3 | The request has no postcode. |
| `postcode_invalid` | 3 | The postcode is not shaped like a UK postcode or outward code. |
| `postcode_unknown_area` | 3 | The postcode is shaped like one, but its postcode area is not recognised. |
| `postcode_outside_england_wales` | 3 | Scotland, Northern Ireland, Jersey, Guernsey or the Isle of Man: Chambers Finder covers England and Wales only. details.place names the place. |
| `postcode_special_gir` | 3 | GIR 0AA names no place, so no distance can be measured. |
| `postcode_special_bfpo` | 3 | A forces post office number names no place, so no distance can be measured. |
| `court_not_found` | 3 | No court in the data has the courtId given. |
| `data_file_not_found` | 3 | A data file (finder-data.json or postcode-districts.json) could not be read. |
| `data_invalid` | 3 | A data file failed its checks (schema version, ids, positions), so nothing was answered from it. |
| `items_failed` | 3 | A batch: at least one request failed. The others were still answered; items[] says which. |
| `internal_error` | 1 | An unexpected fault in the tool itself (no stack trace is printed). |
<!-- /cli-docs:errors -->

## Data checks

Before answering, the tool checks both data files (`validateFinderData` and `validatePostcodeTable` in `finder-core.js`): the schema version, unique ids, a usable position for every court and branch, and the postcode table's shape. A file that fails is refused with `data_invalid`, and no answer is given from a file that does not pass.

## Stability

Within a major version of `cliVersion` these do not change: the options and their meaning, the four exit codes, the meaning of `--json` and `--version`, the field names and types in the success object and in `error`, and every error code listed above. What may change without a major version: new fields, new error codes for new checks, new options, the wording of `message` (code against `error.code`, never the text), the data behind the answers (courts and chambers are added, moved and removed as the directory is kept up to date), and the order of unrelated keys. Ranking follows the page: if the page's ranking changes, the CLI's changes with it.

## Tests

`npm test` in the repository root runs this CLI as a child process (`tests/chambersFinderCli.test.mjs`): rankings against the page's functions on the real data for ten postcodes and both ways of measuring, the shared ranking function against an independent reference ranking with random starred and hidden preferences, edge postcodes, batches, exit codes, the `--json` shape against `response.schema.json`, schema and code agreement, and refusal of damaged data files.
