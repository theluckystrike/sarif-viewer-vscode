'use strict';
// Pure SARIF logic: no vscode import, no file or network access, so the tests and the worker can use it.
// buildIndex() turns parsed SARIF logs into compact columns; query() filters, sorts and groups them;
// detail() returns everything about one result for the details pane.

const LEVELS = ['error', 'warning', 'note', 'none'];
const BASELINES = ['new', 'unchanged', 'updated', 'absent', ''];
const MSG_MAX = 2000;

function str(v) { return typeof v === 'string' ? v : ''; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }

/** Checks the top level and returns { ok, version, warning, error }. */
function checkLog(doc) {
  const d = obj(doc);
  if (!d) return { ok: false, error: 'This file is valid JSON, but it is not a SARIF log (the top level is not an object).' };
  const version = str(d.version);
  if (!Array.isArray(d.runs)) {
    if (version.startsWith('1.')) return { ok: false, version, error: `This is a SARIF ${version} log. Only SARIF 2.x can be read. Convert it with the Sarif.Multitool "transform" command.` };
    return { ok: false, version, error: 'This file is valid JSON, but it is not a SARIF log: it has no "runs" list.' };
  }
  let warning = '';
  if (version && version !== '2.1.0') {
    if (version.startsWith('2.')) warning = `This is a SARIF ${version} log. It is read as SARIF 2.1.0, so some fields may not show.`;
    else if (version.startsWith('1.')) return { ok: false, version, error: `This is a SARIF ${version} log. Only SARIF 2.x can be read.` };
    else warning = `Unknown SARIF version "${version}". It is read as SARIF 2.1.0.`;
  } else if (!version) warning = 'The log has no "version" field. It is read as SARIF 2.1.0.';
  return { ok: true, version: version || '2.1.0', warning };
}

/** Fills {0}, {1} ... placeholders. Doubled braces stay literal. */
function fillArgs(text, args) {
  const a = arr(args);
  if (!a.length) return text;
  return text.replace(/\{\{|\}\}|\{(\d+)\}/g, (m, n) => (m === '{{' ? '{' : m === '}}' ? '}' : (n !== undefined && n < a.length ? String(a[n]) : m)));
}

/** SARIF message object -> plain text. Uses rule.messageStrings when the result names an id. */
function messageText(msg, rule, run) {
  const m = obj(msg);
  if (!m) return '';
  let t = str(m.text) || str(m.markdown);
  if (!t && m.id) {
    const ms = (rule && obj(rule.messageStrings)) || null;
    const entry = ms && obj(ms[m.id]);
    const global = run && obj(run.tool) && obj(run.tool.driver) && obj(run.tool.driver.globalMessageStrings);
    const g = global && obj(global[m.id]);
    t = (entry && (str(entry.text) || str(entry.markdown))) || (g && (str(g.text) || str(g.markdown))) || '';
  }
  t = fillArgs(t, m.arguments);
  return t;
}

/** Removes the [text](id) link syntax SARIF messages use for related locations, and escaped brackets. */
function plainMessage(t) {
  return t.replace(/\[([^\]]*)\]\((\d+|[a-z][a-z0-9+.-]*:[^)\s]*)\)/gi, '$1').replace(/\\([[\]\\])/g, '$1');
}

function clip(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }

/** Every tool component (driver and extensions) of a run: [{ name, rules, rulesById }] */
function toolComponents(run) {
  const tool = obj(run.tool) || {};
  const comps = [obj(tool.driver) || {}].concat(arr(tool.extensions).map(obj).filter(Boolean));
  return comps.map(c => {
    const rules = arr(c.rules).map(obj).map(r => r || {});
    const byId = new Map();
    for (const r of rules) { const id = str(r.id); if (id && !byId.has(id)) byId.set(id, r); }
    // deprecatedIds and guid also find a rule
    for (const r of rules) { for (const d of arr(r.deprecatedIds)) if (typeof d === 'string' && !byId.has(d)) byId.set(d, r); }
    return { name: str(c.name), version: str(c.semanticVersion) || str(c.version), rules, byId };
  });
}

