#!/usr/bin/env node
// Prints a deterministic ~60 KB storefront page for slim's html fixtures and eval cases: a 40-link
// nav, an article with headings, lists, a table and 30 distinct links (plus repeats), six external
// scripts, an inline style carrying SENTINEL-STYLE-9Q, an inline script, an svg and a footer.
'use strict';

let seed = 20261007;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['glaze', 'stoneware', 'kiln', 'speckled', 'matte', 'celadon', 'handmade', 'studio', 'mug', 'bowl',
  'platter', 'vase', 'earthenware', 'porcelain', 'wheel-thrown', 'oatmeal', 'cobalt', 'rim', 'foot', 'firing',
  'collection', 'season', 'table', 'texture', 'colour', 'everyday', 'gift', 'small-batch', 'clay', 'finish'];
const sentence = (n) => {
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
};
const para = (s) => Array.from({ length: s }, () => sentence(8 + Math.floor(rnd() * 10))).join(' ');

const NAV = Array.from({ length: 40 }, (_, i) => [`/collections/range-${String(i + 1).padStart(2, '0')}`, `Range ${i + 1}`]);
const ARTICLE = Array.from({ length: 30 }, (_, i) => [`/products/piece-${String(i + 1).padStart(2, '0')}`, `Piece ${i + 1}`]);
const SCRIPTS = [
  '/cdn/shop/t/12/assets/vendor.js',
  '/cdn/shop/t/12/assets/theme.js',
  'https://cdn.feedhopper.io/widget.js',
  'https://static.reviewsly.example/v3/reviews.js',
  '/cdn/shop/t/12/assets/cart-drawer.js',
  'https://analytics.example.net/collect.js',
];

const out = [];
out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">');
out.push('<title>Northwind Ceramics — Spring Catalogue</title>');
out.push('<meta name="description" content="Handmade stoneware &amp; porcelain from the Northwind studio.">');
out.push('<meta property="og:title" content="Northwind Ceramics Spring">');
out.push('<link rel="canonical" href="https://northwind-ceramics.example/pages/spring">');
out.push(`<style>.SENTINEL-STYLE-9Q{color:#123}${Array.from({ length: 120 }, (_, i) => `.c${i}{margin:${i}px;padding:${i % 7}px}`).join('')}</style>`);
for (const s of SCRIPTS.slice(0, 2)) out.push(`<script src="${s}" defer></script>`);
out.push('<script>window.Northwind = window.Northwind || []; window.Northwind.push(["init", "SENTINEL-SCRIPT-4K"]);</script>');
out.push('</head>', '<body>');
out.push('<nav class="site-nav"><ul>');
for (const [href, text] of NAV) out.push(`<li><a href="${href}">${text}</a></li>`);
out.push('</ul></nav>');
out.push('<svg aria-hidden="true" width="0" height="0"><symbol id="icon-cart"><path d="M0 0h24v24H0z"/></symbol></svg>');
out.push('<main><article>');
out.push('<h1>Spring Catalogue</h1>');
out.push(`<p>Welcome to the Northwind studio&#8217;s spring range&nbsp;— ${para(3)}</p>`);
for (let s = 0; s < 6; s++) {
  out.push(`<h2>Chapter ${s + 1}: ${pick(WORDS)} &amp; ${pick(WORDS)}</h2>`);
  for (let p = 0; p < 4; p++) out.push(`<p>${para(5)}</p>`);
  out.push(`<h3>Notes ${s + 1}</h3>`);
  out.push('<ul>');
  for (let k = 0; k < 5; k++) {
    const [href, text] = ARTICLE[(s * 5 + k) % ARTICLE.length];
    out.push(`<li><a href="${href}">${text}</a> — ${sentence(9)}</li>`);
  }
  out.push('</ul>');
  out.push('<ol>');
  for (let k = 0; k < 3; k++) out.push(`<li>${sentence(7)}</li>`);
  out.push('</ol>');
  out.push(`<p>See also <a href="${NAV[s][0]}">${NAV[s][1]}</a> and <a href="${ARTICLE[s][0]}">${ARTICLE[s][1]} again</a>.</p>`);
}
out.push('<table><tr><th>Piece</th><th>Glaze</th><th>Price</th></tr>');
for (let r = 0; r < 12; r++) out.push(`<tr><td>Piece ${r + 1}</td><td>${pick(WORDS)}</td><td>€${20 + r * 3}</td></tr>`);
out.push('</table>');
out.push('<pre><code>care: hand-wash, no microwave</code></pre>');
out.push('</article></main>');
out.push('<footer><p>Northwind Ceramics, a small studio.</p><ul>');
for (const [href, text] of [['/policies/privacy', 'Privacy'], ['/policies/terms', 'Terms'], ['/pages/contact', 'Contact'], ['/policies/shipping', 'Shipping'], [NAV[0][0], NAV[0][1]]]) {
  out.push(`<li><a href="${href}">${text}</a></li>`);
}
out.push('</ul></footer>');
for (const s of SCRIPTS.slice(2)) out.push(`<script src="${s}" async></script>`);
out.push('</body>', '</html>');
let html = out.join('\n');
const pad = [];
while (Buffer.byteLength(html, 'utf8') + pad.join('\n').length < 60000) pad.push(`<!-- build ${pad.length} ${'x'.repeat(80)} -->`);
html = html.replace('</body>', `${pad.join('\n')}\n</body>`);
process.stdout.write(`${html}\n`);
