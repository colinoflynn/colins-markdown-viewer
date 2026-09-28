'use strict';
/* mdview — client. Vanilla JS, no build step. */

/* ============================================================ utils */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const SEPS = /[\\/]/;
const dirname = p => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i); };
const basename = p => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => s.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'section';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function joinPath(base, rel) {
  const sep = base.includes('\\') ? '\\' : '/';
  const parts = base.split(SEPS);
  for (const seg of rel.split(SEPS)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); }
    else parts.push(seg);
  }
  return parts.join(sep);
}
function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 14) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts * 1000).toLocaleDateString();
}
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const api = {
  async get(name, params = {}) {
    const u = new URL('/api/' + name, location.origin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u);
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  async post(name, body) {
    const r = await fetch('/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
};

/* ============================================================ state */
const DEFAULTS = {
  theme: 'system', fontSize: 16, width: 'normal', lineHeight: '1.6', font: 'sans',
  sidebar: true, outline: true, sidebarWidth: 280, follow: true, showAll: false,
  recentOpen: true, treeOpen: true, tableView: 'auto',
};
const settings = Object.assign({}, DEFAULTS, store.get('mdview.settings', {}));
const saveSettings = () => store.set('mdview.settings', settings);

const state = {
  roots: [], sep: '\\',
  groups: [], activeGroup: 0,
  docs: new Map(),   // path -> {content, mtime, size, error}
  dirs: new Map(),   // path -> {mtime, entries}
  dirEls: new Map(), // path -> {node, kids, depth}
  expanded: new Set(),
  recent: [],
  index: null, indexAt: 0,
  standalone: false,
  theme: 'light',
};
let seq = 0;
let drag = null;

const normPath = p => state.sep === '\\' ? p.replace(/\//g, '\\').toLowerCase() : p;
const samePath = (a, b) => normPath(a) === normPath(b);
function rootOf(path) {
  const n = normPath(path);
  return state.roots.find(r => { const rn = normPath(r.path).replace(/[\\/]+$/, ''); return n === rn || n.startsWith(rn + state.sep); });
}
function relToRoot(path) {
  const r = rootOf(path);
  if (!r) return path;
  const rel = path.slice(r.path.replace(/[\\/]+$/, '').length + 1);
  return state.roots.length > 1 ? r.name + state.sep + rel : rel;
}
function resolveRel(docPath, rel) {
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return rel;
  if (/^[\\/]/.test(rel)) { const r = rootOf(docPath); return r ? joinPath(r.path, rel) : rel; }
  return joinPath(dirname(docPath), rel);
}
const sessionKey = () => 'mdview.session.' + state.roots.map(r => r.path).join('|');

/* ============================================================ markdown */
function katexRender(tex, display) {
  if (!window.katex) return `<code>${escapeHtml(tex)}</code>`;
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' }); }
  catch (e) { return `<span class="katex-error">${escapeHtml(tex)}</span>`; }
}

function setupMarkdown() {
  const blockMath = {
    name: 'blockMath', level: 'block',
    start(src) { const m = src.match(/\$\$|\\\[/); return m ? m.index : undefined; },
    tokenizer(src) {
      const m = /^\$\$\s*([\s\S]+?)\s*\$\$[ \t]*(?:\n+|$)/.exec(src) || /^\\\[\s*([\s\S]+?)\s*\\\][ \t]*(?:\n+|$)/.exec(src);
      if (m) return { type: 'blockMath', raw: m[0], text: m[1] };
    },
    renderer(tok) { return katexRender(tok.text, true) + '\n'; },
  };
  const inlineMath = {
    name: 'inlineMath', level: 'inline',
    start(src) { const i = src.search(/\$|\\\(/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: true };
      m = /^\$((?:\\.|[^$\\\n])+?)\$(?![\d$])/.exec(src);
      if (m && !/^\s/.test(m[1]) && !/\s$/.test(m[1])) return { type: 'inlineMath', raw: m[0], text: m[1] };
      m = /^\\\(([\s\S]+?)\\\)/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
    },
    renderer(tok) { return katexRender(tok.text, !!tok.display); },
  };
  marked.use({ gfm: true, breaks: false, extensions: [blockMath, inlineMath] });
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/* LLMs often break a long table with blank lines; the rows after the gap have
   no header, so GFM renders them as paragraphs full of pipes. Re-attach rows
   that follow a table after only blank lines and have the same column count. */
function mergeOrphanTableRows(src) {
  if (!src.includes('|')) return src;
  const lines = src.split('\n');
  const out = [];
  const isRow = l => /^\s*\|/.test(l) && /\|\s*$/.test(l);
  const isSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const ncols = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;
  let i = 0, fence = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const cols = ncols(l);
      out.push(l, lines[i + 1]); i += 2;
      for (;;) {
        while (i < lines.length && isRow(lines[i])) out.push(lines[i++]);
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j > i && j < lines.length && isRow(lines[j]) && ncols(lines[j]) === cols && !(j + 1 < lines.length && isSep(lines[j + 1]))) { i = j; continue; }
        break;
      }
      continue;
    }
    out.push(l); i++;
  }
  return out.join('\n');
}

function renderMarkdown(content, docPath) {
  let fm = null, body = content;
  const fmm = FM_RE.exec(content);
  if (fmm) { fm = fmm[1]; body = content.slice(fmm[0].length); }
  body = mergeOrphanTableRows(body);
  let html;
  try { html = marked.parse(body); }
  catch (e) { html = `<pre class="pane-error">${escapeHtml(String(e))}</pre>`; }
  if (window.DOMPurify) html = DOMPurify.sanitize(html, { ADD_ATTR: ['align', 'width', 'height', 'target'] });
  const art = el('article', { class: 'markdown-body' });
  art.innerHTML = html;
  if (fm) art.prepend(el('details', { class: 'frontmatter' }, el('summary', {}, 'Front matter'), el('pre', {}, el('code', {}, fm))));
  postProcess(art, docPath);
  return art;
}

function postProcess(art, docPath) {
  // headings: stable ids + hover anchors
  const used = new Map();
  for (const hd of $$('h1,h2,h3,h4,h5,h6', art)) {
    let id = slug(hd.textContent);
    const n = used.get(id) || 0; used.set(id, n + 1);
    if (n) id += '-' + n;
    hd.id = id;
    hd.append(el('a', { class: 'anchor', href: '#' + id, 'aria-hidden': 'true' }, '#'));
  }
  // code blocks
  for (const code of $$('pre > code', art)) {
    const pre = code.parentElement;
    const m = /language-([\w+#.-]+)/.exec(code.className);
    const lang = m ? m[1].toLowerCase() : '';
    const text = code.textContent;
    if (lang === 'mermaid') {
      const box = el('div', { class: 'mermaid-block', dataset: { code: text } }, text);
      pre.replaceWith(box); continue;
    }
    if (lang === 'math' || lang === 'latex' || lang === 'tex') {
      const box = el('div', { class: 'math-block' }); box.innerHTML = katexRender(text, true);
      pre.replaceWith(box); continue;
    }
    if (window.hljs && lang && hljs.getLanguage(lang)) {
      try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { /* keep plain */ }
    }
    code.classList.add('hljs');
    const wrap = el('div', { class: 'codeblock' });
    const btn = el('button', { type: 'button', title: 'Copy code' }, 'Copy');
    btn.addEventListener('click', () => copyText(text, btn));
    pre.replaceWith(wrap);
    wrap.append(el('div', { class: 'codeblock-head' }, el('span', {}, lang || 'text'), btn), pre);
  }
  // task lists
  for (const inp of $$('li > input[type=checkbox]', art)) inp.parentElement.classList.add('task');
  // links
  for (const a of $$('a[href]', art)) {
    if (a.classList.contains('anchor')) continue;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; a.classList.add('md-link', 'external'); continue; }
    const [p, hash] = href.split('#');
    let target;
    try { target = resolveRel(docPath, decodeURIComponent(p)); } catch { target = resolveRel(docPath, p); }
    if (!p) { a.href = '#' + (hash || ''); continue; }
    if (/\.(md|markdown|mdown|mkd|mdx|txt|rst|log)$/i.test(target)) {
      a.classList.add('md-link'); a.dataset.md = target; if (hash) a.dataset.hash = hash; a.href = '#';
    } else {
      a.href = '/api/raw?path=' + encodeURIComponent(target); a.target = '_blank';
    }
  }
  // images
  for (const img of $$('img[src]', art)) {
    const src = img.getAttribute('src');
    if (/^([a-z][a-z0-9+.-]*:)/i.test(src)) continue;
    let p = src.split('?')[0];
    try { p = decodeURIComponent(p); } catch { /* keep */ }
    img.src = '/api/raw?path=' + encodeURIComponent(resolveRel(docPath, p));
    img.loading = 'lazy';
  }
  // GitHub-style alerts: > [!NOTE]
  for (const bq of $$('blockquote', art)) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P' || !p.firstChild || p.firstChild.nodeType !== 3) continue;
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.firstChild.nodeValue);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    p.firstChild.nodeValue = p.firstChild.nodeValue.slice(m[0].length);
    if (p.firstChild.nodeValue === '' && p.childNodes.length > 1 && p.childNodes[1].tagName === 'BR') p.childNodes[1].remove();
    if (!p.textContent.trim() && !p.children.length) p.remove();
    bq.classList.add('alert', 'alert-' + kind);
    bq.prepend(el('div', { class: 'alert-title' }, kind[0].toUpperCase() + kind.slice(1)));
  }
  enhanceTables(art, docPath);
}

/* ---- tables: Table / Cards / Rows views, collapse, wide, sort, filter */
function tablePrefs(docPath) { return (store.get('mdview.tables', {}) || {})[normPath(docPath)] || {}; }
function saveTablePref(docPath, ti, pref) {
  const all = store.get('mdview.tables', {}) || {};
  const k = normPath(docPath);
  all[k] = all[k] || {};
  all[k][ti] = Object.assign(all[k][ti] || {}, pref);
  store.set('mdview.tables', all);
}
function cloneCell(td) { const s = el('span', { class: 'cell-clone' }); for (const n of td.childNodes) s.append(n.cloneNode(true)); return s; }
function cellNum(s) { const t = s.replace(/[,\s%]/g, ''); return t !== '' && !isNaN(t) ? parseFloat(t) : null; }

function enhanceTables(art, docPath) {
  const prefs = tablePrefs(docPath);
  $$('table', art).forEach((table, ti) => {
    const ths = $$('thead th', table);
    const rows = $$('tbody tr', table).map((tr, i) => ({ tr, i, cells: $$('td', tr) }));
    if (!ths.length) return;
    const labels = ths.map(th => th.textContent.trim());
    const len = (r, c) => r.cells[c] ? r.cells[c].textContent.length : 0;
    const avg = labels.map((_, c) => rows.length ? rows.reduce((s, r) => s + len(r, c), 0) / rows.length : 0);
    const max = labels.map((_, c) => rows.reduce((m, r) => Math.max(m, len(r, c)), 0));
    const prose = avg.some(a => a > 160) || max.some(m => m > 600);
    let longCols = avg.map((a, c) => a > 80 || max[c] > 300);
    if (!longCols.some(Boolean) && rows.length) { const best = avg.indexOf(Math.max(...avg)); longCols = avg.map((_, c) => c === best); }
    const nLong = longCols.filter(Boolean).length;
    // in the table view, give long columns a width share so short ones stop hogging space
    if (prose) {
      const sum = avg.reduce((a, b) => a + b, 0) || 1;
      labels.forEach((_, c) => { if (longCols[c]) ths[c].style.width = Math.min(85, Math.max(45, Math.round(100 * avg[c] / sum))) + '%'; });
    }

    // column classes; long cells get an inner wrapper so they can be clamped
    labels.forEach((_, c) => {
      const cls = longCols[c] ? 'col-long' : (max[c] <= 40 ? 'col-short' : '');
      if (cls) ths[c].classList.add(cls);
      for (const r of rows) {
        const td = r.cells[c]; if (!td) continue;
        if (cls) td.classList.add(cls);
        if (longCols[c]) { const d = el('div', { class: 'cell' }); d.append(...Array.from(td.childNodes)); td.append(d); }
      }
    });
    for (const r of rows) r.text = r.cells.map(td => td.textContent).join(' ').toLowerCase();

    const wrap = el('div', { class: 'tbl' + (prose ? ' prose' : '') });
    const scroll = el('div', { class: 'tbl-scroll' });
    table.replaceWith(wrap);
    scroll.append(table);
    if (rows.length < 2 && !prose) { wrap.append(scroll); return; }
    const cardsEl = el('div', { class: 'tbl-cards', hidden: true });
    const stackEl = el('div', { class: 'tbl-stack', hidden: true });

    // toolbar
    const p = prefs[ti] || {};
    const count = el('span', { class: 'tbl-count' });
    const filter = el('input', { class: 'tbl-filter', type: 'search', placeholder: 'filter rows…', spellcheck: 'false' });
    const seg = el('div', { class: 'seg' });
    for (const [v, lab] of [['table', 'Table'], ['cards', 'Cards'], ['rows', 'Rows']]) {
      seg.append(el('button', { type: 'button', dataset: { v }, onclick: () => { setView(v); saveTablePref(docPath, ti, { view: v }); } }, lab));
    }
    const clampBtn = el('button', { type: 'button', class: 'tbl-tog', title: 'Show only the first lines of long cells; click a row to expand it' }, 'Collapse');
    clampBtn.addEventListener('click', () => { setClamp(!wrap.classList.contains('clamp')); saveTablePref(docPath, ti, { clamp: wrap.classList.contains('clamp') }); });
    const wideBtn = el('button', { type: 'button', class: 'tbl-tog', title: 'Use the full width of the pane' }, 'Wide');
    wideBtn.addEventListener('click', () => { wrap.classList.toggle('wide'); wideBtn.classList.toggle('on', wrap.classList.contains('wide')); saveTablePref(docPath, ti, { wide: wrap.classList.contains('wide') }); });
    const bar = el('div', { class: 'tbl-bar' }, seg, clampBtn, wideBtn, el('span', { class: 'spacer' }), rows.length >= 5 ? filter : null, count);
    wrap.append(bar, scroll, cardsEl, stackEl);

    // alternative views, built on first use
    function buildCard(r) {
      const meta = el('div', { class: 'tcard-meta' }, el('span', { class: 'tcard-n' }, r.i + 1));
      const body = el('div', { class: 'tcard-body' });
      labels.forEach((lab, c) => {
        const td = r.cells[c]; if (!td) return;
        if (longCols[c]) body.append(nLong > 1 ? el('div', { class: 'tcard-sec' }, el('div', { class: 'tcard-label' }, lab), cloneCell(td)) : cloneCell(td));
        else meta.append(el('span', { class: 'tcard-kv' }, el('b', {}, lab), cloneCell(td)));
      });
      return el('div', { class: 'tcard' }, meta, body);
    }
    function buildStack(r) {
      const d = el('div', { class: 'trow' }, el('div', { class: 'trow-n' }, r.i + 1));
      labels.forEach((lab, c) => { const td = r.cells[c]; if (!td) return; d.append(el('div', { class: 'trow-k' }, lab), el('div', { class: 'trow-v' }, cloneCell(td))); });
      return d;
    }
    function setView(v) {
      if (v === 'cards' && !cardsEl.childElementCount) for (const r of rows) { r.card = buildCard(r); cardsEl.append(r.card); }
      if (v === 'rows' && !stackEl.childElementCount) for (const r of rows) { r.stack = buildStack(r); stackEl.append(r.stack); }
      wrap.dataset.view = v;
      scroll.hidden = v !== 'table'; cardsEl.hidden = v !== 'cards'; stackEl.hidden = v !== 'rows';
      for (const b of seg.children) b.classList.toggle('on', b.dataset.v === v);
      applyFilter();
    }
    function setClamp(on) { wrap.classList.toggle('clamp', on); clampBtn.classList.toggle('on', on); }
    wrap.addEventListener('click', e => {
      if (!wrap.classList.contains('clamp') || e.target.closest('a, button, input, thead')) return;
      const row = e.target.closest('tr, .tcard, .trow');
      if (row && wrap.contains(row)) row.classList.toggle('expanded');
    });

    // filter
    function applyFilter() {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const hide = q !== '' && !r.text.includes(q);
        r.tr.hidden = hide; if (r.card) r.card.hidden = hide; if (r.stack) r.stack.hidden = hide;
        if (!hide) shown++;
      }
      count.textContent = q ? `${shown} of ${rows.length} rows` : `${rows.length} rows`;
    }
    filter.addEventListener('input', applyFilter);
    filter.addEventListener('keydown', e => { if (e.key === 'Escape') { filter.value = ''; applyFilter(); } });

    // sort by clicking a header: ascending, descending, original
    let sortCol = -1, sortDir = 0;
    ths.forEach((th, c) => {
      th.classList.add('sortable'); th.title = 'Click to sort';
      th.append(el('span', { class: 'sort-ind' }));
      th.addEventListener('click', () => {
        if (sortCol !== c) { sortCol = c; sortDir = 1; } else sortDir = sortDir === 1 ? -1 : sortDir === -1 ? 0 : 1;
        ths.forEach((t, k) => { t.querySelector('.sort-ind').textContent = k === sortCol && sortDir ? (sortDir > 0 ? '▲' : '▼') : ''; });
        const ordered = [...rows];
        if (sortDir) {
          ordered.sort((a, b) => {
            const ta = a.cells[c]?.textContent.trim() || '', tb = b.cells[c]?.textContent.trim() || '';
            const na = cellNum(ta), nb = cellNum(tb);
            const r = (na !== null && nb !== null) ? na - nb : ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' });
            return r * sortDir || a.i - b.i;
          });
        } else ordered.sort((a, b) => a.i - b.i);
        const tbody = table.tBodies[0];
        for (const r of ordered) { tbody.append(r.tr); if (r.card) cardsEl.append(r.card); if (r.stack) stackEl.append(r.stack); }
      });
    });

    const def = settings.tableView === 'auto' ? (prose ? 'cards' : 'table') : settings.tableView;
    setView(p.view || def);
    setClamp(!!p.clamp);
    if (p.wide) { wrap.classList.add('wide'); wideBtn.classList.add('on'); }
  });
}

async function renderMermaidIn(root, onDone) {
  if (!window.mermaid) return;
  const blocks = $$('.mermaid-block', root).filter(b => b.dataset.done !== state.theme);
  if (!blocks.length) return;
  for (const box of blocks) {
    const code = box.dataset.code;
    const id = 'mm' + (++seq);
    try {
      const { svg } = await mermaid.render(id, code);
      box.innerHTML = svg;
      box.classList.remove('mermaid-error');
    } catch (e) {
      box.textContent = code;
      box.classList.add('mermaid-error');
      document.getElementById('d' + id)?.remove();
      document.getElementById(id)?.remove();
    }
    box.dataset.done = state.theme;
  }
  if (onDone) onDone();
}

function renderRaw(content) {
  const pre = el('pre', { class: 'raw-source' });
  const lines = content.split('\n');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) frag.append(el('span', { class: 'ln' }, i + 1), lines[i] + '\n');
  pre.append(frag);
  return pre;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); if (btn) { btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy', 1200); } }
  catch { toast('Clipboard unavailable'); }
}

/* ============================================================ groups & tabs */
const groupsEl = $('#groups');

function createGroup() {
  const g = { id: ++seq, tabs: [], activeId: null };
  g.tabsEl = el('div', { class: 'tabs' });
  g.panesEl = el('div', { class: 'panes' });
  g.emptyEl = el('div', { class: 'pane-empty' }, el('div', { class: 'big' }, '≡'), el('div', {}, 'Click a file to preview it, double-click to keep it open'), el('div', {}, 'Ctrl+P searches every Markdown file'));
  g.panesEl.append(g.emptyEl);
  g.el = el('div', { class: 'group' }, g.tabsEl, g.panesEl);
  g.el.addEventListener('mousedown', () => setActiveGroup(state.groups.indexOf(g)), true);
  g.el.addEventListener('focusin', () => setActiveGroup(state.groups.indexOf(g)));
  // drag & drop targets
  g.tabsEl.addEventListener('dragover', e => onTabsDragOver(e, g));
  g.tabsEl.addEventListener('dragleave', () => clearDragMarks(g));
  g.tabsEl.addEventListener('drop', e => onTabsDrop(e, g));
  g.panesEl.addEventListener('dragover', e => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; g.panesEl.classList.add('drop-target'); });
  g.panesEl.addEventListener('dragleave', () => g.panesEl.classList.remove('drop-target'));
  g.panesEl.addEventListener('drop', e => { e.preventDefault(); g.panesEl.classList.remove('drop-target'); dropInto(g, g.tabs.length); });
  g.tabsEl.addEventListener('dblclick', e => { if (e.target === g.tabsEl) { setActiveGroup(state.groups.indexOf(g)); openQuick(); } });
  return g;
}
function addGroup(index = state.groups.length) {
  const g = createGroup();
  state.groups.splice(index, 0, g);
  layoutGroups();
  return g;
}
function removeGroup(g) {
  if (state.groups.length <= 1) return;
  const i = state.groups.indexOf(g);
  state.groups.splice(i, 1);
  g.el.remove();
  state.activeGroup = Math.min(state.activeGroup, state.groups.length - 1);
  layoutGroups();
  onActiveChanged();
}
function layoutGroups() {
  const kids = state.groups.map(g => g.el);
  if (kids.some((k, i) => groupsEl.children[i] !== k) || groupsEl.children.length !== kids.length) groupsEl.replaceChildren(...kids);
  state.groups.forEach((g, i) => g.el.classList.toggle('active-group', i === state.activeGroup && state.groups.length > 1));
  $('#tb-split').classList.toggle('on', state.groups.length > 1);
}
function setActiveGroup(i) {
  if (i < 0 || i === state.activeGroup) return;
  state.activeGroup = i;
  layoutGroups();
  onActiveChanged();
}
const activeGroup = () => state.groups[state.activeGroup];
const activeTab = () => { const g = activeGroup(); return g ? g.tabs.find(t => t.id === g.activeId) || null : null; };
const allTabs = () => state.groups.flatMap(g => g.tabs);
const isActiveTab = t => activeTab() === t;

