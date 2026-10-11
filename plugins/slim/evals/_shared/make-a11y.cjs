#!/usr/bin/env node
// Prints one deterministic browser accessibility snapshot for slim's a11y fixtures, as the browser
// MCP returns it: `node make-a11y.cjs plp|plp-devtools|pdp|cart|docs`.
//   plp           Playwright: a filter form, then three sections of 16 product cards (one sold out per
//                 section, an unnamed badge img per card, a ref-less wrapper per card)
//   plp-devtools  the same page in Chrome DevTools MCP's `uid=… role "name" attr` grammar
//   pdp           Playwright: gallery, a variant form (size / shade radios, quantity), an accordion,
//                 recommendations and long reviews
//   cart          Playwright: the page header behind an open cart drawer dialog with 8 line items
//   docs          Playwright: a prose documentation article (must not fold)
'use strict';

const KINDS = ['Serum', 'Cream', 'Cleanser', 'Toner', 'Mask', 'Balm', 'Oil', 'Mist'];
const SECTIONS = ['Best sellers', 'New in', 'Sale'];
const product = (s, i) => `${KINDS[(s * 3 + i) % KINDS.length]} No. ${s * 16 + i + 1}`;
const price = (s, i) => `$${(18 + ((s * 16 + i) * 7) % 90).toFixed(2)}`;
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');

function playwright(header, build) {
  let n = 0;
  const lines = [];
  const ref = () => `[ref=e${++n}]`;
  build((depth, s) => lines.push(`${'  '.repeat(depth)}- ${s.replace(/\{ref\}/g, () => ref())}`));
  return `${header}\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`;
}
const pageHeader = (url, title) => `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot`;

function siteHeader(add, d) {
  add(d, 'banner {ref}:');
  add(d + 1, 'link "Skip to content" {ref} [cursor=pointer]:');
  add(d + 2, '/url: "#MainContent"');
  add(d + 1, 'navigation "Main" {ref}:');
  add(d + 2, 'list {ref}:');
  for (const c of ['Shop', 'Skincare', 'Makeup', 'Hair', 'Body', 'Gifts', 'Journal', 'About']) {
    add(d + 3, 'listitem {ref}:');
    add(d + 4, `link "${c}" {ref} [cursor=pointer]:`);
    add(d + 5, `/url: /collections/${slug(c)}`);
  }
  add(d + 1, 'button "Search" {ref} [cursor=pointer]');
  add(d + 1, 'link "Cart (2 items)" {ref} [cursor=pointer]:');
  add(d + 2, '/url: /cart');
}

function card(add, d, s, i) {
  const name = product(s, i);
  add(d, 'listitem {ref}:');
  add(d + 1, 'generic:');
  add(d + 2, `link "${name}" {ref} [cursor=pointer]:`);
  add(d + 3, `/url: /products/${slug(name)}`);
  add(d + 3, `img "${name}" {ref}`);
  add(d + 2, 'img {ref}');
  add(d + 2, `heading "${name}" [level=3] {ref}`);
  add(d + 2, `generic {ref}: Regular price ${price(s, i)}`);
  if (i === 9) add(d + 2, 'generic {ref}: Sold out');
  add(d + 2, `button "Add to cart — ${name}" {ref} [cursor=pointer]${i === 9 ? ' [disabled]' : ''}`);
}

function plp() {
  return playwright(pageHeader('https://shop.example.invalid/collections/all', 'All products – Example Store'), (add) => {
    add(0, 'generic [active] {ref}:');
    siteHeader(add, 1);
    add(1, 'main {ref}:');
    add(2, 'heading "All products" [level=1] {ref}');
    add(2, 'group "Filters" {ref}:');
    for (const [f, on] of [['In stock', true], ['Vegan', false], ['Fragrance free', false], ['Refillable', true]]) {
      add(3, `checkbox "${f}"${on ? ' [checked]' : ''} {ref} [cursor=pointer]`);
    }
    add(3, 'combobox "Sort by" {ref}:');
    for (const o of ['Featured', 'Best selling', 'Price, low to high', 'Price, high to low']) add(4, `option "${o}"${o === 'Featured' ? ' [selected]' : ''}`);
    SECTIONS.forEach((title, s) => {
      add(2, 'generic {ref}:');
      add(3, `heading "${title}" [level=2] {ref}`);
      add(3, 'list {ref}:');
      for (let i = 0; i < 16; i++) card(add, 4, s, i);
    });
    add(2, 'navigation "Pagination" {ref}:');
    for (let p = 1; p <= 4; p++) {
      add(3, `link "Page ${p}" {ref} [cursor=pointer]:`);
      add(4, `/url: /collections/all?page=${p}`);
    }
    add(1, 'contentinfo {ref}:');
    add(2, 'paragraph {ref}: © 2026 Example Store');
  });
}

