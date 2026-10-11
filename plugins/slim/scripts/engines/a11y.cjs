/*
 * engines/a11y.cjs — a browser accessibility snapshot with its repeated siblings folded.
 *
 * Two grammars, both line-per-node and nested by indent:
 *   playwright  `- role "name" [attr] [ref=e12]: inline text`, `- /url: …` property children
 *   devtools    `uid=1_12 role "name" attr="v" flag`
 * Lines outside the tree (page header, fences, console notes) are kept verbatim. The tree keeps its
 * own grammar so the model's habits still work:
 *   1. a nameless, ref-less generic/none wrapper is flattened into its parent; a nameless leaf img is
 *      dropped and its ref listed on one line;
 *   2. a run of more than k adjacent siblings with the same skeleton (the subtree with names, refs,
 *      inline texts and urls as slots) keeps the first k verbatim and becomes one fold line naming
 *      every folded ref as ranges, the folded names (capped) and their price range. Only items that
 *      hold a control or link, and list items, rows and articles fold, each with at most 200 chars of
 *      text; never prose, landmarks, alerts, dialogs or a level-1/2 heading.
 * Refs are never renumbered or dropped: every input ref is on a kept line, in a fold's ranges or on
 * the dropped-img line. A Playwright key YAML-quoted for its `: ` is read unquoted. Fit stages under
 * targetBytes: fold (k=2) → fold1 (k=1, 6 names) → prune (no `/url` lines, state attrs only) → depth
 * (deepest level first, children become one line).
 * Pure: no I/O.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');

// A wire format the delivery's already-slim rule matches (emit.cjs / node-hook.ts MARKS).
const A11Y_HEADER = '<<slim-a11y>>';
const SCAN = 65536;
const MIN_LINES = 20;
const MIN_GAIN = 0.1;
const ITEM_TEXT_MAX = 200;
const NAME_MAX = 60;
// Deeper than any page's accessibility tree; keeps the recursive passes inside the stack.
const MAX_NEST = 512;

const PW_NODE = /^- ([a-z][\w-]*)(?: ("[^"\\]*(?:\\.[^"\\]*)*"))?((?: \[[^\]\n]*\])*)(?:(:)(?: (.*))?)?$/;
const PW_PROP = /^- (\/[\w-]+):(?: (.*))?$/;
const PW_QUOTED = /^- '([^']*(?:''[^']*)*)'(:.*)?$/;
const PW_ATTR = / \[([^\]\n]*)\]/g;
const DT_NODE = /^uid=(\S+) (\S+)(?: ("[^"\\]*(?:\\.[^"\\]*)*"))?(.*)$/;
const DT_ATTR = /\s+([\w-]+)(?:=("[^"\\]*(?:\\.[^"\\]*)*"|\S+))?/g;
const DT_SLOT = new Set(['url', 'value', 'description', 'valuetext']);
const STATE = new Set(['active', 'checked', 'disabled', 'expanded', 'level', 'selected', 'pressed', 'required', 'invalid']);
const FLATTEN = new Set(['generic', 'none']);
const IMG = new Set(['img', 'image']);
const PIN = new Set(['banner', 'navigation', 'main', 'contentinfo', 'alert', 'status', 'dialog', 'alertdialog']);
const ITEM = new Set(['listitem', 'row', 'article']);
const ACT = new Set(['link', 'button', 'checkbox', 'radio', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'textbox', 'searchbox', 'combobox', 'switch', 'slider', 'spinbutton', 'treeitem', 'listbox']);
const PRICE = /[$£€]\s?\d[\d,]*(?:\.\d+)?/g;

const expired = (ctx) => ctx && ctx.deadline != null && Date.now() > ctx.deadline;
const indentOf = (l) => l.length - l.trimStart().length;
// `- 'link "Size: 5" [ref=e14]':` → `- link "Size: 5" [ref=e14]:`; any other line as is.
const unquote = (l) => { const q = PW_QUOTED.exec(l); return q ? `- ${q[1].replace(/''/g, "'")}${q[2] || ''}` : l; };

// 'playwright' | 'devtools' | null: at least MIN_LINES tree lines, 80 % of the lines that are not blank,
// a fence or a markdown heading; a Playwright tree also carries refs on 30 % of its nodes.
function detectSnapshot(text) {
  const head = typeof text === 'string' ? text.slice(0, SCAN) : '';
  if (head.includes(A11Y_HEADER)) return null;
  let pw = 0, refs = 0, dt = 0, total = 0;
  for (const raw of head.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('```') || l.startsWith('#')) continue;
    total++;
    if (DT_NODE.test(l)) dt++;
    else if (PW_PROP.test(l)) pw++;
    else if (PW_NODE.test(unquote(l))) { pw++; if (l.includes('[ref=')) refs++; }
  }
  if (pw >= MIN_LINES && pw >= 0.8 * total && refs >= 0.3 * pw) return 'playwright';
  if (dt >= MIN_LINES && dt >= 0.8 * total) return 'devtools';
  return null;
}

// One tree line → a node, or null when the line is not one of this grammar's.
function parseLine(content, format) {
  if (format === 'devtools') {
    const m = DT_NODE.exec(content);
    if (!m) return null;
    const attrs = [];
    DT_ATTR.lastIndex = 0;
    for (let a = DT_ATTR.exec(m[4]); a; a = DT_ATTR.exec(m[4])) attrs.push({ key: a[1], value: a[2], raw: a[0].trim() });
    const skelAttrs = attrs.map((a) => (DT_SLOT.has(a.key) ? `${a.key}=·` : a.raw)).join(' ');
    return { kind: 'el', role: m[2], name: m[3] || null, ref: m[1], inline: null, attrs, text: content,
      skel: `${m[2]}${m[3] ? ' "·"' : ''} ${skelAttrs}` };
  }
  const p = PW_PROP.exec(content);
  if (p) return { kind: 'prop', key: p[1], text: content, skel: `${p[1]}:${p[2] ? ' ·' : ''}` };
  const key = unquote(content);
  const m = PW_NODE.exec(key);
  if (!m) return null;
  const attrs = [];
  let ref = null;
  PW_ATTR.lastIndex = 0;
  for (let a = PW_ATTR.exec(m[3]); a; a = PW_ATTR.exec(m[3])) {
    if (a[1].startsWith('ref=')) ref = a[1].slice(4);
    else attrs.push(a[1]);
  }
  const inline = m[5] !== undefined ? m[5] : null;
  return { kind: 'el', role: m[1], name: m[2] || null, ref, inline, attrs, colon: !!m[4], quoted: key !== content, text: content,
    skel: `${m[1]}${m[2] ? ' "·"' : ''}${attrs.map((a) => ` [${a}]`).join('')}${m[4] ? ':' : ''}${inline !== null ? ' ·' : ''}` };
}

// The text as alternating verbatim lines and tree regions (contiguous runs of tree lines).
function segments(text, format) {
  const out = [];
  let region = null;
  for (const line of text.split('\n')) {
    const node = parseLine(line.trimStart(), format);
    if (!node) { region = null; out.push(line); continue; }
    node.pad = indentOf(line);
    if (!region) { region = { lines: [] }; out.push(region); }
    region.lines.push(node);
  }
  return out;
}

// Nest a region's nodes by indent, then flatten wrappers, drop nameless imgs and compute per subtree:
// skeleton id, refs in document order, first name, the texts a fold summarises, its byte size and the
// indent it renders at (a root keeps its own, a child sits one unit under its parent). false when the
// nesting passes MAX_NEST.
function buildRegion(region, intern, st) {
  const root = { children: [], pad: -1 };
  const stack = [root];
  let unit = 0;
  for (const n of region.lines) {
    n.children = [];
    while (stack.length > 1 && stack[stack.length - 1].pad >= n.pad) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent !== root && (!unit || n.pad - parent.pad < unit)) unit = n.pad - parent.pad;
    parent.children.push(n);
    stack.push(n);
    if (stack.length > MAX_NEST) return false;
    if (n.kind === 'el') st.nodes++;
  }
  unit = unit || 2;
  const finish = (list, at) => {
    const kept = [];
    for (const n of list) {
      if (n.kind === 'el' && FLATTEN.has(n.role) && !n.name && !n.ref && n.inline === null) {
        st.flattened++;
        for (const c of finish(n.children, at === null ? n.pad : at)) kept.push(c);
        continue;
      }
      n.out = at === null ? n.pad : at;
      n.children = finish(n.children, n.out + unit);
      n.hidden = n.kind === 'el' && IMG.has(n.role) && !n.name && n.inline === null && !n.children.length;
      kept.push(n);
    }
    for (const n of kept) {
      if (n.refs) continue;
      if (n.hidden) { st.imgs++; n.refs = n.ref ? [n.ref] : []; n.texts = []; n.first = null; n.els = 1; n.size = utf8(n.text) + 1 + n.pad; continue; }
      const own = n.kind === 'el' ? [n.name, n.inline !== null ? JSON.stringify(n.inline) : null].filter(Boolean) : [];
      n.refs = n.ref ? [n.ref] : [];
      n.texts = own.slice();
      n.first = own[0] || null;
      n.els = n.kind === 'el' ? 1 : 0;
      n.size = utf8(n.text) + 1 + n.pad;
      n.pin = n.kind === 'el' && (PIN.has(n.role) || (n.role === 'heading' && n.attrs.some((a) => a === 'level=1' || a === 'level=2' ||
        (a.key === 'level' && /^"?[12]"?$/.test(a.value || '')))));
      n.act = n.kind === 'el' && ACT.has(n.role);
      n.textLen = own.reduce((s, t) => s + t.length, 0);
      n.depth = 0;
      for (const c of n.children) {
        for (const r of c.refs) n.refs.push(r);
        n.els += c.els;
        n.size += c.size;
        if (c.hidden) continue;
        for (const t of c.texts) n.texts.push(t);
        if (!n.first) n.first = c.first;
        n.pin = n.pin || c.pin;
        n.act = n.act || c.act;
        n.textLen += c.textLen;
        n.depth = Math.max(n.depth, c.depth + 1);
      }
      const key = `${n.skel}{${n.children.filter((c) => !c.hidden).map((c) => c.sk).join(',')}}`;
      let id = intern.get(key);
      if (id === undefined) { id = intern.size + 1; intern.set(key, id); }
      n.sk = id;
    }
    return kept;
  };
  region.roots = finish(root.children, null);
  region.unit = unit;
  region.depth = region.roots.reduce((m, n) => Math.max(m, n.depth), 0);
  return true;
}

// `e71–e184, e190`: consecutive ids (same prefix, number + 1) as one range, in document order.
function ranges(refs) {
  const out = [];
  const split = (r) => { const m = /^(.*?)(\d+)$/.exec(r); return m ? [m[1], Number(m[2])] : [r, NaN]; };
  for (let i = 0; i < refs.length;) {
    const [p, n] = split(refs[i]);
    let j = i;
    while (j + 1 < refs.length) {
      const [q, k] = split(refs[j + 1]);
      if (q !== p || !Number.isFinite(n) || k !== n + (j + 1 - i)) break;
      j++;
    }
    out.push(j > i ? `${refs[i]}–${refs[j]}` : refs[i]);
    i = j + 1;
  }
  return out.join(', ');
}

function priceSpan(texts) {
  const found = [];
  for (const t of texts) for (const m of t.matchAll(PRICE)) found.push(m[0]);
  if (!found.length || new Set(found.map((f) => f[0])).size > 1) return '';
  const num = (s) => Number(s.replace(/[^\d.]/g, ''));
  found.sort((a, b) => num(a) - num(b));
  return found.length === 1 || found[0] === found[found.length - 1] ? `; price ${found[0]}` : `; prices ${found[0]}–${found[found.length - 1]}`;
}

// `"…"` cut to NAME_MAX chars, still quoted.
function clip(name) {
  const cs = Array.from(name);
  return cs.length <= NAME_MAX ? name : `${cs.slice(0, NAME_MAX - 2).join('').replace(/\\+$/, '')}…"`;
}

// One summary line for nodes leaving the output: refs as ranges, names up to `cap` (each node's first
// one, or with `deep` every name in the subtrees), prices.
function summary(nodes, lead, format, cap, deep) {
  const refs = [];
  const names = [];
  const texts = [];
  for (const n of nodes) {
    for (const r of n.refs) refs.push(r);
    if (deep) for (const t of n.texts) names.push(t);
    else if (n.first) names.push(n.first);
    for (const t of n.texts) texts.push(t);
  }
  const bullet = format === 'devtools' ? '' : '- ';
  const label = format === 'devtools' ? 'uids' : 'refs';
  const shown = names.slice(0, cap).map(clip);
  const more = names.length - shown.length;
  return `${bullet}… ${lead}${refs.length ? ` [${label} ${ranges(refs)}]` : ''}` +
    `${shown.length ? `: names ${shown.join(', ')}${more ? ` … +${more}` : ''}` : ''}${priceSpan(texts)}`;
}

const foldable = (n) => n.kind === 'el' && (n.act || ITEM.has(n.role)) && !n.pin && n.textLen <= ITEM_TEXT_MAX;

function lineOf(n, format, prune, leaf) {
  if (n.kind !== 'el') return n.text;
  if (!prune) return leaf && n.colon && n.inline === null ? n.text.replace(/:$/, '') : n.text;
  if (format === 'devtools') {
    const kept = n.attrs.filter((a) => STATE.has(a.key)).map((a) => ` ${a.raw}`).join('');
    return `uid=${n.ref} ${n.role}${n.name ? ` ${n.name}` : ''}${kept}`;
  }
  const kept = n.attrs.filter((a) => STATE.has(a.split('=')[0])).map((a) => ` [${a}]`).join('');
  const key = `${n.role}${n.name ? ` ${n.name}` : ''}${kept}${n.ref ? ` [ref=${n.ref}]` : ''}`;
  return `- ${n.quoted ? `'${key.replace(/'/g, "''")}'` : key}${n.colon && (!leaf || n.inline !== null) ? ':' : ''}${n.inline !== null ? ` ${n.inline}` : ''}`;
}

// Render one region under options { k, cap, prune, maxDepth } into `out`; counts folds into `st`.
function renderRegion(region, o, format, out, st) {
  const pad = (n) => ' '.repeat(n);
  const emit = (nodes, d) => {
    for (let i = 0; i < nodes.length;) {
      let j = i + 1;
      if (foldable(nodes[i])) while (j < nodes.length && nodes[j].sk === nodes[i].sk && foldable(nodes[j])) j++;
      if (j - i > o.k) {
        const rest = nodes.slice(i + o.k, j);
        const line = pad(nodes[i].out) + summary(rest, `${rest.length} more like the ${o.k === 1 ? 'one' : o.k} above`, format, o.cap);
        if (utf8(line) < rest.reduce((s, n) => s + n.size, 0)) {
          for (let x = i; x < i + o.k; x++) node(nodes[x], d);
          out.push(line);
          st.folds++;
          st.folded += rest.reduce((s, n) => s + n.els, 0);
          i = j;
          continue;
        }
      }
      for (let x = i; x < j; x++) node(nodes[x], d);
      i = j;
    }
  };
  const node = (n, d) => {
    if (n.hidden) { if (n.ref) st.imgRefs.push(n.ref); return; }
    if (o.prune && n.kind === 'prop' && n.key === '/url') return;
    const kids = n.children.filter((c) => !(o.prune && c.kind === 'prop' && c.key === '/url'));
    out.push(pad(n.out) + lineOf(n, format, o.prune, !kids.some((c) => !c.hidden)));
    if (!kids.length) return;
    if (d >= o.maxDepth) {
      const els = kids.reduce((s, c) => s + c.els, 0);
      out.push(pad(n.out + region.unit) + summary(kids, `${els} node${els === 1 ? '' : 's'} below`, format, o.cap, true));
      st.cut++;
      st.folded += els;
      return;
    }
    emit(kids, d + 1);
  };
  emit(region.roots, 0);
}

function footerOf(format) {
  const look = format === 'devtools' ? 'take_snapshot({ verbose: true })' : 'browser_find, or browser_snapshot again';
  return `slim a11y: a ref inside a fold is still live — act on it directly; to see a folded subtree call ${look}, ` +
    'or mcp__slim__lookup({ path: <the full= file below>, question }).';
}

function render(segs, format, o, st0) {
  const st = { ...st0, folds: 0, folded: 0, cut: 0, imgRefs: [] };
  const body = [];
  let lines = 0;
  for (const s of segs) {
    if (typeof s === 'string') { body.push(s); continue; }
    const out = [];
    renderRegion(s, o, format, out, st);
    lines += out.length;
    for (const l of out) body.push(l);
  }
  const head = `${A11Y_HEADER} ${format} · ${commas(st.nodes)} nodes → ${commas(lines)} lines · ${st.folds} fold${st.folds === 1 ? '' : 's'} (${commas(st.folded)} nodes)` +
    (st.cut ? ` · ${st.cut} subtree${st.cut === 1 ? '' : 's'} cut at depth ${o.maxDepth}` : '') +
    (st.imgs ? ` · ${st.imgs} unnamed img${st.imgs === 1 ? '' : 's'} dropped` : '') +
    (st.flattened ? ` · ${st.flattened} wrapper${st.flattened === 1 ? '' : 's'} flattened` : '');
  const tail = [];
  if (st.imgRefs.length) tail.push(`unnamed imgs dropped: ${format === 'devtools' ? 'uids' : 'refs'} ${ranges(st.imgRefs)}`);
  tail.push(footerOf(format));
  while (body.length && body[body.length - 1] === '') body.pop();
  return { text: [head, ...body, '', ...tail].join('\n'), st };
}

const STAGES = [['fold', { k: 2, cap: 12, prune: false }], ['fold1', { k: 1, cap: 6, prune: false }], ['prune', { k: 1, cap: 6, prune: true }]];

// The engine entry. targetBytes walks the fit stages until the output is under it; still over → the
// last stage's output, which the caller stubs.
function run(text, opts, ctx) {
  const format = detectSnapshot(text);
  if (!format) return { decision: 'passthrough', reason: 'non-a11y', text };
  if (expired(ctx)) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  const segs = segments(text, format);
  const intern = new Map();
  const st0 = { nodes: 0, flattened: 0, imgs: 0 };
  let depth = 0;
  for (const s of segs) {
    if (typeof s === 'string') continue;
    if (!buildRegion(s, intern, st0)) return { decision: 'passthrough', reason: 'non-a11y', text };
    depth = Math.max(depth, s.depth);
  }
  const target = opts && opts.targetBytes;
  const stages = [];
  let r;
  let last;
  for (const [name, o] of STAGES) {
    last = { ...o, maxDepth: Infinity };
    r = render(segs, format, last, st0);
    stages.push(name);
    if (!target || utf8(r.text) <= target) break;
    if (expired(ctx)) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  }
  if (target && utf8(r.text) > target) {
    stages.push('depth');
    for (let d = depth - 1; d >= 0; d--) {
      r = render(segs, format, { ...last, maxDepth: d }, st0);
      if (utf8(r.text) <= target) break;
      if (expired(ctx)) return { decision: 'passthrough', reason: 'budget-exceeded', text };
    }
  }
  if (expired(ctx)) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  if (utf8(r.text) > utf8(text) * (1 - MIN_GAIN)) return { decision: 'passthrough', reason: 'no-gain', text };
  const { nodes, folds, folded, imgs, cut } = r.st;
  return { decision: 'compressed', text: r.text, stages, meta: { format, nodes, folds, folded, imgs, cut } };
}

module.exports = { id: 'a11y', run, detectSnapshot, A11Y_HEADER };
