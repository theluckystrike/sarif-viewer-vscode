'use strict';
// package.json, source tree and webview rules: phrase-first name, engine floor, no network code, CSP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { ext: read('src/extension.js'), support: read('src/support.js'), rate: read('src/rate.js'), worker: read('src/worker.js'), core: read('src/core/sarif.js') + read('src/core/paths.js'), view: read('media/viewer.js'), md: read('media/markdown.js') };

test('displayName has every word of "sarif viewer", "sarif", "codeql results" (codeql), "static analysis results"', () => {
  const words = pkg.displayName.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of ['sarif', 'viewer', 'codeql', 'static', 'analysis', 'results', 'semgrep']) assert.ok(words.includes(w), w);
  assert.ok(pkg.displayName.toLowerCase().startsWith('sarif viewer'));
});

test('description says Free, No sign-in and offline', () => {
  for (const s of ['Free', 'No sign-in', 'offline']) assert.ok(pkg.description.includes(s), s);
});

test('engines.vscode is the OVX1 floor ^1.90.0; main and icon exist', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
  assert.ok(fs.existsSync(path.join(ROOT, pkg.icon)));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
});

test('custom editor for *.sarif and *.sarif.json with explicit activation', () => {
  const ce = pkg.contributes.customEditors[0];
  assert.deepEqual(ce.selector.map(s => s.filenamePattern), ['*.sarif', '*.sarif.json']);
  assert.ok(pkg.activationEvents.includes('onCustomEditor:' + ce.viewType));
  assert.ok(SRC.ext.includes(`VIEW_TYPE = '${ce.viewType}'`));
});

test('every contributed command is registered', () => {
  for (const { command } of pkg.contributes.commands) {
    const suffix = command.split('.').pop();
    const ok = SRC.ext.includes(`'${command}'`) || (SRC.support.includes(`\${prefix}.${suffix}\``) && SRC.ext.includes("SECTION = 'sarifViewer'"));
    assert.ok(ok, command);
  }
});

test('every setting is read somewhere', () => {
  for (const key of Object.keys(pkg.contributes.configuration.properties)) {
    const short = key.split('.').slice(1).join('.');
    const all = SRC.ext + SRC.rate + SRC.support;
    assert.ok(all.includes(`'${short}'`) || all.includes(`"${short}"`) || (short === 'askForRating' && SRC.rate.includes('askForRating')) || (short === 'showSupportLinks' && SRC.support.includes("'showSupportLinks'")), key);
  }
});

test('no network modules, no child processes, no telemetry in shipped code', () => {
  for (const [name, code] of Object.entries(SRC)) {
    assert.ok(!/require\(['"](https?|net|tls|dgram|child_process|http2)['"]\)/.test(code), name);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(code), name);
    assert.ok(!/telemetry/i.test(code.replace(/no telemetry/gi, '')), name);
  }
});

test('webview CSP is default-src none with nonce scripts; no inline style attributes in built HTML', () => {
  assert.match(SRC.ext, /default-src 'none'/);
  assert.match(SRC.ext, /script-src 'nonce-\$\{n\}'/);
  assert.ok(!/connect-src/.test(SRC.ext));
  assert.ok(!/ style="/.test(SRC.view), 'style attributes are blocked by the CSP');
  assert.ok(!/setAttribute\('style'/.test(SRC.view));
  assert.ok(!/\shref="\$\{/.test(SRC.view), 'links use data-href');
});

test('openExternal only takes http and https', () => {
  assert.match(SRC.ext, /case 'openExternal'[\s\S]{0,200}\^https\?:/);
});

test('vsix ignore list keeps tests, samples and scripts out', () => {
  const ig = read('.vscodeignore');
  for (const p of ['test/**', 'samples/**', 'scripts/**', 'images/**']) assert.ok(ig.includes(p), p);
});

test('walkthrough media files exist', () => {
  for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) assert.ok(fs.existsSync(path.join(ROOT, s.media.markdown)), s.media.markdown);
  assert.ok(fs.existsSync(path.join(ROOT, 'media/sample.sarif')));
});
