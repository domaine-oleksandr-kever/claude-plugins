/*
 * engines/html.cjs — an HTML page reduced to what a reader takes from it.
 *
 * Output, in this order:
 *   # <title>
 *   meta: description=…; og:title=…; canonical=…
 *   <visible body text: h1–h6 → `#…`, li → `- ` / `1. `, pre → fenced, inline code → `…`,
 *    table rows joined with ` | `>
 *   links (N):
 *   - <text> → <href>          deduped by href, first text wins, at most LINKS_MAX then `- … N more`
 *   scripts (N):
 *   - <src>                    every <script src>, in page order
 * Dropped: script/style/svg/noscript/template/iframe/canvas contents, comments, the text of
 * nav/footer/aside and aria-hidden subtrees (their links are still listed). Entities are decoded.
 * A tolerant tokenizer, not a parser: malformed markup degrades to text, it never throws. Pure.
 */
'use strict';

const { utf8 } = require('./util.cjs');
const { windowText } = require('./text-window.cjs');

const LINKS_MAX = 200;
const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'template', 'iframe', 'canvas', 'object']);
const MUTE = new Set(['nav', 'footer', 'aside']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'blockquote', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'form', 'fieldset', 'details', 'summary', 'dl', 'dt', 'dd', 'hr', 'address', 'body']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', euro: '€', pound: '£', deg: '°', shy: '',
};
function decode(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
function attrsOf(raw) {
  const out = {};
  if (!raw) return out;
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(raw); m; m = ATTR.exec(raw)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// A tag's attribute run stops at the next `<` outside quotes and a quoted value at QUOTE_MAX chars, so
// a page of unclosed `<a x="…` costs one bounded scan per `<`, not a scan to the end of the text.
const ATTRS = `(?:[^<>"']|"[^"]{0,4096}"|'[^']{0,4096}')*`;
const TOKEN = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)|<![^>]*>?|<\\?[\\s\\S]*?(?:\\?>|$)|<(\\/?)([a-zA-Z][\\w:-]*)(${ATTRS})>|[^<]+|<`, 'g');
const DEADLINE_EVERY = 512;

// The index just past the element `name` opened before `from` closes (same-name nesting counted),
// or the end of the text when it never closes.
function skipElement(html, name, from, raw) {
  const re = raw ? new RegExp(`</${name}\\s*>`, 'gi') : new RegExp(`<(/?)${name}\\b${ATTRS}>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (raw) return re.lastIndex;
    if (m[1]) depth--; else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return re.lastIndex;
  }
  return html.length;
}

function extract(html, deadline) {
  const out = { title: '', meta: [], body: [], links: new Map(), scripts: [] };
  const stack = [];
  let muted = 0;
  let pre = 0;
  let anchor = null;
  const lists = [];
  let cell = 0;
  const emit = (s) => {
    if (muted) return;
    out.body.push(s);
    if (anchor) anchor.text += s;
  };
  const nl = () => { if (!muted) out.body.push(BR); };
  const para = () => { if (!muted) out.body.push(PARA); };
  const meta = { description: '', 'og:title': '', canonical: '' };

  TOKEN.lastIndex = 0;
  let n = 0;
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    if (deadline != null && ++n % DEADLINE_EVERY === 0 && Date.now() > deadline) return null;
    const tok = m[0];
    if (tok[0] !== '<' || (!m[2] && tok === '<')) {
      const text = decode(tok);
      if (pre) emit(text);
      else {
        const t = text.replace(/\s+/g, ' ');
        if (t.trim()) emit(t);
        else if (t && out.body.length && !/[\s\u0001\u0002]$/.test(out.body[out.body.length - 1])) emit(' ');
        if (anchor && muted) anchor.text += t;
      }
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA, processing instruction
    const close = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = close ? {} : attrsOf(m[3]);
    const selfClosing = /\/\s*$/.test(m[3] || '');

    if (!close && name === 'title' && !out.title) {
      const end = skipElement(html, 'title', TOKEN.lastIndex, true);
      const inner = html.slice(TOKEN.lastIndex, end).replace(/<\/title\s*>$/i, '');
      out.title = decode(inner).replace(/\s+/g, ' ').trim();
      TOKEN.lastIndex = end;
      continue;
    }
    if (!close && name === 'meta') {
      const key = (attrs.name || attrs.property || '').toLowerCase();
      if ((key === 'description' || key === 'og:title') && attrs.content && !meta[key]) meta[key] = attrs.content.replace(/\s+/g, ' ').trim();
      continue;
    }
    if (!close && name === 'link') {
      if (/(^|\s)canonical(\s|$)/i.test(attrs.rel || '') && attrs.href && !meta.canonical) meta.canonical = attrs.href;
      continue;
    }
    if (!close && SKIP.has(name)) {
      if (name === 'script' && attrs.src) out.scripts.push(attrs.src);
      if (!selfClosing) TOKEN.lastIndex = skipElement(html, name, TOKEN.lastIndex, name === 'script' || name === 'style');
      continue;
    }

    if (close) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) {
        const e = stack.pop();
        if (e.mute) muted--;
        if (e.name === 'pre') { pre--; nl(); emit('```'); para(); }
        else if (e.name === 'code' && !pre) emit('`');
        else if (e.name === 'li' || e.name === 'tr') nl();
        else if (/^h[1-6]$/.test(e.name) || BLOCK.has(e.name)) para();
        if (e.name === 'ul' || e.name === 'ol') { lists.pop(); if (!lists.length) para(); }
        if (e.name === 'a' && anchor && e.anchor === anchor) {
          const text = anchor.text.replace(/\s+/g, ' ').trim();
          if (anchor.href && !out.links.has(anchor.href)) out.links.set(anchor.href, text);
          anchor = null;
        }
      }
      continue;
    }

    if (name === 'br') { if (pre) emit('\n'); else nl(); continue; }
    if (VOID.has(name)) {
      if (name === 'img' && attrs.alt && attrs.alt.trim()) emit(` ${attrs.alt.trim()} `);
      continue;
    }
    if (selfClosing) continue;
    const entry = { name, mute: MUTE.has(name) || attrs['aria-hidden'] === 'true' || 'hidden' in attrs };
    if (entry.mute) muted++;
    if (/^h[1-6]$/.test(name)) { para(); emit(`${'#'.repeat(Number(name[1]))} `); }
    else if (name === 'ul' || name === 'ol') { if (!lists.length) para(); else nl(); lists.push({ ordered: name === 'ol', n: 0 }); }
    else if (name === 'li') {
      const l = lists[lists.length - 1];
      nl();
      const depth = Math.max(0, lists.length - 1);
      emit(`${INDENT.repeat(depth * 2)}${l && l.ordered ? `${++l.n}. ` : '- '}`);
    } else if (name === 'tr') { nl(); cell = 0; }
    else if (name === 'td' || name === 'th') { if (cell++ > 0) emit(' | '); }
    else if (name === 'pre') { para(); emit('```'); nl(); pre++; }
    else if (name === 'code' && !pre) emit('`');
    else if (BLOCK.has(name)) para();
    if (name === 'a') {
      const href = (attrs.href || '').trim();
      anchor = { href: href && !/^(?:javascript:|#$)/i.test(href) ? href : '', text: '' };
      entry.anchor = anchor;
    }
    stack.push(entry);
  }
  if (anchor && anchor.href && !out.links.has(anchor.href)) out.links.set(anchor.href, anchor.text.replace(/\s+/g, ' ').trim());
  for (const k of ['description', 'og:title', 'canonical']) if (meta[k]) out.meta.push(`${k}=${meta[k]}`);
  return out;
}

