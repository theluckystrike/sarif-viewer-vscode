'use strict';
// SARIF Viewer: a read-only custom editor for .sarif and .sarif.json logs.
// The log is parsed in a worker thread; the webview asks for windows of rows. No network, no telemetry,
// no search processes: files are found with a few stat calls per distinct path.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const P = require('./core/paths');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks, footerHtml, FOOTER_CSS } = require('./support');

const EXT_ID = 'zovo.zovo-sarif-viewer';
const SECTION = 'sarifViewer';
const VIEW_TYPE = 'sarifViewer.viewer';
const MAP_KEY = 'sarifViewer.pathMap.v1';
const FILTER_KEY = 'sarifViewer.filter.v1';
const HARD_MAX_MB = 500; // V8 cannot hold a longer string

let rating = { success() {}, failure() {} };
let log = { info() {}, warn() {}, error() {} };
const sessions = new Set();

function cfg() {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    maxFileMB: Math.min(HARD_MAX_MB, Math.max(1, Number(c.get('maxFileMB', 300)) || 300)),
    problemsLimit: Math.max(100, Math.min(100000, Number(c.get('problemsLimit', 5000)) || 5000)),
    openBeside: c.get('openBeside', true) !== false,
    pathMappings: c.get('pathMappings', {}) || {},
    groupBy: c.get('groupBy', 'rule'),
    showSuppressed: c.get('showSuppressed', 'hide'),
  };
}

function nonce() { return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, ''); }

function fmtMB(n) { return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB'; }

/** The worker with request/response ids. */
class Engine {
  constructor(context, onProgress) {
    this.w = new Worker(path.join(__dirname, 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 6144 } });
    this.seq = 0; this.pend = new Map(); this.onProgress = onProgress; this.dead = false;
    this.w.on('message', m => {
      if (!m.done) { if (m.type === 'progress' && this.onProgress) this.onProgress(m); return; }
      const p = this.pend.get(m.id); if (p) { this.pend.delete(m.id); p(m); }
    });
    const fail = (e) => { this.dead = true; for (const p of this.pend.values()) p({ error: 'crash', message: String(e && e.message || e || 'worker stopped') }); this.pend.clear(); };
    this.w.on('error', fail);
    this.w.on('exit', code => fail(code ? `the parser stopped (code ${code}); the file may need more memory than the limit` : 'worker exited'));
  }
  ask(cmd, data, transfer) {
    if (this.dead) return Promise.resolve({ error: 'crash', message: 'The parser is not running. Close and reopen the file.' });
    const id = ++this.seq;
    return new Promise(r => { this.pend.set(id, r); this.w.postMessage(Object.assign({ id, cmd }, data || {}), transfer || []); });
  }
  dispose() { try { this.w.terminate(); } catch {} this.dead = true; }
}

function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file' || f.uri.scheme === 'vscode-remote').map(f => f.uri);
}

function rootPaths() { return workspaceRoots().map(u => u.path); }

async function exists(uri) {
  try { const st = await vscode.workspace.fs.stat(uri); return (st.type & vscode.FileType.File) !== 0; } catch { return false; }
}

