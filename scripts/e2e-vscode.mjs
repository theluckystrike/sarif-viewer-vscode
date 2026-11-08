// Release gate in a real VS Code. Installs the .vsix into an isolated profile, opens every sample log with real
// clicks and keys, checks counts against the JSON, opens result locations (CI paths, %SRCROOT%), steps a code flow,
// uses filters, the Problems panel, compare, the 150 MB log and the hostile logs, and logs every webview request.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <realDir> <large.sarif> <shotDir> <outJson> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [work0, port, vsix, samples0, real0, large, shotDir, outJson, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const R = { theme: theme || 'Default Dark Modern', vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), steps: [], files: [], network: { outside: [], all: 0 }, extHostMB: [] };
const tag = /Light/.test(R.theme) ? 'light' : 'dark';
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.cpSync(samples0, ws, { recursive: true });
fs.mkdirSync(path.join(ws, 'real'));
for (const f of fs.readdirSync(real0).filter(f => f.endsWith('.sarif'))) fs.copyFileSync(path.join(real0, f), path.join(ws, 'real', f));
fs.symlinkSync(path.resolve(large), path.join(ws, 'large-merged.sarif'));

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.editor.enablePreview': false,
  'editor.minimap.enabled': false, 'extensions.ignoreRecommendations': true, 'problems.decorations.enabled': true, 'chat.commandCenter.enabled': false,
});

const LOCAL = /^(vscode-webview|vscode-resource|vscode-file|data|blob|about|chrome-error|devtools):|^https:\/\/[^/]*\.vscode-(cdn|resource)\.net\//;
let phase = 'start';
vs.network = true;
vs.s.on(m => {
  const info = m.sessionId && vs.attached.get(m.sessionId);
  if (m.method === 'Network.requestWillBeSent' && info && m.sessionId !== vs.wb) {
    R.network.all++;
    const u = m.params.request.url;
    if (!LOCAL.test(u)) R.network.outside.push({ url: u.slice(0, 200), phase, frame: (info.url || '').slice(0, 60) });
  }
});

const shots = [];
const shot = async name => { const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); try { await vs.shot(f); shots.push(path.basename(f)); } catch (e) { console.log('shot failed', name, e.message); } return f; };
const step = async (name, fn) => {
  const t0 = Date.now(); phase = name;
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 400)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 600)); await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); }
};
const must = (c, msg) => { if (!c) throw new Error(msg); };