function plpDevtools() {
  let n = 0;
  const lines = [];
  const add = (d, s) => lines.push(`${'  '.repeat(d)}uid=1_${n++} ${s}`);
  const origin = 'https://shop.example.invalid';
  add(0, `RootWebArea "All products – Example Store" url="${origin}/collections/all"`);
  add(1, 'banner');
  add(2, `link "Skip to content" url="${origin}/collections/all#MainContent"`);
  add(2, 'navigation "Main"');
  add(3, 'list');
  for (const c of ['Shop', 'Skincare', 'Makeup', 'Hair', 'Body', 'Gifts', 'Journal', 'About']) {
    add(4, 'listitem');
    add(5, `link "${c}" url="${origin}/collections/${slug(c)}"`);
    add(6, `StaticText "${c}"`);
  }
  add(2, 'button "Search"');
  add(1, 'main');
  add(2, 'heading "All products" level="1"');
  add(2, 'group "Filters"');
  for (const [f, on] of [['In stock', true], ['Vegan', false], ['Fragrance free', false], ['Refillable', true]]) add(3, `checkbox "${f}"${on ? ' checked' : ''}`);
  add(3, 'combobox "Sort by" haspopup="listbox" value="Featured"');
  SECTIONS.forEach((title, s) => {
    add(2, `heading "${title}" level="2"`);
    add(2, 'list');
    for (let i = 0; i < 16; i++) {
      const name = product(s, i);
      add(3, 'listitem');
      add(4, `link "${name}" url="${origin}/products/${slug(name)}"`);
      add(5, `image "${name}" url="${origin}/cdn/shop/files/${slug(name)}.jpg"`);
      add(4, 'image');
      add(4, `heading "${name}" level="3"`);
      add(5, `StaticText "${name}"`);
      add(4, `StaticText "Regular price ${price(s, i)}"`);
      if (i === 9) add(4, 'StaticText "Sold out"');
      add(4, `button "Add to cart — ${name}"${i === 9 ? ' disabled' : ''}`);
    }
  });
  add(2, 'navigation "Pagination"');
  for (let p = 1; p <= 4; p++) add(3, `link "Page ${p}" url="${origin}/collections/all?page=${p}"`);
  add(1, 'contentinfo');
  add(2, 'StaticText "© 2026 Example Store"');
  return `# take_snapshot response\n## Latest page snapshot\n${lines.join('\n')}\n`;
}

const REVIEW = (i) => `I have used this every morning for ${i + 2} weeks. The texture is light, it sinks in quickly and my skin ` +
  `feels calmer by the evening. The pump jams now and then and the scent is stronger than I expected, which is why it ` +
  `is ${i % 2 ? 'four' : 'five'} stars and not more. Would buy again for the price.`;

function pdp() {
  const name = 'Serum No. 1';
  return playwright(pageHeader('https://shop.example.invalid/products/serum-no-1', `${name} – Example Store`), (add) => {
    add(0, 'generic [active] {ref}:');
    siteHeader(add, 1);
    add(1, 'main {ref}:');
    add(2, 'navigation "Breadcrumbs" {ref}:');
    for (const [t, u] of [['Home', '/'], ['Skincare', '/collections/skincare'], [name, '/products/serum-no-1']]) {
      add(3, `link "${t}" {ref} [cursor=pointer]:`);
      add(4, `/url: ${u}`);
    }
    add(2, 'region "Gallery" {ref}:');
    add(3, `img "${name} — front" {ref}`);
    add(3, 'list {ref}:');
    for (let i = 1; i <= 8; i++) {
      add(4, 'listitem {ref}:');
      add(5, `button "Show image ${i} of 8" {ref} [cursor=pointer]${i === 1 ? ' [pressed]' : ''}:`);
      add(6, 'img {ref}');
    }
    add(2, `heading "${name}" [level=1] {ref}`);
    add(2, 'generic {ref}: Regular price $18.00');
    add(2, 'form "Product options" {ref}:');
    add(3, 'radiogroup "Size" {ref}:');
    for (const [z, st] of [['15 ml', ''], ['30 ml', ' [checked]'], ['50 ml', ''], ['100 ml', ' [disabled]']]) add(4, `radio "${z}"${st} {ref} [cursor=pointer]`);
    add(3, 'radiogroup "Shade" {ref}:');
    for (let i = 1; i <= 14; i++) add(4, `radio "Shade ${String(i).padStart(2, '0')}"${i === 3 ? ' [checked]' : ''} {ref} [cursor=pointer]`);
    add(3, 'spinbutton "Quantity" {ref}: "1"');
    add(3, 'button "Decrease quantity" {ref} [cursor=pointer]');
    add(3, 'button "Increase quantity" {ref} [cursor=pointer]');
    add(3, 'button "Add to cart" {ref} [cursor=pointer]');
    add(3, 'status {ref}: Free shipping over $50');
    for (const [t, open] of [['Description', true], ['How to use', false], ['Ingredients', false], ['Shipping and returns', false]]) {
      add(2, `button "${t}"${open ? ' [expanded]' : ''} {ref} [cursor=pointer]`);
      if (open) {
        add(2, `region "${t}" {ref}:`);
        add(3, 'paragraph {ref}: A lightweight daily serum with niacinamide and panthenol that evens tone and supports the skin barrier. Suitable for all skin types.');
      }
    }
    add(2, 'generic {ref}:');
    add(3, 'heading "You may also like" [level=2] {ref}');
    add(3, 'list {ref}:');
    for (let i = 1; i <= 8; i++) card(add, 4, 1, i);
    add(2, 'generic {ref}:');
    add(3, 'heading "Reviews" [level=2] {ref}');
    add(3, 'list {ref}:');
    for (let i = 0; i < 10; i++) {
      add(4, 'listitem {ref}:');
      add(5, `heading "Calm skin, week ${i + 2}" [level=3] {ref}`);
      add(5, `paragraph {ref}: ${REVIEW(i)}`);
      add(5, `button "Helpful (${i * 3})" {ref} [cursor=pointer]`);
    }
    add(1, 'contentinfo {ref}:');
    add(2, 'paragraph {ref}: © 2026 Example Store');
  });
}