function createTab(g, path, pinned) {
  const t = { id: ++seq, path, pinned, group: g, renderedKey: null, raw: false, scrollTop: 0, atBottom: false, missing: false, headings: [] };
  t.inner = el('div', { class: 'pane-inner w-' + settings.width });
  t.pane = el('div', { class: 'pane', tabindex: '0', hidden: true }, t.inner);
  t.pane.addEventListener('scroll', () => onPaneScroll(t), { passive: true });
  t.pane.addEventListener('click', e => onContentClick(e, t));
  g.panesEl.append(t.pane);
  return t;
}

function openFile(path, { pinned = false, side = false, group = null, activate = true, hash = null } = {}) {
  let g = group || activeGroup();
  if (side) {
    const i = state.groups.indexOf(g) + 1;
    g = i < state.groups.length ? state.groups[i] : addGroup();
  }
  let t = g.tabs.find(x => samePath(x.path, path));
  if (t) {
    if (pinned) t.pinned = true;
  } else {
    const prev = pinned ? null : g.tabs.find(x => !x.pinned);
    if (prev) {
      t = prev;
      t.path = path; t.renderedKey = null; t.raw = false; t.missing = false; t.scrollTop = 0; t.atBottom = false;
      t.inner.replaceChildren();
      t.pane.scrollTop = 0;
    } else {
      t = createTab(g, path, pinned);
      const ai = g.tabs.findIndex(x => x.id === g.activeId);
      g.tabs.splice(ai < 0 ? g.tabs.length : ai + 1, 0, t);
    }
  }
  if (activate) activateTab(t); else renderTabs(g);
  ensureDoc(path).then(() => { if (hash) scrollToHash(t, hash); });
  persistSession();
  updateTreeMarks();
  return t;
}

