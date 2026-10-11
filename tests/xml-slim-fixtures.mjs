#!/usr/bin/env node
// Suite for slim's xml engine (plugins/slim/scripts/engines/xml.cjs): detection, the folded tree and
// the SVG reduction as pure functions (XS sniff, XC compress, XT targetBytes fit, XG guarantees), then
// end to end through slim.cjs per channel (XD), each spawn in its own temp dir with an explicit env.
// The 50,000-URL sitemap and the ~430 KB SVG are generated here, deterministically; the feed fixtures
// are in tests/fixtures/ (README there).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPTS = path.join(ROOT, 'plugins/slim/scripts');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const { compress, sniff } = require(path.join(SCRIPTS, 'engines/index.cjs'));
const emit = require(path.join(SCRIPTS, 'delivery/emit.cjs'));

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
const fx = (f) => readFileSync(path.join(FIX, f), 'utf8');
const O = { maxMs: 0, trace: true };
const xml = (data, o = {}) => compress({ data }, { ...O, ...o });

function sitemap(n) {
  const urls = [];
  for (let i = 0; i < n; i++) {
    const kind = ['products', 'collections', 'pages', 'blogs/journal'][i % 4];
    urls.push(`  <url>\n    <loc>https://northwind.example/${kind}/item-${i}</loc>\n    <lastmod>2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}</lastmod>\n    <changefreq>${i % 3 ? 'weekly' : 'daily'}</changefreq>\n    <priority>${(0.5 + (i % 5) / 10).toFixed(1)}</priority>\n  </url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// An Inkscape export: editor namespaces, metadata, a comment, 12 layers of long paths, symbols and <use> refs.
function heroSvg() {
  const geometry = (k, len) => {
    let d = `M${k % 97}.5 ${k % 53}.25`;
    for (let j = 0; d.length < len; j++) d += ` c${(j * 7 + k) % 31}.${j % 10} ${(j * 3) % 17}.${k % 10} ${(j * 11) % 23}.5 -${(j + k) % 13}.25 ${(j * 5) % 29}.75 ${(k * j) % 19}.5`;
    return d;
  };
  const p = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!-- Created with Inkscape (http://www.inkscape.org/) -->',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="1200" height="800" viewBox="0 0 1200 800" id="hero-illustration" sodipodi:docname="hero.svg" inkscape:version="1.3">',
    '  <metadata id="metadata5"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><cc:Work xmlns:cc="http://creativecommons.org/ns#"><dc:format xmlns:dc="http://purl.org/dc/elements/1.1/">image/svg+xml</dc:format></cc:Work></rdf:RDF></metadata>',
    '  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="0.5" inkscape:cx="600" inkscape:cy="400"/>',
    '  <defs id="defs2">',
    '    <linearGradient id="sky"><stop offset="0" stop-color="#f6efe4"/><stop offset="1" stop-color="#d9c7ad"/></linearGradient>',
    `    <symbol id="leaf" viewBox="0 0 40 40"><path fill="#5f7a52" d="${geometry(1, 900)}"/></symbol>`,
    `    <symbol id="star" viewBox="0 0 24 24"><path fill="#c9a14a" d="${geometry(2, 400)}"/></symbol>`,
    '  </defs>',
    '  <rect id="background" width="1200" height="800" fill="url(#sky)"/>',
  ];
  for (let g = 0; g < 12; g++) {
    p.push(`  <g id="layer${g + 1}" inkscape:groupmode="layer" inkscape:label="Layer ${g + 1}" transform="translate(${g * 90} 0)">`);
    for (let k = 0; k < 18; k++) p.push(`    <path style="fill:#${(0x334455 + g * 4097 + k * 911).toString(16).slice(0, 6)};stroke:none" inkscape:connector-curvature="0" d="${geometry(g * 100 + k, 1500 + (k % 5) * 200)}"/>`);
    for (let k = 0; k < 6; k++) p.push('    <path fill="#e8dcc8" opacity="0.4" d="M0 0h4v4H0z"/>');
    p.push(`    <use href="#leaf" x="${g * 13}" y="${g * 7}" width="40" height="40"/>`);
    p.push(`    <use xlink:href="#star" x="${g * 17}" y="40" width="24" height="24"/>`);
    p.push('  </g>');
  }
  p.push('  <text id="headline" x="600" y="720" font-family="Graphik" font-size="48" fill="#2b2b2b" text-anchor="middle">Made to last</text>', '</svg>');
  return `${p.join('\n')}\n`;
}

const SITEMAP = sitemap(50000);
const SVG = heroSvg();
const FEED = fx('merchant-feed.xml');
const RSS = fx('rss-feed.xml');
const FIGMA = fx('figma-metadata-3326-39542.xml');
const SNIPPET = fx('icon-snippet.liquid');
const squeeze = (s) => s.replace(/>\s+</g, '><').trim();
const samplesOf = (text) => [...text.matchAll(/^\s+#([\d,]+) (<.*)$/gm)].map((m) => [Number(m[1].replace(/,/g, '')), m[2]]);
const recordsOf = (src, name) => [...src.matchAll(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g'))].map((m) => squeeze(m[0]));

// XS — sniff
{
  const rows = [
    ['sitemap', SITEMAP, 'xml', 'xml'],
    ['merchant-feed.xml', FEED, 'xml', 'xml'],
    ['rss-feed.xml', RSS, 'xml', 'xml'],
    ['figma-metadata', FIGMA, 'xml', 'xml'],
    ['svg', SVG, 'xml', 'svg'],
    ['bare-svg', '<svg viewBox="0 0 2 2"><path d="M0 0"/></svg>', 'xml', 'svg'],
    ['icon-snippet.liquid', SNIPPET, 'text', 'template'],
    ['html-fragment', '<div class="card">\n  <p>Hello</p>\n</div>\n', 'text', 'markup'],
    ['html-page', '<!doctype html><html><head><title>x</title></head><body><p>x</p></body></html>', 'html', 'html'],
    ['xhtml-prolog', '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body/></html>', 'html', 'html'],
    ['xhtml-doctype', '<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><div><p>Paragraph 40</p></div></body></html>', 'html', 'html'],
    ['html-no-doctype', '<html lang="en"><head><title>x</title></head><body><p>x</p></body></html>', 'html', 'html'],
    ['head-opener', '<head><title>x</title></head><body><p>x</p></body>', 'html', 'html'],
    ['body-opener', '<body class="page"><main><p>x</p></main></body>', 'html', 'html'],
    ['fenced', `Feed fetched:\n\`\`\`xml\n${RSS}\`\`\`\n`, 'xml', 'fence'],
    ['own-output', xml(RSS).text, 'text', 'prose'],
  ];
  for (const [name, data, engine, reason] of rows) eq(`XS-${name}`, [sniff({ data }).engine, sniff({ data }).reason], [engine, reason]);
}

