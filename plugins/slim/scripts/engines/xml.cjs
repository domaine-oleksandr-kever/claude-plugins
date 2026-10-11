/*
 * engines/xml.cjs — an XML document as an element tree with counts; an SVG with its geometry elided.
 *
 * XML (sitemaps, product feeds, RSS, anything else), one line per element, indented by depth:
 *   <<slim-xml>> xml <urlset> · 50,001 elements · 7,512,345 B · 1 record list folded (50,000 records)
 *   urlset xmlns="…"                          a wrapper with one child chains on: `rss version="2.0" › channel`
 *     url ×50,000 {loc, lastmod, changefreq, priority}
 *       #1 <url><loc>…</loc>…</url>           sample records verbatim: first, middle, last of the list
 *   → one record: lookup({ path: <the full= file below>, question: "…" })
 * Five or more same-name siblings fold into one `name ×N {fields}` line (`@attr`, child names, `+` for a
 * child repeated inside a record, `#text`); siblings of several shapes list each shape with its count
 * and its own samples. Siblings carrying an `id` / `xml:id` are addressable and never fold (a Figma
 * node tree keeps every node). An element outside a fold keeps its text whole; a sample's text and
 * any attribute value over 200 chars are elided to a head and a length (a URL under 2,048 chars is kept).
 *
 * SVG (root `<svg`): the markup one element per line, nesting by indent: viewBox, ids, groups,
 * `<use>` refs, fills, `<text>` kept; `d` / `points` over 40 chars → `d="(1,204 chars)"`; comments,
 * `<metadata>` and editor namespaces (inkscape, sodipodi, sketch, serif) dropped; five or more adjacent
 * identical leaves without an id fold to one line with `×N`.
 *
 * Fit (targetBytes): samples 3 → 1 → 0, then the deepest level folds into its parent's line
 * (`… N elements deeper folded`), one level per pass down to the root's children. Pure.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');
const { unwrapFence } = require('./json.cjs');

const MARK = '<<slim-xml>>';
const FOLD_MIN = 5;
const SHAPES_MAX = 12;
const TEXT_MAX = 200;
const URL_MAX = 2048;
const GEOMETRY_MAX = 40;
const SAMPLE_MAX = 1500;
const DEADLINE_EVERY = 512;
const EDITOR = /^(?:inkscape|sodipodi|sketch|serif):|^xmlns:(?:inkscape|sodipodi|sketch|serif)$/;
const GEOMETRY = new Set(['d', 'points']);
const ID_ATTRS = ['id', 'xml:id'];

// XML forbids a raw `<` inside an attribute value, so a quoted value stops at the next `<`: an unclosed
// quote costs a scan to the next tag, never to the end of the text.
const ATTRS = `(?:[^<>"']|"[^"<]*"|'[^'<]*')*`;
const TOKEN = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[([\\s\\S]*?)(?:\\]\\]>|$)|<!DOCTYPE[^>\\[]*(?:\\[[^\\]]*\\])?[^>]*>?|<![^>]*>?|<\\?[\\s\\S]*?(?:\\?>|$)|<(\\/?)([A-Za-z_][\\w:.-]*)(${ATTRS})>|[^<]+|<`, 'gi');
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

function attrsOf(raw) {
  const out = [];
  if (!raw) return out;
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(raw); m; m = ATTR.exec(raw)) out.push([m[1], m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

// → { top: [elements], count, comments } or null once the deadline passed. Values stay raw (entities
// as written), so a sample is the input's own text.
function parse(src, deadline) {
  const root = { name: '', attrs: [], kids: [], text: '', depth: -1 };
  const stack = [root];
  let count = 0;
  let comments = 0;
  let n = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    if (deadline != null && ++n % DEADLINE_EVERY === 0 && Date.now() > deadline) return null;
    const tok = m[0];
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[3]) {
      const name = m[3];
      if (m[2] === '/') {
        let at = stack.length - 1;
        while (at > 0 && stack[at].name !== name) at--;
        if (at > 0) stack.length = at;
        continue;
      }
      const el = { name, attrs: attrsOf(m[4]), kids: [], text: '', depth: stack.length - 1 };
      top.kids.push(el);
      count++;
      if (!/\/\s*$/.test(m[4])) stack.push(el);
      continue;
    }
    if (tok.startsWith('<!--')) { comments++; continue; }
    if (tok.length > 1 && tok[0] === '<' && (tok[1] === '!' || tok[1] === '?')) continue;
    if (stack.length > 1) top.text += tok;
  }
  return { top: root.kids, count, comments };
}

const flat = (s) => s.replace(/\s+/g, ' ').trim();
const URL = /^https?:\/\/\S+$/;
function clip(v) {
  if (v.length <= TEXT_MAX || (v.length < URL_MAX && URL.test(v))) return v;
  return `${v.slice(0, 60)}… (${commas(v.length)} chars)`;
}
// A record's or an SVG element's text; the tree itself keeps an element's text whole.
const textOf = (el) => clip(flat(el.text));
const attrText = (attrs) => attrs.map(([k, v]) => ` ${k}="${clip(v)}"`).join('');
const idOf = (el) => { for (const [k, v] of el.attrs) if (ID_ATTRS.includes(k)) return v; return null; };
const descendants = (el) => { let n = 0; for (const k of el.kids) n += 1 + descendants(k); return n; };
const deepest = (el) => { let d = el.depth; for (const k of el.kids) d = Math.max(d, deepest(k)); return d; };

// A record as one line of compact markup, cut at SAMPLE_MAX chars.
function serialize(el) {
  let out = '';
  const walk = (e) => {
    if (out.length > SAMPLE_MAX) return;
    const t = textOf(e);
    out += `<${e.name}${attrText(e.attrs)}`;
    if (!t && !e.kids.length) { out += '/>'; return; }
    out += `>${t}`;
    for (const k of e.kids) walk(k);
    out += `</${e.name}>`;
  };
  walk(el);
  return out.length > SAMPLE_MAX ? `${out.slice(0, SAMPLE_MAX)}… (+${commas(out.length - SAMPLE_MAX)} chars)` : out;
}

function shapeOf(el) {
  const seen = new Map();
  for (const k of el.kids) seen.set(k.name, (seen.get(k.name) || 0) + 1);
  const key = [...el.attrs.map(([k]) => `@${k}`), ...seen.keys(), ...(flat(el.text) ? ['#text'] : [])].join('\u0000');
  return { key, repeated: [...seen].filter(([, c]) => c > 1).map(([k]) => k) };
}

// Same-name siblings grouped once per parent: { name → members } in first-occurrence order.
function groupsOf(el) {
  if (!el.groups) {
    el.groups = new Map();
    for (const k of el.kids) {
      if (!el.groups.has(k.name)) el.groups.set(k.name, []);
      el.groups.get(k.name).push(k);
    }
  }
  return el.groups;
}

// The shapes of a record list, most frequent first (ties in first-occurrence order).
function shapesOf(members) {
  const by = new Map();
  for (const m of members) {
    const s = shapeOf(m);
    if (!by.has(s.key)) by.set(s.key, { key: s.key, members: [], repeated: new Set() });
    const g = by.get(s.key);
    g.members.push(m);
    for (const r of s.repeated) g.repeated.add(r);
  }
  return [...by.values()].sort((a, b) => b.members.length - a.members.length);
}

const fieldsOf = (shape) => `{${shape.key.split('\u0000').filter(Boolean).map((f) => (shape.repeated.has(f) ? `${f}+` : f)).join(', ')}}`;
function pick(n, k) {
  if (k <= 0 || n === 0) return [];
  if (k === 1) return [0];
  return [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
}

function renderXml(top, o, stats) {
  const lines = [];
  const fold = (name, members, pad, index) => {
    const shapes = shapesOf(members);
    stats.lists++;
    stats.records += members.length;
    if (!stats.first) stats.first = name;
    const listed = shapes.slice(0, SHAPES_MAX);
    const one = shapes.length === 1;
    lines.push(one ? `${pad}${name} ×${commas(members.length)} ${fieldsOf(shapes[0])}` : `${pad}${name} ×${commas(members.length)} in ${shapes.length} shapes`);
    for (const s of listed) {
      const p = one ? `${pad}  ` : `${pad}    `;
      if (!one) lines.push(`${pad}  ${fieldsOf(s)} ×${commas(s.members.length)}`);
      for (const i of pick(s.members.length, o.samples)) lines.push(`${p}#${commas(index.get(s.members[i]) + 1)} ${serialize(s.members[i])}`);
    }
    if (shapes.length > SHAPES_MAX) {
      const rest = shapes.slice(SHAPES_MAX).reduce((a, s) => a + s.members.length, 0);
      lines.push(`${pad}  … ${shapes.length - SHAPES_MAX} more shapes (${commas(rest)} records)`);
    }
  };
  const children = (el, pad) => {
    const groups = groupsOf(el);
    const folds = new Map();
    for (const [name, members] of groups) folds.set(name, members.length >= FOLD_MIN && members.every((m) => idOf(m) === null));
    for (const k of el.kids) {
      if (!folds.get(k.name)) { render(k, pad); continue; }
      if (folds.get(k.name) === 'done') continue;
      folds.set(k.name, 'done');
      const members = groups.get(k.name);
      fold(k.name, members, pad, new Map(members.map((m, i) => [m, i])));
    }
  };
  const render = (el, pad) => {
    let head = `${el.name}${attrText(el.attrs)}`;
    let at = el;
    while (!at.text.trim() && at.kids.length === 1 && at.depth < o.depthCap) {
      at = at.kids[0];
      head += ` › ${at.name}${attrText(at.attrs)}`;
    }
    const t = at.text.trim().replace(/\n/g, `\n${pad}  `);
    lines.push(`${pad}${head}${t ? `: ${t}` : ''}`);
    if (!at.kids.length) return;
    if (at.depth < o.depthCap) { children(at, `${pad}  `); return; }
    const n = descendants(at);
    lines.push(`${pad}  … ${commas(n)} elements deeper folded`);
    stats.deep += n;
  };
  if (top.length >= FOLD_MIN) children({ kids: top, depth: -1 }, '');
  else for (const el of top) render(el, '');
  return lines;
}

function renderSvg(top, o, stats) {
  const lines = [];
  const geometry = (k, v) => GEOMETRY.has(k) && v.length > GEOMETRY_MAX;
  const keep = (el) => el.name !== 'metadata' && !EDITOR.test(el.name);
  const attrs = (el) => el.attrs.filter(([k]) => !EDITOR.test(k)).map(([k, v]) => ` ${k}="${geometry(k, v) ? `(${commas(v.length)} chars)` : clip(v)}"`).join('');
  const count = (el) => {
    for (const [k, v] of el.attrs) if (geometry(k, v)) { stats.geometry++; stats.geometryChars += v.length; }
    for (const k of el.kids) if (keep(k)) count(k); else stats.dropped++;
  };
  const line = (el) => {
    const t = textOf(el);
    const open = `<${el.name}${attrs(el)}`;
    if (el.kids.some(keep)) return `${open}>${t}`;
    return t ? `${open}>${t}</${el.name}>` : `${open}/>`;
  };
  const LEN = /\((?:[\d,]+) chars\)/g;
  const render = (el, pad) => {
    lines.push(`${pad}${line(el)}`);
    const kids = el.kids.filter(keep);
    if (!kids.length) return;
    if (el.depth >= o.depthCap) {
      const n = descendants(el);
      lines.push(`${pad}  … ${commas(n)} elements deeper folded`);
      stats.deep += n;
      return;
    }
    for (let i = 0; i < kids.length;) {
      const k = kids[i];
      if (idOf(k) !== null || k.kids.some(keep)) { render(k, `${pad}  `); i++; continue; }
      const l = line(k);
      const norm = l.replace(LEN, '(… chars)');
      let j = i + 1;
      while (j < kids.length && idOf(kids[j]) === null && !kids[j].kids.some(keep) && line(kids[j]).replace(LEN, '(… chars)') === norm) j++;
      if (j - i >= FOLD_MIN) { lines.push(`${pad}  ${norm} ×${j - i}`); stats.folded += j - i; }
      else for (let x = i; x < j; x++) lines.push(`${pad}  ${line(kids[x])}`);
      i = j;
    }
  };
  for (const el of top) if (keep(el)) { count(el); render(el, ''); }
  return lines;
}

function build(doc, svg, bytesIn, o, wrap) {
  const stats = { first: null, lists: 0, records: 0, deep: 0, geometry: 0, geometryChars: 0, dropped: 0, folded: 0 };
  const body = svg ? renderSvg(doc.top, o, stats) : renderXml(doc.top, o, stats);
  const root = doc.top[0];
  const head = [`${MARK} ${svg ? 'svg' : `xml <${root.name}>`} · ${commas(doc.count)} elements · ${commas(bytesIn)} B`];
  if (svg) {
    const vb = root.attrs.find(([k]) => k === 'viewBox');
    if (vb) head.push(`viewBox="${vb[1]}"`);
    if (stats.geometry) head.push(`${commas(stats.geometry)} d/points elided (${commas(stats.geometryChars)} chars)`);
    if (stats.dropped || doc.comments) head.push(`dropped: ${commas(stats.dropped)} editor/metadata elements, ${commas(doc.comments)} comments`);
    if (stats.folded) head.push(`${commas(stats.folded)} identical leaves folded`);
  } else if (stats.lists) {
    head.push(`${stats.lists} record list${stats.lists === 1 ? '' : 's'} folded (${commas(stats.records)} records)`);
  }
  if (stats.deep) head.push(`${commas(stats.deep)} elements below depth ${o.depthCap} folded to fit`);
  const foot = svg
    ? '→ exact markup (a path, a style): lookup({ path: <the full= file below>, question: "the d of #<id>" })'
    : `→ one record: lookup({ path: <the full= file below>, question: "the <${stats.first || root.name}> whose … is …" })`;
  return { text: wrap(head.join(' · '), [...body, foot].join('\n')), deep: stats.deep };
}

// The engine entry: compressed only when the tree is smaller than the document.
function run(text, opts, ctx) {
  const late = () => ctx.deadline != null && Date.now() > ctx.deadline;
  const fence = unwrapFence(text);
  const doc = parse(fence ? fence.body : text, ctx.deadline);
  if (doc === null || late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  const svg = doc.top.length > 0 && doc.top[0].name.toLowerCase() === 'svg';
  const format = svg ? 'svg' : 'xml';
  if (!doc.top.length) return { decision: 'passthrough', reason: 'no-gain', text, format };
  // The header leads even inside a fence's prose: a re-run knows the mark by the first line.
  const wrap = (head, s) => (fence ? [head, fence.preamble, s, fence.trailer].filter(Boolean).join('\n\n') : `${head}\n${s}`);
  const bytesIn = utf8(text);
  const maxDepth = doc.top.reduce((d, el) => Math.max(d, deepest(el)), 0);
  const target = opts && opts.targetBytes;
  const attempts = [{ samples: 3, depthCap: Infinity }];
  if (target) {
    if (!svg) attempts.push({ samples: 1, depthCap: Infinity }, { samples: 0, depthCap: Infinity });
    for (let cap = maxDepth - 1; cap >= 1; cap--) attempts.push({ samples: 0, depthCap: cap });
  }
  let out = null;
  let used = null;
  for (const o of attempts) {
    if (late()) return { decision: 'passthrough', reason: 'budget-exceeded', text, format };
    out = build(doc, svg, bytesIn, o, wrap);
    used = o;
    if (!target || utf8(out.text) <= target) break;
  }
  if (utf8(out.text) >= bytesIn) return { decision: 'passthrough', reason: 'no-gain', text, format };
  const stages = [format];
  const warnings = [];
  if (used.samples < 3 && !svg) { stages.push('samples'); warnings.push(`samples: ${used.samples} per record list to meet targetBytes`); }
  if (used.depthCap !== Infinity) { stages.push('depth'); warnings.push(`depth: ${out.deep} elements below depth ${used.depthCap} folded to meet targetBytes`); }
  if (target && utf8(out.text) > target) warnings.push(`targetBytes ${target} not met: ${utf8(out.text)} B`);
  return { decision: 'compressed', text: out.text, stages, warnings };
}

module.exports = { id: 'xml', run, MARK };