function activateTab(t) {
  const g = t.group;
  const gi = state.groups.indexOf(g);
  const old = g.tabs.find(x => x.id === g.activeId);
  if (old && old !== t) {
    old.scrollTop = old.pane.scrollTop; old.atBottom = isAtBottom(old.pane);
    old.pane.hidden = true;
  }
  g.activeId = t.id;
  g.emptyEl.hidden = true;
  if (t.pane.hidden) {
    t.pane.hidden = false;
    applyScroll(t.pane, t.scrollTop);
  }
  if (gi !== state.activeGroup) { state.activeGroup = gi; layoutGroups(); }
  renderTab(t);
  renderTabs(g);
  onActiveChanged();
  t.pane.focus({ preventScroll: true });
  const te = g.tabsEl.querySelector(`[data-id="${t.id}"]`);
  te?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function closeTab(t) {
  const g = t.group;
  const i = g.tabs.indexOf(t);
  if (i < 0) return;
  g.tabs.splice(i, 1);
  t.pane.remove();
  if (g.activeId === t.id) {
    g.activeId = null;
    const next = g.tabs[i] || g.tabs[i - 1];
    if (next) activateTab(next);
    else if (state.groups.length > 1) removeGroup(g);
    else { g.emptyEl.hidden = false; renderTabs(g); onActiveChanged(); }
  } else renderTabs(g);
  persistSession();
  updateTreeMarks();
}
function closeTabs(list) { for (const t of list) closeTab(t); }

function moveTab(t, g2, index) {
  const g1 = t.group;
  const i1 = g1.tabs.indexOf(t);
  g1.tabs.splice(i1, 1);
  if (g1 === g2 && index > i1) index--;
  if (g1 !== g2) {
    if (g1.activeId === t.id) { g1.activeId = null; const nx = g1.tabs[i1] || g1.tabs[i1 - 1]; if (nx) { t.pane.hidden = true; t.scrollTop = t.pane.scrollTop; activateTab(nx); } }
    g2.panesEl.append(t.pane);
    t.group = g2;
    const dup = g2.tabs.find(x => samePath(x.path, t.path));
    if (dup) { closeTab(dup); }
  }
  t.pinned = true;
  g2.tabs.splice(Math.min(index, g2.tabs.length), 0, t);
  if (g1 !== g2 && g1.tabs.length === 0) removeGroup(g1);
  activateTab(t);
  renderTabs(g1); renderTabs(g2);
  persistSession();
}

function renderTabs(g) {
  const frag = document.createDocumentFragment();
  for (const t of g.tabs) {
    const te = el('div', {
      class: 'tab' + (t.id === g.activeId ? ' active' : '') + (t.pinned ? '' : ' preview') + (t.missing ? ' missing' : ''),
      draggable: 'true', title: t.path, dataset: { id: t.id },
    }, el('span', { class: 'tab-name' }, basename(t.path)), el('span', { class: 'tab-close', title: 'Close (Alt+W)' }, '×'));
    te.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    te.addEventListener('click', e => { if (e.target.classList.contains('tab-close')) closeTab(t); else activateTab(t); });
    te.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    te.addEventListener('dblclick', () => { t.pinned = true; renderTabs(g); persistSession(); });
    te.addEventListener('contextmenu', e => { e.preventDefault(); showTabMenu(e, t); });
    te.addEventListener('dragstart', e => { drag = { tab: t }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.path); });
    te.addEventListener('dragend', () => { drag = null; state.groups.forEach(clearDragMarks); $$('.drop-target').forEach(x => x.classList.remove('drop-target')); });
    frag.append(te);
  }
  g.tabsEl.replaceChildren(frag);
  if (!g.tabs.length) g.tabsEl.append(el('div', { class: 'tabs-empty-hint' }, state.groups.length > 1 ? 'empty group' : ''));
}