// the viewer webview for a file name (several may be open)
async function viewer(name, ms = 20000) {
  return vs.waitFor(async () => {
    for (const [sid, info] of vs.attached) {
      if (sid === vs.wb || info.type !== 'iframe') continue;
      for (const c of vs.ctx.get(sid) || []) {
        if (!c.auxData?.isDefault) continue;
        try {
          const r = await vs.s.send('Runtime.evaluate', { expression: `(() => { const a = document.getElementById('app'); return a ? a.dataset.name + '|' + (document.body.getBoundingClientRect().width) : ''; })()`, contextId: c.id, returnByValue: true }, sid);
          const [n, w] = String(r.result.value || '').split('|');
          if (n === name && Number(w) > 0) return { sid, cid: c.id };
        } catch {}
      }
    }
    return null;
  }, ms, 150);
}
const E = (wv, expr) => vs.wvEval(wv, expr);
const state = wv => E(wv, `JSON.stringify({ rows: document.querySelectorAll('.row').length, loading: document.querySelectorAll('.row.loading').length, status: (document.getElementById('status') || {}).textContent || '', empty: !!document.getElementById('empty-ok'), err: (document.getElementById('load-error') || {}).textContent || '', large: (document.getElementById('too-large') || {}).textContent || '', progress: !!document.getElementById('progress'), banner: (document.getElementById('banner') || {}).textContent || '', footer: (document.getElementById('zovo-support') || {}).textContent || '' })`).then(JSON.parse);
async function wclick(name, sel, opts) {
  const wv = await viewer(name);
  const off = await vs.wvOffset();
  const b = JSON.parse(await E(wv, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(b.width / 2, 60), y: b.y + b.height / 2 }); })()`));
  if (!b) throw new Error('no element ' + sel + ' in ' + name);
  await vs.click(off.x + b.x, off.y + b.y, opts);
  await sleep(250);
}
async function setSelect(name, id, value) { const wv = await viewer(name); await E(wv, `(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`); await sleep(500); }
const statusTotal = s => { const m = /([\d,]+) of ([\d,]+) results?/.exec(s); return m ? { shown: Number(m[1].replace(/,/g, '')), total: Number(m[2].replace(/,/g, '')) } : null; };
const jqCount = f => { try { return Number(execFileSync('jq', ['[.runs[].results[]?]|length', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { const d = JSON.parse(fs.readFileSync(f, 'utf8')); R.countFallback = (R.countFallback || []).concat(path.basename(f)); return d.runs.reduce((n, r) => n + (r.results || []).length, 0); } };
// The text editor beside the viewer: its active tab and the line of its cursor (focus stays in the viewer).
const editorPos = () => vs.wbEval(`(() => { for (const g of document.querySelectorAll('.editor-group-container')) { const ed = g.querySelector('.monaco-editor .view-lines'); if (!ed || ed.getBoundingClientRect().width === 0) continue; const t = g.querySelector('.tabs-container .tab.active .label-name, .title-label'); const ln = g.querySelector('.line-numbers.active-line-number'); return JSON.stringify({ tab: t ? t.textContent.trim().slice(0, 60) : '', pos: ln ? 'Ln ' + ln.textContent.trim() : '' }); } return JSON.stringify({ tab: '', pos: '' }); })()`).then(JSON.parse);
async function clickRow(name, text) {
  const wv = await viewer(name);
  const ok = await E(wv, `(() => { const r = [...document.querySelectorAll('.row.res')].find(r => r.textContent.includes(${JSON.stringify(text)})); if (!r) return false; document.querySelectorAll('[data-gate]').forEach(e => delete e.dataset.gate); r.dataset.gate = '1'; return true; })()`);
  if (!ok) throw new Error('no row with ' + text);
  await wclick(name, '.row.res[data-gate="1"]');
}
const dialog = () => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d && d.offsetParent !== null ? d.textContent.slice(0, 400) : ''; })()`);
async function focusWorkbench() {
  const b = JSON.parse(await vs.wbEval(`(() => { const e = document.querySelector('.part.titlebar') || document.querySelector('.part.statusbar'); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width * 0.3, y: r.y + r.height / 2 }); })()`));
  await vs.click(b.x, b.y); await sleep(200);
}
const closeAll = async () => {
  for (let i = 0; i < 3; i++) {
    try { await focusWorkbench(); await vs.command('View: Close All Editors'); break; } catch (e) { if (i === 2) throw e; await vs.key('Escape', 'Escape'); await sleep(800); }
  }
  await sleep(600); if (await dialog()) { await vs.key('Escape', 'Escape'); }
};
const extHostRss = () => {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let best = 0;
    for (const ln of out.split('\n')) if (ln.includes(vs.ud) && /extensionHost|Code Helper \(Plugin\)|utility-sub-type=node.mojom.NodeService/.test(ln)) best = Math.max(best, Number(ln.trim().split(/\s+/)[1]) || 0);
    return Math.round(best / 1024);
  } catch { return -1; }
};
async function openLog(rel, ms = 30000) {
  const name = path.basename(rel);
  const t0 = Date.now();
  vs.open(path.join(ws, rel));
  const wv = await viewer(name, ms);
  must(wv, 'viewer did not open for ' + rel);
  const st = await vs.waitFor(async () => { const s = await state(wv); return !s.progress && (s.rows > 0 && !s.loading || s.empty || s.err || s.large || /0 of/.test(s.status)) ? s : null; }, ms, 100);
  must(st, 'viewer did not finish for ' + rel);
  return { wv, st, ms: Date.now() - t0 };
}

