#!/usr/bin/env node
// Prints a deterministic Shopify-style product export for slim's csv fixtures: 12,480 variant rows ×
// 14 columns (~2 MB), a quoted `Body (HTML)` with commas and an occasional line break, TRUE/FALSE
// `Published`, blank compare-at prices, four statuses, and `NW-…` SKUs. Argument: the row count.
'use strict';

let seed = 1248;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ROWS = Number(process.argv[2]) || 12480;
const NOUNS = ['Mug', 'Bowl', 'Plate', 'Vase', 'Planter', 'Tumbler', 'Carafe', 'Platter', 'Jug', 'Candle'];
const ADJ = ['Speckled', 'Matte', 'Glazed', 'Ribbed', 'Stoneware', 'Hand-thrown', 'Oat', 'Charcoal', 'Sage', 'Coral'];
const VENDORS = ['Northwind Studio', 'Clay & Kiln', 'Harbour Ceramics', 'Fieldhouse'];
const TYPES = ['Drinkware', 'Tableware', 'Decor', 'Home Fragrance'];
const SIZES = ['Small', 'Medium', 'Large', 'XL'];
const STATUS = ['active', 'active', 'active', 'draft', 'archived', 'unlisted'];
const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const out = ['Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Qty,Variant Price,Variant Compare At Price,Status'];
for (let i = 0; out.length <= ROWS; i++) {
  const title = `${pick(ADJ)} ${pick(NOUNS)} ${i}`;
  const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const body = `<p>${title}, made in small batches${rnd() < 0.05 ? '.</p>\n<p>Dishwasher safe' : ''}, glazed by hand.</p>`;
  const tags = [pick(TYPES).toLowerCase(), pick(['gift', 'new', 'sale', 'bestseller'])].join(', ');
  const published = rnd() < 0.8 ? 'TRUE' : 'FALSE';
  const vendor = pick(VENDORS);
  const type = pick(TYPES);
  const status = pick(STATUS);
  for (const size of SIZES) {
    if (out.length > ROWS) break;
    const price = (4 + Math.floor(rnd() * 129500) / 100).toFixed(2);
    const compare = rnd() < 0.7 ? '' : (Number(price) * 1.25).toFixed(2);
    out.push([handle, q(title), q(body), q(vendor), type, q(tags), published, size, `NW-${String(i).padStart(5, '0')}-${size[0]}`,
      String(200 + Math.floor(rnd() * 1800)), String(Math.floor(rnd() * 400) - 20), price, compare, status].join(','));
  }
}
process.stdout.write(`${out.join('\n')}\n`);