/* ---- drag & drop */
function onTabsDragOver(e, g) {
  if (!drag) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  clearDragMarks(g);
  const te = e.target.closest('.tab');
  if (te) {
    const r = te.getBoundingClientRect();
    te.classList.add(e.clientX < r.left + r.width / 2 ? 'drag-over-left' : 'drag-over-right');
  }
}
function clearDragMarks(g) { $$('.tab', g.tabsEl).forEach(x => x.classList.remove('drag-over-left', 'drag-over-right')); }
function onTabsDrop(e, g) {
  if (!drag) return;
  e.preventDefault();
  const te = e.target.closest('.tab');
  let index = g.tabs.length;
  if (te) {
    const r = te.getBoundingClientRect();
    index = g.tabs.findIndex(x => String(x.id) === te.dataset.id);
    if (e.clientX >= r.left + r.width / 2) index++;
  }
  clearDragMarks(g);
  dropInto(g, index);
}
function dropInto(g, index) {
  if (!drag) return;
  if (drag.tab) moveTab(drag.tab, g, index);
  else if (drag.path) openFile(drag.path, { pinned: true, group: g });
  drag = null;
}

/* ============================================================ documents */
async function ensureDoc(path) {
  if (state.docs.has(path)) { for (const t of allTabs()) if (samePath(t.path, path)) renderTab(t); return; }
  await loadDoc(path);
}
async function loadDoc(path) {
  let d;
  try { d = await api.get('file', { path }); }
  catch (e) { d = { path, error: String(e.message || e), mtime: null, content: '' }; }
  const prev = state.docs.get(path);
  if (prev && prev.mtime === d.mtime && prev.content === d.content) return;
  state.docs.set(path, d);
  for (const t of allTabs()) if (samePath(t.path, path)) renderTab(t);
}

// "at bottom" once the end of the content is on screen (the pane has 50vh of bottom padding)
function isAtBottom(pane) { return pane.scrollHeight - pane.scrollTop - pane.clientHeight < pane.clientHeight * 0.5 + 48; }
function applyScroll(pane, top) { pane.scrollTop = top === Infinity ? pane.scrollHeight : top; }