/** Finds the local file for a SARIF location. One instance per open log; results are cached. */
class Resolver {
  constructor(context, sarifUri) {
    this.context = context; this.sarifUri = sarifUri; this.cache = new Map();
    this.scheme = workspaceRoots()[0] ? workspaceRoots()[0].scheme : sarifUri.scheme;
    this.authority = workspaceRoots()[0] ? workspaceRoots()[0].authority : sarifUri.authority;
  }
  maps() {
    const saved = this.context.workspaceState.get(MAP_KEY, []);
    const fromSettings = Object.entries(cfg().pathMappings).filter(([a, b]) => typeof a === 'string' && typeof b === 'string').map(([from, to]) => ({ from: from.replace(/\\/g, '/'), to: to.replace(/\\/g, '/') }));
    return fromSettings.concat(Array.isArray(saved) ? saved : []);
  }
  async remember(m) {
    if (!m) return;
    const list = (this.context.workspaceState.get(MAP_KEY, []) || []).filter(x => x.from !== m.from);
    list.unshift(m);
    await this.context.workspaceState.update(MAP_KEY, list.slice(0, 50));
    this.cache.clear();
  }
  uriOf(p) { return vscode.Uri.from({ scheme: this.scheme, authority: this.authority, path: p }); }
  /** -> { uri?, outside?, reason?, loc } (no prompts) */
  async find(raw) {
    const key = (raw.baseId || '') + '|' + raw.uri;
    if (this.cache.has(key)) return this.cache.get(key);
    const loc = P.classify(raw.uri, raw.baseId);
    const maps = this.maps(), baseMap = {}, extraRoots = [];
    for (const m of maps) { const b = /^%(.*)%$/.exec(m.from); if (!b) continue; if (b[1]) baseMap[b[1]] = m.to; else extraRoots.push(m.to); }
    const ctx = { roots: rootPaths().concat(extraRoots), sarifDir: path.posix.dirname(this.sarifUri.path), map: maps.filter(m => !/^%.*%$/.test(m.from)), baseMap };
    let res;
    if (loc.kind === 'empty') res = { reason: 'This result has no file location.', loc };
    else if (loc.kind === 'remote') res = { reason: `The location is a web address (${loc.path}). It is not opened, because this viewer makes no network requests.`, loc };
    else if (loc.kind === 'unc') res = { reason: `The location is a network share path (${loc.path}). It is not opened, because this viewer makes no network requests. Map it to a local folder with "Locate file".`, loc, canLocate: true };
    else {
      res = null;
      for (const c of P.candidates(loc, ctx)) {
        const u = this.uriOf(c.path);
        if (await exists(u)) {
          res = { uri: u, outside: !c.inside && c.why !== 'path map', why: c.why, loc };
          if (c.why === 'workspace match' && (loc.kind === 'posix' || loc.kind === 'windows')) {
            const m = P.learn(loc.path, c.path, ctx.roots.find(r => P.isInside(c.path, r)));
            if (m && m.from !== '/' && m.from.length > 1) { res.learned = m; await this.remember(m); }
          }
          break;
        }
      }
      if (!res) res = { reason: `Cannot find ${loc.path}${loc.unresolvedBase ? ` (relative to ${loc.unresolvedBase})` : ''} in this workspace.`, loc, canLocate: true };
    }
    this.cache.set(key, res);
    return res;
  }
  /** Lets the user pick the local file; learns a prefix map from it. */
  async locate(res) {
    const name = res.loc.path.split('/').pop();
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this file', title: `Locate ${name}`, defaultUri: workspaceRoots()[0] });
    if (!picked || !picked[0]) return null;
    const local = picked[0].path;
    if (res.loc.kind === 'relative') {
      const base = local.endsWith('/' + res.loc.path) ? local.slice(0, -res.loc.path.length - 1) : '';
      if (base) await this.remember({ from: '%' + (res.loc.unresolvedBase || '') + '%', to: base });
    } else {
      const m = P.learn(res.loc.path, local, rootPaths().find(r => P.isInside(local, r)));
      if (m) await this.remember(m);
    }
    this.cache.clear();
    return picked[0];
  }
}

let highlight;
function highlightDeco() {
  if (!highlight) highlight = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'), border: '1px solid', borderColor: new vscode.ThemeColor('editor.findMatchBorder'), isWholeLine: false });
  return highlight;
}

