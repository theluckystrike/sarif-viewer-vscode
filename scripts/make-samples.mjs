// Writes the sample logs used by the tests and the real VS Code gate.
//   node scripts/make-samples.mjs <dir>                      small samples + demo-app source files
//   node scripts/make-samples.mjs <dir> --large <file> [MB]  also one large merged log (default 150 MB), streamed
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'samples';
fs.mkdirSync(out, { recursive: true });
const w = (f, data) => { const p = path.join(out, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2)); return p; };

// ---- demo source files the results point at ----
const SRC = {
  'demo-app/src/server.js': `'use strict';
const express = require('express');
const db = require('./db');
const { clean } = require('./utils/sanitize');
const app = express();

app.get('/user', async (req, res) => {
  const id = req.query.id;
  const rows = await db.findUser(id);
  res.send('<h1>Hello ' + req.query.name + '</h1>' + JSON.stringify(rows));
});

app.get('/file', (req, res) => {
  const name = req.query.name;
  res.sendFile('/srv/files/' + name);
});

app.get('/safe', (req, res) => {
  res.send(clean(req.query.q));
});

app.listen(3000);
`,
  'demo-app/src/db.js': `'use strict';
const sqlite = require('sqlite3');
const conn = new sqlite.Database(':memory:');

function findUser(id) {
  const sql = "SELECT * FROM users WHERE id = '" + id + "'";
  return new Promise((ok, fail) => conn.all(sql, (e, r) => (e ? fail(e) : ok(r))));
}

const password = "hunter2-not-a-real-secret";

module.exports = { findUser, password };
`,
  'demo-app/src/utils/sanitize.js': `'use strict';
function clean(s) {
  return String(s).replace(/</g, '&lt;');
}
function unused(a) {
  var b = a;
  return a;
}
module.exports = { clean };
`,
  'demo-app/scripts/deploy.py': `import subprocess, sys

def deploy(target):
    subprocess.call("rsync -a build/ " + target, shell=True)

if __name__ == "__main__":
    deploy(sys.argv[1])
`,
};
for (const [f, t] of Object.entries(SRC)) w(f, t);

const CI = '/home/runner/work/demo-app/demo-app';
const loc = (uri, startLine, startColumn, endColumn, message, extra = {}) => ({
  physicalLocation: { artifactLocation: Object.assign({ uri }, extra.base ? { uriBaseId: extra.base } : {}), region: Object.assign({ startLine, startColumn }, endColumn ? { endColumn } : {}, extra.snippet ? { snippet: { text: extra.snippet } } : {}) },
  ...(message ? { message: { text: message } } : {}),
  ...(extra.id !== undefined ? { id: extra.id } : {}),
});
const tf = (l, kinds) => ({ location: l, kinds });