function renderTab(t) {
  const d = state.docs.get(t.path);
  if (!d) { if (!t.inner.childElementCount) t.inner.replaceChildren(el('div', { class: 'pane-empty' }, 'Loading…')); return; }
  if (d.error && !d.content) {
    t.inner.replaceChildren(el('pre', { class: 'pane-error' }, 'Could not read file:\n' + t.path + '\n\n' + d.error));
    t.renderedKey = 'err';
    return;
  }
  const key = d.mtime + ':' + d.size + ':' + (t.raw ? 'raw' : 'md');
  if (t.renderedKey === key) return;
  const first = t.renderedKey === null;
  const pane = t.pane, visible = !pane.hidden;
  const prevTop = visible ? pane.scrollTop : t.scrollTop;
  const wasAtBottom = visible ? isAtBottom(pane) : t.atBottom;
  const node = t.raw ? renderRaw(d.content) : renderMarkdown(d.content, t.path);
  t.inner.replaceChildren(node);
  if (t.missing) t.inner.prepend(missingNotice());
  t.renderedKey = key;
  const target = (!first && settings.follow && wasAtBottom) ? Infinity : prevTop;
  if (visible) applyScroll(pane, target); else t.scrollTop = target;
  if (!t.raw) renderMermaidIn(node, () => { if (target === Infinity && !pane.hidden) applyScroll(pane, Infinity); if (isActiveTab(t)) updateOutline(); });
  if (isActiveTab(t)) { updateOutline(); updateStatus(); }
}
const missingNotice = () => el('div', { class: 'pane-notice' }, 'This file no longer exists on disk. Showing the last content that was read.');

function setMissing(path, missing) {
  for (const t of allTabs()) {
    if (!samePath(t.path, path) || t.missing === missing) continue;
    t.missing = missing;
    const n = t.inner.querySelector('.pane-notice');
    if (missing && !n) t.inner.prepend(missingNotice());
    if (!missing && n) n.remove();
    renderTabs(t.group);
  }
}

function toggleRaw(t) {
  if (!t) return;
  t.raw = !t.raw;
  t.pinned = true;
  renderTab(t); renderTabs(t.group);
  $('#tb-raw').classList.toggle('on', t.raw);
  persistSession();
}

function scrollToHash(t, hash) {
  let target = null;
  try { target = t.inner.querySelector('#' + CSS.escape(hash)); } catch { /* ignore */ }
  if (!target) target = t.inner.querySelector('#' + CSS.escape(slug(hash)));
  if (target) target.scrollIntoView({ block: 'start' });
}

function onContentClick(e, t) {
  const a = e.target.closest('a');
  if (!a || !t.inner.contains(a)) return;
  if (a.dataset.md) {
    e.preventDefault();
    openFile(a.dataset.md, { pinned: false, side: e.ctrlKey || e.metaKey, hash: a.dataset.hash || null });
    return;
  }
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) {
    e.preventDefault();
    let h = href.slice(1);
    try { h = decodeURIComponent(h); } catch { /* keep */ }
    scrollToHash(t, h);
  }
}

const persistScroll = debounce(persistSession, 600);
let scrollRaf = 0;
function onPaneScroll(t) {
  if (!isActiveTab(t)) return;
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateOutlineCurrent(t); });
  persistScroll();
}

/* ============================================================ session */
function persistSession() {
  if (state.standalone) return;
  store.set(sessionKey(), {
    groups: state.groups.map(g => ({
      tabs: g.tabs.map(t => ({ path: t.path, pinned: t.pinned, raw: t.raw, scrollTop: t.pane.hidden ? (t.scrollTop === Infinity ? 0 : t.scrollTop) : t.pane.scrollTop })),
      active: g.tabs.findIndex(t => t.id === g.activeId),
    })),
    activeGroup: state.activeGroup,
    expanded: [...state.expanded],
  });
}
function restoreSession(sess) {
  for (const sg of sess.groups || []) {
    if (!sg.tabs.length) continue;
    const g = addGroup();
    for (const st of sg.tabs) {
      const t = createTab(g, st.path, !!st.pinned);
      t.raw = !!st.raw; t.scrollTop = st.scrollTop || 0;
      g.tabs.push(t);
    }
    const at = g.tabs[sg.active] || g.tabs[0];
    g.activeId = at.id; at.pane.hidden = false; g.emptyEl.hidden = true;
    renderTabs(g);
  }
  state.activeGroup = Math.min(sess.activeGroup || 0, Math.max(0, state.groups.length - 1));
}

/* ============================================================ active-tab dependent UI */
function onActiveChanged() {
  const t = activeTab();
  document.title = t ? basename(t.path) + ' – mdview' : 'mdview';
  $('#tb-raw').classList.toggle('on', !!(t && t.raw));
  updateCrumbs(); updateOutline(); updateStatus(); updateTreeMarks();
  if (t) revealInTree(t.path, false);
  persistSession();
}

function updateCrumbs() {
  const c = $('#crumbs'); c.replaceChildren();
  const t = activeTab(); if (!t) return;
  const r = rootOf(t.path);
  const segs = relToRoot(t.path).split(SEPS);
  if (r && state.roots.length === 1) segs.unshift(r.name);
  let acc = r ? r.path : '';
  const isMulti = state.roots.length > 1;
  segs.forEach((s, i) => {
    if (i) c.append(el('span', { class: 'sep' }, '›'));
    const last = i === segs.length - 1;
    if (i > 0 || !r || isMulti) { if (!(isMulti && i === 0)) acc = joinPath(acc, s); }
    const p = acc;
    c.append(el('span', { class: last ? 'leaf' : '', onclick: () => revealInTree(p, true) }, s));
  });
}

function updateStatus() {
  const t = activeTab();
  const sp = $('#status-path'), si = $('#status-info');
  if (!t) { sp.textContent = state.roots.map(r => r.path).join('  ·  '); si.textContent = ''; return; }
  sp.textContent = t.path;
  const d = state.docs.get(t.path);
  if (!d || d.error) { si.textContent = ''; return; }
  const words = d.content.split(/\s+/).filter(Boolean).length;
  const lines = d.content.split('\n').length;
  si.textContent = `${words.toLocaleString()} words · ${lines.toLocaleString()} lines · ${fmtSize(d.size)} · modified ${timeAgo(d.mtime)}`;
}
setInterval(updateStatus, 15000);

