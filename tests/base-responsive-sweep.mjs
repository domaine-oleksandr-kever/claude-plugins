#!/usr/bin/env node
// Fixture suite for plugins/base/scripts/responsive-sweep.js (the in-page sweep of references/responsive-sweep.md):
// run in a vm against a minimal stub DOM, loaded both ways the MCPs load it (a classic script, a function source):
// the width list, every finding kind and its false-positive guards, the stable selectors, the range table with its
// caps, and the proof that base's storefront-login guard passes its code. Exit 0 = all green.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'plugins/base/scripts/responsive-sweep.js'), 'utf8');
const LOGIN_TS = fs.readFileSync(path.join(ROOT, 'plugins/base/hooks/mods/guards/login.ts'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(`[${name}]\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- stub DOM: the selector subset and the layout reads the snippet uses ---------------------------------
const box = ([left, top, width, height]) => ({ left, top, width, height, right: left + width, bottom: top + height });
class Text { constructor(t, rects) { this.nodeType = 3; this.textContent = t; this.rects = rects; } }
class El {
  // o: { id, class, role, style, rect [l,t,w,h], sw/cw/sh/ch (scroll/client sizes), text, lines (text rects), hidden }
  constructor(tag, o = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.o = o;
    this.id = o.id || ''; this.className = o.class || '';
    this.st = { visibility: 'visible', overflowX: 'visible', overflowY: 'visible', textOverflow: 'clip', webkitLineClamp: 'none', ...o.style };
    this.parentElement = null; this.children = [];
    this.childNodes = o.text ? [new Text(o.text, (o.lines || [o.rect || [0, 0, 100, 20]]).map(box))] : [];
    for (const c of children) { c.parentElement = this; this.children.push(c); this.childNodes.push(c); }
    const r = box(o.rect || [0, 0, 100, 20]);
    this.clientWidth = o.cw ?? r.width; this.scrollWidth = o.sw ?? this.clientWidth;
    this.clientHeight = o.ch ?? r.height; this.scrollHeight = o.sh ?? this.clientHeight;
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  getBoundingClientRect() { return box(this.o.rect || [0, 0, 100, 20]); }
  getClientRects() { return this.o.hidden ? [] : [this.getBoundingClientRect()]; }
  // What a Range over this element's contents returns: its text rects and every child element's own box.
  rangeRects() { return this.childNodes.flatMap((n) => (n.nodeType === 3 ? n.rects : [n.getBoundingClientRect(), ...n.rangeRects()])); }
  textNodes() { return this.childNodes.flatMap((n) => (n.nodeType === 3 ? [n] : n.textNodes())); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  contains(x) { for (let a = x; a; a = a.parentElement) if (a === this) return true; return false; }
  matches(sel) { return sel.split(',').some((s) => matchOne(this, s.trim())); }
  closest(sel) { for (let a = this; a; a = a.parentElement) if (a.matches(sel)) return a; return null; }
  querySelector(sel) { return this.descendants().find((d) => d.matches(sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((d) => d.matches(sel)); }
}
function matchOne(el, s) {
  if (s === '*') return true;
  if (s[0] === '#') return el.id === s.slice(1);
  const role = /^\[role=([\w-]+)\]$/.exec(s);
  if (role) return el.o.role === role[1];
  if (!/^[a-z][a-z0-9]*$/.test(s)) throw new SyntaxError(`stub cannot match '${s}'`);
  return el.tagName === s.toUpperCase();
}
const VW = 1000;
function page(body, { width = VW, scrollWidth = width } = {}) {
  const html = new El('html', { rect: [0, 0, width, 800], cw: width, sw: scrollWidth }, [body]);
  return {
    body, documentElement: html,
    querySelector: (sel) => html.querySelector(sel),
    createRange: () => { let n = null; return { selectNodeContents: (x) => { n = x; }, getClientRects: () => (n.nodeType === 3 ? n.rects : n.rangeRects()) }; },
    createTreeWalker: (root, what) => { const list = what === 4 ? root.textNodes() : []; let i = 0; return { nextNode: () => list[i++] || null }; },
    fonts: { ready: Promise.resolve() },
  };
}
function context(document, width = VW) {
  return {
    document, innerWidth: width,
    getComputedStyle: (el) => el.st,
    NodeFilter: { SHOW_TEXT: 4 },
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
}
const asScript = (ctx) => vm.runInNewContext(`${SRC}\n;responsiveSweep`, ctx);
const asFunction = (ctx) => vm.runInNewContext(`(${SRC}\n)`, ctx);
const findings = (ctx) => ctx.__responsiveSweep.seen[ctx.innerWidth];

// --- the file's shape and the width list ---------------------------------------------------------------
{
  const ctx = context(page(new El('body')));
  vm.runInNewContext(SRC, ctx);
  check('classic script defines the responsiveSweep global', typeof ctx.responsiveSweep, 'function');
  check('function source evaluates to the same function', typeof asFunction(context(page(new El('body')))), 'function');
  const w = ctx.responsiveSweep({ widths: [] });
  check('default widths: 320 to 1920 every 40 px', [w.length, w[0], w[1], w[w.length - 1]], [41, 320, 360, 1920]);
  const b = ctx.responsiveSweep({ widths: [768, '1024px'] });
  check('each breakpoint and 1 px below join the list, sorted', b.filter((x) => x > 760 && x < 1050), [767, 768, 800, 840, 880, 920, 960, 1000, 1023, 1024, 1040]);
  const c = ctx.responsiveSweep({ widths: [1150], step: 160 });
  check('a coarser step keeps both ends and the breakpoints', c, [320, 480, 640, 800, 960, 1120, 1149, 1150, 1280, 1440, 1600, 1760, 1920]);
  check('starting a sweep clears the measured widths', Object.keys(ctx.__responsiveSweep.seen), []);
  const em = ctx.responsiveSweep({ widths: ['48em', '64rem'], step: 800 });
  check('em and rem breakpoints are 16 px each', [em, ctx.__responsiveSweep.bps], [[320, 767, 768, 1023, 1024, 1120, 1920], [768, 1024]]);
}

// --- false-positive guards: an icon or image above a label, a visually-hidden skip link -----------------------
{
  const card = new El('a', { class: 'card-link', rect: [0, 0, 200, 170] }, [
    new El('img', { rect: [0, 0, 200, 150] }), new El('span', { text: 'Linen shirt', rect: [0, 150, 200, 20] })]);
  const icon = new El('button', { class: 'icon-btn', rect: [300, 0, 60, 60] }, [
    new El('svg', { rect: [315, 0, 30, 30] }), new El('span', { text: 'Menu', rect: [310, 34, 40, 20] })]);
  const skip = new El('button', { class: 'sr-only', style: { overflowX: 'hidden', overflowY: 'hidden' }, text: 'Skip to Content',
    rect: [0, 0, 1, 1], cw: 1, sw: 117, ch: 1, sh: 24, lines: [[0, 0, 40, 20], [0, 20, 60, 20]] });
  const ctx = context(page(new El('body', {}, [new El('main', { id: 'main' }, [card, icon, skip])])));
  const run = asScript(ctx);
  run({ widths: [] });
  check('a label under an image or icon is one line; a 1 px sr-only element is no finding', await run({ root: '#main' }), { width: VW, findings: 0 });
}

// --- one width: every finding kind -------------------------------------------------------------------------
{
  const links = [0, 1, 2].map((i) => new El('a', { class: 'md:px-4 menu-link', text: 'Shop all', rect: [i * 100, 0, 90, 40], lines: [[i * 100, 0, 90, 20], [i * 100, 20, 60, 20]] }));
  const nav = new El('nav', { id: 'nav' }, [
    ...links.map((a) => new El('li', { class: 'item' }, [a])),
    new El('a', { class: 'inline', text: 'Sale', rect: [400, 0, 60, 20], lines: [[400, 0, 30, 20], [430, 2, 30, 16]] }),
    new El('a', { class: 'gone', text: 'Two\nlines', hidden: true, lines: [[0, 0, 9, 9], [0, 30, 9, 9]] }),
  ]);
  const longH2 = new El('h2', { text: 'A long heading sentence that is meant to wrap on narrow screens', lines: [[0, 0, 9, 20], [0, 20, 9, 20]] });
  const clipBox = new El('div', { class: 'card', style: { overflowY: 'hidden' }, rect: [0, 100, 300, 120], ch: 120, sh: 180 }, [
    new El('p', { text: 'Long copy', rect: [0, 110, 300, 170] }),
  ]);
  const clampBox = new El('p', { class: 'clamp', style: { overflowY: 'hidden', webkitLineClamp: '2' }, text: 'Clamped copy', ch: 40, sh: 80 });
  const decor = new El('div', { class: 'decor', style: { overflowY: 'hidden' }, rect: [0, 300, 300, 100], ch: 100, sh: 160 }, [
    new El('span', { class: 'blob', rect: [0, 350, 50, 110] }),
    new El('p', { text: 'fits', rect: [0, 300, 300, 40] }),
  ]);
  const nowrap = new El('span', { class: 'badge', style: { overflowX: 'hidden', textOverflow: 'ellipsis' }, text: 'Free shipping on orders', cw: 80, sw: 140 });
  const track = new El('div', { class: 'track', style: { overflowX: 'hidden' }, cw: 1000, sw: 3000 }, [new El('div', { class: 'slide', rect: [1000, 0, 1000, 20] }, [new El('h3', { text: 'Slide 2', rect: [1000, 0, 200, 20] })])]);
  const spillIn = new El('div', { class: 'inner', cw: 200, sw: 260 });
  const spillOut = new El('div', { class: 'outer', cw: 400, sw: 460 }, [spillIn]);
  const wide = new El('div', { class: 'wide', rect: [0, 500, 1040, 50] }, [new El('div', { class: 'wide-child', rect: [0, 500, 1040, 50] })]);
  const drawer = new El('div', { class: 'drawer', rect: [-400, 0, 400, 800] });
  const inline = new El('span', { class: 'chip', cw: 0, sw: 30 });
  const main = new El('main', { id: 'main' }, [nav, longH2, clipBox, clampBox, decor, nowrap, track, spillOut, wide, drawer, inline]);
  const body = new El('body', { style: { overflowX: 'hidden' } }, [main]);
  const ctx = context(page(body, { scrollWidth: 1040 }));
  const run = asScript(ctx);
  run({ widths: [] });
  const r = await run({ root: '#main' });
  check('measure answers the width and the finding count', r, { width: VW, findings: 9 });
  check('every finding at one width', findings(ctx).map((f) => [f.sel, f.kind, f.px, f.label]), [
    ['page', 'scroll', 40, ''],
    ['#nav li.item > a.menu-link', 'lines', 2, ''],
    ['#nav li.item > a.menu-link', 'lines', 2, ''],
    ['#nav li.item > a.menu-link', 'lines', 2, ''],
    ['#main > div.card', 'clip', 60, ''],
    ['#main > p.clamp', 'clip', 40, 'line-clamp'],
    ['#main > span.badge', 'clip-x', 60, 'ellipsis'],
    ['#main > div.wide', 'offscreen', 40, ''],
    ['#main div.outer > div.inner', 'spill', 60, ''],
  ]);
  check('the root name is kept for the table', ctx.__responsiveSweep.root, '#main');
  check('a missing root is an answer, not a throw', await run({ root: '#nope' }), { width: VW, error: 'root not found: #nope' });
  const byUid = await asFunction(ctx)(nav);
  check('an Element argument (a chrome-devtools uid) is the root', [byUid.findings, ctx.__responsiveSweep.root], [4, '#nav']);
}

// --- a sweep folded into the table ---------------------------------------------------------------------------
async function sweep(layout, widths, opts = {}) {
  const ctx = context(page(new El('body')));
  const run = asScript(ctx);
  const list = run({ widths, ...opts });
  for (const w of list) { ctx.document = page(layout(w), { width: w }); ctx.innerWidth = w; await run({ root: '#main' }); }
  return { ctx, run, list };
}
{
  // The nav wraps between 1024 and 1150; the fixed-height card cuts its text below 600.
  const layout = (w) => new El('body', {}, [new El('main', { id: 'main' }, [
    new El('nav', { id: 'header-nav' }, [0, 1].map((i) => new El('a', { class: 'link', text: 'Collections', rect: [i * 100, 0, 90, 40],
      lines: w >= 1024 && w <= 1150 ? [[i * 100, 0, 90, 20], [i * 100, 20, 40, 20]] : [[i * 100, 0, 90, 20]] }))),
    new El('div', { class: 'promo', style: { overflowY: 'hidden' }, rect: [0, 100, w, 120], ch: 120, sh: w < 600 ? 150 : 120, text: 'Promo copy' }),
  ])]);
  const { run, list } = await sweep(layout, [1024]);
  const table = run({ table: true });
  check('the table: one row per finding, ranges over the measured widths', table.split('\n'), [
    `responsive sweep: root #main, ${list.length} widths 320-1920 (step 40, breakpoints 1024 and 1 px below), 2 rows; a range runs from the first to the last measured width that shows it`,
    'element | finding | widths',
    '#main > div.promo | text cut by a fixed height +30px | 320-560',
    '#header-nav > a.link ×2 | 2 lines | 1024-1120',
  ]);
}
{
  const layout = (w) => new El('body', {}, [new El('main', { id: 'main' }, [
    new El('h3', { class: 'title', text: 'Title', lines: w < 400 ? [[0, 0, 9, 20], [0, 20, 9, 20], [0, 40, 9, 20]] : w < 500 || w > 1800 ? [[0, 0, 9, 20], [0, 20, 9, 20]] : [[0, 0, 9, 20]] }),
  ])]);
  const { run } = await sweep(layout, []);
  check('line counts are separate rows; a gap splits a range', run({ table: true }).split('\n').slice(2), [
    '#main > h3.title | 3 lines | 320-360',
    '#main > h3.title | 2 lines | 400-480, 1840-1920',
  ]);
}
{
  const { run } = await sweep(() => new El('body', {}, [new El('main', { id: 'main' })]), [], { step: 800 });
  check('no findings is said, not left blank', run({ table: true }).split('\n')[1], 'no findings at any measured width');
  const fresh = asScript(context(page(new El('body'))));
  check('a table before any measure', fresh({ table: true }), 'responsive sweep: no width measured');
}
{
  const layout = () => new El('body', {}, [new El('main', { id: 'main' },
    Array.from({ length: 50 }, (_, i) => new El('button', { id: `b${i}`, text: 'Add', lines: [[0, 0, 9, 20], [0, 20, 9, 20]] })))]);
  const { run } = await sweep(layout, [], { step: 800 });
  const capped = run({ table: true }).split('\n');
  check('rows are capped at 30 by default', capped.length, 2 + 30 + 1);
  check('the dropped rows are counted with the call that shows them', capped[capped.length - 1],
    '… 20 more rows dropped (cap 30 rows / 3000 bytes): responsiveSweep({ table: true, maxRows: 50, maxBytes: 12000 }) shows them');
  const small = run({ table: true, maxRows: 100, maxBytes: 600 });
  check('the byte cap holds for the rows, the drop line follows them', [Buffer.byteLength(small) <= 600 + 200, /^… \d+ more rows dropped \(cap 100 rows \/ 600 bytes\)/m.test(small)], [true, true]);
  check('every row when the caps allow', run({ table: true, maxRows: 50, maxBytes: 12000 }).split('\n').length, 52);
}

// --- the storefront-login guard ------------------------------------------------------------------------
{
  const block = /const ACT = \[\n([\s\S]*?)\n\]/.exec(LOGIN_TS);
  const act = block ? block[1].split('\n').map((l) => /^\s*\/(.+)\/([a-z]*),?\s*$/.exec(l)).filter(Boolean).map((m) => new RegExp(m[1], m[2])) : [];
  check('login.ts ACT list read', act.length >= 5, true);
  check('no fill, value write, submit, POST or password field append in the sweep', act.filter((r) => r.test(SRC)).map(String), []);
}

for (const f of failures) console.error(f);
console.log(`base-responsive-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