const codeqlRules = [
  { id: 'js/sql-injection', name: 'SqlInjection', shortDescription: { text: 'Database query built from user-controlled sources' },
    fullDescription: { text: 'Building a database query from user-controlled sources is vulnerable to insertion of malicious code by the user.' },
    defaultConfiguration: { level: 'error' }, helpUri: 'https://codeql.github.com/codeql-query-help/javascript/js-sql-injection/',
    help: { text: 'Use parameters.', markdown: '# Database query built from user-controlled sources\n\nIf a database query is built from user-provided data without sufficient sanitization, a user may be able to run malicious queries.\n\n## Recommendation\n\nUse **prepared statements** with `?` parameters:\n\n```js\nconn.all("SELECT * FROM users WHERE id = ?", [id]);\n```\n\n## References\n\n- OWASP: [SQL Injection](https://owasp.org/www-community/attacks/SQL_Injection)\n- Common Weakness Enumeration: CWE-89.\n' },
    properties: { tags: ['security', 'external/cwe/cwe-089', 'external/cwe/cwe-090'], precision: 'high', 'security-severity': '8.8', 'problem.severity': 'error' } },
  { id: 'js/reflected-xss', name: 'ReflectedXss', shortDescription: { text: 'Reflected cross-site scripting' }, fullDescription: { text: 'Writing user input directly to an HTTP response allows for a cross-site scripting vulnerability.' },
    defaultConfiguration: { level: 'error' }, helpUri: 'https://codeql.github.com/codeql-query-help/javascript/js-reflected-xss/',
    help: { text: 'Escape output.', markdown: '# Reflected cross-site scripting\n\nDirectly writing user input to a webpage without escaping allows cross-site scripting.\n\n1. Escape the input.\n2. Or use a template engine that escapes by default.\n' },
    properties: { tags: ['security', 'external/cwe/cwe-079', 'external/cwe/cwe-116'], precision: 'high', 'security-severity': '6.1' } },
  { id: 'js/path-injection', name: 'TaintedPath', shortDescription: { text: 'Uncontrolled data used in path expression' }, defaultConfiguration: { level: 'error' },
    helpUri: 'https://codeql.github.com/codeql-query-help/javascript/js-path-injection/', properties: { tags: ['security', 'external/cwe/cwe-022'], 'security-severity': '7.5' } },
  { id: 'js/hardcoded-credentials', name: 'HardcodedCredentials', shortDescription: { text: 'Hard-coded credentials' }, defaultConfiguration: { level: 'warning' }, properties: { tags: ['security', 'external/cwe/cwe-798'], 'security-severity': '9.8' } },
  { id: 'js/unused-local-variable', name: 'UnusedVariable', shortDescription: { text: 'Unused variable, import, function or class' }, defaultConfiguration: { level: 'note' }, properties: { tags: ['maintainability'] } },
];
const codeqlResults = [
  { ruleId: 'js/sql-injection', ruleIndex: 0, message: { text: 'This query string depends on a [user-provided value](1).' },
    locations: [loc(`${CI}/src/db.js`, 6, 15, 59, null, { snippet: `const sql = "SELECT * FROM users WHERE id = '" + id + "'";` })],
    relatedLocations: [loc(`${CI}/src/server.js`, 8, 14, 26, 'user-provided value', { id: 1 })],
    partialFingerprints: { primaryLocationLineHash: 'a1b2c3d4e5f60708:1' },
    codeFlows: [{ threadFlows: [{ locations: [
      tf(loc(`${CI}/src/server.js`, 8, 14, 26, 'req.query.id'), ['source']),
      tf(loc(`${CI}/src/server.js`, 8, 9, 26, 'id')),
      tf(loc(`${CI}/src/server.js`, 9, 33, 35, 'id')),
      tf(loc(`${CI}/src/db.js`, 5, 19, 21, 'id')),
      tf(loc(`${CI}/src/db.js`, 6, 15, 59, '"SELECT ... " + id + "\'"'), ['sink']),
    ] }] }] },
  { ruleId: 'js/reflected-xss', ruleIndex: 1, message: { text: 'Cross-site scripting vulnerability due to a [user-provided value](1).' },
    locations: [loc(`${CI}/src/server.js`, 10, 12, 49)], relatedLocations: [loc(`${CI}/src/server.js`, 10, 32, 46, 'user-provided value', { id: 1 })],
    partialFingerprints: { primaryLocationLineHash: 'b2c3d4e5f6070819:1' },
    codeFlows: [{ threadFlows: [{ locations: [tf(loc(`${CI}/src/server.js`, 10, 32, 46, 'req.query.name'), ['source']), tf(loc(`${CI}/src/server.js`, 10, 12, 49, "'<h1>Hello ' + ..."), ['sink'])] }] }] },
  { ruleId: 'js/path-injection', ruleIndex: 2, message: { text: 'This path depends on a [user-provided value](1).' }, locations: [loc(`${CI}/src/server.js`, 15, 16, 39)],
    relatedLocations: [loc(`${CI}/src/server.js`, 14, 16, 30, 'user-provided value', { id: 1 })], partialFingerprints: { primaryLocationLineHash: 'c3d4e5f607081920:1' },
    codeFlows: [{ threadFlows: [{ locations: [tf(loc(`${CI}/src/server.js`, 14, 16, 30, 'req.query.name')), tf(loc(`${CI}/src/server.js`, 14, 9, 30, 'name')), tf(loc(`${CI}/src/server.js`, 15, 16, 39, "'/srv/files/' + name"))] }] }] },
  { ruleId: 'js/hardcoded-credentials', ruleIndex: 3, message: { text: 'The hard-coded value "hunter2-not-a-real-secret" is used as password.' }, locations: [loc(`${CI}/src/db.js`, 10, 18, 45)], partialFingerprints: { primaryLocationLineHash: 'd4e5f60708192021:1' } },
  { ruleId: 'js/unused-local-variable', ruleIndex: 4, message: { text: 'Unused variable b.' }, locations: [loc(`${CI}/src/utils/sanitize.js`, 6, 7, 8)], partialFingerprints: { primaryLocationLineHash: 'e5f6070819202122:1' } },
];
const codeql = { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{
  tool: { driver: { name: 'CodeQL', organization: 'GitHub', semanticVersion: '2.19.3', rules: codeqlRules } },
  invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
  results: codeqlResults, columnKind: 'utf16CodeUnits', properties: { semmle: { sourceLanguage: 'javascript' } },
}] };
w('codeql-ci-paths.sarif', codeql);