/** The rule object of a result, or null. */
function findRule(result, comps) {
  const ref = obj(result.rule);
  let ci = 0;
  if (ref && obj(ref.toolComponent) && Number.isInteger(ref.toolComponent.index)) ci = ref.toolComponent.index;
  const comp = comps[ci] || comps[0];
  if (!comp) return null;
  const idx = Number.isInteger(result.ruleIndex) ? result.ruleIndex : (ref && Number.isInteger(ref.index) ? ref.index : -1);
  if (idx >= 0 && comp.rules[idx]) return comp.rules[idx];
  const id = str(result.ruleId) || (ref && str(ref.id));
  if (id) {
    if (comp.byId.has(id)) return comp.byId.get(id);
    // "rule/subrule" ids: try the part before the slash
    const base = id.split('/')[0];
    if (comp.byId.has(base)) return comp.byId.get(base);
    for (const c of comps) if (c.byId.has(id)) return c.byId.get(id);
  }
  return null;
}

/** Effective level (SARIF 2.1.0 section 3.27.10). */
function effectiveLevel(result, rule, run) {
  const kind = str(result.kind);
  if (LEVELS.includes(result.level)) return result.level;
  if (kind && kind !== 'fail') return 'none';
  const dc = rule && obj(rule.defaultConfiguration);
  if (dc && LEVELS.includes(dc.level)) return dc.level;
  // run-level configuration overrides
  return 'warning';
}

/** Resolve a uriBaseId chain (originalUriBaseIds). Returns { base, unresolved } where base may be ''. */
function resolveBase(id, bases, depth = 0) {
  if (!id) return { base: '', unresolved: '' };
  const entry = bases && obj(bases[id]);
  if (!entry || depth > 8) return { base: '', unresolved: id };
  const u = str(entry.uri);
  if (entry.uriBaseId) {
    const up = resolveBase(entry.uriBaseId, bases, depth + 1);
    return { base: joinUri(up.base, u), unresolved: up.unresolved };
  }
  return { base: u, unresolved: '' };
}

function joinUri(base, rel) {
  if (!base) return rel;
  if (!rel) return base;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/')) return rel;
  return base.replace(/\/?$/, '/') + rel;
}

/** artifactLocation -> { uri, baseId } with index and uriBaseId applied. uri may be relative. */
function artifactUri(loc, run) {
  const l = obj(loc);
  if (!l) return { uri: '', baseId: '' };
  let uri = str(l.uri), baseId = str(l.uriBaseId);
  if (!uri && Number.isInteger(l.index)) {
    const a = obj(arr(run.artifacts)[l.index]);
    const al = a && obj(a.location);
    if (al) { uri = str(al.uri); baseId = baseId || str(al.uriBaseId); }
  }
  if (baseId) {
    const r = resolveBase(baseId, obj(run.originalUriBaseIds));
    if (r.base) return { uri: joinUri(r.base, uri), baseId: r.unresolved };
    return { uri, baseId: r.unresolved || baseId };
  }
  return { uri, baseId: '' };
}

/** Short display path: decoded, without file:// and %SRCROOT% decorations. */
function displayPath(uri) {
  let p = uri;
  if (/^file:/i.test(p)) {
    p = p.replace(/^file:(\/\/)?/i, m => (m.length > 5 ? '//' : ''));
    if (/^\/\/\/?/.test(p)) p = p.replace(/^\/\/(?=\/)/, ''); // file:///x -> /x
  }
  try { p = decodeURIComponent(p); } catch {}
  return p;
}

/** First physical location of a result: { uri, baseId, line, col, endLine, endCol } */
function primaryLocation(result, run) {
  const loc = obj(arr(result.locations)[0]);
  const pl = loc && obj(loc.physicalLocation);
  if (!pl) {
    // logical-only locations
    const ll = loc && obj(arr(loc.logicalLocations)[0]);
    return { uri: '', baseId: '', line: 0, col: 0, endLine: 0, endCol: 0, logical: ll ? (str(ll.fullyQualifiedName) || str(ll.name)) : '' };
  }
  return physical(pl, run);
}

function physical(pl, run) {
  const a = artifactUri(pl.artifactLocation, run);
  const reg = obj(pl.region) || {};
  const ctx = obj(pl.contextRegion) || {};
  const line = num(reg.startLine) || num(ctx.startLine) || 0;
  return {
    uri: a.uri, baseId: a.baseId,
    line, col: num(reg.startColumn) || (line ? 1 : 0),
    endLine: num(reg.endLine) || line, endCol: num(reg.endColumn) || 0,
    charOffset: Number.isInteger(reg.charOffset) ? reg.charOffset : -1, charLength: Number.isInteger(reg.charLength) ? reg.charLength : -1,
    snippet: clip(str(obj(reg.snippet) && reg.snippet.text), 500),
    logical: '',
  };
}
function num(v) { return Number.isInteger(v) && v > 0 ? v : 0; }