/* ---- outline */
function updateOutline() {
  const list = $('#outline-list'); list.replaceChildren();
  const t = activeTab();
  if (!t || t.raw) { t && (t.headings = []); list.append(el('div', { class: 'ol-empty' }, t ? 'Raw view' : 'No file open')); return; }
  const hs = $$('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6', t.inner);
  t.headings = hs;
  if (!hs.length) { list.append(el('div', { class: 'ol-empty' }, 'No headings')); return; }
  const frag = document.createDocumentFragment();
  for (const hd of hs) {
    const text = hd.textContent.replace(/#$/, '').trim();
    const item = el('div', { class: 'ol-item', style: `--lvl: ${hd.tagName[1]}`, title: text }, text);
    item.addEventListener('click', () => hd.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    item._h = hd;
    frag.append(item);
  }
  list.append(frag);
  updateOutlineCurrent(t);
}
function updateOutlineCurrent(t) {
  if (!t.headings.length || document.body.classList.contains('no-outline')) return;
  const pr = t.pane.getBoundingClientRect();
  let cur = null;
  for (const hd of t.headings) { if (hd.getBoundingClientRect().top - pr.top <= 24) cur = hd; else break; }
  if (isAtBottom(t.pane) && t.pane.scrollHeight > t.pane.clientHeight) cur = t.headings[t.headings.length - 1];
  const list = $('#outline-list');
  for (const item of list.children) {
    const on = item._h === cur;
    if (on !== item.classList.contains('current')) { item.classList.toggle('current', on); if (on) item.scrollIntoView({ block: 'nearest' }); }
  }
}

/* ============================================================ sidebar: tree */
const treeEl = $('#tree');

function renderTree() {
  treeEl.replaceChildren();
  state.dirEls.clear();
  for (const r of state.roots) treeEl.append(dirNode(r.path, r.name, 0));
  updateTreeMarks();
}
function dirNode(path, name, depth) {
  const open = state.expanded.has(path);
  const node = el('div', { class: 'node dir' + (open ? ' open' : '') + (name.startsWith('.') ? ' hidden-dir' : ''), style: `--depth:${depth}`, title: path, dataset: { path, type: 'dir' } },
    el('span', { class: 'icon' }), el('span', { class: 'name' }, name));
  const kids = el('div', { class: 'children' + (open ? ' open' : '') });
  const rec = { node, kids, depth };
  state.dirEls.set(path, rec);
  node.addEventListener('click', () => toggleDir(path));
  node.addEventListener('contextmenu', e => { e.preventDefault(); showDirMenu(e, path); });
  if (open) fillChildren(path);
  const frag = document.createDocumentFragment();
  frag.append(node, kids);
  return frag;
}
function fileNode(entry, depth, sub) {
  const node = el('div', { class: 'node file' + (entry.md === false ? ' txt' : ''), style: `--depth:${depth}`, title: entry.path, draggable: 'true', dataset: { path: entry.path, type: 'file' } },
    el('span', { class: 'icon' }), el('span', { class: 'name' }, entry.name));
  if (sub) node.append(el('span', { class: 'sub' }, sub));
  node.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  node.addEventListener('click', e => openFile(entry.path, { pinned: false, side: e.ctrlKey || e.metaKey }));
  node.addEventListener('auxclick', e => { if (e.button === 1) openFile(entry.path, { pinned: true, side: true }); });
  node.addEventListener('dblclick', () => openFile(entry.path, { pinned: true }));
  node.addEventListener('contextmenu', e => { e.preventDefault(); showFileMenu(e, entry.path); });
  node.addEventListener('dragstart', e => { drag = { path: entry.path }; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', entry.path); });
  node.addEventListener('dragend', () => { drag = null; $$('.drop-target').forEach(x => x.classList.remove('drop-target')); });
  return node;
}
async function loadDir(path, force = false) {
  if (!force && state.dirs.has(path)) return state.dirs.get(path);
  const d = await api.get('list', { path, all: settings.showAll ? 1 : 0 });
  state.dirs.set(path, d);
  return d;
}
async function fillChildren(path) {
  const rec = state.dirEls.get(path); if (!rec) return;
  let d;
  try { d = await loadDir(path); }
  catch (e) { rec.kids.replaceChildren(el('div', { class: 'tree-empty', style: `--depth:${rec.depth}` }, 'cannot read: ' + e.message)); return; }
  const frag = document.createDocumentFragment();
  if (!d.entries.length) frag.append(el('div', { class: 'tree-empty', style: `--depth:${rec.depth}` }, 'no markdown files'));
  for (const e of d.entries) {
    if (e.type === 'dir') frag.append(dirNode(e.path, e.name, rec.depth + 1));
    else frag.append(fileNode(e, rec.depth + 1));
  }
  rec.kids.replaceChildren(frag);
  updateTreeMarks();
}
function toggleDir(path, force) {
  const rec = state.dirEls.get(path); if (!rec) return;
  const open = force !== undefined ? force : !state.expanded.has(path);
  if (open) { state.expanded.add(path); fillChildren(path); } else state.expanded.delete(path);
  rec.node.classList.toggle('open', open);
  rec.kids.classList.toggle('open', open);
  persistSession();
}
async function reloadDir(path) {
  await loadDir(path, true);
  if (state.expanded.has(path)) await fillChildren(path);
}
function updateTreeMarks() {
  const open = new Set(allTabs().map(t => normPath(t.path)));
  const act = activeTab() ? normPath(activeTab().path) : null;
  for (const n of $$('.node.file')) {
    const p = normPath(n.dataset.path);
    n.classList.toggle('open-tab', open.has(p));
    n.classList.toggle('selected', p === act);
  }
}
async function revealInTree(path, expand) {
  const r = rootOf(path); if (!r) return;
  // expand ancestors
  const rel = path.slice(r.path.replace(/[\\/]+$/, '').length + 1);
  const segs = rel.split(SEPS).filter(Boolean);
  let acc = r.path;
  const chain = [acc];
  for (let i = 0; i < segs.length - 1; i++) { acc = joinPath(acc, segs[i]); chain.push(acc); }
  const isDir = state.dirEls.has(path);
  if (expand) {
    for (const p of chain) {
      if (!state.dirEls.has(p)) return;
      if (!state.expanded.has(p)) toggleDir(p, true);
      if (!state.dirs.has(p)) await loadDir(p);
      await fillChildren(p);
    }
    if (isDir && !state.expanded.has(path)) toggleDir(path, true);
  } else if (chain.some(p => !state.expanded.has(p))) return;
  const n = treeEl.querySelector(`.node[data-path="${CSS.escape(path)}"]`);
  if (n) { n.scrollIntoView({ block: 'nearest' }); if (expand) { n.classList.add('selected'); } }
}

/* ---- recent */
async function refreshRecent() {
  if (document.hidden || !settings.sidebar) return;
  try { const r = await api.get('recent', { n: 25 }); state.recent = r.files; renderRecent(); } catch { /* ignore */ }
}
function renderRecent() {
  const list = $('#recent-list');
  const frag = document.createDocumentFragment();
  for (const f of state.recent) {
    const n = fileNode(f, 0, dirname(relToRoot(f.path)) || '');
    n.append(el('span', { class: 'age' }, timeAgo(f.mtime)));
    if (Date.now() / 1000 - f.mtime < 120) n.classList.add('fresh');
    frag.append(n);
  }
  list.replaceChildren(frag);
  updateTreeMarks();
}

/* ---- search / index */
async function ensureIndex() {
  if (state.index && Date.now() - state.indexAt < 8000) return state.index;
  const r = await api.get('index');
  state.index = r.files; state.indexAt = Date.now();
  return state.index;
}
function subseqScore(q, s) {
  let si = 0, score = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = s.indexOf(q[qi], si);
    if (idx < 0) return -1;
    if (idx === si && qi > 0) { streak++; score += 3 + streak; } else streak = 0;
    if (idx === 0 || /[\\/ _\-.]/.test(s[idx - 1])) score += 4;
    score += 1;
    si = idx + 1;
  }
  return score - s.length * 0.03; // prefer shorter paths
}
function fuzzy(query, f) {
  const ql = query.toLowerCase();
  const words = ql.split(/\s+/).filter(Boolean);
  const name = f.name.toLowerCase(), rel = relToRoot(f.path).toLowerCase();
  let total = 0;
  for (const w of words) {
    const a = subseqScore(w, name), b = subseqScore(w, rel);
    if (a < 0 && b < 0) return -1;
    total += Math.max(a >= 0 ? a * 2 + 10 : -1, b);
    if (name.includes(w)) total += 15;
  }
  if (rel.includes(ql)) total += 20;
  total += Math.max(0, 10 - (Date.now() / 1000 - f.mtime) / 86400); // slight recency boost
  return total;
}
async function searchFiles(query, limit = 200) {
  const idx = await ensureIndex();
  const out = [];
  for (const f of idx) { const s = fuzzy(query, f); if (s >= 0) out.push([s, f]); }
  out.sort((a, b) => b[0] - a[0]);
  return out.slice(0, limit).map(x => x[1]);
}
function highlightName(name, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const span = el('span', { class: 'name' });
  const lower = name.toLowerCase();
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0) { span.append(name.slice(0, i), el('mark', { class: 'fz' }, name.slice(i, i + w.length)), name.slice(i + w.length)); return span; }
  }
  span.textContent = name;
  return span;
}

const filterEl = $('#filter');
const searchResults = $('#search-results');
const runSidebarSearch = debounce(async () => {
  const q = filterEl.value.trim();
  const showing = !!q;
  searchResults.hidden = !showing;
  $('#recent-section').hidden = showing;
  $('#tree-section').hidden = showing;
  if (!showing) return;
  const files = await searchFiles(q, 150);
  if (filterEl.value.trim() !== q) return;
  const frag = document.createDocumentFragment();
  if (!files.length) frag.append(el('div', { class: 'sr-empty' }, 'No matches'));
  for (const f of files) {
    const n = fileNode(f, 0, dirname(relToRoot(f.path)));
    n.querySelector('.name').replaceWith(highlightName(f.name, q));
    frag.append(n);
  }
  searchResults.replaceChildren(frag);
  updateTreeMarks();
}, 80);
filterEl.addEventListener('input', runSidebarSearch);
filterEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') { filterEl.value = ''; runSidebarSearch(); filterEl.blur(); }
  if (e.key === 'Enter') { const n = searchResults.querySelector('.node'); if (n) openFile(n.dataset.path, { pinned: !e.shiftKey, side: e.ctrlKey }); }
});