// Semgrep style: %SRCROOT% base, relative uris, a suppression
const semgrep = { version: '2.1.0', $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json', runs: [{
  tool: { driver: { name: 'Semgrep OSS', semanticVersion: '1.95.0', rules: [
    { id: 'javascript.express.security.audit.xss.direct-response-write', name: 'direct-response-write', shortDescription: { text: 'Semgrep Finding: direct-response-write' }, fullDescription: { text: 'Detected directly writing to a Response object from user-defined input.' }, defaultConfiguration: { level: 'warning' }, helpUri: 'https://semgrep.dev/r/javascript.express.security.audit.xss.direct-response-write', help: { markdown: 'Detected directly writing to a Response object.\n\n<b>[Semgrep Rule](https://semgrep.dev/r/javascript.express.security.audit.xss.direct-response-write)</b>' }, properties: { tags: ['CWE-79: Improper Neutralization of Input During Web Page Generation', 'OWASP-A03:2021 - Injection', 'MEDIUM CONFIDENCE', 'security'], precision: 'very-high' } },
    { id: 'python.lang.security.audit.subprocess-shell-true', name: 'subprocess-shell-true', shortDescription: { text: 'subprocess call with shell=True' }, defaultConfiguration: { level: 'error' }, helpUri: 'https://semgrep.dev/r/python.lang.security.audit.subprocess-shell-true', properties: { tags: ['CWE-78: OS Command Injection', 'security'] } },
    { id: 'javascript.lang.security.detect-sql-concat', name: 'detect-sql-concat', shortDescription: { text: 'SQL built by string concatenation' }, defaultConfiguration: { level: 'warning' } },
  ] } },
  originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///home/runner/work/demo-app/demo-app/' } },
  invocations: [{ executionSuccessful: true }],
  results: [
    { ruleId: 'javascript.express.security.audit.xss.direct-response-write', level: 'warning', message: { text: 'Detected directly writing to a Response object from user-defined input.' }, locations: [loc('src/server.js', 10, 3, 72, null, { base: '%SRCROOT%' })], fingerprints: { matchBasedId: 'sg-1111' } },
    { ruleId: 'python.lang.security.audit.subprocess-shell-true', level: 'error', message: { text: 'Found subprocess call with shell=True. Use a list of arguments instead.' }, locations: [loc('scripts/deploy.py', 4, 5, 64, null, { base: '%SRCROOT%' })], fingerprints: { matchBasedId: 'sg-2222' } },
    { ruleId: 'javascript.lang.security.detect-sql-concat', level: 'warning', message: { text: 'SQL query built with string concatenation.' }, locations: [loc('src/db.js', 6, 15, 59, null, { base: '%SRCROOT%' })], fingerprints: { matchBasedId: 'sg-3333' },
      suppressions: [{ kind: 'inSource', status: 'accepted', justification: 'nosemgrep: test fixture only' }] },
  ],
}] };
w('semgrep-srcroot.sarif', semgrep);

