// Small Markdown renderer for SARIF rule help and messages. Every character of the input is escaped first;
// only the tags built here are produced (h3-h6, p, ul, ol, li, pre, code, strong, em, a, br, table parts, hr, blockquote).
// Links never get an href: they get data-href (http and https only) and the viewer asks the extension to open them
// on click. Images are shown as their alt text. Raw HTML in the input shows as text.
// Works in Node (module.exports) and in the webview (window.SarifMarkdown).
(function (root) {
  'use strict';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const MAX = 100000;

  function safeUrl(u) {
    const s = String(u || '').trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return '';
    return s;
  }

  function inline(text, opts) {
    // code spans first, kept out of other rules
    const codes = [];
    let t = text.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0002'; });
    t = esc(t);
    // images: alt text only
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt) => alt ? '[image: ' + alt + ']' : '');
    // links [text](url) and [text](3) (SARIF related location ids)
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
      if (/^\d+$/.test(url) && opts && opts.locLinks) return '<a class="loc-link" data-loc="' + url + '" tabindex="0">' + label + '</a>';
      const raw = url.replace(/&amp;/g, '&');
      const ok = safeUrl(raw);
      return ok ? '<a class="ext-link" data-href="' + esc(ok) + '" title="' + esc(ok) + '" tabindex="0">' + label + '</a>' : label;
    });
    // bare https links
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (m, pre, url) => {
      const raw = url.replace(/&amp;/g, '&');
      const ok = safeUrl(raw);
      return ok ? pre + '<a class="ext-link" data-href="' + esc(ok) + '" title="' + esc(ok) + '" tabindex="0">' + url + '</a>' : m;
    });
    t = t.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (m, a, b) => '<strong>' + (a || b) + '</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)|(^|[^_\w])_([^_\n]+)_(?!\w)/g, (m, p1, a, p2, b) => (p1 !== undefined ? p1 : p2) + '<em>' + (a || b) + '</em>');
    t = t.replace(/\u0001(\d+)\u0002/g, (m, n) => '<code>' + esc(codes[Number(n)]) + '</code>');
    return t;
  }

  function render(src, opts) {
    const text = String(src || '').slice(0, MAX).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => { if (para.length) { out.push('<p>' + inline(para.join('\n'), opts).replace(/\n/g, '<br>') + '</p>'); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        const close = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close.slice(0, 3))) { body.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { flush(); const lv = Math.min(6, h[1].length + 2); out.push('<h' + lv + '>' + inline(h[2], opts) + '</h' + lv + '>'); i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
        out.push('<blockquote>' + render(body.join('\n'), opts) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim(), opts));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push('<table><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      const li = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
          if (m) { items.push(m[3]); i++; continue; }
          if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++; continue; }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(x => '<li>' + inline(x, opts).replace(/\n/g, '<br>') + '</li>').join('') + '</' + tag + '>');
        continue;
      }
      if (/^( {4}|\t)/.test(line) && !para.length) {
        const body = [];
        while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || /^\s*$/.test(lines[i]))) { body.push(lines[i].replace(/^( {4}|\t)/, '')); i++; }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  }

  const api = { render, inline, escapeHtml: esc, safeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SarifMarkdown = api;
})(typeof self !== 'undefined' ? self : this);
