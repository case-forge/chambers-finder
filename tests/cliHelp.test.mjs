/**
 * The command line documents itself (`--help`, `--help <topic>`, `--schema`, `--json --help`), and this file stops
 * that documentation drifting from the code: every request field, answer field, error code and exit code must be in
 * the help, every example must run, and the generated README tables must equal what the tool prints. The help is
 * generated from the tool's own tables (chambers-finder-cli/docs.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_MEANINGS, USAGE_ERRORS, INTERNAL_ERROR } from '../scripts/cli-contract.mjs';
import { renderReadme } from '../scripts/sync-cli-docs.mjs';
import * as docs from '../chambers-finder-cli/docs.mjs';
import { REQUEST_KEYS } from '../chambers-finder-cli/request.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'chambers-finder-cli', 'cli.mjs');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const TOPICS = ['request', 'output', 'errors', 'examples', 'schema'];

function run(args, { cwd, input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('--help works in an empty folder, is plain stable text, and lists options, exit codes, examples and topics; -h and the word help are the same', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhelp-'));
  try {
    const a = run(['--help'], { cwd: d });
    assert.equal(a.status, 0);
    assert.equal(a.stderr, '');
    assert.equal(a.stdout, run(['--help'], { cwd: d }).stdout, 'the help is stable');
    assert.doesNotMatch(a.stdout, /\u001b\[/, 'no colour codes');
    assert.match(a.stdout, /^chambers-finder \d+\.\d+\.\d+: /);
    for (const word of ['Usage:', 'Options:', 'Exit codes:', 'Examples:', 'More:']) assert.ok(a.stdout.includes(word), word);
    for (const code of Object.keys(EXIT_MEANINGS)) assert.match(a.stdout, new RegExp(`^  ${code}  `, 'm'), `exit code ${code}`);
    for (const topic of TOPICS) assert.ok(a.stdout.includes(topic), `lists the topic ${topic}`);
    for (const alias of [['-h'], ['-help'], ['-?'], ['help']]) assert.equal(run(alias).stdout, a.stdout, alias.join(' '));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('every topic prints, an unknown topic is a usage error, and --json --help is one JSON object with the same text', () => {
  for (const topic of TOPICS) {
    const text = run(['--help', topic]);
    assert.equal(text.status, 0, topic);
    assert.ok(text.stdout.length > 100, `${topic} has content`);
    const j = run(['--json', '--help', topic]);
    assert.equal(j.status, 0);
    assert.equal(j.stderr, '');
    assert.equal(j.json.topic, topic);
    assert.equal(j.json.help.trim(), text.stdout.trim());
  }
  assert.equal(run(['--json', '--help', 'nonsense']).json.error.code, 'usage_unknown_topic');
  assert.equal(run(['--help', 'a', 'b']).status, 2);
  const overview = run(['--json', '--help']).json;
  assert.deepEqual(overview.exitCodes, JSON.parse(JSON.stringify(EXIT_MEANINGS)));
  assert.ok(overview.examples.length >= 2 && overview.examples.every((e) => e.command.includes('chambers-finder ')));
});

test('--schema prints the request schema, byte for byte the file, also as JSON', () => {
  assert.deepEqual(JSON.parse(run(['--schema']).stdout), JSON.parse(read('chambers-finder-cli/request.schema.json')));
  assert.deepEqual(run(['--json', '--schema']).json.schema, JSON.parse(read('chambers-finder-cli/request.schema.json')));
});

test('every request field and every top-level answer field is in the help', () => {
  const request = run(['--help', 'request']).stdout;
  for (const k of REQUEST_KEYS) assert.match(request, new RegExp(`^  ${k}\\b`, 'm'), `request field ${k}`);
  const schema = JSON.parse(read('chambers-finder-cli/response.schema.json'));
  const output = run(['--help', 'output']).stdout;
  for (const [k, v] of Object.entries(schema.properties)) {
    assert.match(output, new RegExp(`^  ${k}\\b`, 'm'), `answer field ${k}`);
    assert.ok(v.description, `${k} is described in response.schema.json, which is where the help gets its words`);
  }
});

test('every error code the source can raise is documented, and nothing documented is gone from the source', () => {
  const source = ['chambers-finder-cli/cli.mjs', 'chambers-finder-cli/request.mjs'].map(read).join('\n');
  const documented = new Set([...USAGE_ERRORS.map((e) => e.code), INTERNAL_ERROR.code, ...docs.ERRORS.map((e) => e.code)]);
  const thrown = [...source.matchAll(/(?:CliError|RequestError|fail)\(\s*'([a-z][a-z_]+)'/g)].map((m) => m[1]);
  const block = source.match(/const OUTSIDE_CODE = \{[\s\S]*?\};/)?.[0] ?? '';
  const mapped = [...block.matchAll(/'([a-z][a-z_]+)'/g)].map((m) => m[1]).filter((c) => c.startsWith('postcode_'));
  const more = source.includes('readStdinText') ? ['request_too_large'] : [];
  for (const code of new Set([...thrown, ...mapped, ...more])) assert.ok(documented.has(code), `${code} is raised but not documented`);
  for (const e of docs.ERRORS) assert.ok(new RegExp(`'${e.code}'`).test(source), `${e.code} is documented but never raised`);
  const text = run(['--help', 'errors']).stdout;
  for (const code of documented) assert.ok(text.includes(code), `--help errors lists ${code}`);
});

test('every example in the help works exactly as written', () => {
  for (const ex of docs.EXAMPLES) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhelp-'));
    try {
      for (const [name, content] of Object.entries(ex.files ?? {})) {
        const file = path.join(d, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      }
      const input = ex.stdinFile ? fs.readFileSync(path.join(d, ex.stdinFile), 'utf8') : undefined;
      const r = run(ex.args, { cwd: d, input });
      assert.equal(r.status, 0, `"${ex.title}" (${ex.args.join(' ')}): ${r.stderr || r.stdout.slice(0, 300)}`);
      if (ex.args.includes('--json')) assert.equal(r.json.ok, true, `"${ex.title}" answers ok`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test('the generated tables in chambers-finder-cli/README.md equal what the tool prints (run node scripts/sync-cli-docs.mjs to fix)', async () => {
  const [current, generated] = await renderReadme();
  assert.equal(current, generated, 'chambers-finder-cli/README.md is out of date: run node scripts/sync-cli-docs.mjs');
  assert.ok(/<!-- cli-docs:errors -->/.test(current) && /<!-- cli-docs:exit-codes -->/.test(current), 'the README has its generated sections');
});