function regionRange(doc, loc) {
  if (loc.charOffset >= 0 && !loc.line) {
    const a = doc.positionAt(loc.charOffset), b = doc.positionAt(loc.charOffset + Math.max(0, loc.charLength));
    return new vscode.Range(a, b);
  }
  if (!loc.line) return new vscode.Range(0, 0, 0, 0);
  const last = doc.lineCount - 1;
  const l1 = Math.min(last, loc.line - 1);
  const l2 = Math.min(last, Math.max(l1, (loc.endLine || loc.line) - 1));
  const c1 = Math.max(0, (loc.col || 1) - 1);
  let c2 = loc.endCol ? loc.endCol - 1 : doc.lineAt(l2).text.length;
  if (l2 === l1 && c2 <= c1) c2 = doc.lineAt(l2).text.length;
  return new vscode.Range(l1, Math.min(c1, doc.lineAt(l1).text.length), l2, Math.min(c2, doc.lineAt(l2).text.length));
}

class Session {
  constructor(context, document, panel) {
    this.context = context; this.document = document; this.panel = panel; this.uri = document.uri;
    this.resolver = new Resolver(context, this.uri);
    this.diag = null; this.disposed = false; this.loaded = false; this.counted = false;
    this.engine = new Engine(context, m => this.post({ type: 'progress', stage: m.stage, size: m.size, name: m.name }));
    this.subs = [];
    sessions.add(this);
  }
  post(m) { if (!this.disposed) this.panel.webview.postMessage(m); }