// Baseline states and suppressions (SARIF Multitool match-results-forward style)
const base = { version: '2.1.0', runs: [{
  tool: { driver: { name: 'ESLint', informationUri: 'https://eslint.org', version: '8.57.0', rules: [
    { id: 'no-unused-vars', shortDescription: { text: 'Disallow unused variables' }, helpUri: 'https://eslint.org/docs/latest/rules/no-unused-vars', properties: { category: 'Variables' } },
    { id: 'no-var', shortDescription: { text: 'Require let or const instead of var' }, helpUri: 'https://eslint.org/docs/latest/rules/no-var' },
    { id: 'eqeqeq', shortDescription: { text: 'Require the use of === and !==' }, helpUri: 'https://eslint.org/docs/latest/rules/eqeqeq' },
  ] } },
  results: [
    { ruleId: 'no-unused-vars', ruleIndex: 0, level: 'warning', baselineState: 'new', message: { text: "'unused' is defined but never used." }, locations: [loc('demo-app/src/utils/sanitize.js', 5, 10, 16)] },
    { ruleId: 'no-var', ruleIndex: 1, level: 'error', baselineState: 'new', message: { text: 'Unexpected var, use let or const instead.' }, locations: [loc('demo-app/src/utils/sanitize.js', 6, 3, 13)] },
    { ruleId: 'no-unused-vars', ruleIndex: 0, level: 'warning', baselineState: 'unchanged', message: { text: "'b' is assigned a value but never used." }, locations: [loc('demo-app/src/utils/sanitize.js', 6, 7, 8)] },
    { ruleId: 'eqeqeq', ruleIndex: 2, level: 'warning', baselineState: 'updated', message: { text: "Expected '===' and instead saw '=='." }, locations: [loc('demo-app/src/server.js', 8, 3, 30)] },
    { ruleId: 'eqeqeq', ruleIndex: 2, level: 'warning', baselineState: 'absent', message: { text: "Expected '!==' and instead saw '!='." }, locations: [loc('demo-app/src/db.js', 7, 3, 20)] },
    { ruleId: 'no-var', ruleIndex: 1, level: 'error', baselineState: 'unchanged', message: { text: 'Unexpected var, use let or const instead.' }, locations: [loc('demo-app/src/server.js', 2, 1, 6)],
      suppressions: [{ kind: 'inSource', status: 'accepted', justification: 'eslint-disable-line: legacy file, tracked in issue 42' }] },
    { ruleId: 'no-unused-vars', ruleIndex: 0, level: 'warning', baselineState: 'new', message: { text: "'rows' is assigned a value but never used." }, locations: [loc('demo-app/src/server.js', 9, 9, 13)],
      suppressions: [{ kind: 'external', status: 'underReview', justification: 'Waiting for review' }] },
  ],
}] };
w('eslint-baseline-suppressions.sarif', base);

// 0 results
w('zero-results.sarif', { version: '2.1.0', runs: [{ tool: { driver: { name: 'Bandit', version: '1.7.10', rules: [{ id: 'B602' }, { id: 'B105' }] } }, invocations: [{ executionSuccessful: true }], results: [] }] });

// compare pair: old has 4, new has 4; 2 match by fingerprint
const cmpRule = [{ id: 'gitleaks:generic-api-key', shortDescription: { text: 'Generic API key' } }, { id: 'gitleaks:aws-access-token', shortDescription: { text: 'AWS access key' } }];
const cmpRes = (fp, line, rule, file = 'demo-app/src/db.js') => ({ ruleId: rule, message: { text: `${rule} has detected a secret at line ${line}` }, locations: [loc(file, line, 1, 20)], partialFingerprints: { commitSha: 'none', fingerprint: fp } });
w('compare-old.sarif', { version: '2.1.0', runs: [{ tool: { driver: { name: 'gitleaks', version: '8.30.1', rules: cmpRule } }, results: [cmpRes('fp-A', 10, 'gitleaks:generic-api-key'), cmpRes('fp-B', 3, 'gitleaks:aws-access-token'), cmpRes('fp-C', 2, 'gitleaks:generic-api-key', 'demo-app/src/server.js'), cmpRes('fp-D', 12, 'gitleaks:generic-api-key')] }] });
w('compare-new.sarif', { version: '2.1.0', runs: [{ tool: { driver: { name: 'gitleaks', version: '8.30.1', rules: cmpRule } }, results: [cmpRes('fp-A', 11, 'gitleaks:generic-api-key'), cmpRes('fp-B', 4, 'gitleaks:aws-access-token'), cmpRes('fp-E', 5, 'gitleaks:aws-access-token'), cmpRes('fp-F', 7, 'gitleaks:generic-api-key', 'demo-app/scripts/deploy.py')] }] });