/** 0 = not suppressed, 1 = suppressed (accepted or no status), 2 = suppression under review, 3 = rejected */
function suppressionState(result) {
  const s = arr(result.suppressions).map(obj).filter(Boolean);
  if (!s.length) return 0;
  if (s.some(x => !x.status || x.status === 'accepted')) return 1;
  if (s.some(x => x.status === 'underReview')) return 2;
  return 3;
}

/** A stable key for comparing results across two logs. */
function fingerprint(result, ruleId, path, msg) {
  const fp = obj(result.fingerprints);
  if (fp) { const k = Object.keys(fp).sort(); if (k.length) return 'f:' + k.map(x => x + '=' + fp[x]).join('&'); }
  const pf = obj(result.partialFingerprints);
  if (pf) { const k = Object.keys(pf).sort(); if (k.length) return 'p:' + ruleId + '|' + k.map(x => x + '=' + pf[x]).join('&'); }
  if (result.guid && typeof result.guid === 'string' && result.correlationGuid) return 'g:' + result.correlationGuid;
  return 'm:' + ruleId + '|' + path + '|' + msg.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Intern strings into a table. */
class Strings {
  constructor() { this.list = []; this.map = new Map(); }
  id(s) { let i = this.map.get(s); if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); } return i; }
}

/**
 * Build the compact index for one or more parsed logs.
 * logs: [{ doc, name }]. Returns an index object (plain data) that query() and detail() use.
 */
function buildIndex(logs, opts = {}) {
  const maxResults = opts.maxResults || 5e6;
  const files = new Strings(), rules = new Strings(), tools = new Strings();
  const cols = { level: [], rule: [], file: [], line: [], col: [], endLine: [], endCol: [], tool: [], src: [], run: [], res: [], base: [], supp: [], msg: [], fp: [], flows: [] };
  const ruleInfo = []; // per rule string id: { src, run, comp, ruleIdx } for details
  const runs = []; // [{ src, run, tool, version, results, ok, notes }]
  const warnings = [];
  const sources = [];
  let truncated = false;
  logs.forEach((log, src) => {
    const chk = checkLog(log.doc);
    sources.push({ name: log.name || '', version: chk.version || '', error: chk.ok ? '' : chk.error });
    if (!chk.ok) return;
    if (chk.warning) warnings.push((logs.length > 1 ? log.name + ': ' : '') + chk.warning);
    log.doc.runs.forEach((runRaw, ri) => {
      const run = obj(runRaw);
      if (!run) return;
      const comps = toolComponents(run);
      const driver = comps[0];
      const toolName = driver.name || 'Unknown tool';
      const t = tools.id(toolName);
      const inv = arr(run.invocations).map(obj).filter(Boolean);
      const failed = inv.some(i => i.executionSuccessful === false);
      const notes = [];
      for (const i of inv) for (const n of arr(i.toolExecutionNotifications).concat(arr(i.toolConfigurationNotifications)).slice(0, 20)) {
        const nn = obj(n); if (nn && (nn.level === 'error' || nn.level === 'warning')) notes.push(clip(plainMessage(messageText(nn.message, null, run)), 300));
      }
      const rr = { src, run: ri, tool: toolName, version: driver.version, results: 0, ruleCount: driver.rules.length, failed, notes: notes.slice(0, 10), hasResults: Array.isArray(run.results) };
      runs.push(rr);
      const results = arr(run.results);
      for (let k = 0; k < results.length; k++) {
        if (cols.level.length >= maxResults) { truncated = true; break; }
        const r = obj(results[k]);
        if (!r) continue;
        const rule = findRule(r, comps);
        const ruleId = str(r.ruleId) || (obj(r.rule) && str(r.rule.id)) || (rule && str(rule.id)) || '(no rule id)';
        const ruleKey = toolName + '\u0000' + ruleId;
        const rid = rules.id(ruleKey);
        if (!ruleInfo[rid]) ruleInfo[rid] = { src, run: ri, id: ruleId, tool: toolName, name: rule ? str(rule.name) : '', short: rule ? clip(plainMessage(messageText(rule.shortDescription)), 300) : '', has: !!rule };
        const level = effectiveLevel(r, rule, run);
        const loc = primaryLocation(r, run);
        const path = loc.uri ? displayPath(loc.uri) : (loc.logical || '');
        const msg = clip(plainMessage(messageText(r.message, rule, run)), MSG_MAX);
        cols.level.push(LEVELS.indexOf(level));
        cols.rule.push(rid);
        cols.file.push(files.id(path));
        cols.line.push(loc.line); cols.col.push(loc.col); cols.endLine.push(loc.endLine); cols.endCol.push(loc.endCol);
        cols.tool.push(t); cols.src.push(src); cols.run.push(ri); cols.res.push(k);
        const bs = BASELINES.indexOf(str(r.baselineState));
        cols.base.push(bs < 0 ? 4 : bs);
        cols.supp.push(suppressionState(r));
        cols.msg.push(msg);
        cols.fp.push(opts.fingerprints === false ? '' : fingerprint(r, ruleId, path, msg));
        cols.flows.push(arr(r.codeFlows).length ? 1 : 0);
        rr.results++;
      }
    });
  });
  if (truncated) warnings.push(`Only the first ${maxResults.toLocaleString('en-US')} results are shown.`);
  return { cols, files: files.list, rules: rules.list.map(k => k.split('\u0000')[1]), ruleInfo, tools: tools.list, runs, sources, warnings, compare: null };
}

