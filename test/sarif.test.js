'use strict';
// Core parser, query engine, compare and detail checks on the generated samples.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const S = require('../src/core/sarif');

const ROOT = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sarif-test-'));
execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-samples.mjs'), DIR], { stdio: 'ignore' });
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const load = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const ixOf = (...files) => { const docs = files.map(load); return { docs, ix: S.buildIndex(docs.map((doc, k) => ({ doc, name: files[k] }))) }; };
const ALL = { levels: [1, 1, 1, 1], supp: 'show', group: 'none' };

test('counts match the number of results in each sample', () => {
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.sarif') && !x.startsWith('broken') && !x.startsWith('hostile-deep-only') && !x.includes('utf8'))) {
    const doc = load(f);
    const want = doc.runs.reduce((n, r) => n + (r.results || []).length, 0);
    const { ix } = ixOf(f);
    assert.equal(S.facets(ix).total, want, f);
    assert.equal(S.query(ix, ALL).count, want, f);
  }
});

test('checkLog: SARIF 1.x refused, 2.0 warned, non-objects refused', () => {
  assert.equal(S.checkLog({ version: '1.0.0', runLogs: [] }).ok, false);
  assert.match(S.checkLog({ version: '2.0.0', runs: [] }).warning, /2\.0\.0/);
  assert.equal(S.checkLog([1, 2]).ok, false);
  assert.equal(S.checkLog({ version: '2.1.0' }).ok, false);
  assert.equal(S.checkLog({ version: '2.1.0', runs: [] }).warning, '');
});

test('effective level follows the spec: result level, kind, rule default, warning', () => {
  assert.equal(S.effectiveLevel({ level: 'note' }, null), 'note');
  assert.equal(S.effectiveLevel({ kind: 'pass' }, { defaultConfiguration: { level: 'error' } }), 'none');
  assert.equal(S.effectiveLevel({}, { defaultConfiguration: { level: 'error' } }), 'error');
  assert.equal(S.effectiveLevel({}, null), 'warning');
});

test('messages: arguments, messageStrings, [text](id) links removed for the table', () => {
  const rule = { messageStrings: { m1: { text: 'Value {0} flows to {1}, not {{literal}}' } } };
  assert.equal(S.messageText({ id: 'm1', arguments: ['a', 'b'] }, rule), 'Value a flows to b, not {literal}');
  assert.equal(S.plainMessage('depends on a [user-provided value](1).'), 'depends on a user-provided value.');
});

test('uriBaseId chains resolve; unknown bases stay unresolved', () => {
  const run = { originalUriBaseIds: { SRC: { uri: 'src/', uriBaseId: 'ROOT' }, ROOT: { uri: 'file:///home/runner/work/x/x/' } } };
  assert.deepEqual(S.artifactUri({ uri: 'a.js', uriBaseId: 'SRC' }, run), { uri: 'file:///home/runner/work/x/x/src/a.js', baseId: '' });
  assert.deepEqual(S.artifactUri({ uri: 'a.js', uriBaseId: 'NOPE' }, run), { uri: 'a.js', baseId: 'NOPE' });
  // loops do not hang
  const loop = { originalUriBaseIds: { A: { uri: 'a/', uriBaseId: 'B' }, B: { uri: 'b/', uriBaseId: 'A' } } };
  assert.ok(S.artifactUri({ uri: 'x', uriBaseId: 'A' }, loop));
  // artifact index
  assert.equal(S.artifactUri({ index: 0 }, { artifacts: [{ location: { uri: 'z.c' } }] }).uri, 'z.c');
});

test('semgrep %SRCROOT% sample resolves to the CI path', () => {
  const { ix } = ixOf('semgrep-srcroot.sarif');
  assert.ok(ix.files.includes('/home/runner/work/demo-app/demo-app/src/server.js'), ix.files.join());
});

test('filters: level, baseline, suppression, tool and text', () => {
  const { ix } = ixOf('eslint-baseline-suppressions.sarif');
  assert.equal(S.query(ix, { group: 'none' }).count, 6, 'accepted suppression hidden by default');
  assert.equal(S.query(ix, { group: 'none', supp: 'only' }).count, 2);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', base: 'new' }).count, 3);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', base: 'absent' }).count, 1);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', base: 'updated' }).count, 1);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', levels: [1, 0, 0, 0] }).count, 2);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', text: 'eqeqeq server' }).count, 1);
  assert.equal(S.query(ix, { group: 'none', supp: 'show', text: 'sanitize' }).count, 3);
  const f = S.facets(ix);
  assert.deepEqual(f.supp, [5, 1, 1, 0]);
});

test('grouping by rule puts the worst level first and collapses', () => {
  const { ix } = ixOf('codeql-ci-paths.sarif');
  const v = S.query(ix, { group: 'rule' });
  assert.equal(v.groups.length, 5);
  assert.equal(v.groups[0].worst, 0);
  assert.equal(v.groups[v.groups.length - 1].label, 'js/unused-local-variable');
  assert.equal(v.rows.length, 10);
  const c = S.query(ix, { group: 'rule', collapsed: [v.groups[0].key] });
  assert.equal(c.rows.length, 9);
  const all = S.query(ix, { group: 'rule', collapsedAll: true });
  assert.equal(all.rows.length, 5);
  const rows = S.windowRows(ix, v, 0, 3);
  assert.equal(rows[0].g, 1);
  assert.equal(typeof rows[1].msg, 'string');
});