// Boundaries are collected as markers and resolved here: any run holding a paragraph break becomes
// one blank line, a run of line breaks one newline.
const BR = '\u0001';
const PARA = '\u0002';
const INDENT = '\u0003';
const LIST_ITEM = /^ *(?:- |\d+\. )/;
function bodyText(parts) {
  const joined = parts.join('').replace(/[ \t]*[\u0001\u0002][\u0001\u0002 \t]*/g, (m) => (m.includes(PARA) ? '\n\n' : '\n'));
  const lines = joined.replace(/\u0003/g, ' ').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const kept = [];
  let fence = false;
  for (const raw of lines) {
    const l = fence ? raw : (LIST_ITEM.test(raw) ? raw : raw.trimStart()).replace(/(\S) {2,}/g, '$1 ');
    if (l.trim() === '```') fence = !fence;
    if (!l.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
    kept.push(l);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

// → the reduced page text, or null once `deadline` (Date.now() scale) has passed.
function slimHtml(html, budgetBytes, deadline = null) {
  const x = extract(html, deadline);
  if (!x) return null;
  const head = [];
  if (x.title) head.push(`# ${x.title}`);
  if (x.meta.length) head.push(`meta: ${x.meta.join('; ')}`);
  const links = [...x.links.entries()];
  const tail = [`links (${links.length}):`];
  for (const [href, text] of links.slice(0, LINKS_MAX)) tail.push(`- ${text || '(no text)'} → ${href}`);
  if (links.length > LINKS_MAX) tail.push(`- … ${links.length - LINKS_MAX} more`);
  tail.push(`scripts (${x.scripts.length}):`);
  for (const src of x.scripts) tail.push(`- ${src}`);
  let body = bodyText(x.body);
  const join = (b) => [head.join('\n'), b, tail.join('\n')].filter((s) => s !== '').join('\n\n');
  let text = join(body);
  if (budgetBytes && utf8(text) > budgetBytes) {
    const room = budgetBytes - utf8(join(''));
    if (room > 256) {
      const w = windowText(body, room);
      if (w) body = w.text;
      text = join(body);
    } else {
      const w = windowText(text, budgetBytes);
      if (w) text = w.text;
    }
  }
  return text;
}

// The engine entry: compressed only when the reduced text is smaller than the page.
function run(text, opts, ctx) {
  const out = slimHtml(text, opts.budgetBytes, ctx && ctx.deadline);
  if (out === null) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  if (utf8(out) >= utf8(text)) return { decision: 'passthrough', reason: 'no-gain', text };
  return { decision: 'compressed', text: out, stages: ['html'] };
}

module.exports = { id: 'html', run, slimHtml, decode };