/** Counts for the header and the filter buttons. */
function facets(ix) {
  const n = ix.cols.level.length;
  const level = [0, 0, 0, 0], base = [0, 0, 0, 0, 0], supp = [0, 0, 0, 0];
  const tool = new Array(ix.tools.length).fill(0);
  let flows = 0;
  for (let i = 0; i < n; i++) {
    if (ix.compare && ix.compare.hidden[i]) continue;
    level[ix.cols.level[i]]++; base[baseOf(ix, i)]++; supp[ix.cols.supp[i]]++; tool[ix.cols.tool[i]]++; flows += ix.cols.flows[i];
  }
  const shown = level.reduce((a, b) => a + b, 0);
  return { total: shown, level, base, supp, tool, flows, files: ix.files.length, rules: ix.rules.length };
}

function baseOf(ix, i) { return ix.compare ? ix.compare.state[i] : ix.cols.base[i]; }

/**
 * Compare: the first log is the baseline, the second the new one. Matches results by fingerprint.
 * Sets compare.state (0 new, 1 unchanged, 3 absent=fixed) and hides the matched baseline copies.
 */
function applyCompare(ix, baseSrc = 0, newSrc = 1) {
  const n = ix.cols.level.length;
  const counts = new Map();
  for (let i = 0; i < n; i++) if (ix.cols.src[i] === baseSrc) counts.set(ix.cols.fp[i], (counts.get(ix.cols.fp[i]) || 0) + 1);
  const state = new Uint8Array(n), hidden = new Uint8Array(n);
  const matchedBase = new Map();
  for (let i = 0; i < n; i++) {
    if (ix.cols.src[i] !== newSrc) continue;
    const c = counts.get(ix.cols.fp[i]) || 0;
    if (c > 0) { state[i] = 1; counts.set(ix.cols.fp[i], c - 1); matchedBase.set(ix.cols.fp[i], (matchedBase.get(ix.cols.fp[i]) || 0) + 1); }
    else state[i] = 0;
  }
  for (let i = 0; i < n; i++) {
    if (ix.cols.src[i] !== baseSrc) continue;
    const m = matchedBase.get(ix.cols.fp[i]) || 0;
    if (m > 0) { hidden[i] = 1; matchedBase.set(ix.cols.fp[i], m - 1); } else state[i] = 3;
  }
  for (let i = 0; i < n; i++) if (ix.cols.src[i] !== baseSrc && ix.cols.src[i] !== newSrc) hidden[i] = 1;
  ix.compare = { baseSrc, newSrc, state, hidden };
  let nw = 0, same = 0, fixed = 0;
  for (let i = 0; i < n; i++) { if (hidden[i]) continue; if (state[i] === 0) nw++; else if (state[i] === 1) same++; else fixed++; }
  return { new: nw, unchanged: same, fixed };
}

const DEFAULT_FILTER = { levels: [1, 1, 1, 1], base: 'all', supp: 'hide', tool: -1, text: '', group: 'rule', sort: 'level', collapsed: [] };