function cart() {
  return playwright(pageHeader('https://shop.example.invalid/collections/skincare', 'Skincare – Example Store'), (add) => {
    add(0, 'generic {ref}:');
    siteHeader(add, 1);
    add(1, 'main {ref}:');
    add(2, 'heading "Skincare" [level=1] {ref}');
    add(1, 'dialog "Your cart" [active] {ref}:');
    add(2, 'heading "Your cart (8)" [level=2] {ref}');
    add(2, 'button "Close cart" {ref} [cursor=pointer]');
    add(2, 'list {ref}:');
    for (let i = 0; i < 8; i++) {
      const name = product(0, i);
      add(3, 'listitem {ref}:');
      add(4, `link "${name}" {ref} [cursor=pointer]:`);
      add(5, `/url: /products/${slug(name)}?variant=4${String(1000 + i * 37)}`);
      add(5, `img "${name}" {ref}`);
      add(4, `generic {ref}: Size: ${['15 ml', '30 ml', '50 ml'][i % 3]}`);
      add(4, `generic {ref}: ${price(0, i)}`);
      add(4, `spinbutton "Quantity for ${name}" {ref}: "${1 + (i % 2)}"`);
      add(4, `button "Decrease quantity for ${name}" {ref} [cursor=pointer]`);
      add(4, `button "Increase quantity for ${name}" {ref} [cursor=pointer]`);
      add(4, `button "Remove ${name}" {ref} [cursor=pointer]`);
    }
    add(2, 'status {ref}: Subtotal $214.00');
    add(2, 'textbox "Order note" {ref}');
    add(2, 'checkbox "I agree with the terms and conditions" {ref} [cursor=pointer]');
    add(2, 'button "Check out" [disabled] {ref} [cursor=pointer]');
  });
}

const DOC = (s, p) => `Section ${s + 1}, paragraph ${p + 1}: a theme app extension renders inside the merchant's theme through app blocks ` +
  `and app embed blocks. Each block declares its settings in a schema, which the theme editor turns into controls; the ` +
  `values reach the block's Liquid as block.settings. Keep assets small, because the storefront loads them on every page.`;

function docs() {
  return playwright(pageHeader('https://docs.example.invalid/apps/theme-extensions', 'Theme app extensions – Docs'), (add) => {
    add(0, 'generic {ref}:');
    add(1, 'navigation "Docs" {ref}:');
    for (const t of ['Overview', 'Getting started', 'App blocks', 'App embeds', 'Settings', 'Assets']) {
      add(2, `link "${t}" {ref} [cursor=pointer]:`);
      add(3, `/url: /apps/theme-extensions/${slug(t)}`);
    }
    add(1, 'main {ref}:');
    add(2, 'heading "Theme app extensions" [level=1] {ref}');
    for (let s = 0; s < 6; s++) {
      add(2, `heading "Part ${s + 1}" [level=2] {ref}`);
      for (let p = 0; p < 4; p++) add(2, `paragraph {ref}: ${DOC(s, p)}`);
      add(2, `code {ref}: "shopify app generate extension --template theme_app_extension --name block-${s + 1}"`);
    }
  });
}

const BUILD = { plp, 'plp-devtools': plpDevtools, pdp, cart, docs };
const kind = process.argv[2];
if (!BUILD[kind]) {
  process.stderr.write(`usage: make-a11y.cjs ${Object.keys(BUILD).join('|')}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(BUILD[kind]());
}
