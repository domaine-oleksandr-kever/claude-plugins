#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/html.cjs — the html engine — on a small golden page built
// inline (exact output asserted) and on tests/fixtures/page.html (structure asserted), plus the
// robustness rows: malformed markup, empty input, XML, determinism and the byte budget.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const html = require(path.join(ROOT, 'plugins/slim/scripts/engines/html.cjs'));
const { compress, sniff } = require(path.join(ROOT, 'plugins/slim/scripts/engines/index.cjs'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
  `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

const GOLDEN_IN = `<!DOCTYPE html>
<html><head>
<title>  Studio &amp; Shop  </title>
<meta name="description" content="Mugs &amp; bowls">
<meta property="og:title" content="Studio">
<link rel="canonical" href="https://studio.example/">
<style>.x{color:red}</style>
<script src="/a.js"></script>
<script>var secret = "INLINE-SCRIPT";</script>
</head>
<body>
<nav><a href="/shop">Shop</a> <a href="/about">About us</a></nav>
<!-- a comment -->
<h1>Welcome</h1>
<p>Our studio&#8217;s mugs&nbsp;are hand&#x2011;made. <a href="/shop">Browse the shop</a>.</p>
<svg><text>SVG-TEXT</text></svg>
<h2>Range</h2>
<ul><li>Mug</li><li>Bowl <ul><li>Small</li></ul></li></ul>
<ol><li>Pick</li><li>Pay</li></ol>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Mug</td><td>£20</td></tr></table>
<pre><code>wash by hand
dry flat</code></pre>
<p>Use <code>care-kit</code> weekly.</p>
<div aria-hidden="true">HIDDEN-TEXT <a href="/hidden">Hidden link</a></div>
<footer>Footer text <a href="/terms">Terms</a></footer>
<script src="https://cdn.example/b.js" async></script>
</body></html>`;

const GOLDEN_OUT = `# Studio & Shop
meta: description=Mugs & bowls; og:title=Studio; canonical=https://studio.example/

# Welcome

Our studio’s mugs are hand‑made. Browse the shop.

## Range

- Mug
- Bowl
  - Small

1. Pick
2. Pay

Item | Price
Mug | £20

\`\`\`
wash by hand
dry flat
\`\`\`

Use \`care-kit\` weekly.

links (4):
- Shop → /shop
- About us → /about
- Hidden link → /hidden
- Terms → /terms
scripts (2):
- /a.js
- https://cdn.example/b.js`;

{
  const out = html.slimHtml(GOLDEN_IN);
  eq('H1-golden', out, GOLDEN_OUT);
  check('H1-no-inline', !out.includes('INLINE-SCRIPT') && !out.includes('SVG-TEXT') && !out.includes('color:red') && !out.includes('a comment'), out);
  check('H1-muted-text', !out.includes('HIDDEN-TEXT') && !out.includes('Footer text') && !/^Shop About us$/m.test(out), out);
  check('H1-dedupe-first-text-wins', out.includes('- Shop → /shop') && !out.includes('Browse the shop →'), out);
}

// The committed page, by structure.
{
  const page = readFileSync(path.join(ROOT, 'tests/fixtures/page.html'), 'utf8');
  const r = compress({ data: page }, { maxMs: 0 });
  const t = r.text;
  const heads = t.split('\n').filter((l) => /^#{1,6} /.test(l));
  eq('H2-title-first', heads[0], '# Northwind Ceramics — Spring Catalogue');
  eq('H2-heading-order', heads.slice(1, 5), ['# Spring Catalogue', heads[2], '### Notes 1', heads[4]]);
  check('H2-h2-chapter', /^## Chapter 1: /.test(heads[2]) && /^## Chapter 2: /.test(heads[4]), heads.slice(0, 6).join(' | '));
  check('H2-meta', t.split('\n')[1] === 'meta: description=Handmade stoneware & porcelain from the Northwind studio.; og:title=Northwind Ceramics Spring; canonical=https://northwind-ceramics.example/pages/spring', t.split('\n')[1]);
  check('H2-nav-text-out', !/^Range 1 Range 2/m.test(t) && t.includes('- Range 1 → /collections/range-01'), 'nav text in the body or its links missing');
  const linkLines = t.slice(t.indexOf('\nlinks (')).split('\n').filter((l) => l.startsWith('- ') && l.includes(' → '));
  eq('H2-links-unique', new Set(linkLines.map((l) => l.split(' → ')[1])).size, linkLines.length);
  check('H2-links-first-text', t.includes('- Piece 1 → /products/piece-01') && !t.includes('Piece 1 again →'), 'a repeat link replaced the first text');
  check('H2-scripts', t.endsWith('scripts (6):\n- /cdn/shop/t/12/assets/vendor.js\n- /cdn/shop/t/12/assets/theme.js\n- https://cdn.feedhopper.io/widget.js\n- https://static.reviewsly.example/v3/reviews.js\n- /cdn/shop/t/12/assets/cart-drawer.js\n- https://analytics.example.net/collect.js'), t.slice(-300));
  check('H2-entities', t.includes('Northwind studio’s spring range — ') && !/&(?:amp|nbsp|#8217);/.test(t), 'an entity survived');
  check('H2-lists', /^- Piece 1 — /m.test(t) && /^1\. /m.test(t) && /^Piece \| Glaze \| Price$/m.test(t), 'list or table lines missing');
  check('H2-table-row', /^Piece 1 \| \w[\w-]* \| €20$/m.test(t), 'table row');
  check('H2-pre', t.includes('```\ncare: hand-wash, no microwave\n```'), 'pre not fenced');
}

// Robustness
{
  const malformed = ['<', '<<<>>>', '<div><p>unclosed', '<a href="/x">no close', '<script>never closed', '</p></div>stray closers',
    '<p title="a > b">x</p>', '<!-- open comment', '<svg><svg></svg>', '<table><td>x<td>y', `<p>${'<b>'.repeat(5000)}deep</p>`, '&#xZZ; &#99999999; &bogus;'];
  for (const [i, m] of malformed.entries()) {
    let out = null;
    let threw = null;
    try { out = html.slimHtml(m); } catch (e) { threw = e; }
    check(`H3-malformed-${i}`, threw === null && typeof out === 'string', String(threw));
  }
  eq('H3-deep-text', html.slimHtml(`<p>${'<b>'.repeat(5000)}deep</p>`).includes('deep'), true);
  eq('H3-bad-entities-kept', html.slimHtml('<p>&#xZZ; &bogus; &#99999999;</p>').includes('&#xZZ; &bogus; &#99999999;'), true);
  const e = compress({ data: '' }, { maxMs: 0 });
  eq('H4-empty', [e.decision, e.reason], ['passthrough', 'empty']);
  const tiny = html.run('<b>x</b>', {});
  eq('H4-no-gain', [tiny.decision, tiny.reason], ['passthrough', 'no-gain']);
  const xml = '<?xml version="1.0"?>\n<feed><entry><title>x</title></entry></feed>';
  eq('H5-xml-not-html', [sniff({ data: xml }).engine, sniff({ data: xml }).reason], ['text', 'xml']);
  const frag = '<frame id="1" name="Card"><frame id="2" name="Title"/></frame>';
  eq('H5-fragment-not-html', sniff({ data: frag }).reason, 'xml');
  const page = readFileSync(path.join(ROOT, 'tests/fixtures/page.html'), 'utf8');
  eq('H6-deterministic', html.slimHtml(page), html.slimHtml(page));
  const clipped = compress({ data: page }, { maxMs: 0, budgetBytes: 6000 });
  check('H7-budget', bytes(clipped.text) <= 6000 && clipped.text.startsWith('# Northwind') && clipped.text.includes('scripts (6):') && /\[slim: [\d,]+ (?:of [\d,]+ lines )?hidden/.test(clipped.text), `${bytes(clipped.text)} B`);
  const unclipped = compress({ data: page }, { maxMs: 0 });
  check('H7-no-budget-no-clip', !/\[slim: /.test(unclipped.text), 'clipped without a budget');
}

console.log(`html-slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
