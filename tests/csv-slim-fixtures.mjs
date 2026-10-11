#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/csv.cjs — the csv engine — on the generated 12,480-row product
// export and the committed table fixtures: detection (CS), the profile's counts, types, samples and
// verbatim rows checked against an independent read of the input (CC), the fit stages (CT), the
// passthroughs and guarantees (CG), and the already-slim mark (CM).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const ENGINES = path.join(ROOT, 'plugins/slim/scripts/engines');
const csv = require(path.join(ENGINES, 'csv.cjs'));
const { compress, sniff } = require(path.join(ENGINES, 'index.cjs'));
const emit = require(path.join(ROOT, 'plugins/slim/scripts/delivery/emit.cjs'));

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
const fx = (f) => readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8');
const O = { maxMs: 0 };

const PRODUCTS = spawnSync('node', [path.join(ROOT, 'plugins/slim/evals/_shared/make-products-csv.cjs')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
const TSV = fx('inventory.tsv');
const EU = fx('prices-eu.csv');
const SMALL = fx('small.csv');
const LOG = fx('sync-commas.log');
const ts = (i) => `2026-10-10T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.123Z`;
const ISO_LOG = Array.from({ length: 300 }, (_, i) => (i === 136 ? `${ts(i)},ERROR,payments,charge ch_9XyZ failed: card_declined` : `${ts(i)},INFO,worker-${i % 5},job ${i} done in ${i * 3}ms`)).join('\n');
const LEVEL_LOG = Array.from({ length: 300 }, (_, i) => `[INFO] service=api, path=/v1/items/${i}, status=200`).join('\n');
const PIVOT = ['sku,title,2024-01-01,2024-01-02,2024-01-03', ...Array.from({ length: 400 }, (_, i) => `S-${i},Item ${i},${i},${i * 2},${i * 3}`)].join('\n');
const EU_QUOTED = ['"Name, full";"Price, EUR";"Weight, kg"', ...Array.from({ length: 40 }, (_, i) => `"Item, ${i + 1}";1,${i + 5};1,${i + 25}`)].join('\n');
const WRAPPED_HEADER = ['id,"first\nname",x', ...Array.from({ length: 300 }, (_, i) => `${i},n${i},x${i}`)].join('\n');

// An independent reader for the assertions: quote-aware, one record per data row.
function records(text, d) {
  const out = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c;
  }
  if (f || row.length) { row.push(f); out.push(row); }
  return out;
}
const sections = (text) => {
  const lines = text.split('\n');
  const c = lines.indexOf('columns:');
  const end = lines.findIndex((l, i) => i > c && l === '');
  const t = lines.findIndex((l) => l.startsWith('| # |'));
  const rows = t === -1 ? [] : lines.slice(t + 2, lines.findIndex((l, i) => i > t && l === ''));
  return { head: lines[0], cols: lines.slice(c + 1, end), rows, footer: lines[lines.length - 1] };
};
const field = (line, name) => { const m = new RegExp(`  ${name} (.*?)(?:  |$)`).exec(line); return m ? m[1] : null; };
const unclip = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
const cellIn = (cell) => cell.replace(/\\\|/g, '|').replace(/<br>/g, '\n');
const splitRow = (line) => line.slice(2, -2).split(/ (?<!\\)\| /);

// CS — detection
{
  for (const [name, text, engine, reason] of [
    ['products', PRODUCTS, 'csv', 'csv'], ['tsv-quoted-commas', TSV, 'csv', 'csv'], ['semicolon-eu', EU, 'csv', 'csv'],
    ['15-lines', SMALL, 'text', 'prose'], ['log-with-commas', LOG, 'log', 'log'],
    ['log-iso-t', ISO_LOG, 'log', 'log'], ['log-level-first', LEVEL_LOG, 'log', 'log'],
    ['date-pivot-header', PIVOT, 'csv', 'csv'], ['wrapped-header-cell', WRAPPED_HEADER, 'csv', 'csv'],
    ['headerless-dates', Array.from({ length: 30 }, (_, i) => `x${i},2024-01-${String(i + 1).padStart(2, '0')},y${i}`).join('\n'), 'text', 'prose'],
    ['headerless', `1,2,3\n${'4,5,6\n'.repeat(30)}`, 'text', 'prose'],
    ['two-columns', `a,b\n${'x,y\n'.repeat(30)}`, 'text', 'prose'],
    ['ragged-prose', Array.from({ length: 40 }, (_, i) => `word, ${'more, '.repeat(i % 4)}end`).join('\n'), 'text', 'prose'],
  ]) {
    const s = sniff({ data: text });
    eq(`CS-${name}`, [s.engine, s.reason], [engine, reason]);
  }
  eq('CS-delimiters', [csv.detect(PRODUCTS), csv.detect(TSV), csv.detect(EU)], [{ delim: ',', width: 14 }, { delim: '\t', width: 8 }, { delim: ';', width: 7 }]);
  eq('CS-fence', sniff({ data: `Export:\n\`\`\`csv\n${TSV}\`\`\`\n` }).engine, 'csv');
  eq('CS-template-guard-first', sniff({ data: `a,b,c\n${'{{ x }},2,3\n'.repeat(30)}` }).reason, 'template');
  eq('CS-bom', csv.detect(`﻿${EU}`), { delim: ';', width: 7 });
  // `,` would also split the quoted-comma header into 3, but leaves text after its closing quotes.
  eq('CS-semicolon-quoted-comma-header', csv.detect(EU_QUOTED), { delim: ';', width: 3 });
  const q = sections(compress({ data: EU_QUOTED }, O).text);
  eq('CS-semicolon-quoted-comma-columns', q.cols.map((l) => l.split(/ {2,}/).slice(0, 2).join(' / ')), ['Name, full / string', 'Price, EUR / number', 'Weight, kg / number']);
  eq('CS-wrapped-header-name', sections(compress({ data: WRAPPED_HEADER }, O).text).cols[1].split(/ {2,}/)[0], 'first\\nname');
  eq('CG-iso-log-keeps-error', compress({ data: ISO_LOG }, O).text.includes('ch_9XyZ'), true);
}

// CC — the profile against the input, per fixture
const TYPES = {
  products: ['string', 'string', 'string', 'category', 'category', 'category', 'bool', 'category', 'string', 'integer', 'integer', 'number', 'number', 'category'],
  tsv: ['category', 'category', 'string', 'string', 'integer', 'integer', 'date', 'category'],
  eu: ['string', 'string', 'number', 'number', 'number', 'integer', 'category'],
};
for (const [name, text, d, rowsN, colsN, size] of [['products', PRODUCTS, ',', 12480, 14, '2.3 MB'], ['tsv', TSV, '\t', 640, 8, '36.9 KB'], ['eu', EU, ';', 320, 7, '15.9 KB']]) {
  const r = compress({ data: text }, { ...O, trace: true });
  eq(`CC-${name}-decision`, [r.engine, r.decision, r.stats.stages], ['csv', 'compressed', ['profile']]);
  const s = sections(r.text);
  eq(`CC-${name}-header`, s.head, `<<slim-csv>> ${rowsN.toLocaleString('en-US')} rows × ${colsN} cols · delimiter ${d === '\t' ? 'tab' : d} · ${size} · 6 rows shown`);
  const recs = records(text, d);
  const header = recs[0];
  const data = recs.slice(1);
  eq(`CC-${name}-counts`, [data.length, header.length], [rowsN, colsN]);
  eq(`CC-${name}-column-names`, s.cols.map((l) => l.split('  ')[0].trim()), header);
  eq(`CC-${name}-types`, s.cols.map((l) => l.split(/ {2,}/)[1]), TYPES[name]);
  const bad = [];
  s.cols.forEach((line, i) => {
    const col = data.map((row) => row[i] ?? '');
    const nonNull = col.filter((v) => !/^(?:|null|n\/a|nan)$/i.test(v.trim()));
    if (Number(field(line, 'nulls').replace(/,/g, '')) !== col.length - nonNull.length) bad.push(`${header[i]} nulls`);
    const distinct = new Set(nonNull);
    if (Number(field(line, 'distinct').replace(/,/g, '')) !== distinct.size) bad.push(`${header[i]} distinct`);
    const eg = field(line, 'e\\.g\\.');
    if (eg) {
      const samples = eg.split(' · ');
      if (samples.length !== 3 || new Set(samples).size !== 3) bad.push(`${header[i]} sample count`);
      for (const v of samples) {
        const u = unclip(v);
        if (!(u.includes('… [+') ? nonNull.some((x) => x.startsWith(u.split('… [+')[0])) : distinct.has(u))) bad.push(`${header[i]} sample ${v}`);
      }
    }
    const mm = /  min (.*?) max (.*?)  /.exec(line);
    if (mm) {
      const num = name === 'eu' ? (v) => Number(v.replace(/\./g, '').replace(',', '.')) : (v) => Number(v);
      const sorted = TYPES[name][i] === 'date' ? [...distinct].sort() : [...distinct].sort((a, b) => num(a) - num(b));
      if (mm[1] !== sorted[0] || mm[2] !== sorted[sorted.length - 1]) bad.push(`${header[i]} min/max ${mm[1]}/${mm[2]} vs ${sorted[0]}/${sorted[sorted.length - 1]}`);
    }
    if (/^(?:category|bool)$/.test(TYPES[name][i])) {
      const listed = line.split(/ {2,}/).pop().split(' · ').map((x) => /^(.*) ×([\d,]+)$/.exec(x));
      for (const [, v, n] of listed) if (nonNull.filter((x) => x === unclip(v)).length !== Number(n.replace(/,/g, ''))) bad.push(`${header[i]} count ${v}`);
      if (listed.length !== distinct.size) bad.push(`${header[i]} listed ${listed.length}`);
    }
  });
  eq(`CC-${name}-column-facts`, bad, []);
  eq(`CC-${name}-table-rows`, s.rows.length, 6);
  const nums = s.rows.map((l) => Number(splitRow(l)[0]));
  check(`CC-${name}-first-three`, nums.slice(0, 3).join() === '1,2,3' && nums.slice(3).every((n, k, a) => n > 3 && n <= rowsN && (k === 0 || n > a[k - 1])), nums.join());
  const verbatim = s.rows.every((l) => {
    const cells = splitRow(l);
    const want = data[Number(cells[0]) - 1];
    return cells.slice(1).every((c, k) => (c.includes('… [+') ? want[k].startsWith(cellIn(c.split('… [+')[0])) : cellIn(c) === want[k]));
  });
  check(`CC-${name}-rows-verbatim`, verbatim, s.rows.join('\n'));
  eq(`CC-${name}-footer`, s.footer, 'next: a row, a column or a filter → lookup({ path: <the original: its full= or original: path, or the file you viewed>, question })');
  check(`CC-${name}-smaller`, r.stats.bytesOut < r.stats.bytesIn / 4, `${r.stats.bytesIn} → ${r.stats.bytesOut}`);
}
{
  // Identifiers in the shown rows stay as written: SKUs, handles, quoted commas.
  const s = sections(compress({ data: PRODUCTS }, O).text);
  check('CC-identifiers', s.rows.every((l) => /\| NW-\d{5}-[SMLX] \|/.test(l)) && s.rows[0].includes('| ribbed-vase-0 |'), s.rows[0]);
  check('CC-quoted-comma', compress({ data: TSV }, O).text.includes('Austin, TX ×'), 'quoted comma value split');
}
{
  // Cells: a pipe escaped, a line break as <br>, a long value clipped with its length, ragged rows counted, BOM dropped.
  const long = 'x'.repeat(300);
  const rows = ['﻿id,name,body'];
  for (let i = 0; i < 300; i++) rows.push(i === 1 ? `2,"a|b","line one\nline two"` : i === 2 ? `3,c,${long}` : i === 4 ? `5,e,f,EXTRA` : `${i + 1},n${i},b${i}`);
  const r = compress({ data: rows.join('\n') }, O);
  const s = sections(r.text);
  check('CC-cell-escapes', s.rows[1] === '| 2 | 2 | a\\|b | line one<br>line two |', s.rows[1]);
  check('CC-cell-clip', s.rows[2] === `| 3 | 3 | c | ${'x'.repeat(120)}… [+180 chars] |`, s.rows[2]);
  check('CC-ragged', s.head.endsWith('· 1 rows of another width'), s.head);
  eq('CC-bom-stripped', s.cols[0].split(' ')[0], 'id');
}
{
  // Long identifiers stay whole in samples, so three of them stay told apart.
  const url = (i) => `https://cdn.shopify.com/s/files/1/0000/0001/products/very-long-image-name-${i}.jpg?v=17${i}`;
  const text = ['id,img,alt', ...Array.from({ length: 30 }, (_, i) => `${i},${url(i)},alt ${i}`)].join('\n');
  const eg = field(sections(compress({ data: text }, O).text).cols[1], 'e\\.g\\.').split(' · ');
  check('CC-long-samples-verbatim', eg.length === 3 && eg.every((v) => /^https:\/\/\S+\?v=17\d+$/.test(v) && text.includes(`,${v},`)), eg.join(' | '));
}
{
  // An identifier-like value (no whitespace) is never clipped in the column block up to 400 chars, then cut with '…';
  // a prose value keeps the 160 → 120 clip. Table cells keep the clip either way.
  const id = (i) => `gid://shopify/ProductVariant/${'v'.repeat(260)}-${i}`;
  const huge = (i) => `${'h'.repeat(450)}${i}`;
  const prose = (i) => `${'word '.repeat(50)}${i}`;
  const text = ['n,gid,blob,note', ...Array.from({ length: 30 }, (_, i) => `${i},${id(i)},${huge(i)},${prose(i)}`)].join('\n');
  const s = sections(compress({ data: text }, O).text);
  const egOf = (k) => field(s.cols[k], 'e\\.g\\.').split(' · ');
  check('CC-id-sample-whole', egOf(1).length === 3 && egOf(1).every((v) => v.length > 160 && text.includes(`,${v},`)), egOf(1).join(' | ').slice(0, 200));
  check('CC-id-sample-cap', egOf(2).every((v) => v === `${'h'.repeat(400)}…`), egOf(2)[0].slice(-20));
  check('CC-prose-sample-clipped', egOf(3).every((v) => v.startsWith(`${'word '.repeat(24)}…`) && v.endsWith(' chars]')), egOf(3)[0].slice(-40));
  check('CC-id-cell-clipped', s.rows.every((l) => l.includes('… [+')), s.rows[0].slice(0, 200));
  const mm = ['k,code,tag', ...Array.from({ length: 30 }, (_, i) => `${i},${i + 10}${'0'.repeat(200)},t${i}`)].join('\n');
  const line = sections(compress({ data: mm }, O).text).cols[1];
  check('CC-id-minmax-whole', line.includes(`min 10${'0'.repeat(200)} max 39${'0'.repeat(200)}`), line.slice(0, 120));
}

// CT — fit: rows 3+3 → 3 → 0, then samples 3 → 1; a target nothing meets says so
{
  const full = compress({ data: PRODUCTS }, O).text;
  const at = (target) => compress({ data: PRODUCTS }, { ...O, trace: true, targetBytes: target });
  const big = at(bytes(full));
  eq('CT-fits-untouched', [big.text === full, big.stats.stages, big.warnings], [true, ['profile'], []]);
  const three = at(bytes(full) - 1);
  check('CT-rows-3', sections(three.text).rows.length === 3 && three.stats.stages.join() === 'profile,rows' && bytes(three.text) < bytes(full) && three.text.includes('3 rows shown'), three.stats.stages.join());
  const none = at(bytes(three.text) - 1);
  check('CT-rows-0', !none.text.includes('| # |') && none.text.includes('0 rows shown') && /e\.g\. \S.* · .* · /.test(none.text), none.stats.stages.join());
  const one = at(bytes(none.text) - 1);
  check('CT-samples-1', one.stats.stages.join() === 'profile,rows,samples' && !/e\.g\. [^\n]* · /.test(one.text) && one.warnings.includes('samples: 1 per column to meet targetBytes'), one.warnings.join(' | '));
  const miss = at(100);
  check('CT-not-met', miss.decision === 'compressed' && miss.warnings.some((w) => w.startsWith('targetBytes 100 not met: ')), miss.warnings.join(' | '));
}

// CG — passthroughs and guarantees
{
  const small = compress({ data: SMALL }, { ...O, engine: 'csv' });
  eq('CG-15-lines-no-gain', [small.decision, small.reason], ['passthrough', 'no-gain']);
  const prose = compress({ data: 'just a sentence\n'.repeat(30) }, { ...O, engine: 'csv' });
  eq('CG-non-csv', [prose.decision, prose.reason], ['passthrough', 'non-csv']);
  const late = compress({ data: TSV }, { maxMs: -1, engine: 'csv' });
  eq('CG-budget', [late.decision, late.reason], ['passthrough', 'budget-exceeded']);
  const strip = (r) => ({ ...r, stats: { ...r.stats, ms: 0 } });
  for (const [name, text] of [['products', PRODUCTS], ['tsv', TSV], ['eu', EU]]) eq(`CG-deterministic-${name}`, strip(compress({ data: text }, O)), strip(compress({ data: text }, O)));
  const r = compress({ data: TSV }, { ...O, spillDir: '/s' });
  check('CG-spill-txt', r.spill.payload === TSV && /^slim-original-[0-9a-f]{16}\.txt$/.test(r.spill.suggestedName) && !r.parts, r.spill.suggestedName);
  const fenced = compress({ data: `Export:\n\`\`\`csv\n${TSV}\`\`\`\nTruncated: no.` }, O);
  check('CG-fence-kept', fenced.engine === 'csv' && fenced.text.startsWith('Export:\n\n<<slim-csv>> 640 rows') && fenced.text.endsWith('Truncated: no.'), fenced.text.slice(0, 60));
  const log = compress({ data: LOG }, O);
  eq('CG-log-stays-log', log.engine, 'log');
}

// CM — the mark: a csv result handed back to slim is already slim
{
  const out = compress({ data: TSV }, O).text;
  check('CM-already-slim', out.startsWith(csv.MARK) && emit.alreadySlim([out], bytes(out), 34000, 's'), out.slice(0, 40));
}

console.log(`csv-slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