await sleep(2500);

// 1. Every sample opens; totals match jq.
const files = [
  ['real/codeql-defectdojo-codeflows.sarif', 'count'], ['real/codeql-cpp-gha-ci-paths.sarif', 'count'], ['real/semgrep-ruletruss.sarif', 'count'], ['real/eslint-thingweb-core.sarif', 'count'],
  ['real/bandit-secobserve.sarif', 'count'], ['real/trivy-alpine-310.sarif', 'count'], ['real/checkov-secobserve.sarif', 'count'], ['real/gitleaks.sarif', 'count'],
  ['real/sarifsdk-baselinestate.sarif', 'count'], ['real/sariftut-suppressions.sarif', 'count'], ['real/sariftut-codeflows.sarif', 'count'],
  ['codeql-ci-paths.sarif', 'count'], ['semgrep-srcroot.sarif', 'count'], ['eslint-baseline-suppressions.sarif', 'count'], ['compare-new.sarif', 'count'], ['old-version-2.0.sarif', 'warn'],
  ['zero-results.sarif', 'empty'], ['broken-truncated.sarif', 'error'], ['hostile-deep-only.sarif', 'error'], ['hostile-deep-nesting.sarif', 'count'], ['hostile-invalid-utf8.sarif', 'utf8'], ['hostile-markup-paths.sarif', 'count'],
];
for (const [rel, kind] of files) {
  await step('open ' + rel, async () => {
    const { st, ms } = await openLog(rel);
    const out = { ms, status: st.status.slice(0, 80) };
    if (kind === 'count' || kind === 'warn' || kind === 'utf8') {
      const want = jqCount(path.join(ws, rel));
      const got = statusTotal(st.status);
      must(got && got.total === want, `total ${JSON.stringify(got)} vs jq ${want}`);
      out.jq = want; out.total = got.total; out.shown = got.shown;
      if (kind === 'warn') must(/2\.0\.0/.test(st.banner), 'no 2.0 warning: ' + st.banner);
      if (kind === 'utf8') must(/UTF-8/.test(st.banner), 'no UTF-8 warning: ' + st.banner);
    }
    if (kind === 'empty') must(st.empty, 'no success message');
    if (kind === 'error') { must(st.err && /not valid JSON|not a SARIF log/.test(st.err), 'no error message: ' + st.err); out.err = st.err.slice(0, 160); }
    must(/Sponsor/.test(st.footer) || kind === 'error' || kind === 'empty', 'support footer missing');
    R.files.push(Object.assign({ file: rel, kind }, out));
    if (['real/codeql-defectdojo-codeflows.sarif', 'zero-results.sarif', 'broken-truncated.sarif'].includes(rel)) await shot(path.basename(rel, '.sarif'));
    await closeAll();
    return out;
  });
}

