/**
 * The site as built: `hugo` into a temporary folder, then the checks that keep a standalone repository honest.
 * The build tests skip themselves when hugo is not installed or `npm ci` has not been run (the QR library is
 * mounted from node_modules).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

let hugoOk = true;
try { execFileSync('hugo', ['version'], { stdio: 'ignore' }); } catch { hugoOk = false; }
const depsOk = fs.existsSync(path.join(root, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js'));

let out = null;
before(() => {
  if (!hugoOk || !depsOk) return;
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-finder-'));
  execFileSync('hugo', ['--quiet', '-d', out], { cwd: root, stdio: 'ignore' });
});
const skip = (t) => t.skip(hugoOk ? 'run npm ci first' : 'hugo is not installed');
const walk = (dir, base = dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, base, acc); else acc.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return acc;
};

test('the page, the not-found page, the data, the QR library and the stand-in worker are published', (t) => {
  if (!out) return skip(t);
  for (const f of ['index.html', '404.html', 'finder-data.json', 'manifest.json', 'sw.js', 'vendor/qrcode.js', 'js/shared/theme.js', 'js/shared/icons.js']) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} is in the build`);
  }
  assert.ok(walk(out).some((f) => /^finder\/data\/postcode-districts\.[0-9a-f]+\.json$/.test(f)), 'the fingerprinted postcode table');
});

test('the QR code library is the npm package file, byte for byte', (t) => {
  if (!out) return skip(t);
  assert.equal(fs.readFileSync(path.join(out, 'vendor', 'qrcode.js')).toString('hex'),
    fs.readFileSync(path.join(root, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')).toString('hex'));
  assert.match(read('package.json'), /"qrcode-generator": "\d+\.\d+\.\d+"/, 'the dependency is pinned to an exact version');
});

test('every local link, script, stylesheet and image in every page exists', (t) => {
  if (!out) return skip(t);
  const broken = [];
  for (const rel of walk(out).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(out, rel), 'utf8');
    for (const m of html.matchAll(/\s(?:href|src|data-light|data-dark|data-sw)\s*=\s*["']?([^"'\s>]+)/g)) {
      const ref = m[1].replace(/&amp;/g, '&');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref)) continue;
      const clean = ref.split('#')[0].split('?')[0];
      if (!clean) continue;
      const target = clean.startsWith('/') ? path.join(out, clean) : path.join(out, path.posix.dirname(rel), clean);
      if (!fs.existsSync(target)) broken.push(`${rel}: ${ref}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('nothing is loaded from another origin: scripts, styles, images, fonts and fetches are this site\'s own', (t) => {
  if (!out) return skip(t);
  const external = [];
  for (const rel of walk(out).filter((f) => /\.(?:html|js|css)$/.test(f))) {
    const text = fs.readFileSync(path.join(out, rel), 'utf8');
    for (const m of text.matchAll(/<(?:script|img|source|link)\b[^>]*\s(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
      if (/^<link\b/i.test(m[0]) && !/rel\s*=\s*["']?(?:stylesheet|icon|preload|manifest|modulepreload)/i.test(m[0])) continue;
      external.push(`${rel}: ${m[1]}`);
    }
    for (const m of text.matchAll(/url\(\s*["']?(https?:\/\/[^)"']+)/gi)) external.push(`${rel}: ${m[1]}`);
    for (const m of text.matchAll(/\b(?:fetch|importScripts|import)\(\s*["'`](https?:\/\/[^"'`]+)/g)) external.push(`${rel}: ${m[1]}`);
  }
  assert.deepEqual(external, []);
});

test('no inline script or style attribute anywhere, so the Content-Security-Policy in static/_headers holds', (t) => {
  if (!out) return skip(t);
  const csp = read('static', '_headers');
  assert.match(csp, /Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.equal((csp.match(/Content-Security-Policy:/g) || []).length, 1, 'sent once');
  for (const rel of walk(out).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(out, rel), 'utf8');
    assert.ok(!/<script(?![^>]*\ssrc)[^>]*>\s*\S/i.test(html.replace(/<script[^>]*type=["']?application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, '')), `${rel} has an inline script`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${rel} has a style attribute`);
  }
});

test('the offline worker is written at /sw.js, scoped to /, lists the page, the postcode table and the QR library, and keeps the data live', async (t) => {
  if (!out) return skip(t);
  const mod = await import(pathToFileURL(path.join(root, 'scripts', 'build-offline.mjs')).href);
  const { TOOLS } = await import(pathToFileURL(path.join(root, 'scripts', 'offline-tools.mjs')).href);
  assert.ok(mod.registersWorker(out, TOOLS[0]), 'the page registers /sw.js');
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), new RegExp(`data-tool=["']?${TOOLS[0].id}["'\\s>]`), 'the registration names the tool the worker was built for, so its caches and kill switch are found');
  const [r] = mod.buildOffline(out, { write: true, tools: TOOLS });
  assert.deepEqual(r.missing, [], 'every file the page names is in the build');
  const body = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
  assert.match(body, /CaseForge offline worker/);
  assert.ok(r.core.some(([p]) => /^\/finder\/data\/postcode-districts\.[0-9a-f]+\.json$/.test(p)), 'the postcode table');
  assert.ok(r.core.some(([p]) => p === '/vendor/qrcode.js'), 'the QR library');
  assert.deepEqual(r.live, ['/finder-data.json']);
});

test('the attribution the data licences require is in the product itself, its README and its NOTICE', (t) => {
  if (!out) return skip(t);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const [name, text] of [['the page', html], ['README.md', read('README.md')], ['NOTICE', read('NOTICE')]]) {
    assert.match(text, /Open Government Licence v3\.0/, `${name}: OGL v3.0`);
    assert.match(text, /Office for National Statistics/, `${name}: ONS`);
    assert.match(text, /Royal Mail data/, `${name}: Royal Mail`);
    assert.match(text, /Crown copyright and database right/, `${name}: OS data`);
  }
  assert.match(html, /Creative Commons Attribution 4\.0/, 'the page: CC BY 4.0 for the directory');
  assert.match(read('DATA-LICENCE.md'), /CC BY 4\.0/);
  assert.match(read('README.md'), /DATA-LICENCE\.md/);
  assert.match(read('NOTICE'), /DATA-LICENCE\.md/);
  assert.doesNotMatch(read('NOTICE') + html + read('README.md'), /geonames/i);
});

test('the repository names no other CaseForge tool as part of itself, and ships no contact form or bug reporter', () => {
  assert.ok(!fs.existsSync(path.join(root, 'static', 'js', 'shared', 'bug-report.js')), 'no bug reporter (it posts to a contact form this repository does not have)');
  for (const f of walk(root).filter((p) => !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.startsWith('public/') && /\.(?:m?js|html|css|json|md|toml|ya?ml)$/.test(p) && !p.startsWith('tests/'))) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\/api\/contact|\/bundletool\/|\/envelope-guide\//.test(text) || /^(?:README\.md|NOTICE|DATA-LICENCE\.md)$/.test(f), `${f} reaches into another product`);
  }
});

test('every relative link in the Markdown files points at a file that is in the repository', () => {
  const broken = [];
  for (const rel of walk(root).filter((f) => f.endsWith('.md') && !f.startsWith('node_modules/'))) {
    const md = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const ref = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)) continue;
      const clean = ref.split('#')[0];
      if (clean && !fs.existsSync(path.join(root, path.posix.dirname(rel), clean))) broken.push(`${rel}: ${ref}`);
    }
  }
  assert.deepEqual(broken, []);
});