// XC — compress
{
  const r = xml(SITEMAP);
  const lines = r.text.split('\n');
  eq('XC-sitemap-decision', [r.decision, r.engine, r.stats.stages], ['compressed', 'xml', ['xml']]);
  eq('XC-sitemap-header', lines[0], `<<slim-xml>> xml <urlset> · 250,001 elements · ${(bytes(SITEMAP)).toLocaleString('en-US')} B · 1 record list folded (50,000 records)`);
  eq('XC-sitemap-fold', lines[2], '  url ×50,000 {loc, lastmod, changefreq, priority}');
  const urls = recordsOf(SITEMAP, 'url');
  const s = samplesOf(r.text);
  eq('XC-sitemap-sample-positions', s.map(([k]) => k), [1, 25000, 50000]);
  check('XC-sitemap-samples-verbatim', s.every(([k, rec]) => urls[k - 1] === rec), JSON.stringify(s.map(([, x]) => x)));
  eq('XC-sitemap-footer', lines[lines.length - 1], '→ one record: lookup({ path: <the full= file below>, question: "the <url> whose … is …" })');
  check('XC-sitemap-small', bytes(r.text) < 1024, String(bytes(r.text)));
}
{
  const r = xml(FEED);
  const items = recordsOf(FEED, 'item');
  const sale = items.filter((x) => x.includes('<g:sale_price>')).length;
  eq('XC-feed-shapes', [r.decision, r.text.includes(`  item ×${items.length} in 2 shapes`), r.text.includes(`} ×${items.length - sale}`), r.text.includes(`} ×${sale}`)], ['compressed', true, true, true]);
  check('XC-feed-prefixes', /\{g:id, g:item_group_id, title, description, link, g:image_link, g:additional_image_link\+, g:availability, g:price, g:sale_price, /.test(r.text), r.text.slice(0, 900));
  const s = samplesOf(r.text);
  check('XC-feed-sample-ids', s.length === 6 && s.every(([k, rec]) => {
    const id = /<g:id>([^<]+)<\/g:id>/.exec(rec)[1];
    const link = /<link>([^<]+)<\/link>/.exec(rec)[1];
    return items[k - 1].includes(`<g:id>${id}</g:id>`) && items[k - 1].includes(`<link>${link}</link>`);
  }), JSON.stringify(s.map(([k]) => k)));
  check('XC-feed-long-text-elided', s.every(([, rec]) => /<description>The .{40,60}… \(\d+ chars\)<\/description>/.test(rec)), s[0] && s[0][1]);
  check('XC-feed-channel-whole', r.text.includes('  title: Northwind Goods — Google Shopping feed'), r.text.slice(0, 400));
}
{
  const r = xml(RSS);
  check('XC-rss-fold', r.text.includes('  item ×40 {title, link, guid, pubDate, author, category, description}'), r.text.slice(0, 600));
  check('XC-rss-cdata-elided', samplesOf(r.text).every(([, rec]) => /<description><!\[CDATA\[<p>Paragraph 1 .*… \(\d{3} chars\)<\/description>/.test(rec)), r.text);
  check('XC-rss-attrs-kept', r.text.includes('atom:link href="https://northwind.example/blogs/journal.atom" rel="self" type="application/rss+xml"') && r.text.includes('<guid isPermaLink="false">northwind-journal-9000</guid>'), r.text);
}
{
  const r = xml(SVG);
  eq('XC-svg-decision', [r.decision, r.engine, r.stats.stages], ['compressed', 'xml', ['svg']]);
  check('XC-svg-small', bytes(r.text) < bytes(SVG) / 20, `${bytes(SVG)} → ${bytes(r.text)}`);
  const targets = [...SVG.matchAll(/(?:xlink:)?href="#([^"]+)"|url\(#([^)]+)\)/g)].map((m) => m[1] || m[2]);
  check('XC-svg-use-targets', targets.length === 25 && targets.every((id) => r.text.includes(`id="${id}"`)) && r.text.includes('<use href="#leaf"') && r.text.includes('<use xlink:href="#star"'), targets.join(' '));
  const ids = [...SVG.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]).filter((id) => !['metadata5', 'namedview7'].includes(id));
  check('XC-svg-every-id', ids.every((id) => r.text.includes(`id="${id}"`)), ids.join(' '));
  check('XC-svg-dropped', !/inkscape:|sodipodi:|<metadata|rdf:|Created with/.test(r.text), (/inkscape:|sodipodi:|<metadata|rdf:|Created with/.exec(r.text) || [])[0]);
  check('XC-svg-geometry', /d="\(1,\d{3} chars\)"/.test(r.text) && !/ c\d+\.\d /.test(r.text), r.text.slice(0, 600));
  check('XC-svg-kept', r.text.includes('<text id="headline" x="600" y="720" font-family="Graphik" font-size="48" fill="#2b2b2b" text-anchor="middle">Made to last</text>')
    && r.text.includes('style="fill:#334455;stroke:none"') && r.text.includes('<path fill="#e8dcc8" opacity="0.4" d="M0 0h4v4H0z"/> ×6'), r.text.slice(0, 400));
  check('XC-svg-header', /^<<slim-xml>> svg · \d+ elements · [\d,]+ B · viewBox="0 0 1200 800" · 218 d\/points elided \([\d,]+ chars\) · dropped: 2 editor\/metadata elements, 1 comments · 72 identical leaves folded$/.test(r.text.split('\n')[0]), r.text.split('\n')[0]);
}
{
  const r = xml(FIGMA);
  const ids = [...FIGMA.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  eq('XC-figma-compressed', r.decision, 'compressed');
  check('XC-figma-every-id', ids.length > 40 && ids.every((id) => r.text.includes(`id="${id}"`)), `${ids.length}`);
  check('XC-figma-no-fold', !/ ×\d/.test(r.text), r.text.slice(0, 300));
}
{
  const items = Array.from({ length: 6 }, (_, i) => `<item><title>Post ${i}</title><description><![CDATA[<p>Hello & <b>bye</b> ${i}</p>]]></description></item>`);
  const r = xml(`<?xml version="1.0"?>\n<rss><channel><title>t</title>\n${items.join('\n')}\n</channel></rss>\n`);
  const s = samplesOf(r.text);
  check('XC-cdata-samples-verbatim', s.length === 3 && s.every(([k, rec]) => rec === items[k - 1]), JSON.stringify(s));
}
{
  const ps = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} says <strong>important ${i}</strong> and then continues.</p>`);
  const s = samplesOf(xml(`<?xml version="1.0"?>\n<doc>\n${ps.join('\n')}\n</doc>\n`).text);
  check('XC-mixed-samples-in-order', s.length === 3 && s.every(([k, rec]) => rec === ps[k - 1]), JSON.stringify(s));
}
{
  // A Notion-style page: prose with inline references is written as it reads; no reference is cut out.
  const tasks = Array.from({ length: 30 }, (_, i) => `- Task ${i} owner <mention-user url="user://u${i}"/> spec <mention-page url="https://www.notion.so/page-${i}"/>`);
  const page = `<page url="https://www.notion.so/tasks">\n<properties>{"title":"Tasks"}</properties>\n<content>\n# Tasks\n${tasks.join('\n')}\n</content>\n</page>\n`;
  const r = xml(page);
  check('XC-mixed-inline-refs', tasks.every((t) => r.text.includes(t)), r.text.slice(0, 600));
}
{
  const blob = `<?xml version="1.0"?><doc><title>t</title><blob>${'QUJDRA'.repeat(14000)}</blob><a>x</a></doc>`;
  const r = xml(blob);
  check('XC-long-text-elided', r.decision === 'compressed' && r.text.includes('blob: QUJDRA') && r.text.includes('… (84,000 chars)') && bytes(r.text) < 1024, `${r.decision} ${bytes(r.text)}`);
  const desc = 'A long channel description that goes on about the studio, its makers and its materials. '.repeat(55);
  const rss = xml(`<?xml version="1.0"?><rss><channel><title>t</title><description>${desc}</description>${'<item><title>x</title></item>'.repeat(3)}</channel></rss>`);
  check('XC-channel-description-elided', rss.decision === 'compressed' && rss.text.includes(`description: ${desc.slice(0, 60)}… (`), rss.text.slice(0, 400));
  // A multi-line text body (prose, markdown) is content the model reads: kept whole, so it gains nothing.
  const prose = `<answer>\n${'The order ships in two parcels; the second leaves the warehouse on Friday.\n'.repeat(60)}</answer>\n`;
  eq('XC-prose-kept', [xml(prose).decision, xml(prose).reason, xml(prose).format], ['passthrough', 'no-gain', 'xml']);
  eq('XC-tiny', [xml('<a>x</a>', { engine: 'xml' }).decision, xml('<a>x</a>', { engine: 'xml' }).reason], ['passthrough', 'no-gain']);
  eq('XC-no-element', xml('just text', { engine: 'xml' }).reason, 'no-gain');
  const fenced = xml(`Feed fetched:\n\`\`\`xml\n${RSS}\`\`\`\nDone.`);
  check('XC-fence', fenced.decision === 'compressed' && fenced.text.startsWith('<<slim-xml>> ') && fenced.text.includes('\n\nFeed fetched:\n\n') && fenced.text.endsWith('\n\nDone.'), fenced.text.slice(0, 200));
  check('XC-already-slim', emit.alreadySlim([xml(RSS).text], bytes(xml(RSS).text), 33968, 's'), 'the xml mark');
}

{
  const products = Array.from({ length: 2000 }, (_, i) => `  <product id="P${i}"><name>Linen shirt ${i}</name><price>${(20 + i % 50).toFixed(2)}</price><url>https://northwind.example/products/p-${i}</url></product>`);
  const cat = `<?xml version="1.0"?>\n<catalog>\n${products.join('\n')}\n</catalog>\n`;
  const r = xml(cat);
  check('XC-id-feed-folds', r.text.includes('  product ×2,000 {@id, name, price, url}\n    ids: P0…P1999\n') && bytes(r.text) < 2048, r.text.slice(0, 500));
  const fit = xml(cat, { targetBytes: 4000 });
  eq('XC-id-feed-fits', [fit.decision, bytes(fit.text) <= 4000, fit.text.includes('ids: P0…P1999')], ['compressed', true, true]);
  eq('XC-id-list-runs', xml(`<l>${['a1', 'a2', 'a3', 'b', 'a5', 'a7', 'a8', 'a9', 'a10'].map((id) => `<e id="${id}"><v>${'a value long enough that a fold of the list pays for its own lines. '.repeat(2)}</v></e>`).join('')}</l>`, { engine: 'xml' }).text.split('\n')[3], '    ids: a1…a3, b, a5, a7…a10');
}
{
  const OPT = ['g:sale_price', 'g:color', 'g:size', 'g:gtin', 'g:mpn', 'g:brand', 'g:material', 'g:gender'];
  const items = Array.from({ length: 1000 }, (_, i) => `<item><g:id>${i}</g:id><title>Item ${i}</title>${OPT.filter((_, b) => (i >> b) & 1).map((f) => `<${f}>v</${f}>`).join('')}${i === 999 ? '<g:rare_field>r</g:rare_field>' : ''}</item>`);
  const r = xml(`<?xml version="1.0"?>\n<rss><channel>\n${items.join('\n')}\n</channel></rss>\n`);
  const fields = /^\s+fields: (.*)$/m.exec(r.text);
  check('XC-shapes-union', r.text.includes('item ×1,000 in 257 shapes') && !!fields && fields[1].startsWith('g:id ×1,000, title ×1,000, ') && OPT.every((f) => new RegExp(`${f} ×\\d{3}`).test(fields[1])) && fields[1].includes('g:rare_field ×1'), (fields || [r.text.slice(0, 300)])[0]);
  const recs = Array.from({ length: 40 }, (_, i) => (i % 2 ? `<rec x="${i}" y="2"><a>${i}</a><b>2</b></rec>` : `<rec y="2" x="${i}"><b>2</b><a>${i}</a></rec>`));
  const o = xml(`<?xml version="1.0"?><l>${recs.join('')}</l>`).text;
  check('XC-shape-order-insensitive', o.includes('rec ×40 {@y, @x, b, a}'), o);
}
{
  const fills = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
  const style = (f) => `font-variation-settings:normal;opacity:1;vector-effect:none;fill-opacity:1;stroke:none;stroke-width:1;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-dashoffset:0;stroke-opacity:1;-inkscape-stroke:none;stop-color:#000000;stop-opacity:1;fill:${f}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:#111111}${'.b{stroke:#222222;stroke-width:2px}'.repeat(8)}.brand{fill:#C8102E}</style>${fills.map((f) => `<path style="${style(f)}" d="M0 0 ${'L1 1 '.repeat(300)}"/>`).join('')}</svg>`;
  const r = xml(svg);
  check('XC-svg-fills-kept', r.decision === 'compressed' && fills.every((f) => r.text.includes(`fill:${f}`)) && r.text.includes('.brand{fill:#C8102E}') && !/identical leaves folded/.test(r.text), r.text.slice(0, 600));
}

// XT — targetBytes: samples 3 → 1 → 0, then depth
{
  const one = xml(FEED, { targetBytes: 5000 });
  eq('XT-samples-1', [one.stats.stages, samplesOf(one.text).map(([k]) => k), bytes(one.text) <= 5000], [['xml', 'samples'], [2, 1], true]);
  const none = xml(FEED, { targetBytes: 2000 });
  eq('XT-samples-0', [none.stats.stages, samplesOf(none.text).length, bytes(none.text) <= 2000, none.warnings], [['xml', 'samples'], 0, true, ['samples: 0 per record list to meet targetBytes']]);
  const svg = xml(SVG, { targetBytes: 4000 });
  check('XT-svg-depth', svg.stats.stages.join() === 'svg,depth' && bytes(svg.text) <= 4000 && svg.text.includes('elements deeper folded') && / elements below depth \d folded to fit/.test(svg.text.split('\n')[0]), `${svg.stats.stages} ${bytes(svg.text)}`);
  check('XT-svg-ids-at-depth-1', ['defs2', 'background', 'layer1', 'layer12', 'headline'].every((id) => svg.text.includes(`id="${id}"`)), svg.text);
  const fits = xml(SITEMAP, { targetBytes: 32768 });
  eq('XT-sitemap-fits', [fits.stats.stages, samplesOf(fits.text).length], [['xml'], 3]);
  const miss = xml(FEED, { targetBytes: 100 });
  check('XT-not-met', miss.decision === 'compressed' && miss.warnings.some((w) => /^targetBytes 100 not met: \d+ B$/.test(w)), JSON.stringify(miss.warnings));
}

// XG — guarantees
{
  const strip = (r) => ({ ...r, stats: { ...r.stats, ms: 0 } });
  for (const [name, data] of [['sitemap', SITEMAP], ['svg', SVG], ['feed', FEED]]) eq(`XG-deterministic-${name}`, strip(xml(data)), strip(xml(data)));
  const t0 = Date.now();
  const bad = [
    ['unclosed', `<?xml version="1.0"?><a><b x="1"><c>${'<d y="'.repeat(20000)}`],
    ['open-flood', `<feed>${'<e '.repeat(100000)}`],
    ['deep', `<r>${'<n>'.repeat(4000)}x${'</n>'.repeat(4000)}</r>`],
    ['stray-close', `<r>${'</x>'.repeat(5000)}<a>1</a></r>`],
    ['doctype-subset', '<?xml version="1.0"?><!DOCTYPE note [<!ENTITY w "x">]><note><to>&w;</to></note>'],
  ];
  for (const [name, data] of bad) {
    let threw = null;
    let r;
    try { r = xml(data, { engine: 'xml' }); } catch (e) { threw = e; }
    check(`XG-${name}-no-throw`, threw === null && r && typeof r.text === 'string', String(threw));
  }
  check('XG-bad-fast', Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  eq('XG-budget', xml(SITEMAP, { maxMs: -1 }).reason, 'budget-exceeded');
  const t1 = Date.now();
  xml(SITEMAP, { maxMs: 0 });
  check('XG-sitemap-under-budget', Date.now() - t1 < 2500, `${Date.now() - t1} ms`);
}

// XD — delivery: each channel's admission, end to end through slim.cjs
const SLIM = path.join(SCRIPTS, 'slim.cjs');
const TEMPS = [];
function core(response, extra) {
  const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slimxml-')));
  TEMPS.push(T);
  const env = { PATH: process.env.PATH, HOME: `${T}/home`, XDG_CONFIG_HOME: `${T}/xdg`, CLAUDE_CONFIG_DIR: `${T}/cfg`, SLIM_DIR: `${T}/spill`, SLIM_DEBUG: '2' };
  const input = { v: 1, channel: 'mcp', tool: 'mcp__x__y', tool_use_id: 'toolu_x', tool_input: {}, tool_response: response, is_error: false, cwd: T, session_id: 's1', ...extra };
  const r = spawnSync('node', [SLIM], { cwd: T, env, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return { T, ...JSON.parse(r.stdout) }; } catch (_) { return { T, decision: `bad stdout: ${String(r.stdout).slice(0, 200)} ${r.stderr}`, record: {} }; }
}
const BASH = (stdout) => ({ stdout, stderr: '', interrupted: false, isImage: false });
const SMALL_MAP = sitemap(5000);
const readRec = (filePath, content) => ({ type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } });
{
  const a = core(BASH(SMALL_MAP), { channel: 'bash', tool: 'Bash', tool_input: { command: 'curl -s https://northwind.example/sitemap.xml' } });
  eq('XD-bash-fetch', [a.decision, a.record.engine], ['compressed', 'xml']);
  check('XD-bash-fetch-shape', String((a.result || {}).stdout).startsWith('<<slim-xml>> xml <urlset> · 25,001 elements') && /<<full=\S+\.txt original_result>>$/.test(a.result.stdout), String((a.result || {}).stdout).slice(0, 120));
  const page = `<html lang="en"><head><title>Shop</title></head><body>${Array.from({ length: 120 }, (_, i) => `<div class="card"><a href="/products/p-${i}">Product ${i}</a><p>A short line of copy about product ${i}.</p></div>`).join('\n')}</body></html>`;
  const h = core(BASH(page), { channel: 'bash', tool: 'Bash', tool_input: { command: 'curl -s https://shop.example/' } });
  eq('XD-bash-fetch-html-no-doctype', [h.decision, h.record.engine], ['compressed', 'html']);
  const c = core(BASH(SVG), { channel: 'bash', tool: 'Bash', tool_input: { command: 'cat assets/hero.svg' } });
  eq('XD-bash-cat-svg-text', [c.decision, c.record.engine], ['compressed', 'text']);
}
{
  const p = path.join(FIX, 'merchant-feed.xml');
  const a = core(readRec(p, FEED), { channel: 'read', tool: 'Read', tool_input: { file_path: p } });
  eq('XD-read-xml', [a.decision, a.record.engine], ['compressed', 'xml']);
  const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slimxml-')));
  TEMPS.push(T);
  mkdirSync(path.join(T, 'assets'));
  const svgPath = path.join(T, 'assets/hero.svg');
  writeFileSync(svgPath, SVG);
  eq('XD-read-svg-guard', core(readRec(svgPath, SVG), { channel: 'read', tool: 'Read', tool_input: { file_path: svgPath } }).reason, 'read-guard');
  const fp = path.join(FIX, 'figma-metadata-3326-39542.xml');
  eq('XD-read-small-xml-guard', core(readRec(fp, FIGMA), { channel: 'read', tool: 'Read', tool_input: { file_path: fp } }).reason, 'read-guard');
}
{
  const w = core({ bytes: bytes(RSS), code: 200, codeText: 'OK', result: RSS, durationMs: 9, url: 'https://northwind.example/blogs/journal.atom' }, { channel: 'webfetch', tool: 'WebFetch', tool_input: { url: 'https://northwind.example/blogs/journal.atom', prompt: 'list posts' } });
  eq('XD-webfetch', [w.decision, w.record.engine, String((w.result || {}).result).startsWith('<<slim-xml>> xml <rss>')], ['compressed', 'xml', true]);
}
{
  const m = core([{ type: 'text', text: SVG }]);
  eq('XD-mcp-svg', [m.decision, m.record.engine, String(((m.result || [])[0] || {}).text).startsWith('<<slim-xml>> svg')], ['compressed', 'xml', true]);
  const big = core([{ type: 'text', text: SITEMAP }]);
  eq('XD-mcp-sitemap', [big.decision, big.record.engine], ['compressed', 'xml']);
  const again = core([{ type: 'text', text: ((m.result || [])[0] || {}).text || '' }]);
  eq('XD-mcp-rerun-already-slim', again.reason, 'already-slim');
  const snippet = core([{ type: 'text', text: SNIPPET.repeat(12) }]);
  eq('XD-mcp-liquid-template', [snippet.decision, snippet.reason], ['passthrough', 'template']);
}

for (const T of TEMPS) rmSync(T, { recursive: true, force: true });
console.log(`xml slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