// 2. CodeQL CI paths: click the SQL injection result; the CI path maps to the workspace; code flow stepping.
await step('codeql CI path: click result opens db.js at line 6 (automatic path mapping)', async () => {
  const { wv } = await openLog('codeql-ci-paths.sarif');
  await clickRow('codeql-ci-paths.sarif', 'This query string');
  const pos = await vs.waitFor(async () => { const p = await editorPos(); return /db\.js/.test(p.tab) && /Ln 6\b/.test(p.pos) ? p : null; }, 10000);
  must(pos, 'editor not at db.js:6: ' + JSON.stringify(await editorPos()));
  const det = await E(wv, `(document.getElementById('d-rule') || {}).textContent + '|' + (document.getElementById('d-resolve') || {}).textContent`);
  must(/js\/sql-injection/.test(det), det);
  return { pos, det };
});
await step('code flow: Next steps through 5 locations in order', async () => {
  const seen = [];
  for (let k = 0; k < 5; k++) {
    await wclick('codeql-ci-paths.sarif', '#flow-next');
    await sleep(700);
    const p = await editorPos();
    seen.push(p.tab.replace(/\s.*/, '') + ':' + (/Ln (\d+)/.exec(p.pos) || [])[1]);
  }
  const wv = await viewer('codeql-ci-paths.sarif');
  const posText = await E(wv, `document.getElementById('flow-pos').textContent`);
  must(JSON.stringify(seen) === JSON.stringify(['server.js:8', 'server.js:8', 'server.js:9', 'db.js:5', 'db.js:6']), JSON.stringify(seen));
  await wclick('codeql-ci-paths.sarif', '#flow-prev'); await sleep(700);
  const back = await editorPos();
  must(/db\.js/.test(back.tab) && /Ln 5\b/.test(back.pos), 'Previous: ' + JSON.stringify(back));
  await shot('codeql-codeflow');
  return { seen, posText, back };
});
await step('details: rule help is rendered Markdown, helpUri and CWE links, security severity', async () => {
  const wv = await viewer('codeql-ci-paths.sarif');
  const d = JSON.parse(await E(wv, `JSON.stringify({ help: !!document.querySelector('#d-help h3, #d-help h4, #d-help pre'), helpuri: (document.getElementById('d-helpuri') || {}).dataset ? document.getElementById('d-helpuri').dataset.href : '', cwe: [...document.querySelectorAll('.details a.ext-link')].map(a => a.textContent).filter(t => /CWE/.test(t)), sev: document.querySelector('.details .kv').textContent.includes('8.8'), anyHref: document.querySelectorAll('.details a[href]').length })`));
  must(d.help && /codeql\.github\.com/.test(d.helpuri) && d.cwe.length === 2 && d.sev && d.anyHref === 0, JSON.stringify(d));
  return d;
});
await step('group by file, sort, collapse a group, keyboard down + Enter opens', async () => {
  const name = 'codeql-ci-paths.sarif';
  await setSelect(name, 'sel-group', 'file');
  const wv = await viewer(name);
  const groups = await E(wv, `[...document.querySelectorAll('.row.grp .glabel')].map(e => e.textContent)`);
  must(groups.length === 3, JSON.stringify(groups));
  await wclick(name, '.row.grp');
  await sleep(500);
  const after = await E(wv, `document.querySelectorAll('.row.res').length`);
  must(after < 5, 'collapse did not hide rows: ' + after);
  await setSelect(name, 'sel-group', 'none');
  await wclick(name, '.row.res');
  await vs.key('ArrowDown', 'ArrowDown'); await sleep(300);
  await vs.key('Enter', 'Enter');
  await sleep(1000);
  const p = await editorPos();
  await setSelect(name, 'sel-group', 'rule');
  return { groups, after, opened: p };
});
await closeAll();

// 3. Semgrep with %SRCROOT% (originalUriBaseIds -> CI path).
await step('semgrep %SRCROOT%: click opens the mapped file at its line', async () => {
  await openLog('semgrep-srcroot.sarif');
  await clickRow('semgrep-srcroot.sarif', 'shell=True');
  const pos = await vs.waitFor(async () => { const p = await editorPos(); return /deploy\.py/.test(p.tab) && /Ln 4\b/.test(p.pos) ? p : null; }, 10000);
  must(pos, JSON.stringify(await editorPos()));
  return pos;
});
await closeAll();