// SARIF 2.0 (read with a warning)
w('old-version-2.0.sarif', { version: '2.0.0', $schema: 'http://json.schemastore.org/sarif-2.0.0', runs: [{ tool: { name: 'OldTool', driver: { name: 'OldTool' } }, results: [{ ruleId: 'OT1', level: 'warning', message: { text: 'An old-style result' }, locations: [loc('demo-app/src/db.js', 1, 1)] }] }] });

// ---- hostile ----
const hostileRules = [{ id: 'X1<script>alert(1)</script>', name: '<img src=x onerror=alert(2)>', shortDescription: { text: '<b onmouseover="alert(3)">bold</b>' },
  helpUri: 'javascript:alert(document.cookie)',
  help: { text: 'x', markdown: '# Help <script>window.PWNED_HELP=1</script>\n\n<img src="https://evil.example/pixel.gif" onerror="window.PWNED_IMG=1">\n\n[click me](javascript:window.PWNED_LINK=1) [data link](data:text/html,<script>alert(1)</script>) [vb](vbscript:msgbox) [web](https://evil.example/track?x=1)\n\n![tracker](https://evil.example/t.png)\n\n<iframe src="https://evil.example"></iframe>\n\n```html\n<script>alert("in code")</script>\n```\n' },
  properties: { tags: ['<svg onload=alert(4)>'] } },
  { id: 'X2', shortDescription: { text: 'Paths outside the workspace' }, helpUri: 'file:///etc/passwd' }];
w('hostile-markup-paths.sarif', { version: '2.1.0', runs: [{ tool: { driver: { name: 'Hostile<script>alert(5)</script>', rules: hostileRules } },
  results: [
    { ruleId: hostileRules[0].id, ruleIndex: 0, level: 'error', message: { markdown: 'Message <script>window.PWNED_MSG=1</script> **bold** [js](javascript:window.PWNED_MSGLINK=1)', text: 'Message <script>window.PWNED_MSG=1</script>' }, locations: [loc('demo-app/src/server.js', 1, 1)] },
    { ruleId: 'X2', ruleIndex: 1, level: 'warning', message: { text: 'Points at /etc/passwd' }, locations: [loc('/etc/passwd', 1, 1)] },
    { ruleId: 'X2', ruleIndex: 1, level: 'warning', message: { text: 'Points at a Windows system file' }, locations: [loc('C:\\Windows\\System32\\drivers\\etc\\hosts', 1, 1)] },
    { ruleId: 'X2', ruleIndex: 1, level: 'warning', message: { text: 'Points at a UNC share' }, locations: [loc('file://evil-server/share/payload.js', 1, 1)] },
    { ruleId: 'X2', ruleIndex: 1, level: 'warning', message: { text: 'Points at a web URL' }, locations: [loc('https://evil.example/src/app.js', 3, 1)] },
    { ruleId: 'X2', ruleIndex: 1, level: 'note', message: { text: 'Climbs out of the workspace' }, locations: [loc('../../../../../../etc/hosts', 1, 1)] },
  ] }] });
