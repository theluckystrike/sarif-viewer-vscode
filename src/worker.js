'use strict';
// Worker thread: reads and parses SARIF logs off the extension host thread and keeps the index.
// The extension asks it for windows of rows, so a log with a million results never crosses into the UI at once.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const S = require('./core/sarif');

let docs = [], names = [], ix = null, view = null, filter = null;

function decode(buf) {
  let bad = false, text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { bad = true; text = new TextDecoder('utf-8').decode(buf); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, bad };
}

function lineCol(text, pos) {
  let line = 1, last = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i + 1; }
  return { line, col: pos - last + 1 };
}

function parse(src, post) {
  const t0 = Date.now();
  let buf;
  if (src.bytes) buf = Buffer.from(src.bytes);
  else {
    const st = fs.statSync(src.path);
    if (st.size > src.maxBytes) return { error: 'tooLarge', size: st.size };
    post({ type: 'progress', stage: 'read', size: st.size, name: src.name });
    buf = fs.readFileSync(src.path);
  }
  const t1 = Date.now();
  post({ type: 'progress', stage: 'decode', size: buf.length, name: src.name });
  const { text, bad } = decode(buf);
  buf = null;
  post({ type: 'progress', stage: 'parse', size: text.length, name: src.name });
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) {
    const m = /position (\d+)/.exec(String(e.message));
    const where = m ? lineCol(text, Number(m[1])) : null;
    return { error: 'json', message: String(e.message).slice(0, 300) + (where ? ` (line ${where.line}, column ${where.col})` : ''), bad };
  }
  return { doc, bad, size: text.length, ms: { read: t1 - t0, parse: Date.now() - t1 } };
}

function summary(extra) {
  const f = S.facets(ix);
  return Object.assign({ facets: f, tools: ix.tools, runs: ix.runs, sources: ix.sources, warnings: ix.warnings, compare: ix.compare ? compareCounts() : null }, extra || {});
}

function compareCounts() {
  const c = ix.compare; let nw = 0, same = 0, fixed = 0;
  for (let i = 0; i < c.state.length; i++) { if (c.hidden[i]) continue; if (c.state[i] === 0) nw++; else if (c.state[i] === 1) same++; else if (c.state[i] === 3) fixed++; }
  return { new: nw, unchanged: same, fixed, baseName: names[c.baseSrc], newName: names[c.newSrc] };
}

function rebuild() {
  ix = S.buildIndex(docs.map((doc, k) => ({ doc, name: names[k] })));
  view = null;
}

const handlers = {
  load(msg, post) {
    docs = []; names = [];
    const res = parse(msg.source, post);
    if (res.error) return res;
    docs.push(res.doc); names.push(msg.source.name);
    const t = Date.now();
    rebuild();
    const chk = ix.sources[0];
    if (chk.error) { docs = []; return { error: 'notSarif', message: chk.error }; }
    if (res.bad) ix.warnings.push('The file is not valid UTF-8. Bad bytes are shown as �.');
    return summary({ ms: Object.assign(res.ms, { index: Date.now() - t }), size: res.size });
  },
  add(msg, post) {
    const res = parse(msg.source, post);
    if (res.error) return res;
    const chk = S.checkLog(res.doc);
    if (!chk.ok) return { error: 'notSarif', message: chk.error };
    docs = docs.slice(0, msg.keep || docs.length);
    names = names.slice(0, docs.length);
    docs.push(res.doc); names.push(msg.source.name);
    rebuild();
    if (msg.mode === 'compare') S.applyCompare(ix, docs.length - 1, 0);
    return summary();
  },
  reset() {
    docs = docs.slice(0, 1); names = names.slice(0, 1);
    rebuild();
    return summary();
  },
  query(msg) {
    filter = msg.filter;
    view = S.query(ix, filter);
    return { count: view.count, length: view.rows.length, groups: view.groups.length, rows: S.windowRows(ix, view, msg.start || 0, msg.size || 200), seq: msg.seq };
  },
  window(msg) {
    if (!view) view = S.query(ix, filter);
    return { start: msg.start, rows: S.windowRows(ix, view, msg.start, msg.size), seq: msg.seq };
  },
  find(msg) {
    // position of a result index in the current view, -1 when hidden
    if (!view) return { p: -1 };
    for (let p = 0; p < view.rows.length; p++) if (view.rows[p] === msg.i) return { p };
    return { p: -1 };
  },
  detail(msg) { return { detail: S.detail(ix, docs, msg.i) }; },
  loc(msg) { return { loc: S.rawLocation(ix, docs, msg.i, msg.which, msg.idx) }; },
  diag(msg) { return S.diagnosticsInput(ix, docs, msg.filter, msg.limit); },
  stats() { return { heap: process.memoryUsage() }; },
};

parentPort.on('message', msg => {
  const post = m => parentPort.postMessage(Object.assign({ id: msg.id }, m));
  let out;
  try {
    const h = handlers[msg.cmd];
    out = h ? h(msg, post) : { error: 'unknown', message: msg.cmd };
  } catch (e) {
    out = { error: 'crash', message: String(e && e.message || e).slice(0, 500) };
  }
  parentPort.postMessage(Object.assign({ id: msg.id, done: true }, out));
});