  html() {
    const wv = this.panel.webview, n = nonce();
    const media = f => wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const footer = footerHtml(SECTION, showLinks(vscode, SECTION), '');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data:; style-src ${wv.cspSource} 'nonce-${n}'; font-src ${wv.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('viewer.css')}" nonce="${n}">
<style nonce="${n}">${FOOTER_CSS}</style>
<title>SARIF Viewer</title></head>
<body><div id="app" data-name="${escAttr(path.posix.basename(this.uri.path))}"></div>
<template id="footer-tpl">${footer}</template>
<script nonce="${n}" src="${media('markdown.js')}"></script>
<script nonce="${n}" src="${media('viewer.js')}"></script>
</body></html>`;
  }

  async start() {
    const wv = this.panel.webview;
    wv.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], enableCommandUris: commandUris(SECTION) };
    wv.html = this.html();
    this.subs.push(wv.onDidReceiveMessage(m => this.onMessage(m).catch(e => { log.error(String(e && e.stack || e)); this.post({ type: 'toast', level: 'error', text: String(e && e.message || e) }); })));
    this.panel.onDidDispose(() => this.dispose());
  }

  async load(force) {
    const c = cfg();
    let size = -1;
    try { size = (await vscode.workspace.fs.stat(this.uri)).size; } catch (e) { this.post({ type: 'error', text: 'Cannot read the file: ' + (e && e.message || e) }); rating.failure(); return; }
    const name = path.posix.basename(this.uri.path);
    if (size > HARD_MAX_MB * 1048576) { this.post({ type: 'tooLarge', size, hard: true, limitMB: HARD_MAX_MB }); return; }
    if (size > c.maxFileMB * 1048576 && !force) { this.post({ type: 'tooLarge', size, hard: false, limitMB: c.maxFileMB }); return; }
    this.post({ type: 'progress', stage: 'start', size, name });
    const source = { name, maxBytes: HARD_MAX_MB * 1048576 };
    let transfer;
    if (this.uri.scheme === 'file') source.path = this.uri.fsPath;
    else { const bytes = await vscode.workspace.fs.readFile(this.uri); source.bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); transfer = [source.bytes]; }
    const t = Date.now();
    const r = await this.engine.ask('load', { source }, transfer);
    if (this.disposed) return;
    if (r.error) {
      const text = r.error === 'json' ? `This file is not valid JSON: ${r.message}` : r.error === 'notSarif' ? r.message : r.error === 'tooLarge' ? '' : `The log could not be read: ${r.message}`;
      if (r.error === 'tooLarge') { this.post({ type: 'tooLarge', size: r.size, hard: true, limitMB: HARD_MAX_MB }); return; }
      this.post({ type: 'error', text });
      if (!this.counted) { this.counted = true; rating.failure(); }
      log.warn(`${name}: ${text}`);
      return;
    }
    this.loaded = true;
    log.info(`${name}: ${r.facets.total} results, ${fmtMB(size)}, read ${r.ms.read} ms, parse ${r.ms.parse} ms, index ${r.ms.index} ms, total ${Date.now() - t} ms`);
    const saved = this.context.workspaceState.get(FILTER_KEY + ':' + this.uri.toString());
    this.post({ type: 'loaded', summary: r, size, filter: saved || null, defaults: { group: c.groupBy, supp: c.showSuppressed }, ms: Date.now() - t, problems: !!this.diag });
    if (!this.counted) { this.counted = true; rating.success(this.uri); }
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.load(false);
      case 'loadAnyway': return this.load(true);
      case 'query': {
        this.filter = m.filter;
        this.context.workspaceState.update(FILTER_KEY + ':' + this.uri.toString(), m.filter);
        const r = await this.engine.ask('query', { filter: m.filter, start: m.start || 0, size: m.size || 200, seq: m.seq });
        this.post(Object.assign({ type: 'view' }, r));
        if (this.diag && m.refreshProblems) this.refreshProblems();
        return;
      }
      case 'window': { const r = await this.engine.ask('window', { start: m.start, size: m.size, seq: m.seq }); this.post(Object.assign({ type: 'rows' }, r)); return; }
      case 'detail': {
        const r = await this.engine.ask('detail', { i: m.i });
        const d = r.detail;
        if (d) {
          // resolve the main location without prompts so the pane can say where it points
          const res = d.location.uri ? await this.resolver.find(d.location) : null;
          d.resolved = res ? (res.uri ? { path: vscode.workspace.asRelativePath(res.uri, true), outside: !!res.outside, why: res.why } : { reason: res.reason }) : null;
        }
        this.post({ type: 'detail', detail: d, seq: m.seq });
        return;
      }
      case 'open': return this.openLocation(m.i, m.which || 'primary', m.idx, m.preserveFocus);
      case 'openExternal': {
        const ok = typeof m.url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(m.url);
        if (ok) await vscode.env.openExternal(vscode.Uri.parse(m.url, true));
        return;
      }
      case 'copy': await vscode.env.clipboard.writeText(String(m.text || '').slice(0, 100000)); vscode.window.setStatusBarMessage('Copied', 1500); return;
      case 'problems': return m.on ? this.showProblems() : this.clearProblems(true);
      case 'compare': return this.addFile('compare');
      case 'merge': return this.addFile('merge');
      case 'endCompare': { const r = await this.engine.ask('reset'); this.post({ type: 'summary', summary: r }); return; }
      case 'openJson': return vscode.commands.executeCommand('vscode.openWith', this.uri, 'default', { viewColumn: vscode.ViewColumn.Beside });
      case 'forgetMaps': await this.context.workspaceState.update(MAP_KEY, []); this.resolver.cache.clear(); vscode.window.showInformationMessage('SARIF Viewer: remembered path mappings were removed.'); return;
    }
  }

  async openLocation(i, which, idx, preserveFocus) {
    const r = await this.engine.ask('loc', { i, which, idx });
    const loc = r.loc;
    if (!loc) return;
    if (!loc.uri) { vscode.window.showInformationMessage(loc.logical ? `This location has no file: ${loc.logical}` : 'This result has no file location.'); return; }
    let res = await this.resolver.find(loc);
    let uri = res.uri;
    if (uri && res.outside) {
      const pick = await vscode.window.showWarningMessage(`This result points to a file outside your workspace:\n${uri.fsPath || uri.path}\nOpen it?`, { modal: true }, 'Open');
      if (pick !== 'Open') return;
    }
    if (!uri) {
      const btns = res.canLocate ? ['Locate file…'] : [];
      const pick = await vscode.window.showWarningMessage(res.reason, ...btns);
      if (pick !== 'Locate file…') return;
      uri = await this.resolver.locate(res);
      if (!uri) return;
    }
    if (res.learned) vscode.window.setStatusBarMessage(`SARIF Viewer: ${res.learned.from} → ${res.learned.to}`, 6000);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = regionRange(doc, loc);
      const col = cfg().openBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
      const ed = await vscode.window.showTextDocument(doc, { viewColumn: col, preserveFocus: !!preserveFocus, preview: true, selection: new vscode.Range(range.start, range.start) });
      ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      for (const e of vscode.window.visibleTextEditors) e.setDecorations(highlightDeco(), []);
      ed.setDecorations(highlightDeco(), [range]);
      this.post({ type: 'opened', i, path: vscode.workspace.asRelativePath(uri, true), line: range.start.line + 1 });
    } catch (e) {
      vscode.window.showWarningMessage(`Cannot open ${uri.fsPath || uri.path}: ${e && e.message || e}`);
    }
  }

  async addFile(mode) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: mode === 'compare' ? 'Compare' : 'Add', title: mode === 'compare' ? 'Pick the older SARIF log (the baseline)' : 'Pick a SARIF log to show with this one', filters: { 'SARIF logs': ['sarif', 'json'] }, defaultUri: vscode.Uri.joinPath(this.uri, '..') });
    if (!picked || !picked[0]) return;
    return this.addUri(picked[0], mode);
  }

  async addUri(uri, mode) {
    let size = 0;
    try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { vscode.window.showWarningMessage('Cannot read ' + uri.fsPath); return; }
    if (size > cfg().maxFileMB * 1048576) { vscode.window.showWarningMessage(`${path.posix.basename(uri.path)} is ${fmtMB(size)}, more than the sarifViewer.maxFileMB setting.`); return; }
    const source = { name: path.posix.basename(uri.path), maxBytes: HARD_MAX_MB * 1048576 };
    let transfer;
    if (uri.scheme === 'file') source.path = uri.fsPath;
    else { const b = await vscode.workspace.fs.readFile(uri); source.bytes = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); transfer = [source.bytes]; }
    this.post({ type: 'progress', stage: 'start', size, name: source.name });
    const r = await this.engine.ask('add', { source, mode, keep: mode === 'compare' ? 1 : undefined }, transfer);
    if (r.error) { this.post({ type: 'summaryError' }); vscode.window.showWarningMessage(`${source.name}: ${r.message || r.error}`); return; }
    this.post({ type: 'summary', summary: r });
  }

  async showProblems() {
    if (!this.diag) this.diag = vscode.languages.createDiagnosticCollection('sarif:' + path.posix.basename(this.uri.path));
    await this.refreshProblems();
  }

  async refreshProblems() {
    if (!this.diag) return;
    const limit = cfg().problemsLimit;
    const r = await this.engine.ask('diag', { filter: Object.assign({}, this.filter || {}, { skipNone: false }), limit });
    const byFile = new Map();
    let missing = 0, outside = 0;
    const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, note: vscode.DiagnosticSeverity.Information, none: vscode.DiagnosticSeverity.Hint };
    const pathCache = new Map();
    for (const it of r.items || []) {
      let target = pathCache.get(it.path);
      if (target === undefined) {
        const rawUri = /^[a-z][a-z0-9+.-]+:/i.test(it.path) || it.path.startsWith('/') ? it.path : it.path;
        const res = await this.resolver.find({ uri: rawUri, baseId: '' });
        target = res.uri && !res.outside ? res.uri : null;
        if (!res.uri) missing++; else if (res.outside) outside++;
        pathCache.set(it.path, target);
      }
      if (!target) continue;
      const l1 = Math.max(0, (it.line || 1) - 1), c1 = Math.max(0, (it.col || 1) - 1);
      const l2 = Math.max(l1, (it.endLine || it.line || 1) - 1);
      const c2 = it.endCol ? Math.max(0, it.endCol - 1) : (l2 === l1 ? c1 + 1 : 0);
      const d = new vscode.Diagnostic(new vscode.Range(l1, c1, l2, l2 === l1 ? Math.max(c2, c1 + 1) : c2), it.msg.slice(0, 2000), sev[it.level]);
      d.source = it.tool;
      d.code = /^https?:\/\//i.test(it.helpUri) ? { value: it.rule, target: vscode.Uri.parse(it.helpUri, true) } : it.rule;
      const k = target.toString();
      if (!byFile.has(k)) byFile.set(k, { uri: target, list: [] });
      byFile.get(k).list.push(d);
    }
    this.diag.clear();
    let n = 0;
    for (const v of byFile.values()) { this.diag.set(v.uri, v.list); n += v.list.length; }
    this.post({ type: 'problems', on: true, count: n, total: r.total, limit, files: byFile.size, missing, outside });
  }

  clearProblems(notify) {
    if (this.diag) { this.diag.clear(); this.diag.dispose(); this.diag = null; }
    if (notify) this.post({ type: 'problems', on: false });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearProblems(false);
    this.engine.dispose();
    for (const s of this.subs) try { s.dispose(); } catch {}
    sessions.delete(this);
  }
}

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

class Provider {
  constructor(context) { this.context = context; this.pendingCompare = new Map(); }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(document, panel) {
    const s = new Session(this.context, document, panel);
    await s.start();
    const k = document.uri.toString();
    if (this.pendingCompare.has(k)) {
      const base = this.pendingCompare.get(k); this.pendingCompare.delete(k);
      const wait = setInterval(() => { if (s.loaded || s.disposed) { clearInterval(wait); if (s.loaded) s.addUri(base, 'compare'); } }, 200);
      setTimeout(() => clearInterval(wait), 120000);
    }
  }
}

function activeSession() {
  for (const s of sessions) if (s.panel.active) return s;
  return null;
}

function activate(context) {
  log = vscode.window.createOutputChannel('SARIF Viewer', { log: true });
  context.subscriptions.push(log);
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'SARIF Viewer' });
  const provider = new Provider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('sarifViewer.open', async (uri) => {
      let u = uri instanceof vscode.Uri ? uri : null;
      if (!u) { const p = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'SARIF logs': ['sarif', 'json'] } }); u = p && p[0]; }
      if (u) await vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('sarifViewer.compare', async (uri, uris) => {
      let pair = Array.isArray(uris) && uris.length === 2 ? uris : null;
      if (!pair) {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Compare', title: 'Pick two SARIF logs', filters: { 'SARIF logs': ['sarif', 'json'] } });
        if (!picked || picked.length !== 2) { if (picked) vscode.window.showInformationMessage('Pick exactly two SARIF logs.'); return; }
        pair = picked;
      }
      // the older file (by modification time) is the baseline
      const st = await Promise.all(pair.map(u => vscode.workspace.fs.stat(u).then(s => s.mtime, () => 0)));
      const [base, newer] = st[0] <= st[1] ? pair : [pair[1], pair[0]];
      const open = [...sessions].find(s => s.uri.toString() === newer.toString() && s.loaded);
      if (open) { open.panel.reveal(); return open.addUri(base, 'compare'); }
      provider.pendingCompare.set(newer.toString(), base);
      await vscode.commands.executeCommand('vscode.openWith', newer, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('sarifViewer.toggleProblems', () => { const s = activeSession(); if (!s) return; s.post({ type: 'toggleProblems' }); }),
    vscode.commands.registerCommand('sarifViewer.forgetPathMappings', async () => { await context.workspaceState.update(MAP_KEY, []); for (const s of sessions) s.resolver.cache.clear(); vscode.window.showInformationMessage('SARIF Viewer: remembered path mappings were removed.'); }),
    vscode.commands.registerCommand('sarifViewer.openSample', () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'media', 'sample.sarif'), VIEW_TYPE)),
    vscode.commands.registerCommand('sarifViewer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#sarifViewer.start`, false)),
    { dispose: () => { for (const s of [...sessions]) s.dispose(); if (highlight) highlight.dispose(); } },
  );
  return { _sessions: sessions };
}

function deactivate() { for (const s of [...sessions]) s.dispose(); }

module.exports = { activate, deactivate, _test: { regionRange, Resolver, Engine } };