/* ---- quick open */
const qo = $('#quickopen'), qoInput = $('#qo-input'), qoList = $('#qo-list');
let qoItems = [], qoSel = 0;
function openQuick() { qo.hidden = false; qoInput.value = ''; qoInput.focus(); runQuick(); }
function closeQuick() { qo.hidden = true; }
const runQuick = debounce(async () => {
  const q = qoInput.value.trim();
  let files;
  if (!q) { await ensureIndex(); files = [...state.index].sort((a, b) => b.mtime - a.mtime).slice(0, 40); }
  else files = await searchFiles(q, 60);
  if (qoInput.value.trim() !== q) return;
  qoItems = files; qoSel = 0;
  const frag = document.createDocumentFragment();
  if (!files.length) frag.append(el('div', { class: 'sr-empty' }, 'No matches'));
  files.forEach((f, i) => {
    const item = el('div', { class: 'qo-item' + (i === 0 ? ' selected' : ''), title: f.path },
      highlightName(f.name, q), el('span', { class: 'dir' }, dirname(relToRoot(f.path))), el('span', { class: 'age' }, timeAgo(f.mtime)));
    item.addEventListener('click', e => { closeQuick(); openFile(f.path, { pinned: true, side: e.ctrlKey }); });
    item.addEventListener('mousemove', () => { if (qoSel !== i) { qoSel = i; qoRender(); } });
    frag.append(item);
  });
  qoList.replaceChildren(frag);
}, 60);
function qoRender() { [...qoList.children].forEach((c, i) => c.classList.toggle('selected', i === qoSel)); qoList.children[qoSel]?.scrollIntoView({ block: 'nearest' }); }
qoInput.addEventListener('input', runQuick);
qoInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); qoSel = Math.min(qoSel + 1, qoItems.length - 1); qoRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qoSel = Math.max(qoSel - 1, 0); qoRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); const f = qoItems[qoSel]; if (f) { closeQuick(); openFile(f.path, { pinned: true, side: e.ctrlKey || e.metaKey }); } }
  else if (e.key === 'Escape') { closeQuick(); }
});
qo.addEventListener('mousedown', e => { if (e.target === qo) closeQuick(); });

/* ============================================================ live reload */
let pollTimer = 0;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const files = new Set(allTabs().map(t => t.path));
    const dirs = [...state.expanded].filter(p => state.dirs.has(p));
    const paths = [...files, ...dirs];
    if (paths.length) {
      const r = await api.post('stat', { paths });
      let changed = false;
      for (const p of files) {
        const m = r.results[p], d = state.docs.get(p);
        if (m == null) { setMissing(p, true); continue; }
        setMissing(p, false);
        if (!d || d.mtime !== m) { changed = true; await loadDoc(p); }
      }
      for (const p of dirs) {
        const m = r.results[p], d = state.dirs.get(p);
        if (m != null && d && d.mtime !== m) { changed = true; await reloadDir(p); }
      }
      if (changed) { flashLive(); refreshRecent(); state.indexAt = 0; }
    }
  } catch (e) { /* server may be restarting; keep polling */ }
  pollTimer = setTimeout(poll, document.hidden ? 3000 : 1000);
}
function flashLive() { const d = $('#live-dot'); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 900); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); refreshRecent(); } });
setInterval(refreshRecent, 12000);

/* ============================================================ menus */
const menuEl = $('#ctxmenu');
function showMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const it of items) {
    if (it === '-') { menuEl.append(el('div', { class: 'menu-sep' })); continue; }
    if (!it) continue;
    const m = el('div', { class: 'menu-item' }, el('span', {}, it.label), it.kbd ? el('span', { class: 'kbd' }, it.kbd) : null);
    m.addEventListener('click', () => { hideMenu(); it.action(); });
    menuEl.append(m);
  }
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
}
function hideMenu() { menuEl.hidden = true; }
document.addEventListener('mousedown', e => { if (!menuEl.contains(e.target)) hideMenu(); if (!$('#settings-panel').contains(e.target) && e.target !== $('#tb-settings')) $('#settings-panel').hidden = true; });
window.addEventListener('blur', hideMenu);

function fileActions(path) {
  return [
    { label: 'Copy path', action: () => copyText(path) },
    { label: 'Reveal in file manager', action: () => api.post('reveal', { path }).catch(e => toast(e.message)) },
    { label: 'Open in default editor', action: () => api.post('open', { path }).catch(e => toast(e.message)) },
  ];
}
function showFileMenu(e, path) {
  showMenu(e.clientX, e.clientY, [
    { label: 'Open', action: () => openFile(path, { pinned: true }) },
    { label: 'Open to the side', kbd: 'Ctrl+click', action: () => openFile(path, { pinned: true, side: true }) },
    { label: 'Open in new window', action: () => popOut(path) },
    '-', ...fileActions(path),
  ]);
}
function showDirMenu(e, path) {
  showMenu(e.clientX, e.clientY, [
    { label: 'Refresh', action: () => reloadDir(path) },
    { label: 'Collapse all inside', action: () => { for (const p of [...state.expanded]) if (p !== path && normPath(p).startsWith(normPath(path))) state.expanded.delete(p); fillChildren(path); persistSession(); } },
    '-', ...fileActions(path).slice(0, 2),
  ]);
}
function showTabMenu(e, t) {
  const g = t.group, i = g.tabs.indexOf(t);
  showMenu(e.clientX, e.clientY, [
    !t.pinned ? { label: 'Keep open', kbd: 'Alt+Enter', action: () => { t.pinned = true; renderTabs(g); persistSession(); } } : null,
    { label: 'Close', kbd: 'Alt+W', action: () => closeTab(t) },
    { label: 'Close others', action: () => closeTabs(g.tabs.filter(x => x !== t)) },
    { label: 'Close to the right', action: () => closeTabs(g.tabs.slice(i + 1)) },
    { label: 'Close all', action: () => closeTabs([...g.tabs]) },
    '-',
    { label: 'Move to the side', kbd: 'Ctrl+\\', action: () => { const gi = state.groups.indexOf(g); const g2 = state.groups[gi + 1] || addGroup(); moveTab(t, g2, g2.tabs.length); } },
    { label: 'Open in new window', action: () => popOut(t.path) },
    { label: t.raw ? 'Rendered view' : 'Raw source', kbd: 'Alt+R', action: () => toggleRaw(t) },
    '-', ...fileActions(t.path),
  ]);
}

