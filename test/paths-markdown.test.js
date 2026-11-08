'use strict';
// Path mapping and the Markdown sanitiser.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/core/paths');
const MD = require('../media/markdown');

test('classify: file URIs, CI paths, Windows, UNC, web and relative', () => {
  assert.deepEqual(P.classify('file:///home/runner/work/a/a/src/x.js'), { kind: 'posix', path: '/home/runner/work/a/a/src/x.js', unresolvedBase: '' });
  assert.equal(P.classify('/home/runner/work/a/a/src/x.js').kind, 'posix');
  assert.deepEqual(P.classify('file:///C:/Users/me/x.js'), { kind: 'windows', path: 'C:/Users/me/x.js', unresolvedBase: '' });
  assert.equal(P.classify('C:\\Windows\\System32\\drivers\\etc\\hosts').path, 'C:/Windows/System32/drivers/etc/hosts');
  assert.equal(P.classify('file://evil-server/share/x.js').kind, 'unc');
  assert.equal(P.classify('\\\\server\\share\\x.js').kind, 'unc');
  assert.equal(P.classify('https://evil.example/x.js').kind, 'remote');
  assert.equal(P.classify('src/my%20file.js').path, 'src/my file.js');
  assert.equal(P.classify('').kind, 'empty');
  assert.equal(P.classify('file://localhost/etc/x').path, '/etc/x');
});

test('relative paths never climb out of their root', () => {
  assert.equal(P.joinInside('/ws', '../../etc/passwd'), '');
  assert.equal(P.joinInside('/ws', 'a/../b.js'), '/ws/b.js');
  const c = P.candidates(P.classify('../../../../etc/hosts'), { roots: ['/ws'], sarifDir: '/ws/out' });
  assert.ok(c.every(x => x.path.startsWith('/ws/')), JSON.stringify(c));
});

test('CI absolute path: workspace suffix candidates, longest first, file name last', () => {
  const c = P.candidates(P.classify('/home/runner/work/app/app/src/a.js'), { roots: ['/Users/me/app'], sarifDir: '/Users/me/app/out' }).map(x => x.path);
  assert.equal(c[0], '/home/runner/work/app/app/src/a.js');
  assert.ok(c.indexOf('/Users/me/app/src/a.js') > 0);
  assert.equal(c[c.length - 1], '/Users/me/app/a.js');
});

test('as-written absolute paths outside the workspace are marked outside', () => {
  const c = P.candidates(P.classify('/etc/passwd'), { roots: ['/ws'], sarifDir: '/ws' });
  assert.equal(c[0].path, '/etc/passwd');
  assert.equal(c[0].inside, false);
  assert.equal(c[1].path, '/ws/etc/passwd');
  assert.equal(c[1].inside, true);
});

test('learn + applyMap: one mapping fixes every result from the same checkout', () => {
  const m = P.learn('/home/runner/work/app/app/src/a.js', '/Users/me/app/src/a.js', '/Users/me/app');
  assert.deepEqual(P.learn('/home/runner/work/app/app/src/a.js', '/Users/me/app/src/a.js'), { from: '/home/runner/work/app', to: '/Users/me' });
  assert.deepEqual(m, { from: '/home/runner/work/app/app', to: '/Users/me/app' });
  assert.equal(P.applyMap('/home/runner/work/app/app/lib/b.js', [m]), '/Users/me/app/lib/b.js');
  assert.equal(P.applyMap('/other/b.js', [m]), '');
  assert.equal(P.learn('/a/x.js', '/b/y.js'), null);
  const c = P.candidates(P.classify('/home/runner/work/app/app/lib/b.js'), { roots: ['/Users/me/app'], map: [m] });
  assert.equal(c[0].path, '/Users/me/app/lib/b.js');
  assert.equal(c[0].why, 'path map');
});

test('Windows CI path maps by suffix', () => {
  const c = P.candidates(P.classify('D:\\a\\app\\app\\src\\a.js'), { roots: ['/Users/me/app'] }).map(x => x.path);
  assert.ok(c.includes('/Users/me/app/src/a.js'));
  assert.ok(!c.some(p => p.startsWith('D:')));
});

test('UNC and web locations get no candidates (never opened, no network)', () => {
  assert.deepEqual(P.candidates(P.classify('file://srv/share/a.js'), { roots: ['/ws'] }), []);
  assert.deepEqual(P.candidates(P.classify('https://x.example/a.js'), { roots: ['/ws'] }), []);
});

test('unresolved uriBaseId uses a mapped base first', () => {
  const c = P.candidates(P.classify('src/a.js', 'SRCROOT'), { roots: ['/ws'], baseMap: { SRCROOT: '/code/app' } });
  assert.equal(c[0].path, '/code/app/src/a.js');
});

test('markdown: script, event handlers and raw HTML become text', () => {
  const h = MD.render('# T <script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src="https://e.example"></iframe>');
  assert.ok(!/<script|<img|<iframe/i.test(h), h);
  assert.ok(h.includes('&lt;script&gt;'));
  assert.ok(!/\sonerror=/i.test(h.replace(/&[a-z]+;/g, '')) || h.includes('onerror=alert(2)&gt;') || h.includes('&lt;img'));
});

test('markdown: only http and https links, and never as href', () => {
  const h = MD.render('[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x) [d](https://ok.example/p?q=1&r=2) [e](file:///etc/passwd)');
  assert.ok(!/javascript:|data:text|vbscript:|file:/.test(h.replace(/>[^<]*</g, '><')), h);
  assert.ok(!/\shref=/.test(h));
  assert.match(h, /data-href="https:\/\/ok\.example\/p\?q=1&amp;r=2"/);
  assert.equal(MD.safeUrl('javascript:alert(1)'), '');
  assert.equal(MD.safeUrl('https://a.example/x" onclick="y'), '');
});

test('markdown: images show alt text only, code blocks are escaped', () => {
  const h = MD.render('![tracker](https://evil.example/t.png)\n\n```html\n<script>x</script>\n```');
  assert.ok(!/<img/.test(h));
  assert.match(h, /\[image: tracker\]/);
  assert.match(h, /<pre><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
});

test('markdown: lists, headings, tables and related-location links', () => {
  const h = MD.render('## Rec\n\n1. one\n2. **two**\n\n| a | b |\n|---|---|\n| `x` | y |\n\nsee [here](3)', { locLinks: true });
  assert.match(h, /<h4>Rec<\/h4>/);
  assert.match(h, /<ol><li>one<\/li><li><strong>two<\/strong><\/li><\/ol>/);
  assert.match(h, /<table>/);
  assert.match(h, /data-loc="3"/);
});

test('markdown: a 1 MB input is cut and still renders', () => {
  const h = MD.render('x'.repeat(1 << 20));
  assert.ok(h.length < 200000);
});
