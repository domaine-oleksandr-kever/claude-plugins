#!/usr/bin/env node
// Fixture suite for plugins/base/scripts/storefront-overlay.js (the in-page overlay helper of
// references/storefront-login.md): run in a vm against a minimal stub DOM, both the way Playwright's
// addScriptTag loads it (a classic script) and the way chrome-devtools' evaluate_script sourcePath does (a
// function source), plus the proof that base's storefront-login guard passes its code. Exit 0 = all green.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'plugins/base/scripts/storefront-overlay.js'), 'utf8');
const LOGIN_TS = fs.readFileSync(path.join(ROOT, 'plugins/base/hooks/mods/guards/login.ts'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(`[${name}]\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- stub DOM: the selector subset the helper and these fixtures use ---------------------------------
const VW = 1000, VH = 800;
class El {
  constructor(tag, attrs = {}, style = {}, rect = [0, 0, 100, 40], children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs;
    this.id = attrs.id || ''; this.className = attrs.class || '';
    this.st = { display: 'block', visibility: 'visible', opacity: '1', position: 'static', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible', ...style };
    this.rect = rect; this.parentElement = null; this.children = [];
    for (const c of children) this.append(c);
  }
  append(c) { c.parentElement = this; this.children.push(c); return this; }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  getBoundingClientRect() { const [left, top, width, height] = this.rect; return { left, top, width, height }; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  contains(o) { for (let a = o; a; a = a.parentElement) if (a === this) return true; return false; }
  matches(sel) { return sel.split(',').some((s) => matchChain(this, s.trim())); }
  closest(sel) { for (let a = this; a; a = a.parentElement) if (a.matches(sel)) return a; return null; }
  querySelector(sel) { return this.descendants().find((d) => d.matches(sel)) || null; }
  remove() { const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); this.parentElement = null; }
}
// A compound selector, or a chain of them joined by the child combinator `>`.
function matchChain(el, s) {
  if (s === 'body *') return el.tagName !== 'BODY' && !!el.parentElement && !!el.parentElement.closest('body');
  const parts = s.split(/\s*>\s*/);
  for (let i = parts.length - 1, a = el; i >= 0; i--, a = a && a.parentElement) if (!a || !matchOne(a, parts[i])) return false;
  return true;
}
const PART = /#[\w-]+|\.[\w-]+|\[[^\]]+\]|:disabled|:nth-child\(\d+\)/g;
function matchOne(el, s) {
  const m = /^([a-z]*)((?:#[\w-]+|\.[\w-]+|\[[^\]]+\]|:disabled|:nth-child\(\d+\))*)$/i.exec(s);
  if (!m || !s) throw new SyntaxError(`'${s}' is not a valid selector`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(PART) || []) {
    if (part === ':disabled') { if (!('disabled' in el.attrs)) return false; continue; }
    if (part[0] === '#') { if (el.id !== part.slice(1)) return false; continue; }
    if (part[0] === '.') { if (!el.className.split(/\s+/).includes(part.slice(1))) return false; continue; }
    if (part[0] === ':') { const p = el.parentElement; if (!p || p.children.indexOf(el) + 1 !== Number(part.slice(11, -1))) return false; continue; }
    const a = /^\[([\w-]+)(?:(\*?=)"?([^"]*)"?)?\]$/.exec(part);
    const v = el.getAttribute(a[1]);
    if (v === null) return false;
    if (a[2] === '=' && v !== a[3]) return false;
    if (a[2] === '*=' && !v.includes(a[3])) return false;
  }
  return true;
}
function page(body, hitAt = () => null) {
  const html = new El('html', {}, {}, [0, 0, VW, VH], [body]);
  const document = {
    body,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.descendants().filter((d) => d.matches(sel)),
    elementFromPoint: hitAt,
  };
  return { document, getComputedStyle: (el) => el.st, innerWidth: VW, innerHeight: VH };
}
const FULL = [0, 0, VW, VH];
const FIXED = { position: 'fixed' };
const asScript = (ctx) => vm.runInNewContext(`${SRC}\n;storefrontOverlay`, ctx);
const asFunction = (ctx) => vm.runInNewContext(`(${SRC}\n)`, ctx);

// --- the file's shape -----------------------------------------------------------------------------------
{
  const ctx = page(new El('body'));
  vm.runInNewContext(SRC, ctx);
  check('classic script defines the storefrontOverlay global', typeof ctx.storefrontOverlay, 'function');
  check('function source evaluates to the same function', typeof asFunction(page(new El('body'))), 'function');
}

// --- removal --------------------------------------------------------------------------------------------
{
  const ot = new El('div', { id: 'onetrust-consent-sdk' }, {}, [0, 0, 0, 0], [new El('div', { class: 'onetrust-pc-dark-filter' }, FIXED, FULL)]);
  const cb = new El('div', { id: 'CybotCookiebotDialog' }, FIXED, [0, 600, VW, 200]);
  const modal = new El('div', { id: 'region-modal', 'aria-modal': 'true' }, FIXED, FULL);
  const body = new El('body', {}, {}, FULL, [new El('header'), ot, cb, modal]);
  const ctx = page(body);
  const r = asFunction(ctx)();
  check('known overlays removed, no opts', r.removed, ['#onetrust-consent-sdk', '#CybotCookiebotDialog']);
  check('a project modal stays without hide and is reported covering', r.covering, ['div#region-modal']);
  check('no probe key without a probe', 'probe' in r, false);
  check('removed from the DOM', body.children.map((c) => c.tagName + c.id), ['HEADER', 'DIVregion-modal']);
  const r2 = asScript(ctx)({ hide: ['#region-modal', '[['] });
  check('a hide selector removes the project overlay', r2.removed, ['#region-modal']);
  check('an invalid selector is kept, not thrown', r2.kept, ['[[ (invalid selector)']);
  check('nothing covers after the hide', r2.covering, []);
}
{
  const gate = new El('form', { action: '/password' }, {}, [0, 0, 300, 100], [new El('input', { name: 'password', type: 'text' })]);
  const wrap = new El('div', { class: 'wrap' }, {}, FULL, [gate]);
  const body = new El('body', {}, {}, FULL, [wrap]);
  const r = asScript(page(body))({ hide: ['div', 'form', 'input'] });
  check('an element holding or inside the password gate is never removed', r.removed, []);
  check('…and each is named in kept', r.kept, ['div (holds the password gate)', 'form (holds the password gate)', 'input (holds the password gate)']);
  check('the gate is still in the DOM', body.querySelector('form[action*="/password"]') === gate, true);
}

// --- covering ---------------------------------------------------------------------------------------------
{
  const inner = new El('div', { class: 'box inner extra' }, {}, [350, 300, 300, 200]);
  const backdrop = new El('div', { id: 'backdrop' }, FIXED, FULL, [inner]);
  const body = new El('body', {}, {}, FULL, [
    backdrop,
    new El('div', { id: 'glass' }, { ...FIXED, pointerEvents: 'none' }, FULL),
    new El('div', { id: 'gone' }, { ...FIXED, display: 'none' }, FULL),
    new El('div', { id: 'clear' }, { ...FIXED, opacity: '0' }, FULL),
    new El('header', { id: 'sticky' }, FIXED, [0, 0, VW, 80]),
    new El('dialog', { open: '', class: 'drawer' }, {}, [600, 0, 400, VH]),
  ]);
  const r = asScript(page(body))();
  check('full-viewport fixed and open modals only, outermost only', r.covering, ['div#backdrop', 'dialog.drawer']);
}

// --- probe ------------------------------------------------------------------------------------------------
{
  const btn = new El('button', { id: 'try' }, {}, [100, 100, 100, 40]);
  const next = new El('button', { 'data-carousel-next': '', disabled: '' }, {}, [300, 100, 40, 40]);
  const aria = new El('a', { id: 'aria', 'aria-disabled': 'true' }, {}, [400, 100, 40, 40]);
  const hid = new El('button', { id: 'hid' }, { visibility: 'hidden' }, [500, 100, 40, 40]);
  const far = new El('button', { id: 'far' }, {}, [100, 2000, 100, 40]);
  const label = new El('span', {}, {}, [110, 110, 50, 20]);
  btn.append(label);
  const box = new El('div', { class: 'box' }, {}, [0, 0, 400, 300]);
  const modal = new El('div', { id: 'region-modal' }, FIXED, FULL, [box]);
  const body = new El('body', {}, {}, FULL, [btn, next, aria, hid, far, modal]);
  let hit = box;
  const ctx = page(body, (x, y) => (x === 150 && y === 120 ? hit : null));
  const f = asScript(ctx);
  check('covered: the element at the centre and its fixed layer', f({ probe: '#try' }).probe,
    { target: '#try', found: true, disabled: false, hidden: false, covered: true, by: 'div.box', layer: 'div#region-modal' });
  hit = modal;
  check('covered by the layer itself: no separate layer', f({ probe: '#try' }).probe,
    { target: '#try', found: true, disabled: false, hidden: false, covered: true, by: 'div#region-modal' });
  hit = label;
  check('a hit inside the target is not covered', f({ probe: '#try' }).probe.covered, false);
  check('disabled attribute', f({ probe: '[data-carousel-next]' }).probe.disabled, true);
  check('aria-disabled', f({ probe: '#aria' }).probe.disabled, true);
  check('hidden: no hit test', f({ probe: '#hid' }).probe, { target: '#hid', found: true, disabled: false, hidden: true });
  check('offscreen centre', f({ probe: '#far' }).probe.offscreen, true);
  check('not found', f({ probe: '#nope' }).probe, { target: '#nope', found: false });
  hit = box;
  check('an Element argument (a chrome-devtools uid) is probed', asFunction(ctx)(btn).probe.target, 'button#try');
}

// --- names that select one element, removal counts, an off-canvas drawer ----------------------------------
{
  const menu = new El('div', { class: 'fixed inset-0 menu' }, { ...FIXED, pointerEvents: 'none' }, FULL);
  const modal = new El('div', { class: 'fixed inset-0 z-100' }, FIXED, FULL);
  const drawer = new El('div', { id: 'menu-drawer' }, FIXED, [-VW, 0, VW, VH]);
  const body = new El('body', {}, {}, FULL, [new El('header', { id: 'hdr' }, {}, [0, 0, VW, 80], [menu]), modal, drawer]);
  const ctx = page(body);
  const r = asScript(ctx)();
  check('a shared class pair is named by its path, not by the classes alone', r.covering, ['body > div.fixed.inset-0:nth-child(2)']);
  check('a closed off-canvas drawer is not covering', r.covering.some((c) => c.includes('menu-drawer')), false);
  const r2 = asScript(ctx)({ hide: r.covering });
  check('hiding the reported name removes that element only', [r2.removed, menu.parentElement !== null, modal.parentElement], [['body > div.fixed.inset-0:nth-child(2)'], true, null]);
  const r3 = asScript(page(new El('body', {}, {}, FULL, [new El('div', { class: 'fixed a' }), new El('div', { class: 'fixed b' })])))({ hide: ['div.fixed'] });
  check('a selector that removed several elements says how many', r3.removed, ['div.fixed ×2']);
}

// --- probe: a hit on the target's own ancestor, a fixed drawer, a clipped slide, a bad selector ------------
{
  const atc = new El('button', { id: 'atc' }, { pointerEvents: 'none' }, [100, 100, 100, 40]);
  const form = new El('div', { id: 'pf', class: 'product-form' }, {}, [0, 0, 400, 300], [atc]);
  const footer = new El('div', { class: 'drawer-footer' }, {}, [600, 600, 400, 200]);
  const checkout = new El('button', { id: 'checkout' }, {}, [700, 640, 100, 40]);
  const cart = new El('div', { id: 'CartDrawer', class: 'cart-drawer' }, FIXED, [600, 0, 400, VH], [checkout, footer]);
  const slide = new El('button', { id: 'next-slide-btn' }, {}, [600, 400, 40, 40]);
  const track = new El('div', { class: 'track' }, { overflowX: 'hidden' }, [0, 380, 500, 100], [slide]);
  const main = new El('main', { id: 'MainContent' }, {}, FULL, [form, track]);
  const body = new El('body', {}, {}, FULL, [main, cart]);
  const hits = { '150,120': form, '750,660': footer, '620,420': main };
  const f = asScript(page(body, (x, y) => hits[`${x},${y}`] || null));
  check('a target with pointer-events none is disabled, never covered by its own form', f({ probe: '#atc' }).probe,
    { target: '#atc', found: true, disabled: true, hidden: false, covered: false });
  check('a layer never contains the target: the cart drawer is not the layer', f({ probe: '#checkout' }).probe,
    { target: '#checkout', found: true, disabled: false, hidden: false, covered: true, by: 'div.drawer-footer' });
  check('a centre outside a clipping ancestor is offscreen, not covered by main', f({ probe: '#next-slide-btn' }).probe,
    { target: '#next-slide-btn', found: true, disabled: false, hidden: false, offscreen: true });
  const bad = f({ hide: ['#CartDrawer'], probe: '[[' });
  check('an invalid probe selector is reported next to the removals', [bad.removed, bad.probe], [['#CartDrawer'], { target: '[[', found: false, error: 'invalid selector' }]);
}

// --- the storefront-login guard ------------------------------------------------------------------------
// isStorefrontLogin and isLoginCall both answer false when no ACT pattern matches, so the guard's own ACT list,
// read from login.ts, proves the helper passes it whichever way a call carries its code.
{
  const block = /const ACT = \[\n([\s\S]*?)\n\]/.exec(LOGIN_TS);
  const act = block ? block[1].split('\n').map((l) => /^\s*\/(.+)\/([a-z]*),?\s*$/.exec(l)).filter(Boolean).map((m) => new RegExp(m[1], m[2])) : [];
  check('login.ts ACT list read', act.length >= 5, true);
  check('no fill, value write, submit, POST or password field append in the helper', act.filter((r) => r.test(SRC)).map(String), []);
}

for (const f of failures) console.error(f);
console.log(`base-storefront-overlay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