// 4. Filters: level, baseline, suppression.
await step('filters: level, baseline and suppression', async () => {
  const name = 'eslint-baseline-suppressions.sarif';
  const { wv } = await openLog(name);
  const t = async () => statusTotal((await state(wv)).status).shown;
  const start = await t();
  await wclick(name, 'button.lv[data-level=error]'); await sleep(500);
  const noErr = await t();
  await wclick(name, 'button.lv[data-level=error]'); await sleep(500);
  await setSelect(name, 'sel-base', 'new'); const nw = await t();
  await setSelect(name, 'sel-base', 'absent'); const absent = await t();
  await setSelect(name, 'sel-base', 'all');
  await setSelect(name, 'sel-supp', 'only'); const onlySupp = await t();
  await wclick(name, '.row.res'); await sleep(600);
  const just = await E(wv, `(document.getElementById('d-supp') || {}).textContent || ''`);
  await shot('filters-suppressed');
  await setSelect(name, 'sel-supp', 'hide');
  const r = { start, noErr, nw, absent, onlySupp, just: just.slice(0, 120) };
  must(start === 6 && noErr === 5 && nw === 3 && absent === 1 && onlySupp === 2 && /Justification/.test(just), JSON.stringify(r));
  return r;
});
await step('text filter', async () => {
  const name = 'eslint-baseline-suppressions.sarif';
  const wv = await viewer(name);
  await wclick(name, '#filter-text');
  await vs.type('eqeqeq server');
  await sleep(700);
  const s = statusTotal((await state(wv)).status);
  await E(wv, `(() => { const i = document.getElementById('filter-text'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  must(s && s.shown === 1, JSON.stringify(s));
  return s;
});
await closeAll();

// 5. Problems panel: on, then off; removed when the log closes.
const problemCounts = () => vs.wbEval(`(() => { const p = document.getElementById('status.problems'); return p ? (p.getAttribute('aria-label') || p.textContent || '').trim() : ''; })()`);
const nums = s => (s.match(/\d+/g) || []).map(Number).reduce((a, b) => a + b, 0);
await step('Problems panel: Show in Problems adds diagnostics; again removes them; closing the log clears them', async () => {
  const name = 'codeql-ci-paths.sarif';
  await openLog(name);
  const before = await problemCounts();
  await wclick(name, '#btn-problems');
  const on = await vs.waitFor(async () => { const c = await problemCounts(); return nums(c) >= 5 ? c : null; }, 10000);
  must(on, 'no diagnostics: ' + await problemCounts());
  await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
  await sleep(1200);
  const rows = await vs.wbEval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].map(r => r.textContent.trim().slice(0, 120)).slice(0, 12)`);
  await shot('problems-panel');
  await wclick(name, '#btn-problems');
  const off = await vs.waitFor(async () => { const c = await problemCounts(); return nums(c) === nums(before) ? c : null; }, 10000);
  must(off !== null, 'not removed: ' + await problemCounts());
  await wclick(name, '#btn-problems');
  await vs.waitFor(async () => nums(await problemCounts()) >= 5, 10000);
  await closeAll();
  const closed = await vs.waitFor(async () => { const c = await problemCounts(); return nums(c) === nums(before) ? c : null; }, 10000);
  must(closed !== null, 'not cleared on close: ' + await problemCounts());
  must(rows.some(r => /SQL|query string|js\/sql-injection/i.test(r)), JSON.stringify(rows));
  return { before, on, off, closed, rows: rows.slice(0, 4) };
});

