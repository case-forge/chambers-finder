# Chambers Finder

Barristers' chambers near any family court in England and Wales. Use it at [caseforge.uk/chambers-finder](https://caseforge.uk/chambers-finder/). This repository is the tool on its own: a static web page that finds the courts and chambers nearest a postcode, its two data files, and a command line that answers the same question as JSON.

Chambers Finder covers England and Wales only. A postcode in Scotland, Northern Ireland, Jersey, Guernsey or the Isle of Man gets a plain note saying so, never a guess. Everything runs on the device: the page fetches its own files and nothing is sent anywhere. More tools are at [caseforge.uk](https://caseforge.uk/).

## What is in the repository

| Path | What it is |
| --- | --- |
| `layouts/`, `content/`, `hugo.toml` | The Hugo site: one page, a not found page and the header and footer partials |
| `assets/finder/` | The page's styles, scripts (`app.js`, `finder-core.js`) and the postcode table |
| `static/` | The court and chambers data (`finder-data.json`), the web app manifest, images, the shared browser scripts and styles, and `_headers` |
| `chambers-finder-cli/` | The command line, with its own README, schemas and help |
| `scripts/` | The offline worker build, the postcode table builder and the offline tool list |
| `tests/` | The tests: `npm test` |
| `DATA-LICENCE.md`, `NOTICE`, `LICENSE`, `THIRD-PARTY-LICENSES/` | The licences, see below |

## Running the site

You need Node 22 or later and Hugo 0.165.0 or later (the extended edition).

```sh
npm ci            # installs the QR code library, which Hugo publishes from node_modules
npm run build     # hugo, then the offline service worker; the site is in public/
npm run serve     # hugo server for local work (no service worker is registered)
npm test
```

Set `baseURL` in `hugo.toml` to the address the site is served from, at the root of a host (for example `https://finder.example/`). The offline worker is `/sw.js` with scope `/`, so a site under a path needs `scripts/offline-tools.mjs` changed to match.

### Headers

`static/_headers` is in Cloudflare Pages format and carries the security headers, one Content-Security-Policy for the page and the cache rules. Other hosts need the same rules written in their own format:

- **Content-Security-Policy:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'`, plus `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`, `object-src 'none'` and `upgrade-insecure-requests`. The page has no inline script and no style attribute, so this holds without exceptions.
- **`/sw.js`, `/js/*`, `/css/*`, `/vendor/*`:** `Cache-Control: no-cache`. These have fixed names, so a long lifetime would keep an old copy after a deploy.
- **`/finder/*`:** `public, max-age=31536000, immutable`. These files carry a content hash in their names.
- **`/finder-data.json`:** `public, max-age=300, must-revalidate`. It is edited in place and fetched by a fixed name.

## The command line

```sh
node chambers-finder-cli/cli.mjs --postcode "M1 1AE"
node chambers-finder-cli/cli.mjs --help
```

It finds the courts nearest a postcode and the chambers nearest the chosen court, from the two data files, with the same ranking as the page. `--json` prints one JSON object, and the exit codes and error codes are stable. `chambers-finder-cli/README.md` has the full contract, and `--help` (or `--help <topic>`) documents the tool from the tool itself. `npm link` in this folder makes the `chambers-finder` command available anywhere.

## Using the data without the site

The two data files are enough to answer "which court is nearest this postcode, and which chambers are nearest that court" from any language, with no code from this repository. Both files are minified onto a single line, so read them with a JSON parser; `grep` and `head` on them print the whole file.

**`static/finder-data.json`**

- Top level: `schemaVersion`, `updatedOn`, `defaultTravelMiles` (35), `travelRadiusOptions` (20, 35, 50), `focusArea`, and the two lists `courts` and `chambers`.
- A court has `id`, `name`, `location` (the town), `lat`, `lon` and `aliases`, and sometimes `notes`.
- A chambers has `id`, `name`, `website`, `email` (the clerks), `phone`, `aliases` and `branches`. A branch has `name`, `city`, `lat`, `lon`, `phone` and `address`. Every chambers has at least one branch; some have several (up to seven).
- Coordinates are decimal degrees (WGS84). The file holds no starred, hidden or contacted state: those are a person's saved preferences in the page and never appear here.

**`assets/finder/data/postcode-districts.json`** turns a postcode into a point.

1. Take the outward code: the postcode without its last three characters, spaces removed and upper cased (`ox2 7xx` and `OX2 7XX` are both `OX2`; an outward code on its own is used as it is).
2. Look it up in `d`. The entry is `[lat, lon, label, nation]`: the centre of that postcode district, the local authority most of its postcodes fall in, and `E` or `W`. That point is the whole precision of the lookup: every postcode in a district gets the same point, a few kilometres at most from any address in it.
3. If it is not in `d`, look it up in `x` (first the whole outward code, then just its letters, so `TD12` is found by outward code and `EH` by area). `x` maps a place to `S`, `N`, `J`, `G` or `I` (Scotland, Northern Ireland, Jersey, Guernsey, the Isle of Man). These have no coordinates and no answer: Chambers Finder covers England and Wales only. A code in neither `d` nor `x` is not recognised. `GIR 0AA` and BFPO numbers name no place and have no point.

**Distance** is the great circle distance in miles, by the haversine formula with an earth radius of 3958.8 miles, between two latitude and longitude points. It is a straight line, not a drive.

**Courts** rank by that distance from the point, nearest first. The nearest court is the first.

**Chambers near a court** rank by the distance from the court to the chambers' nearest branch (the smallest distance over its branches), nearest first, and equal distances fall in alphabetical order by name. Exact ties are common, because several chambers share a building: about a quarter of the courts have one among their six nearest chambers. The page breaks them with JavaScript's `localeCompare` on the name; in the current data a plain string comparison of the name, or of the `id`, gives the same five for every court. The branch that gave the distance is the one to show. The travel radius (`defaultTravelMiles`, 35 miles) is a filter on that distance: the page lists chambers inside it first and those beyond it separately, and a caller decides whether to drop or flag them. To rank chambers from the postcode itself instead of from a court, use the postcode's point in place of the court's.

Worked example, with the invented postcode `OX2 7XX`:

- The outward code is `OX2`, and `d.OX2` is `[51.766, -1.281, "Oxford", "E"]`: the point is 51.766, -1.281, in England.
- The nearest court is `oxford-family-court` (51.752, -1.2577), 1.39 miles away. The next is `high-wycombe-magistrates-court-and-family-court`, 24.82 miles.
- The chambers nearest that court are `3pb-barristers` (0.00 miles, Oxford branch, one of its seven), `harcourt-chambers` (0.29, Oxford), `pump-court-chambers` (26.02, Swindon branch), `northampton-chambers` (37.07, Northampton) and `guildford-chambers` (46.31, Guildford). With the default 35 mile radius the first three are inside it and the last two are beyond it.

## Updating the data

`static/finder-data.json` holds the courts and the chambers, with `schemaVersion`, `updatedOn`, `defaultTravelMiles`, `travelRadiusOptions` and `focusArea`. When editing by hand:

- Keep each `id` stable. It is the localStorage key for a person's stars and notes, so renaming one loses their saved data.
- Use decimal `lat` and `lon`. A postcode's own point from the ONS Postcode Directory is a reliable source.
- Keep `travelRadiusOptions` at 50 or below, since the radius chips stop there.
- Update `updatedOn` after a change, then run `npm test`.

The postcode table is rebuilt with `scripts/build-postcode-districts.mjs`; its header has the download links and options. Rebuild when a new ONS Postcode Directory release matters (district boundaries change slowly, so yearly is plenty), then run `npm test`.

## Offline

The tool opens and works with the network switched off after one visit. `scripts/build-offline.mjs`, run after `hugo` (`npm run build` does both), writes `public/sw.js` from the built files: it follows everything the page loads, hashes every file, and lists them in the worker, so a changed file changes the worker and browsers install the new version. The court and chambers data is fetched from the network first and the last copy is used when there is no connection. To switch offline mode off everywhere, set `[params.offline] enabled = false` in `hugo.toml` and deploy: the next deploy ships a stand-in worker that removes the worker and its caches from every browser that had it.

## Licences

- **Code:** Mozilla Public License 2.0 (`LICENSE`).
- **Chambers directory data** (the chambers, branches and contact details in `static/finder-data.json`): Creative Commons Attribution 4.0 (CC BY 4.0). Suggested credit: "Chambers directory by CaseForge (caseforge.uk), CC BY 4.0".
- **Court list:** based in part on the GOV.UK Find a Court or Tribunal service, which contains public sector information licensed under the Open Government Licence v3.0.
- **Postcode data:** Office for National Statistics licensed under the Open Government Licence v3.0. Contains OS data &copy; Crown copyright and database right 2026. Contains Royal Mail data &copy; Royal Mail copyright and database right 2026.

`DATA-LICENCE.md` has the data licence in full, `NOTICE` lists every third party component the repository ships, and `THIRD-PARTY-LICENSES/` holds the full text of each component's licence. The attribution is also shown on the page itself, under "Data sources".

## Source

This repository is refreshed as a whole with each release, so a pull request here is applied by hand rather than merged.