/**
 * Filter, sort and group. Returns view: { rows: Int32Array (>= 0 result index, < 0 group header -(g+1)), groups, count }.
 */
function query(ix, filter) {
  const f = Object.assign({}, DEFAULT_FILTER, filter || {});
  const c = ix.cols, n = c.level.length;
  const words = String(f.text || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const ruleLower = words.length ? ix.rules.map(s => s.toLowerCase()) : null;
  const fileLower = words.length ? ix.files.map(s => s.toLowerCase()) : null;
  const toolLower = words.length ? ix.tools.map(s => s.toLowerCase()) : null;
  const wantBase = f.base === 'all' ? -1 : BASELINES.indexOf(f.base === 'none' ? '' : f.base);
  const keep = [];
  for (let i = 0; i < n; i++) {
    if (ix.compare && ix.compare.hidden[i]) continue;
    if (!f.levels[c.level[i]]) continue;
    const s = c.supp[i];
    if (f.supp === 'hide' && s === 1) continue;
    if (f.supp === 'only' && s === 0) continue;
    if (f.tool >= 0 && c.tool[i] !== f.tool) continue;
    if (wantBase >= 0 && baseOf(ix, i) !== wantBase) continue;
    if (words.length) {
      let ok = true;
      for (const w of words) {
        if (ruleLower[c.rule[i]].includes(w) || fileLower[c.file[i]].includes(w) || toolLower[c.tool[i]].includes(w)) continue;
        if (c.msg[i].toLowerCase().includes(w)) continue;
        const ri = ix.ruleInfo[c.rule[i]];
        if (ri && (ri.name.toLowerCase().includes(w) || ri.short.toLowerCase().includes(w))) continue;
        ok = false; break;
      }
      if (!ok) continue;
    }
    keep.push(i);
  }
  const fileCmp = (a, b) => (c.file[a] === c.file[b] ? 0 : ix.files[c.file[a]] < ix.files[c.file[b]] ? -1 : 1);
  const byLoc = (a, b) => fileCmp(a, b) || c.line[a] - c.line[b] || c.col[a] - c.col[b] || a - b;
  const sorts = {
    level: (a, b) => c.level[a] - c.level[b] || byLoc(a, b),
    file: byLoc,
    rule: (a, b) => (c.rule[a] === c.rule[b] ? 0 : ix.rules[c.rule[a]] < ix.rules[c.rule[b]] ? -1 : 1) || byLoc(a, b),
    message: (a, b) => (c.msg[a] < c.msg[b] ? -1 : c.msg[a] > c.msg[b] ? 1 : byLoc(a, b)),
    baseline: (a, b) => baseOf(ix, a) - baseOf(ix, b) || c.level[a] - c.level[b] || byLoc(a, b),
  };
  keep.sort(sorts[f.sort] || sorts.level);
  const groupKey = { rule: i => c.rule[i], file: i => c.file[i], level: i => c.level[i], tool: i => c.tool[i], baseline: i => baseOf(ix, i) }[f.group];
  if (!groupKey) return { rows: Int32Array.from(keep), groups: [], count: keep.length };
  const groups = new Map();
  for (const i of keep) {
    const k = groupKey(i);
    let g = groups.get(k);
    if (!g) { g = { key: k, items: [], worst: 3 }; groups.set(k, g); }
    g.items.push(i);
    if (c.level[i] < g.worst) g.worst = c.level[i];
  }
  const glist = [...groups.values()];
  const label = g => groupLabel(ix, f.group, g.key);
  if (f.group === 'level' || f.group === 'baseline') glist.sort((a, b) => a.key - b.key);
  else glist.sort((a, b) => a.worst - b.worst || b.items.length - a.items.length || (label(a) < label(b) ? -1 : 1));
  const collapsed = new Set((f.collapsed || []).map(String));
  const allCollapsed = f.collapsedAll === true;
  const rows = [];
  const groupsOut = glist.map((g, gi) => {
    const key = f.group + ':' + label(g);
    const isCol = allCollapsed ? !collapsed.has('!' + key) : collapsed.has(key);
    rows.push(-(gi + 1));
    if (!isCol) for (const i of g.items) rows.push(i);
    return { key, label: label(g), count: g.items.length, worst: g.worst, collapsed: isCol, sub: f.group === 'rule' ? ruleSub(ix, g.key) : '' };
  });
  return { rows: Int32Array.from(rows), groups: groupsOut, count: keep.length };
}

function ruleSub(ix, rid) {
  const ri = ix.ruleInfo[rid];
  if (!ri) return '';
  return [ri.name && ri.name !== ri.id ? ri.name : '', ri.short].filter(Boolean).join(': ').slice(0, 200) + (ix.tools.length > 1 ? ` (${ri.tool})` : '');
}

function groupLabel(ix, group, key) {
  if (group === 'rule') return ix.rules[key];
  if (group === 'file') return ix.files[key] || '(no file)';
  if (group === 'level') return LEVELS[key];
  if (group === 'tool') return ix.tools[key];
  if (group === 'baseline') return baselineName(key, !!ix.compare);
  return String(key);
}

function baselineName(b, compare) {
  if (compare) return ['new', 'unchanged', 'updated', 'fixed', ''][b] || '';
  return ['new', 'unchanged', 'updated', 'absent', ''][b] || '';
}

/** Rows for one window of the view, ready for the webview table. */
function windowRows(ix, view, start, count) {
  const c = ix.cols, out = [];
  const end = Math.min(view.rows.length, start + count);
  for (let p = start; p < end; p++) {
    const v = view.rows[p];
    if (v < 0) { const g = view.groups[-v - 1]; out.push({ p, g: 1, key: g.key, label: g.label, count: g.count, worst: g.worst, collapsed: g.collapsed, sub: g.sub }); continue; }
    out.push({
      p, i: v, level: c.level[v], rule: ix.rules[c.rule[v]], file: ix.files[c.file[v]], line: c.line[v], col: c.col[v],
      tool: ix.tools[c.tool[v]], base: baselineName(baseOf(ix, v), !!ix.compare), supp: c.supp[v], msg: c.msg[v].slice(0, 400), flows: c.flows[v],
    });
  }
  return out;
}

/** Everything about one result. docs: the parsed logs (same order as in buildIndex). */
function detail(ix, docs, i) {
  const c = ix.cols;
  if (!(i >= 0 && i < c.level.length)) return null;
  const doc = docs[c.src[i]];
  const run = obj(doc.runs[c.run[i]]) || {};
  const r = obj(arr(run.results)[c.res[i]]) || {};
  const comps = toolComponents(run);
  const rule = findRule(r, comps);
  const msgRaw = messageText(r.message, rule, run);
  const loc = (l) => {
    const o = obj(l) || {};
    const pl = obj(o.physicalLocation);
    const p = pl ? physical(pl, run) : { uri: '', baseId: '', line: 0, col: 0, endLine: 0, endCol: 0 };
    const ll = obj(arr(o.logicalLocations)[0]);
    return Object.assign(p, { id: Number.isInteger(o.id) ? o.id : -1, message: clip(plainMessage(messageText(o.message, null, run)), 500), logical: ll ? (str(ll.fullyQualifiedName) || str(ll.name)) : '', path: p.uri ? displayPath(p.uri) : '' });
  };
  const flows = arr(r.codeFlows).slice(0, 50).map((cf, fi) => {
    const cfo = obj(cf) || {};
    return {
      message: clip(plainMessage(messageText(cfo.message, null, run)), 300),
      threads: arr(cfo.threadFlows).slice(0, 20).map(tf => {
        const t = obj(tf) || {};
        return { id: str(t.id), message: clip(plainMessage(messageText(t.message, null, run)), 300), steps: arr(t.locations).slice(0, 1000).map(tl => {
          const x = obj(tl) || {};
          return Object.assign(loc(x.location), { nesting: Number.isInteger(x.nestingLevel) ? Math.min(x.nestingLevel, 20) : 0, kinds: arr(x.kinds).filter(k => typeof k === 'string').slice(0, 5), importance: str(x.importance) });
        }) };
      }),
    };
  });
  const props = obj(rule && rule.properties) || {};
  const rprops = obj(r.properties) || {};
  const tags = arr(props.tags).filter(t => typeof t === 'string').slice(0, 40);
  const cwe = tags.map(t => (/cwe[-/_:]?0*(\d{1,5})/i.exec(t) || [])[1]).filter(Boolean)
    .concat(arr(rule && rule.relationships).map(rel => { const tg = obj(obj(rel) && rel.target); return tg && /^\d{1,5}$/.test(str(tg.id)) && /cwe/i.test(str(obj(tg.toolComponent) && tg.toolComponent.name)) ? tg.id : ''; }).filter(Boolean));
  const help = obj(rule && rule.help) || {};
  const sev = props['security-severity'] !== undefined ? String(props['security-severity']).slice(0, 10) : (rprops['security-severity'] !== undefined ? String(rprops['security-severity']).slice(0, 10) : '');
  return {
    i, tool: ix.tools[c.tool[i]], toolVersion: (comps[0] && comps[0].version) || '', level: LEVELS[c.level[i]], kind: str(r.kind) || 'fail',
    ruleId: ix.rules[c.rule[i]],
    rule: rule ? {
      name: str(rule.name), short: messageText(rule.shortDescription), full: messageText(rule.fullDescription),
      helpText: str(help.text).slice(0, 50000), helpMarkdown: str(help.markdown).slice(0, 50000), helpUri: str(rule.helpUri),
      tags, cwe: [...new Set(cwe)].slice(0, 10), securitySeverity: sev, precision: str(props.precision), problemSeverity: str(props['problem.severity']),
      defaultLevel: str(obj(rule.defaultConfiguration) && rule.defaultConfiguration.level),
    } : null,
    message: clip(msgRaw, 20000),
    messageMarkdown: obj(r.message) ? clip(str(r.message.markdown), 20000) : '',
    location: loc(arr(r.locations)[0]),
    locations: arr(r.locations).slice(1, 50).map(loc),
    related: arr(r.relatedLocations).slice(0, 200).map(loc),
    flows,
    baseline: baselineName(baseOf(ix, i), !!ix.compare), baselineRaw: str(r.baselineState),
    suppressions: arr(r.suppressions).slice(0, 10).map(s => { const o = obj(s) || {}; return { kind: str(o.kind), status: str(o.status) || 'accepted', justification: clip(str(o.justification), 2000) }; }),
    fingerprints: Object.assign({}, obj(r.partialFingerprints) || {}, obj(r.fingerprints) || {}),
    rank: typeof r.rank === 'number' ? r.rank : null,
    occurrence: Number.isInteger(r.occurrenceCount) ? r.occurrenceCount : null,
    source: ix.sources[c.src[i]] ? ix.sources[c.src[i]].name : '',
    hostedViewerUri: '',
  };
}

/** Results as diagnostics input: [{ i, path, line, col, endLine, endCol, level, msg, rule, helpUri }] */
function diagnosticsInput(ix, docs, filter, limit) {
  const view = query(ix, Object.assign({}, filter, { group: 'none', collapsed: [] }));
  const out = [];
  const helpCache = new Map();
  for (const i of view.rows) {
    if (out.length >= limit) break;
    const c = ix.cols;
    if (!ix.files[c.file[i]] || c.level[i] === 3 && filter && filter.skipNone) continue;
    let help = helpCache.get(c.rule[i]);
    if (help === undefined) {
      const run = obj(docs[c.src[i]].runs[c.run[i]]) || {};
      const r = obj(arr(run.results)[c.res[i]]) || {};
      const rule = findRule(r, toolComponents(run));
      help = rule ? str(rule.helpUri) : '';
      helpCache.set(c.rule[i], help);
    }
    out.push({ i, path: ix.files[c.file[i]], line: c.line[i], col: c.col[i], endLine: c.endLine[i], endCol: c.endCol[i], level: LEVELS[c.level[i]], msg: c.msg[i], rule: ix.rules[c.rule[i]], tool: ix.tools[c.tool[i]], helpUri: help });
  }
  return { items: out, total: view.count };
}

/** The raw location uri + base id of a result (for opening). */
function rawLocation(ix, docs, i, which, idx) {
  const d = detail(ix, docs, i);
  if (!d) return null;
  if (which === 'related') return d.related[idx] || null;
  if (which === 'locations') return d.locations[idx] || null;
  if (which === 'flow') { const [f, t, s] = idx; const fl = d.flows[f]; const th = fl && fl.threads[t]; return (th && th.steps[s]) || null; }
  return d.location;
}

module.exports = {
  LEVELS, BASELINES, DEFAULT_FILTER, checkLog, fillArgs, messageText, plainMessage, toolComponents, findRule, effectiveLevel,
  resolveBase, joinUri, artifactUri, displayPath, primaryLocation, suppressionState, fingerprint, buildIndex, facets, applyCompare,
  query, windowRows, detail, diagnosticsInput, rawLocation, baselineName,
};