function popOut(path) {
  const u = location.pathname + '?file=' + encodeURIComponent(path) + '&standalone=1';
  window.open(u, '_blank', 'popup=yes,width=1000,height=850');
}

/* ============================================================ settings / theme */
const mql = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && mql.matches);
  const theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const l = $('#hljs-light'), d = $('#hljs-dark');
  if (l) l.disabled = dark; if (d) d.disabled = !dark;
  if (theme !== state.theme) {
    state.theme = theme;
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', suppressErrorRendering: true, securityLevel: 'strict' });
      for (const t of allTabs()) renderMermaidIn(t.inner);
    }
  }
}
mql.addEventListener('change', applyTheme);

function applySettings() {
  const rs = document.documentElement.style;
  rs.setProperty('--font-size', settings.fontSize + 'px');
  rs.setProperty('--line-height', settings.lineHeight);
  rs.setProperty('--font-content', settings.font === 'serif' ? 'var(--font-serif)' : 'var(--font-ui)');
  rs.setProperty('--sidebar-w', settings.sidebarWidth + 'px');
  document.body.classList.toggle('no-sidebar', !settings.sidebar || state.standalone);
  document.body.classList.toggle('no-outline', !settings.outline);
  $('#tb-sidebar').classList.toggle('on', settings.sidebar && !state.standalone);
  $('#tb-outline').classList.toggle('on', settings.outline);
  for (const inner of $$('.pane-inner')) inner.className = 'pane-inner w-' + settings.width;
  $('#follow').checked = settings.follow;
  $('#show-all').checked = settings.showAll;
  $('#font-val').textContent = settings.fontSize + 'px';
  for (const seg of $$('.seg[data-setting]')) for (const b of $$('button', seg)) b.classList.toggle('on', b.dataset.v === String(settings[seg.dataset.setting]));
  $('#recent-list').hidden = !settings.recentOpen; $('.section-head[data-toggle="recent-list"] .chev').classList.toggle('open', settings.recentOpen);
  $('#tree').hidden = !settings.treeOpen; $('.section-head[data-toggle="tree"] .chev').classList.toggle('open', settings.treeOpen);
  applyTheme();
  saveSettings();
  const t = activeTab(); if (t) updateOutlineCurrent(t);
}
for (const seg of $$('.seg[data-setting]')) for (const b of $$('button', seg)) b.addEventListener('click', () => {
  settings[seg.dataset.setting] = b.dataset.v; applySettings();
  if (seg.dataset.setting === 'tableView') rerenderAll();
});
function rerenderAll() { for (const t of allTabs()) { t.renderedKey = null; renderTab(t); } }
$('#font-dec').addEventListener('click', () => { settings.fontSize = Math.max(10, settings.fontSize - 1); applySettings(); });
$('#font-inc').addEventListener('click', () => { settings.fontSize = Math.min(32, settings.fontSize + 1); applySettings(); });
$('#follow').addEventListener('change', e => { settings.follow = e.target.checked; saveSettings(); });
$('#show-all').addEventListener('change', e => { settings.showAll = e.target.checked; saveSettings(); state.dirs.clear(); renderTree(); });
for (const h of $$('.section-head[data-toggle]')) h.addEventListener('click', () => { const k = h.dataset.toggle === 'tree' ? 'treeOpen' : 'recentOpen'; settings[k] = !settings[k]; applySettings(); });

/* ---- toolbar */
$('#tb-sidebar').addEventListener('click', () => { settings.sidebar = !settings.sidebar; applySettings(); });
$('#tb-outline').addEventListener('click', () => { settings.outline = !settings.outline; applySettings(); updateOutline(); });
$('#tb-theme').addEventListener('click', () => { settings.theme = state.theme === 'dark' ? 'light' : 'dark'; applySettings(); });
$('#tb-settings').addEventListener('click', () => { const p = $('#settings-panel'); p.hidden = !p.hidden; });
$('#tb-raw').addEventListener('click', () => toggleRaw(activeTab()));
$('#tb-popout').addEventListener('click', () => { const t = activeTab(); if (t) popOut(t.path); });
$('#tb-split').addEventListener('click', splitActive);
$('#status-path').addEventListener('click', () => { const t = activeTab(); if (t) revealInTree(t.path, true); });
function splitActive() {
  const t = activeTab();
  if (t) openFile(t.path, { pinned: true, side: true });
  else if (state.groups.length < 4) addGroup();
}

/* ---- sidebar resize */
(() => {
  const rz = $('#sidebar-resizer');
  rz.addEventListener('mousedown', e => {
    e.preventDefault();
    const move = ev => { settings.sidebarWidth = Math.max(160, Math.min(640, ev.clientX)); document.documentElement.style.setProperty('--sidebar-w', settings.sidebarWidth + 'px'); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.style.cursor = ''; saveSettings(); };
    document.body.style.cursor = 'col-resize';
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
})();

/* ---- keyboard */
document.addEventListener('keydown', e => {
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { if (!qo.hidden) closeQuick(); hideMenu(); $('#settings-panel').hidden = true; return; }
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openQuick(); return; }
  if (inInput) return;
  if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); settings.sidebar = !settings.sidebar; applySettings(); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); settings.outline = !settings.outline; applySettings(); updateOutline(); return; }
  if (ctrl && e.key === '\\') { e.preventDefault(); splitActive(); return; }
  if (e.altKey && !ctrl) {
    const g = activeGroup(), t = activeTab();
    if (e.code === 'KeyW') { e.preventDefault(); if (t) closeTab(t); }
    else if (e.code === 'KeyR') { e.preventDefault(); toggleRaw(t); }
    else if (e.code === 'Enter') { e.preventDefault(); if (t) { t.pinned = true; renderTabs(g); persistSession(); } }
    else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.preventDefault();
      if (g && g.tabs.length > 1) { const i = g.tabs.indexOf(t); activateTab(g.tabs[(i + (e.code === 'BracketRight' ? 1 : g.tabs.length - 1)) % g.tabs.length]); }
    } else if (/^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      const n = +e.code[5]; if (g && g.tabs[n - 1]) activateTab(g.tabs[n - 1]);
    }
  }
});

/* ---- toast */
let toastTimer = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 1600); }

/* ============================================================ init */
function waitLibs() { return window.__libsReady ? Promise.resolve() : new Promise(r => addEventListener('libs-ready', r, { once: true })); }

async function init() {
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  state.standalone = params.has('standalone');
  try {
    const cfg = await api.get('config');
    state.roots = cfg.roots; state.sep = cfg.sep;
  } catch (e) {
    document.body.replaceChildren(el('pre', { class: 'pane-error', style: 'padding:20px' }, 'Cannot reach the mdview server.\n' + e.message));
    return;
  }
  applySettings();
  await waitLibs();
  setupMarkdown();
  if (window.hljs) hljs.configure({ ignoreUnescapedHTML: true });
  state.theme = ''; applyTheme();

  const sess = state.standalone ? null : store.get(sessionKey(), null);
  if (sess && sess.expanded) sess.expanded.forEach(p => state.expanded.add(p));
  else for (const r of state.roots) state.expanded.add(r.path);
  renderTree();
  refreshRecent();

  if (sess) restoreSession(sess);
  if (!state.groups.length) addGroup();
  layoutGroups();
  if (file) openFile(file, { pinned: true });
  // load docs: active tabs first, then the rest
  const tabs = allTabs().sort((a, b) => (b.group.activeId === b.id) - (a.group.activeId === a.id));
  for (const t of tabs) ensureDoc(t.path);
  onActiveChanged();
  const at = activeTab(); if (at) at.pane.focus({ preventScroll: true });
  poll();
}
init();