test('detail: rule help, CWE, security severity, code flow steps and related locations', () => {
  const { ix, docs } = ixOf('codeql-ci-paths.sarif');
  const i = ix.rules.indexOf('js/sql-injection');
  const r = [...ix.cols.rule].findIndex(x => x === i);
  const d = S.detail(ix, docs, r);
  assert.equal(d.rule.securitySeverity, '8.8');
  assert.deepEqual(d.rule.cwe, ['89', '90']);
  assert.match(d.rule.helpMarkdown, /prepared statements/);
  assert.equal(d.flows[0].threads[0].steps.length, 5);
  assert.equal(d.flows[0].threads[0].steps[0].kinds[0], 'source');
  assert.equal(d.related[0].id, 1);
  assert.equal(d.location.line, 6);
  assert.match(d.location.snippet, /SELECT/);
  const step = S.rawLocation(ix, docs, r, 'flow', [0, 0, 4]);
  assert.equal(step.line, 6);
});

test('compare: matched by fingerprint, new / unchanged / fixed', () => {
  const { ix } = ixOf('compare-new.sarif', 'compare-old.sarif');
  const c = S.applyCompare(ix, 1, 0);
  assert.deepEqual(c, { new: 2, unchanged: 2, fixed: 2 });
  assert.equal(S.query(ix, { group: 'none', base: 'absent' }).count, 2);
  assert.equal(S.query(ix, { group: 'none', base: 'new' }).count, 2);
  assert.equal(S.facets(ix).total, 6);
});

test('fingerprint falls back to rule, path and message without numbers', () => {
  const a = S.fingerprint({}, 'r', 'p', 'line 10 bad');
  assert.equal(a, S.fingerprint({}, 'r', 'p', 'line 11 bad'));
  assert.notEqual(a, S.fingerprint({}, 'r', 'q', 'line 10 bad'));
  assert.match(S.fingerprint({ fingerprints: { b: '2', a: '1' } }, 'r', 'p', ''), /^f:a=1&b=2$/);
});

test('hostile: deep nesting inside a result opens; a deep array alone is not SARIF', () => {
  const { ix } = ixOf('hostile-deep-nesting.sarif');
  assert.equal(S.facets(ix).total, 1);
  const deep = JSON.parse(fs.readFileSync(path.join(DIR, 'hostile-deep-only.sarif'), 'utf8'));
  assert.equal(S.checkLog(deep).ok, false);
});

test('hostile: markup stays text in the index and the detail', () => {
  const { ix, docs } = ixOf('hostile-markup-paths.sarif');
  const d = S.detail(ix, docs, 0);
  assert.equal(d.rule.helpUri, 'javascript:alert(document.cookie)'); // raw; the viewer never makes it a link (markdown.test.js)
  assert.ok(ix.tools[0].includes('<script>'));
  assert.equal(S.facets(ix).total, 6);
});

test('a broken result list entry does not stop the rest', () => {
  const ix = S.buildIndex([{ doc: { version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results: [null, 5, 'x', { message: { text: 'ok' } }] }, null] } }]);
  assert.equal(S.facets(ix).total, 1);
  assert.equal(ix.rules[0], '(no rule id)');
});

test('maxResults caps the index and says so', () => {
  const results = Array.from({ length: 50 }, (_, k) => ({ ruleId: 'r', message: { text: 'm' + k } }));
  const ix = S.buildIndex([{ doc: { version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results }] } }], { maxResults: 10 });
  assert.equal(S.facets(ix).total, 10);
  assert.match(ix.warnings.join(), /first 10/);
});

test('100,000 results: index and query stay fast', () => {
  const results = Array.from({ length: 100000 }, (_, k) => ({ ruleId: 'r' + (k % 300), level: ['error', 'warning', 'note'][k % 3], message: { text: 'message ' + k }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/f' + (k % 900) + '.js' }, region: { startLine: k % 500 + 1 } } }] }));
  const t0 = Date.now();
  const ix = S.buildIndex([{ doc: { version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results }] } }]);
  const t1 = Date.now();
  const v = S.query(ix, { group: 'rule', text: 'message 99' });
  const t2 = Date.now();
  assert.ok(v.count > 0);
  assert.ok(t1 - t0 < 4000, `index ${t1 - t0} ms`);
  assert.ok(t2 - t1 < 2000, `query ${t2 - t1} ms`);
});

test('hostile: a 100,000-deep partialFingerprints value gives a short string, and the detail can be sent (VER11)', () => {
  const deep = JSON.parse('{"b":' + '['.repeat(100000) + ']'.repeat(100000) + '}');
  const doc = { version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results: [{ ruleId: 'x', message: { text: 'm' }, fingerprints: { a: '1' }, partialFingerprints: Object.assign(deep, { n: 5, s: 'x'.repeat(2000) }) }] }] };
  const ix = S.buildIndex([{ doc, name: 'deep.sarif' }]);
  const d = S.detail(ix, [doc], 0);
  assert.deepEqual(Object.keys(d.fingerprints).sort(), ['a', 'b', 'n', 's']);
  assert.equal(d.fingerprints.b, '[list]');
  assert.equal(d.fingerprints.n, '5');
  assert.ok(d.fingerprints.s.length <= 500);
  assert.doesNotThrow(() => structuredClone(d));
});