// 6. Compare with an older log (simple file dialog).
await step('compare: new / unchanged / fixed by fingerprint', async () => {
  const name = 'compare-new.sarif';
  const { wv } = await openLog(name);
  await wclick(name, '#btn-compare');
  const qi = await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null); })()`), 8000);
  must(qi, 'file dialog did not open');
  await vs.key('a', 'KeyA', 4, 65);
  await vs.type(path.join(ws, 'compare-old.sarif'));
  await sleep(500);
  await vs.key('Enter', 'Enter');
  const banner = await vs.waitFor(async () => { const t = await E(wv, `(document.getElementById('compare-banner') || {}).textContent || ''`); return /new/.test(t) ? t : null; }, 15000);
  must(banner && /2 new/.test(banner) && /2 unchanged/.test(banner) && /2 fixed/.test(banner), 'banner: ' + banner);
  await setSelect(name, 'sel-base', 'absent');
  const fixed = statusTotal((await state(wv)).status);
  await shot('compare');
  await setSelect(name, 'sel-base', 'all');
  await wclick(name, '#btn-endcompare'); await sleep(800);
  const after = statusTotal((await state(wv)).status);
  must(fixed && fixed.shown === 2 && after && after.total === 4, JSON.stringify({ fixed, after }));
  return { banner: banner.slice(0, 120), fixed, after };
});
await closeAll();

// 7. Hostile: markup, links and paths.
await step('hostile markup: no script ran, no img/iframe, javascript: helpUri not a link', async () => {
  const name = 'hostile-markup-paths.sarif';
  const { wv } = await openLog(name);
  await setSelect(name, 'sel-group', 'none');
  await clickRow(name, 'Message');
  await sleep(800);
  const r = JSON.parse(await E(wv, `JSON.stringify({ pwned: Object.keys(window).filter(k => /PWNED/.test(k)), scripts: [...document.scripts].filter(x => !(x.src.endsWith('/media/markdown.js') || x.src.endsWith('/media/viewer.js'))).map(x => (x.src || x.textContent).slice(0, 80)), imgs: document.querySelectorAll('img,iframe,svg,object,embed').length, href: [...document.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(h => h && !/^command:|^https:\\/\\/(marketplace\\.visualstudio\\.com|github\\.com)/.test(h)), dataHref: [...document.querySelectorAll('[data-href]')].map(a => a.dataset.href), help: (document.getElementById('d-help') || {}).textContent || '', rule: document.getElementById('d-rule').textContent })`));
  await shot('hostile-markup');
  must(r.pwned.length === 0 && r.imgs === 0 && r.href.length === 0, JSON.stringify(r));
  must(r.dataHref.every(u => /^https:\/\//.test(u)), JSON.stringify(r.dataHref));
  must(/<script>/.test(r.help) && /<script>/.test(r.rule), 'markup should show as text');
  return r;
});
await step('hostile paths: /etc/passwd asks first; UNC, web and C:\\Windows are not opened', async () => {
  const name = 'hostile-markup-paths.sarif';
  const wv = await viewer(name);
  const clickMsg = async text => {
    await E(wv, `(() => { const r = [...document.querySelectorAll('.row.res')].find(r => r.textContent.includes(${JSON.stringify(text)})); r.dataset.gate = '1'; })()`);
    await wclick(name, '.row.res[data-gate="1"]');
    await E(wv, `document.querySelectorAll('[data-gate]').forEach(e => delete e.dataset.gate)`);
    await sleep(1200);
  };
  await clickMsg('Points at /etc/passwd');
  const d1 = await vs.waitFor(dialog, 5000);
  must(d1 && /outside your workspace/.test(d1), 'no prompt for /etc/passwd: ' + d1);
  await vs.key('Escape', 'Escape'); await sleep(600);
  const ed1 = await editorPos();
  must(!/passwd/.test(ed1.tab), 'passwd opened without consent');
  const notes = [];
  for (const t of ['Points at a UNC share', 'Points at a web URL', 'Points at a Windows system file', 'Climbs out of the workspace']) {
    await clickMsg(t);
    const n = (await vs.notifications()).filter(x => /SARIF Viewer|web address|network share|Cannot find/.test(x));
    notes.push(n.slice(-1)[0] || '');
    await vs.command('Notifications: Clear All Notifications');
    const ed = await editorPos();
    must(!/hosts|payload|app\.js|passwd/.test(ed.tab), t + ' opened ' + ed.tab);
  }
  await shot('hostile-paths');
  must(/network share/.test(notes[0]) && /web address/.test(notes[1]) && /Cannot find/.test(notes[2]) && /Cannot find/.test(notes[3]), JSON.stringify(notes));
  return { dialog: d1.slice(0, 160), notes: notes.map(n => n.slice(0, 120)) };
});
await closeAll();

// 8. The 150 MB log.
await step('large: 150 MB merged log, first rows, End key, extension host memory', async () => {
  const before = extHostRss();
  const t0 = Date.now();
  vs.open(path.join(ws, 'large-merged.sarif'));
  const wv = await viewer('large-merged.sarif', 30000);
  must(wv, 'no viewer');
  let peak = before;
  const st = await vs.waitFor(async () => { peak = Math.max(peak, extHostRss()); const s = await state(wv); return s.rows > 0 && !s.loading && !s.progress ? s : null; }, 120000, 250);
  const firstRows = Date.now() - t0;
  must(st, 'large log did not show rows');
  const total = statusTotal(st.status);
  const want = jqCount(path.join(ws, 'large-merged.sarif'));
  // responsiveness: the workbench answers while the table is shown
  const t1 = Date.now(); await vs.wbEval('1'); const wbMs = Date.now() - t1;
  await setSelect('large-merged.sarif', 'sel-group', 'none');
  await wclick('large-merged.sarif', '.row.res');
  await sleep(1200);
  R.focusAfterOpen = R.focusAfterOpen || {}; R.focusAfterOpen[tag] = await E(wv, `document.activeElement && document.activeElement.id`);
  const t2 = Date.now();
  await vs.key('End', 'End');
  let lastSeen = null;
  const end = await vs.waitFor(async () => { const r = JSON.parse(await E(wv, `JSON.stringify({ last: [...document.querySelectorAll('.row.sel')].map(r => r.dataset.p)[0], maxP: Math.max(...[...document.querySelectorAll('.row')].map(r => Number(r.dataset.p))), loading: document.querySelectorAll('.row.loading').length, focus: document.activeElement && document.activeElement.id, top: document.getElementById('list').scrollTop })`)); lastSeen = r; return r.last && Number(r.last) === total.shown - 1 && !r.loading ? r : null; }, 15000, 100);
  const endMs = Date.now() - t2;
  const t3 = Date.now();
  await vs.key('Home', 'Home');
  await vs.waitFor(async () => (await E(wv, `document.querySelectorAll('.row.loading').length`)) === 0, 10000, 100);
  const homeMs = Date.now() - t3;
  await setSelect('large-merged.sarif', 'sel-group', 'rule');
  const t4 = Date.now();
  await E(wv, `(() => { const i = document.getElementById('filter-text'); i.value = 'finding 12345'; i.dispatchEvent(new Event('input')); })()`);
  const filt = await vs.waitFor(async () => { const s = statusTotal((await state(wv)).status); return s && s.shown < total.shown ? s : null; }, 20000, 100);
  const filterMs = Date.now() - t4;
  const after = extHostRss();
  await shot('large-150mb');
  R.extHostMB.push({ at: 'large', before, peak, after });
  must(total && total.total === want, `total ${JSON.stringify(total)} vs jq ${want}`);
  must(end, 'End did not reach the last row: ' + JSON.stringify({ lastSeen, total }));
  return { bytes: fs.statSync(path.join(ws, 'large-merged.sarif')).size, results: want, firstRowsMs: firstRows, workbenchEvalMs: wbMs, endMs, homeMs, filterMs, filtered: filt, extHostMB: { before, peak, after } };
});
await closeAll();
await sleep(1500);
await step('large: memory is released after the log closes', async () => {
  await sleep(3000);
  const now = extHostRss();
  R.extHostMB.push({ at: 'after-close', now });
  return { extHostMB: now };
});

// 9. Support links and the More free viewers picker.
await step('support: footer links and the More free viewers picker', async () => {
  const { wv } = await openLog('codeql-ci-paths.sarif');
  const footer = await E(wv, `[...document.querySelectorAll('#zovo-support a')].map(a => a.textContent)`);
  const pick = () => vs.waitFor(() => vs.wbEval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.textContent.trim().slice(0, 80))`).then(a => a.length > 3 && a.some(t => /Marketplace/.test(t)) ? a : null), 8000);
  // the footer link a user clicks (a command link), then the palette command as a second way in
  await wclick('codeql-ci-paths.sarif', '#zovo-support a[href^="command:sarifViewer.moreViewers"]');
  let items = await pick();
  R.morePickerVia = items ? 'footer link' : '';
  await vs.key('Escape', 'Escape');
  await focusWorkbench();
  await vs.command('SARIF: More free viewers');
  const items2 = await pick();
  if (items2) R.morePickerVia += (R.morePickerVia ? ' + ' : '') + 'command palette';
  items = items || items2;
  await shot('more-viewers');
  await vs.key('Escape', 'Escape');
  must(footer.includes('Sponsor') && footer.includes('More free viewers') && footer.includes('Rate'), JSON.stringify(footer));
  must(items && items.some(t => /JSON|PCAP|HAR/.test(t)), JSON.stringify(items));
  return { footer, items: items.slice(0, 6) };
});
// README screenshots: CodeQL log with the code flow and the file beside it; then the viewer alone with the rule help.
await step('readme screenshots', async () => {
  const name = 'codeql-ci-paths.sarif';
  await closeAll();
  await focusWorkbench();
  await vs.command('View: Close Primary Side Bar');
  const panelOpen = () => vs.wbEval(`(() => { const p = document.querySelector('.part.panel'); return !!(p && p.offsetParent !== null && p.getBoundingClientRect().height > 30); })()`);
  if (await panelOpen()) { await focusWorkbench(); await vs.command('View: Toggle Panel Visibility'); await sleep(500); }
  await openLog(name);
  await clickRow(name, 'This query string');
  await sleep(900);
  await wclick(name, '#flow-next'); await sleep(500);
  await wclick(name, '#flow-next'); await sleep(500);
  await wclick(name, '#flow-next'); await sleep(900);
  const a = await shot('readme-flow');
  // a real click on the viewer's tab makes its group active, then the other group is closed
  const tab = JSON.parse(await vs.wbEval(`(() => { const t = [...document.querySelectorAll('.tab')].find(t => /codeql-ci-paths\\.sarif/.test(t.textContent)); const r = t.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  await vs.click(tab.x, tab.y); await sleep(300);
  await vs.command('View: Close Editors in Other Groups');
  await sleep(1200);
  const wv = await viewer(name);
  await E(wv, `(() => { const d = document.getElementById('details'); const h = [...d.querySelectorAll('h3')].find(x => x.textContent === 'Rule'); if (h) d.scrollTop = h.offsetTop - 260; })()`);
  await sleep(400);
  const b = await shot('readme-wide');
  return [path.basename(a), path.basename(b)];
});
await closeAll();

// 10. No webview exceptions, no requests off the machine.
await step('no webview exceptions or CSP violations', async () => {
  const own = vs.console.filter(c => /vscode-webview/.test(c.where) && (c.type === 'exception' || /Content Security Policy|Refused to/.test(c.text)));
  R.console = vs.console.slice(0, 40);
  must(own.length === 0, JSON.stringify(own.slice(0, 4)));
  return { exceptions: own.length, consoleTotal: vs.console.length };
});

R.shots = shots;
const logs = vs.extHostLogs().filter(f => /SARIF Viewer\.log$/.test(f));
R.extensionLog = logs.length ? fs.readFileSync(logs[0], 'utf8').split('\n').slice(-30) : [];
await vs.close();
R.passed = R.steps.filter(s => s.ok).length; R.total = R.steps.length;
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`${R.passed}/${R.total} passed; webview requests ${R.network.all}, outside the machine ${R.network.outside.length}`);
process.exit(R.passed === R.total && R.network.outside.length === 0 ? 0 : 1);
