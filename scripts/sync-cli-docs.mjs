#!/usr/bin/env node
/**
 * Keeps the generated tables in chambers-finder-cli/README.md equal to what the tool prints for `--help`.
 *
 *   node scripts/sync-cli-docs.mjs          rewrite the sections between the markers
 *   node scripts/sync-cli-docs.mjs --check  exit 1 when the README is out of date
 *
 * The README opts in with `<!-- cli-docs:NAME -->` ... `<!-- /cli-docs:NAME -->` marker pairs. tests/cliHelp.test.mjs
 * runs the same check.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readVersion, readmeSections, markdownTable, fillReadme } from './cli-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const README = root + 'chambers-finder-cli/README.md';
const rowsTable = (header, rows) => markdownTable(header, rows.map((r) => [`\`${r.name}\``, r.text]));

/** [current text, generated text] of the CLI README. */
export async function renderReadme() {
  const { buildDoc } = await import('../chambers-finder-cli/docs.mjs');
  const doc = buildDoc({ version: readVersion(new URL('../chambers-finder-cli/package.json', import.meta.url)) });
  const extra = { request: rowsTable(['Field', 'Kind and meaning'], doc.requestRows), output: rowsTable(['Field', 'Meaning'], doc.outputRows) };
  const current = readFileSync(README, 'utf8');
  return [current, fillReadme(current, readmeSections(doc, extra))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const [current, next] = await renderReadme();
  if (current !== next) {
    if (check) { console.error('chambers-finder-cli/README.md is out of date: run node scripts/sync-cli-docs.mjs'); process.exitCode = 1; }
    else { writeFileSync(README, next); console.log('updated chambers-finder-cli/README.md'); }
  }
}
