// SARIF Viewer webview. Talks only to the extension (postMessage). Never builds HTML from log text without
// escaping; Markdown goes through SarifMarkdown, which escapes everything and makes links data-href only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const MD = window.SarifMarkdown;
  const esc = MD.escapeHtml;
  const RH = 24, MAXH = 8000000, WIN = 200;
  const LV = ['error', 'warning', 'note', 'none'], LVL = ['Error', 'Warning', 'Note', 'None'], LVC = ['!', '!', 'i', '–'];
  const app = document.getElementById('app');
  const NAME = app.dataset.name || 'SARIF log';
  const footerTpl = document.getElementById('footer-tpl');

  let summary = null, filter = null, view = { length: 0, count: 0 }, cache = new Map(), seq = 0, pending = new Set();
  let sel = -1, selI = -1, detail = null, detailSeq = 0, flowPos = null, problems = { on: false };
  let els = {};
  let refocusList = 0; // an open started from the table: give the table its focus back afterwards

  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const fmt = n => Number(n).toLocaleString('en-US');
  const pl = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

  function toast(text) {
    const t = h('div', 'toast'); t.textContent = text; document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  // ---------- simple screens ----------
  function screen(inner) {
    app.innerHTML = '';
    const c = h('div', 'center'); c.innerHTML = inner; app.appendChild(c);
    app.appendChild(footer(''));
    return c;
  }
  function footer(status) {
    const f = h('div', 'foot');
    const s = h('span', 'status'); s.textContent = status; f.appendChild(s);
    if (footerTpl) f.appendChild(footerTpl.content.cloneNode(true));
    return f;
  }
  function progress(m) {
    const stage = { start: 'Opening', read: 'Reading', decode: 'Decoding', parse: 'Parsing' }[m.stage] || 'Working on';
    const c = screen(`<div class="spin"></div><div class="big">${esc(stage)} ${esc(m.name || NAME)}</div><p>${m.size > 0 ? esc(mb(m.size)) : ''}${m.size > 50 * 1048576 ? ' · a large log takes a few seconds; VS Code stays responsive' : ''}</p>`);
    c.id = 'progress';
  }

  // ---------- main layout ----------
  function layout() {
    app.innerHTML = '';
    const top = h('div', 'top');
    els.title = h('h1'); els.title.textContent = NAME; els.title.title = NAME;
    els.chips = h('div', 'chips');
    const actions = h('div', 'actions');
    els.btnProblems = button('Show in Problems', 'Add these results to the Problems panel (current filters). Click again to remove them.', () => send({ type: 'problems', on: !problems.on }));
    els.btnProblems.id = 'btn-problems';
    const cmp = button('Compare…', 'Compare with an older SARIF log of the same project: new, unchanged and fixed results', () => send({ type: 'compare' }));
    cmp.id = 'btn-compare';
    const add = button('Add log…', 'Show another SARIF log in this table (merged, with a tool column)', () => send({ type: 'merge' }));
    add.id = 'btn-add';
    const json = button('JSON', 'Open the log as JSON text', () => send({ type: 'openJson' }));
    actions.append(els.btnProblems, cmp, add, json);
    top.append(els.title, els.chips, actions);
    els.banner = h('div', 'banner hidden'); els.banner.id = 'banner';
    els.cmpBanner = h('div', 'banner info hidden'); els.cmpBanner.id = 'compare-banner';

    const tb = h('div', 'toolbar');
    els.search = h('input'); els.search.type = 'search'; els.search.placeholder = 'Filter by rule, message, path or tool'; els.search.id = 'filter-text';
    els.search.setAttribute('aria-label', 'Filter results');
    let t; els.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filter.text = els.search.value; requery(); }, 160); });
    els.lv = LV.map((l, k) => { const b = button('', `Show or hide ${l} results`, () => { filter.levels[k] = filter.levels[k] ? 0 : 1; requery(); }); b.className = 'lv'; b.dataset.level = l; return b; });
    els.base = dropdown('base', 'Baseline', []);
    els.supp = dropdown('supp', 'Suppressed', [['hide', 'Hide suppressed'], ['show', 'Show suppressed'], ['only', 'Only suppressed']]);
    els.tool = dropdown('tool', 'Tool', []);
    els.group = dropdown('group', 'Group', [['rule', 'By rule'], ['file', 'By file'], ['level', 'By level'], ['tool', 'By tool'], ['baseline', 'By baseline'], ['none', 'No groups']]);
    els.sort = dropdown('sort', 'Sort', [['level', 'Level'], ['file', 'File'], ['rule', 'Rule'], ['message', 'Message'], ['baseline', 'Baseline']]);
    els.collapse = button('Collapse all', 'Collapse or expand every group', () => {
      const allCol = filter.collapsedAll && !(filter.collapsed || []).length;
      filter.collapsedAll = !allCol; filter.collapsed = []; requery();
    });
    tb.append(els.search, ...els.lv, h('span', 'sep'), els.base.wrap, els.supp.wrap, els.tool.wrap, h('span', 'sep'), els.group.wrap, els.sort.wrap, els.collapse);

    const main = h('div', 'main');
    els.list = h('div', 'list'); els.list.tabIndex = 0; els.list.id = 'list'; els.list.setAttribute('role', 'listbox'); els.list.setAttribute('aria-label', 'Results');
    els.spacer = h('div', 'spacer'); els.vp = h('div', 'vp');
    els.list.append(els.vp, els.spacer);
    els.nomatch = h('div', 'nomatch'); els.nomatch.id = 'nomatch';
    const split = h('div', 'splitter');
    els.details = h('div', 'details empty'); els.details.id = 'details';
    els.details.textContent = 'Click a result to see the rule, the code flow and where it is.';
    main.append(els.list, split, els.details);
    els.foot = footer('');
    els.status = els.foot.querySelector('.status'); els.status.id = 'status';
    app.append(top, els.banner, els.cmpBanner, tb, main, els.foot);

    els.list.addEventListener('scroll', () => render(), { passive: true });
    window.addEventListener('resize', () => render());
    els.list.addEventListener('mousedown', onListMouse);
    els.list.addEventListener('keydown', onListKey);
    els.details.addEventListener('click', onDetailsClick);
    els.details.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('a,[data-open],[data-step]')) { e.preventDefault(); onDetailsClick(e); } });
    let drag = null;
    split.addEventListener('mousedown', e => { drag = { x: e.clientX, w: els.details.getBoundingClientRect().width }; e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!drag) return; const w = Math.max(240, Math.min(window.innerWidth - 300, drag.w - (e.clientX - drag.x))); els.details.style.flexBasis = w + 'px'; render(); });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function button(text, title, fn) { const b = h('button'); b.textContent = text; b.title = title; b.addEventListener('click', fn); return b; }
  function dropdown(key, label, opts) {
    const wrap = h('label'); wrap.textContent = label + ' ';
    const s = h('select'); s.id = 'sel-' + key; s.setAttribute('aria-label', label);
    wrap.appendChild(s);
    const set = list => { s.innerHTML = list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); };
    set(opts);
    s.addEventListener('change', () => { filter[key] = key === 'tool' ? Number(s.value) : s.value; if (key === 'group') { filter.collapsed = []; filter.collapsedAll = false; } requery(); });
    return { wrap, s, set };
  }

  function send(m) { vscode.postMessage(m); }

  // ---------- summary ----------
  function applySummary(s, saved, defaults) {
    summary = s;
    const base = { levels: [1, 1, 1, 0], base: 'all', supp: (defaults && defaults.supp) || 'hide', tool: -1, text: '', group: (defaults && defaults.group) || 'rule', sort: 'level', collapsed: [], collapsedAll: false };
    if (!filter) filter = Object.assign(base, saved || {});
    // show "none" level results only when the log has nothing else
    if (!saved && s.facets.level[0] + s.facets.level[1] + s.facets.level[2] === 0) filter.levels[3] = 1;
    if (filter.tool >= s.tools.length) filter.tool = -1;
    const nothing = s.facets.total === 0 && !s.compare;
    if (nothing) return emptyScreen(s);
    if (!els.list || !document.body.contains(els.list)) layout();
    chips(s);
    banners(s);
    requery(true);
  }

  function chips(s) {
    const f = s.facets;
    const parts = [];
    s.runs.forEach(r => { parts.push(`<span class="chip" title="${esc(r.tool + (r.version ? ' ' + r.version : '') + ' · ' + r.ruleCount + ' rules')}">${esc(r.tool)}${r.version ? ' ' + esc(String(r.version).slice(0, 20)) : ''}: ${fmt(r.results)}</span>`); });
    if (parts.length > 6) parts.splice(6, parts.length - 6, `<span class="chip dim">+${s.runs.length - 6} runs</span>`);
    parts.push(`<span class="chip dim">${pl(f.rules, 'rule', 'rules')} · ${pl(f.files, 'file', 'files')}</span>`);
    if (f.supp[1] + f.supp[2] + f.supp[3]) parts.push(`<span class="chip dim" title="Suppressed results (accepted, under review, rejected)">${fmt(f.supp[1])} suppressed</span>`);
    if (f.flows) parts.push(`<span class="chip dim">${fmt(f.flows)} with code flows</span>`);
    els.chips.innerHTML = parts.join('');
    LV.forEach((l, k) => { els.lv[k].textContent = `${LVL[k]} ${fmt(f.level[k])}`; });
    const cmpMode = !!s.compare;
    const names = cmpMode ? ['new', 'unchanged', 'updated', 'fixed', ''] : ['new', 'unchanged', 'updated', 'absent', ''];
    const opts = [['all', 'All']];
    names.forEach((n, k) => { if (n && (f.base[k] || (cmpMode && k !== 2))) opts.push([k === 3 ? 'absent' : n, `${n[0].toUpperCase() + n.slice(1)} (${fmt(f.base[k])})`]); });
    if (!cmpMode && f.base[4] && f.base[4] !== f.total) opts.push(['none', `No state (${fmt(f.base[4])})`]);
    els.base.set(opts);
    els.base.wrap.style.display = opts.length > 1 ? '' : 'none';
    if (!opts.some(o => o[0] === filter.base)) filter.base = 'all';
    const supN = f.supp[1] + f.supp[2] + f.supp[3];
    els.supp.wrap.style.display = supN ? '' : 'none';
    els.tool.set([[-1, 'All tools']].concat(s.tools.map((t, k) => [k, `${t} (${fmt(f.tool[k])})`])));
    els.tool.wrap.style.display = s.tools.length > 1 ? '' : 'none';
    syncControls();
  }

  function syncControls() {
    els.search.value = filter.text || '';
    els.lv.forEach((b, k) => { b.classList.toggle('off', !filter.levels[k]); b.setAttribute('aria-pressed', filter.levels[k] ? 'true' : 'false'); });
    els.base.s.value = filter.base; els.supp.s.value = filter.supp; els.tool.s.value = String(filter.tool); els.group.s.value = filter.group; els.sort.s.value = filter.sort;
    els.collapse.textContent = filter.collapsedAll && !(filter.collapsed || []).length ? 'Expand all' : 'Collapse all';
    els.collapse.style.display = filter.group === 'none' ? 'none' : '';
  }

  function banners(s) {
    const msgs = [].concat(s.warnings || []);
    s.runs.forEach(r => { if (r.failed) msgs.push(`${r.tool} reported that its run did not finish${r.notes.length ? ': ' + r.notes[0] : '.'}`); else if (r.notes.length) msgs.push(`${r.tool}: ${r.notes[0]}`); });
    els.banner.innerHTML = msgs.slice(0, 4).map(m => `<span>${esc(m)}</span>`).join('<span class="sep"></span>');
    els.banner.classList.toggle('hidden', !msgs.length);
    if (s.compare) {
      const c = s.compare;
      els.cmpBanner.innerHTML = `<span>Comparing <b>${esc(c.newName)}</b> with the older <b>${esc(c.baseName)}</b>:</span> <span class="chip">${fmt(c.new)} new</span><span class="chip dim">${fmt(c.unchanged)} unchanged</span><span class="chip dim">${fmt(c.fixed)} fixed</span>`;
      const end = button('End compare', 'Show only this log again', () => send({ type: 'endCompare' })); end.id = 'btn-endcompare';
      els.cmpBanner.appendChild(end);
      els.cmpBanner.classList.remove('hidden');
    } else els.cmpBanner.classList.add('hidden');
  }

  function emptyScreen(s) {
    els = {};
    const failed = s.runs.filter(r => r.failed);
    const runs = s.runs.map(r => `<li>${esc(r.tool)}${r.version ? ' ' + esc(r.version) : ''}: ${r.failed ? 'the tool reported that the run did not finish' : `0 results${r.ruleCount ? ` from ${fmt(r.ruleCount)} rules` : ''}`}</li>`).join('');
    const supN = s.facets.supp[1];
    const c = screen(failed.length
      ? `<div class="errmark">!</div><div class="big">No results, but ${failed.length === s.runs.length ? 'the run' : 'a run'} did not finish</div><p>${esc((failed[0].notes || [])[0] || 'Check the tool output: a log from an unfinished run can miss problems.')}</p><ul>${runs}</ul>`
      : `<div class="okmark">✓</div><div class="big">No results: the analysis ran and found nothing</div><ul>${runs || '<li>The log has no runs.</li>'}</ul><p>${s.runs.length ? 'This log is complete and has 0 results.' : ''}</p>`);
    c.id = 'empty-ok';
    if (s.warnings && s.warnings.length) { const p = h('p'); p.textContent = s.warnings.join(' '); c.appendChild(p); }
    if (supN) { const p = h('p'); p.textContent = `${supN} suppressed results are hidden.`; c.appendChild(p); }
    const b = button('Open as JSON', 'Open the log as JSON text', () => send({ type: 'openJson' })); c.appendChild(b);
  }

  // ---------- querying ----------
  function requery(keepSel) {
    syncControls();
    seq++; cache = new Map(); pending.clear();
    if (!keepSel) { sel = -1; }
    send({ type: 'query', filter, start: 0, size: WIN, seq, refreshProblems: problems.on });
  }

  function onView(m) {
    if (m.seq !== seq) return;
    view = { length: m.length, count: m.count, groups: m.groups };
    for (const r of m.rows) cache.set(r.p, r);
    els.spacer.style.height = Math.min(MAXH, view.length * RH) + 'px';
    if (sel >= view.length) sel = -1;
    // keep the selected result selected when it is still in the view
    if (selI >= 0) { sel = -1; for (const r of m.rows) if (r.i === selI) { sel = r.p; break; } }
    els.status.textContent = statusText();
    if (!view.count) {
      els.nomatch.innerHTML = '';
      const f = summary.facets;
      const allSupp = filter.supp === 'hide' && f.supp[1] > 0 && f.supp[1] === f.total;
      els.nomatch.textContent = allSupp ? `All ${fmt(f.total)} results in this log are suppressed (for example nosemgrep or eslint-disable comments), so they are hidden. ` : 'No results match these filters. ';
      const b = allSupp
        ? button('Show suppressed', 'Show suppressed results, marked as suppressed', () => { filter.supp = 'show'; requery(); })
        : button('Clear filters', 'Show every result', () => { filter.levels = [1, 1, 1, 1]; filter.base = 'all'; filter.supp = 'show'; filter.tool = -1; filter.text = ''; requery(); });
      b.id = allSupp ? 'btn-show-supp' : 'btn-clear';
      els.nomatch.appendChild(b);
      if (!els.nomatch.parentNode) els.list.appendChild(els.nomatch);
    } else if (els.nomatch.parentNode) els.nomatch.remove();
    render();
  }

  function statusText() {
    const total = summary.facets.total;
    let s = `${fmt(view.count)} of ${pl(total, 'result', 'results')}`;
    if (view.groups) s += ' · ' + (filter.group === 'rule' ? pl(view.groups, 'rule', 'rules') : filter.group === 'file' ? pl(view.groups, 'file', 'files') : pl(view.groups, 'group', 'groups'));
    if (problems.on) s += ` · ${fmt(problems.count)} in Problems`;
    return s;
  }

  function geometry() {
    const viewH = els.list.clientHeight;
    const n = view.length;
    const fullH = n * RH;
    const visible = Math.ceil(viewH / RH) + 1;
    if (fullH <= MAXH) {
      const first = Math.floor(els.list.scrollTop / RH);
      return { first, offset: -(els.list.scrollTop - first * RH), visible, viewH, scaled: false };
    }
    const maxFirst = Math.max(0, n - Math.floor(viewH / RH));
    const ratio = els.list.scrollTop / Math.max(1, MAXH - viewH);
    return { first: Math.min(maxFirst, Math.round(ratio * maxFirst)), offset: 0, visible, viewH, scaled: true };
  }

  function render() {
    if (!els.vp) return;
    const g = geometry();
    els.vp.style.height = g.viewH + 'px';
    const frag = document.createDocumentFragment();
    let missing = -1;
    for (let k = 0; k < g.visible; k++) {
      const p = g.first + k;
      if (p >= view.length) break;
      const r = cache.get(p);
      const row = h('div', 'row');
      row.style.top = (k * RH + g.offset) + 'px';
      row.dataset.p = p;
      if (!r) { row.classList.add('loading'); row.innerHTML = '<span class="msg">…</span>'; if (missing < 0) missing = p; }
      else if (r.g) {
        row.classList.add('grp');
        row.innerHTML = `<span class="tw">${r.collapsed ? '▸' : '▾'}</span><span class="lvl l${r.worst}">${LVC[r.worst]}</span><span class="glabel">${esc(r.label)}</span><span class="sub">${esc(r.sub || '')}</span><span class="n chip">${fmt(r.count)}</span>`;
        row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', r.collapsed ? 'false' : 'true');
        row.title = r.label + (r.sub ? ' · ' + r.sub : '');
      } else {
        row.classList.add('res'); if (filter.group !== 'none') row.classList.add('ind');
        const tags = [];
        if (r.base) tags.push(`<span class="tag ${esc(r.base)}">${esc(r.base)}</span>`);
        if (r.supp) tags.push(`<span class="tag supp">${r.supp === 1 ? 'suppressed' : r.supp === 2 ? 'review' : 'rejected'}</span>`);
        if (r.flows) tags.push('<span class="tag" title="Has a code flow">flow</span>');
        const where = r.file ? `${r.file}${r.line ? ':' + r.line : ''}` : '';
        row.innerHTML = `<span class="lvl l${r.level}" title="${LV[r.level]}">${LVC[r.level]}</span>`
          + `<span class="msg">${esc(r.msg || '(no message)')}</span>`
          + tags.join('')
          + (filter.group !== 'rule' ? `<span class="rule">${esc(r.rule)}</span>` : '')
          + (summary.tools.length > 1 && filter.group !== 'tool' ? `<span class="rule">${esc(r.tool)}</span>` : '')
          + (filter.group !== 'file' || !where ? `<span class="file" title="${esc(where)}"><bdi>${esc(where)}</bdi></span>` : (r.line ? `<span class="file">:${r.line}</span>` : ''));
        row.setAttribute('role', 'option');
        row.title = `${LV[r.level]} · ${r.rule}\n${r.msg}\n${where}`;
      }
      if (p === sel) { row.classList.add('sel'); row.setAttribute('aria-selected', 'true'); }
      frag.appendChild(row);
    }
    els.vp.replaceChildren(frag);
    if (missing >= 0) fetchWindow(missing);
  }

  function fetchWindow(p) {
    const start = Math.max(0, Math.floor(p / WIN) * WIN);
    if (pending.has(start)) return;
    pending.add(start);
    send({ type: 'window', start, size: WIN, seq });
    // the next window too, for smooth scrolling
    if (start + WIN < view.length && !pending.has(start + WIN) && !cache.has(start + WIN)) { pending.add(start + WIN); send({ type: 'window', start: start + WIN, size: WIN, seq }); }
  }

  function onRows(m) {
    if (m.seq !== seq) return;
    pending.delete(m.start);
    for (const r of m.rows) cache.set(r.p, r);
    if (cache.size > 20000) { const keep = new Map(); const g = geometry(); for (const [p, r] of cache) if (Math.abs(p - g.first) < 2000) keep.set(p, r); cache = keep; }
    render();
  }

  // ---------- selection ----------
  function onListMouse(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const p = Number(row.dataset.p);
    const r = cache.get(p);
    if (!r) return;
    if (r.g) { toggleGroup(r); return; }
    select(p, true);
  }

  function toggleGroup(r) {
    filter.collapsed = filter.collapsed || [];
    const key = filter.collapsedAll ? '!' + r.key : r.key;
    const k = filter.collapsed.indexOf(key);
    if (k >= 0) filter.collapsed.splice(k, 1); else filter.collapsed.push(key);
    requery(true);
  }

  function select(p, open) {
    sel = p;
    const r = cache.get(p);
    if (r && !r.g) {
      selI = r.i;
      detailSeq++;
      send({ type: 'detail', i: r.i, seq: detailSeq });
      if (open) { refocusList = Date.now(); send({ type: 'open', i: r.i, which: 'primary', preserveFocus: true }); }
    }
    ensureVisible(p);
    render();
  }

  function ensureVisible(p) {
    const g = geometry();
    if (g.scaled) {
      if (p < g.first || p >= g.first + g.visible - 1) { const maxFirst = Math.max(1, view.length - Math.floor(g.viewH / RH)); els.list.scrollTop = Math.min(1, Math.max(0, p - 2) / maxFirst) * (MAXH - g.viewH); }
      return;
    }
    const top = p * RH, bottom = top + RH;
    if (top < els.list.scrollTop) els.list.scrollTop = top;
    else if (bottom > els.list.scrollTop + g.viewH) els.list.scrollTop = bottom - g.viewH;
  }

  function onListKey(e) {
    if (!view.length) return;
    const g = geometry();
    const page = Math.max(1, Math.floor(g.viewH / RH) - 1);
    let p = sel < 0 ? -1 : sel;
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, j: 1, k: -1 };
    if (e.key in moves) { p = Math.max(0, Math.min(view.length - 1, p + moves[e.key])); }
    else if (e.key === 'Home') p = 0;
    else if (e.key === 'End') p = view.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      const r = cache.get(sel);
      if (r && r.g) toggleGroup(r); else if (r) send({ type: 'open', i: r.i, which: 'primary', preserveFocus: e.key === ' ' });
      e.preventDefault(); return;
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const r = cache.get(sel); if (r && r.g && (r.collapsed === (e.key === 'ArrowRight'))) toggleGroup(r); e.preventDefault(); return;
    } else return;
    e.preventDefault();
    sel = p; ensureVisible(p);
    const r = cache.get(p);
    if (r && !r.g) { selI = r.i; detailSeq++; send({ type: 'detail', i: r.i, seq: detailSeq }); }
    render();
  }

  // ---------- details ----------
  function locText(l) {
    if (!l) return '';
    if (!l.path) return l.logical || '(no file)';
    return l.path + (l.line ? `:${l.line}` + (l.col > 1 ? `:${l.col}` : '') : '');
  }

  function showDetail(d) {
    detail = d; flowPos = null;
    const el = els.details;
    el.classList.remove('empty');
    if (!d) { el.textContent = 'This result is not in the log any more.'; return; }
    const rule = d.rule;
    const parts = [];
    parts.push(`<h2><span class="lvl l${LV.indexOf(d.level)}">${LVC[LV.indexOf(d.level)]}</span><span id="d-rule">${esc(d.ruleId)}</span></h2>`);
    if (rule && (rule.name || rule.short)) parts.push(`<div class="rname">${esc([rule.name && rule.name !== d.ruleId ? rule.name : '', rule.short].filter(Boolean).join(': '))}</div>`);
    const msgHtml = d.messageMarkdown ? MD.render(d.messageMarkdown, { locLinks: true }) : MD.inline(d.message, { locLinks: true }).replace(/\n/g, '<br>');
    parts.push(`<div class="message md" id="d-message">${msgHtml}</div>`);
    // location
    const L = d.location;
    parts.push('<h3>Location</h3>');
    if (L && (L.path || L.logical)) {
      parts.push(`<div class="loc"><a data-open="primary" tabindex="0" id="d-open" title="${esc(L.uri || L.logical)}">${esc(locText(L))}</a></div>`);
      if (L.logical && L.path) parts.push(`<div class="note">${esc(L.logical)}</div>`);
      if (d.resolved) {
        if (d.resolved.reason) parts.push(`<div class="note warn" id="d-resolve">${esc(d.resolved.reason)}</div>`);
        else if (d.resolved.outside) parts.push(`<div class="note warn" id="d-resolve">Outside the workspace: ${esc(d.resolved.path)}. VS Code asks before it opens it.</div>`);
        else if (d.resolved.path !== L.path) parts.push(`<div class="note" id="d-resolve">Opens ${esc(d.resolved.path)}${d.resolved.why === 'workspace match' || d.resolved.why === 'path map' ? ' (path mapped)' : ''}</div>`);
      }
      if (L.snippet) parts.push(`<pre class="snip">${esc(L.snippet)}</pre>`);
    } else parts.push('<div class="note">This result has no location.</div>');
    // suppression and baseline
    const kv = [];
    kv.push(['Level', d.level + (d.kind !== 'fail' ? ` (kind: ${d.kind})` : '')]);
    kv.push(['Tool', d.tool + (d.toolVersion ? ' ' + d.toolVersion : '')]);
    if (d.baseline) kv.push(['Baseline', d.baseline]);
    if (d.rank !== null) kv.push(['Rank', String(d.rank)]);
    if (d.occurrence !== null) kv.push(['Occurrences', String(d.occurrence)]);
    if (summary && summary.sources && summary.sources.length > 1) kv.push(['Log', d.source]);
    if (rule && rule.securitySeverity) kv.push(['Security severity', rule.securitySeverity]);
    if (rule && rule.precision) kv.push(['Precision', rule.precision]);
    parts.push('<div class="kv">' + kv.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('') + '</div>');
    if (d.suppressions.length) {
      parts.push('<h3>Suppressed</h3>');
      parts.push(d.suppressions.map(s => `<div class="kv" id="d-supp"><span class="k">Kind</span><span class="v">${esc(s.kind || '-')}</span><span class="k">Status</span><span class="v">${esc(s.status)}</span>${s.justification ? `<span class="k">Justification</span><span class="v">${esc(s.justification)}</span>` : ''}</div>`).join(''));
    }
    // code flows
    if (d.flows.length) {
      parts.push('<h3>Code flow</h3>');
      parts.push(`<div class="flowbar"><button id="flow-prev" title="Previous step (Alt+Up)">◀ Previous</button><button id="flow-next" title="Next step (Alt+Down)">Next ▶</button><span class="note" id="flow-pos"></span></div>`);
      d.flows.forEach((f, fi) => {
        if (f.message) parts.push(`<div class="note">${esc(f.message)}</div>`);
        f.threads.forEach((t, ti) => {
          if (d.flows.length > 1 || f.threads.length > 1) parts.push(`<div class="note">Path ${fi + 1}${f.threads.length > 1 ? '.' + (ti + 1) : ''}${t.message ? ': ' + esc(t.message) : ''} (${t.steps.length} steps)</div>`);
          parts.push('<ol class="steps">' + t.steps.map((s, si) => `<li data-step="${fi},${ti},${si}" tabindex="0" title="${esc(s.uri || '')}"><span class="no">${si + 1}</span><span><span class="at">${esc(locText(s))}</span>${s.message ? ' · ' + esc(s.message) : ''}${s.kinds.length ? ` <span class="tag">${esc(s.kinds.join(', '))}</span>` : ''}</span></li>`).join('') + '</ol>');
        });
      });
    }
    if (d.related.length) {
      parts.push(`<h3>Related locations (${d.related.length})</h3><ol class="steps">` + d.related.map((r, k) => `<li data-related="${k}" tabindex="0" title="${esc(r.uri || '')}"><span class="no">${r.id >= 0 ? r.id : k + 1}</span><span><span class="at">${esc(locText(r))}</span>${r.message ? ' · ' + esc(r.message) : ''}</span></li>`).join('') + '</ol>');
    }
    if (d.locations.length) {
      parts.push(`<h3>More locations (${d.locations.length})</h3><ol class="steps">` + d.locations.map((r, k) => `<li data-locations="${k}" tabindex="0"><span class="no">${k + 2}</span><span class="at">${esc(locText(r))}</span></li>`).join('') + '</ol>');
    }
    // rule
    if (rule) {
      parts.push('<h3>Rule</h3>');
      if (rule.full && rule.full !== rule.short) parts.push(`<div class="md">${MD.render(rule.full)}</div>`);
      const meta = [];
      if (rule.helpUri) {
        const safe = MD.safeUrl(rule.helpUri);
        meta.push(['Help', safe ? `<a class="ext-link" data-href="${esc(safe)}" title="${esc(safe)}" tabindex="0" id="d-helpuri">${esc(safe)}</a>` : `<span title="Not a web link, so it is not clickable">${esc(rule.helpUri)}</span>`]);
      }
      if (rule.cwe.length) meta.push(['CWE', rule.cwe.map(c => `<a class="ext-link" data-href="https://cwe.mitre.org/data/definitions/${esc(c)}.html" tabindex="0">CWE-${esc(c)}</a>`).join(', ')]);
      if (rule.defaultLevel) meta.push(['Default level', esc(rule.defaultLevel)]);
      if (rule.problemSeverity) meta.push(['Severity', esc(rule.problemSeverity)]);
      if (rule.tags.length) meta.push(['Tags', `<span class="tags">${rule.tags.map(t => `<span class="chip dim">${esc(t)}</span>`).join('')}</span>`]);
      if (meta.length) parts.push('<div class="kv">' + meta.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${v}</span>`).join('') + '</div>');
      const help = rule.helpMarkdown ? MD.render(rule.helpMarkdown) : rule.helpText ? `<div class="message">${esc(rule.helpText)}</div>` : '';
      if (help) parts.push(`<h3>Help</h3><div class="md" id="d-help">${help}</div>`);
    }
    const fps = Object.entries(d.fingerprints || {});
    if (fps.length) parts.push('<h3>Fingerprints</h3><div class="kv">' + fps.slice(0, 10).map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(String(v).slice(0, 200))}</span>`).join('') + '</div>');
    parts.push('<div class="btnrow"><button id="d-copy" title="Copy the rule, message and location">Copy</button></div>');
    el.innerHTML = parts.join('\n');
    el.scrollTop = 0;
    const prev = el.querySelector('#flow-prev'), next = el.querySelector('#flow-next');
    if (prev) { prev.addEventListener('click', () => stepFlow(-1)); next.addEventListener('click', () => stepFlow(1)); updateFlowPos(); }
    el.querySelector('#d-copy').addEventListener('click', () => send({ type: 'copy', text: `${d.ruleId} (${d.level})\n${d.message}\n${locText(d.location)}` }));
  }

  function allSteps() {
    const out = [];
    if (!detail) return out;
    detail.flows.forEach((f, fi) => f.threads.forEach((t, ti) => t.steps.forEach((s, si) => out.push([fi, ti, si]))));
    return out;
  }
  function stepFlow(dir) {
    const steps = allSteps();
    if (!steps.length) return;
    let k = flowPos ? steps.findIndex(s => s.join() === flowPos.join()) : -1;
    k = k < 0 ? (dir > 0 ? 0 : steps.length - 1) : Math.max(0, Math.min(steps.length - 1, k + dir));
    gotoStep(steps[k]);
  }
  function gotoStep(st) {
    flowPos = st;
    send({ type: 'open', i: detail.i, which: 'flow', idx: st, preserveFocus: true });
    updateFlowPos();
  }
  function updateFlowPos() {
    const steps = allSteps();
    const k = flowPos ? steps.findIndex(s => s.join() === flowPos.join()) : -1;
    els.details.querySelectorAll('li[data-step]').forEach(li => li.classList.toggle('cur', flowPos && li.dataset.step === flowPos.join()));
    const pos = els.details.querySelector('#flow-pos');
    if (pos) pos.textContent = k >= 0 ? `Step ${k + 1} of ${steps.length}` : `${steps.length} steps`;
    const cur = els.details.querySelector('li.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function onDetailsClick(e) {
    const t = e.target.closest('[data-href],[data-open],[data-step],[data-related],[data-locations],[data-loc]');
    if (!t || !detail) return;
    e.preventDefault();
    if (t.dataset.href) { send({ type: 'openExternal', url: t.dataset.href }); return; }
    if (t.dataset.open) { send({ type: 'open', i: detail.i, which: 'primary' }); return; }
    if (t.dataset.step) { gotoStep(t.dataset.step.split(',').map(Number)); return; }
    if (t.dataset.related) { send({ type: 'open', i: detail.i, which: 'related', idx: Number(t.dataset.related), preserveFocus: true }); return; }
    if (t.dataset.locations) { send({ type: 'open', i: detail.i, which: 'locations', idx: Number(t.dataset.locations), preserveFocus: true }); return; }
    if (t.dataset.loc) { const id = Number(t.dataset.loc); const k = detail.related.findIndex(r => r.id === id); if (k >= 0) send({ type: 'open', i: detail.i, which: 'related', idx: k, preserveFocus: true }); }
  }

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && detail && detail.flows.length) { e.preventDefault(); stepFlow(e.key === 'ArrowDown' ? 1 : -1); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && els.search && !e.shiftKey) { /* the webview find widget handles Cmd+F */ }
  });

  // ---------- messages ----------
  window.addEventListener('message', ev => {
    const m = ev.data || {};
    switch (m.type) {
      case 'progress': if (!summary || m.stage === 'start' && !els.list) progress(m); else els.status && (els.status.textContent = `Reading ${m.name} (${mb(m.size)})…`); break;
      case 'loaded': problems.on = !!m.problems; applySummary(m.summary, m.filter, m.defaults); vscode.setState({ loaded: true }); break;
      case 'summary': filter && (filter.base = 'all'); applySummary(m.summary, null, null); break;
      case 'summaryError': if (els.status) els.status.textContent = statusText(); break;
      case 'view': onView(m); break;
      case 'rows': onRows(m); break;
      case 'detail': if (m.seq === detailSeq) showDetail(m.detail); break;
      case 'opened':
        // opening a file beside the table can create an editor group; the relayout drops the focus inside this frame
        if (refocusList && Date.now() - refocusList < 5000 && els.list) { refocusList = 0; setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) els.list.focus({ preventScroll: true }); }, 50); }
        break;
      case 'problems': {
        problems = m;
        if (els.btnProblems) { els.btnProblems.classList.toggle('on', !!m.on); els.btnProblems.textContent = m.on ? `In Problems: ${fmt(m.count)}` : 'Show in Problems'; els.btnProblems.setAttribute('aria-pressed', m.on ? 'true' : 'false'); }
        if (m.on) {
          const extra = [];
          if (m.total > m.limit) extra.push(`the first ${fmt(m.limit)} of ${fmt(m.total)} (sarifViewer.problemsLimit)`);
          if (m.missing) extra.push(`${fmt(m.missing)} files not found`);
          if (m.outside) extra.push(`${fmt(m.outside)} files outside the workspace left out`);
          toast(`${fmt(m.count)} results added to the Problems panel${extra.length ? ' · ' + extra.join(' · ') : ''}`);
        }
        if (els.status) els.status.textContent = statusText();
        break;
      }
      case 'toggleProblems': send({ type: 'problems', on: !problems.on }); break;
      case 'toast': toast(m.text); break;
      case 'tooLarge': {
        const c = screen(`<div class="errmark">!</div><div class="big">${esc(NAME)} is ${esc(mb(m.size))}</div><p>${m.hard ? `Logs over ${m.limitMB} MB cannot be opened here: the JSON is longer than the longest string VS Code's JavaScript engine can hold. Split the log by run (Sarif.Multitool) or filter it with jq.` : `That is more than the sarifViewer.maxFileMB setting (${m.limitMB} MB). It is parsed in a background thread, so VS Code stays responsive, but it needs about 5 to 8 times the file size in memory.`}</p>`);
        c.id = 'too-large';
        if (!m.hard) { const b = button('Open anyway', 'Parse this log now', () => { send({ type: 'loadAnyway' }); }); b.className = 'primary'; b.id = 'btn-anyway'; c.appendChild(b); }
        c.appendChild(button('Open as JSON', 'Open the log as JSON text', () => send({ type: 'openJson' })));
        break;
      }
      case 'error': {
        els = {};
        const c = screen(`<div class="errmark">!</div><div class="big">This log cannot be shown</div><p id="err-text"></p>`);
        c.id = 'load-error';
        c.querySelector('#err-text').textContent = m.text;
        c.appendChild(button('Open as JSON', 'Open the file as text', () => send({ type: 'openJson' })));
        break;
      }
    }
  });

  progress({ stage: 'start', name: NAME, size: 0 });
  send({ type: 'ready' });
})();
