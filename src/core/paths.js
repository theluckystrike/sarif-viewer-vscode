'use strict';
// Pure path logic for SARIF artifact locations. No vscode import and no file access: the extension does the
// stat calls, in order, for the candidates this module returns. Nothing here starts a search process.

/**
 * Classify a SARIF artifact uri (after uriBaseId resolution).
 * Returns { kind, path, unresolvedBase }
 *   kind: 'empty' | 'relative' | 'posix' (absolute /x) | 'windows' (C:/x) | 'unc' (//server/share) | 'remote' (http, https, other schemes)
 *   path: forward slashes, percent-decoded, no file: prefix.
 */
function classify(uri, unresolvedBase) {
  let u = String(uri || '').trim();
  const out = (kind, path) => ({ kind, path, unresolvedBase: unresolvedBase || '' });
  if (!u) return out('empty', '');
  let fileScheme = false;
  if (/^file:/i.test(u)) {
    fileScheme = true;
    u = u.slice(5);
    if (u.startsWith('//')) {
      const rest = u.slice(2);
      if (rest.startsWith('/')) u = rest; // file:///x
      else if (/^localhost\//i.test(rest)) u = rest.slice(9);
      else if (/^[a-z]:/i.test(rest)) u = '/' + rest;
      else u = '//' + rest; // file://server/share -> UNC
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) {
    return out('remote', u);
  }
  let p = u;
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/\\/g, '/');
  if (/^\/\/[^/]/.test(p)) return out('unc', p);
  if (/^\/[a-z]:\//i.test(p)) p = p.slice(1); // /C:/x -> C:/x
  if (/^[a-z]:\//i.test(p)) return out('windows', p);
  if (p.startsWith('/')) return out('posix', normalize(p));
  if (fileScheme) return out('relative', normalize(p));
  return out('relative', normalize(p));
}

/** Collapses ./ and ../ segments; never climbs above the start of a relative path. */
function normalize(p) {
  const abs = p.startsWith('/');
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); continue; }
    parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/');
}

/** True when the relative path tries to leave its base. */
function escapes(rel) { return normalize(rel).split('/')[0] === '..'; }

/** Join a root (absolute, forward slashes) with a relative path; returns '' when it would leave the root. */
function joinInside(root, rel) {
  if (escapes(rel)) return '';
  const r = root.replace(/\/+$/, '');
  return normalize(r + '/' + rel);
}

/** True when p is root or inside root (forward slashes, case-sensitive unless ci). */
function isInside(p, root, ci) {
  const a = ci ? p.toLowerCase() : p, b = (ci ? root.toLowerCase() : root).replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/');
}

/**
 * Relative suffixes of an absolute path, longest first, for workspace matching:
 * /home/runner/work/app/app/src/a.js -> home/runner/work/app/app/src/a.js, runner/work/..., ..., src/a.js, a.js
 * The bare file name comes last, and only when allowName is true.
 */
function suffixes(absPath, allowName = true, max = 12) {
  const segs = absPath.replace(/^[a-z]:/i, '').split('/').filter(Boolean);
  const out = [];
  const minLen = allowName ? 1 : 2;
  for (let k = Math.max(0, segs.length - max); k <= segs.length - minLen; k++) out.push(segs.slice(k).join('/'));
  return out;
}

/** Apply a remembered prefix map: [{ from, to }]. Longest "from" wins. Returns the mapped path or ''. */
function applyMap(p, map, ci) {
  let best = null;
  for (const m of map || []) {
    if (!m || !m.from || typeof m.to !== 'string') continue;
    if (isInside(p, m.from, ci) && (!best || m.from.length > best.from.length)) best = m;
  }
  if (!best) return '';
  const rest = p.slice(best.from.replace(/\/+$/, '').length).replace(/^\/+/, '');
  if (escapes(rest)) return '';
  return rest ? best.to.replace(/\/+$/, '') + '/' + rest : best.to;
}

/**
 * Learn a prefix pair from a CI path and the local file the user (or the automatic match) chose:
 * /home/runner/work/app/app/src/a.js + /Users/me/app/src/a.js -> { from: /home/runner/work/app/app, to: /Users/me/app }
 * Returns null when the file names differ.
 */
function learn(original, local, root) {
  if (root && isInside(local, root)) {
    // prefer a map onto the workspace folder itself: /home/runner/work/app/app -> /Users/me/app
    const rel = local.slice(root.replace(/\/+$/, '').length);
    if (rel && original.endsWith(rel) && original.length > rel.length) {
      const from = original.slice(0, original.length - rel.length);
      if (from !== root) return { from, to: root.replace(/\/+$/, '') };
    }
  }
  const a = original.split('/'), b = local.split('/');
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k] && a[a.length - 1 - k] !== '') k++;
  if (k === 0) return null;
  const from = a.slice(0, a.length - k).join('/') || '/';
  const to = b.slice(0, b.length - k).join('/') || '/';
  if (from === to) return null;
  return { from, to };
}

/**
 * Candidate local paths for a classified location, in the order the extension should stat them.
 * ctx: { roots: [workspace folder paths], sarifDir, map: [{from,to}], baseMap: { SRCROOT: '/abs' } }
 * Each candidate: { path, why, inside } where inside = under a workspace folder or the SARIF file's folder.
 */
function candidates(loc, ctx) {
  const roots = (ctx.roots || []).filter(Boolean);
  const dirs = roots.concat(ctx.sarifDir ? [ctx.sarifDir] : []);
  const out = [], seen = new Set();
  const add = (p, why) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, why, inside: dirs.some(r => isInside(p, r)) });
  };
  if (loc.kind === 'relative') {
    const bm = loc.unresolvedBase && ctx.baseMap && ctx.baseMap[loc.unresolvedBase];
    if (bm) add(joinInside(bm, loc.path), 'base ' + loc.unresolvedBase);
    for (const r of roots) add(joinInside(r, loc.path), 'workspace');
    if (ctx.sarifDir) add(joinInside(ctx.sarifDir, loc.path), 'next to the SARIF file');
    // a relative path with a leading folder that is not in the workspace (checkout dir names)
    const segs = loc.path.split('/');
    for (let k = 1; k < segs.length && k < 4; k++) for (const r of roots) add(joinInside(r, segs.slice(k).join('/')), 'workspace (shorter path)');
    return out;
  }
  if (loc.kind === 'posix' || loc.kind === 'windows') {
    const mapped = applyMap(loc.path, ctx.map, loc.kind === 'windows');
    if (mapped) add(mapped, 'path map');
    if (loc.kind === 'posix') add(loc.path, 'as written');
    for (const s of suffixes(loc.path, true)) for (const r of roots) add(joinInside(r, s), 'workspace match');
    return out;
  }
  return out; // unc, remote, empty: never opened automatically
}

module.exports = { classify, normalize, escapes, joinInside, isInside, suffixes, applyMap, learn, candidates };