// 10,000-deep nesting inside a valid result, plus a file that is only deep nesting
let deep = '0'; for (let k = 0; k < 10000; k++) deep = (k % 2 ? '[' + deep + ']' : '{"a":' + deep + '}');
fs.writeFileSync(path.join(out, 'hostile-deep-nesting.sarif'), `{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"DeepTool"}},"results":[{"ruleId":"D1","message":{"text":"Result with 10000-deep properties"},"properties":{"deep":${deep}},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"demo-app/src/db.js"},"region":{"startLine":2}}}]}]}]}`);
let deepOnly = ''; for (let k = 0; k < 10000; k++) deepOnly += '['; deepOnly += '1'; for (let k = 0; k < 10000; k++) deepOnly += ']';
fs.writeFileSync(path.join(out, 'hostile-deep-only.sarif'), deepOnly);
// invalid UTF-8 bytes inside a message
const pre = Buffer.from('{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Utf8Tool"}},"results":[{"ruleId":"U1","level":"warning","message":{"text":"bad bytes: ');
const bad = Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1]);
const post = Buffer.from(' end"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"demo-app/src/db.js"},"region":{"startLine":1}}}]}]}]}');
fs.writeFileSync(path.join(out, 'hostile-invalid-utf8.sarif'), Buffer.concat([pre, bad, post]));
// truncated JSON
fs.writeFileSync(path.join(out, 'broken-truncated.sarif'), JSON.stringify(semgrep, null, 2).slice(0, 900));

// ---- large merged log (streamed, never held in memory) ----
const li = process.argv.indexOf('--large');
if (li > 0) {
  const file = process.argv[li + 1];
  const mbTarget = Number(process.argv[li + 2] || 150);
  const fd = fs.openSync(file, 'w');
  let bytes = 0, total = 0;
  const put = s => { fs.writeSync(fd, s); bytes += Buffer.byteLength(s); };
  put('{"$schema":"https://json.schemastore.org/sarif-2.1.0.json","version":"2.1.0","runs":[');
  const tools = ['CodeQL', 'Semgrep OSS', 'ESLint', 'Trivy'];
  const files = Object.keys(SRC).filter(f => f.endsWith('.js'));
  let r = 0;
  const perRunBytes = mbTarget * 1048576 / tools.length;
  tools.forEach((t, ti) => {
    const rules = []; for (let k = 0; k < 200; k++) rules.push({ id: `${t.split(' ')[0].toLowerCase()}/rule-${k}`, shortDescription: { text: `Rule ${k} of ${t}` }, defaultConfiguration: { level: ['error', 'warning', 'note'][k % 3] }, properties: { tags: ['security', `external/cwe/cwe-${100 + k}`] } });
    put((ti ? ',' : '') + JSON.stringify({ tool: { driver: { name: t, version: '1.0.' + ti, rules } } }).slice(0, -1) + ',"results":[');
    const start = bytes;
    let first = true;
    while (bytes - start < perRunBytes) {
      const k = r % 200, f = files[r % files.length];
      const res = { ruleId: rules[k].id, ruleIndex: k, message: { text: `Finding ${r} in ${f}: ${'value flows from a request parameter into a sensitive call. '.repeat(1 + (r % 3))}` },
        locations: [loc(`${CI}/${f.replace('demo-app/', '')}`, 1 + (r % 9), 1 + (r % 20), 30)], partialFingerprints: { primaryLocationLineHash: (r * 2654435761 >>> 0).toString(16) + ':' + ti },
        ...(r % 50 === 0 ? { codeFlows: [{ threadFlows: [{ locations: [tf(loc(`${CI}/src/server.js`, 8, 14, 26, 'source')), tf(loc(`${CI}/src/db.js`, 6, 15, 59, 'sink'))] }] }] } : {}),
        ...(r % 7 === 0 ? { baselineState: 'new' } : { baselineState: 'unchanged' }),
        ...(r % 97 === 0 ? { suppressions: [{ kind: 'external', justification: 'accepted risk' }] } : {}) };
      put((first ? '' : ',') + JSON.stringify(res));
      first = false; r++; total++;
    }
    put(']}');
  });
  put(']}');
  fs.closeSync(fd);
  console.log(JSON.stringify({ large: file, bytes, results: total }));
}
console.log('samples written to ' + out);
