#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/ — slim's compression library — exercised the way an embedder
// would: compress() / sniff() / peek() as pure functions, no environment, no temp dirs (except the
// CONTRACT.md server example), maxMs:0 for determinism. Rows: ES sniff, EC compress, EG guarantees
// (never throws, deterministic, never writes), EP parity against Headroom's fixtures and the frozen
// compressor copies, EF generators equal the committed fixtures, EX the contract's example runs, EL the
// layer's purity, EN the figma-nodes engine on synthetic REST nodes responses, EM media planning, EQ the
// jq narrowing the view tool runs before an engine.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs, { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ENGINES = path.join(ROOT, 'plugins/slim/scripts/engines');
const SHARED = path.join(ROOT, 'plugins/slim/evals/_shared');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const lib = require(path.join(ENGINES, 'index.cjs'));
const { compress, sniff, peek } = lib;

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
// Memoised: the no-fs-writes block re-runs ecRows() with fs patched, and Node 18's readFileSync goes through fs.openSync.
const fxCache = new Map();
const fx = (f) => {
  if (!fxCache.has(f)) fxCache.set(f, readFileSync(path.join(FIX, f), 'utf8'));
  return fxCache.get(f);
};
const gen = (f, ...args) => spawnSync('node', [path.join(SHARED, f), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
const O = { maxMs: 0 };

const PAGE = fx('page.html');
const APPLOG = fx('app.log');
const TESTOUT = fx('test-output.txt');
const DIFF = fx('git-diff.txt');
const JQL = fx('jql-search-ELC.json');
const JSONL = Array.from({ length: 600 }, (_, i) => JSON.stringify({ id: i, sku: `SKU-${i % 40}`, status: i % 50 ? 'ok' : 'error', qty: i % 9 })).join('\n');
const GREP = Array.from({ length: 3000 }, (_, i) => `src/sections/main-product-${i % 60}.liquid:${10 + (i % 400)}:      {{- product.price | money_${i} -}}`).join('\n')
  .replace(/\{\{-?|-?\}\}/g, '');
const ADF = JSON.stringify({ type: 'doc', version: 1, content: Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${i} of the technical approach.`, marks: [{ type: 'strong' }] }] })) });
const GO = '=== RUN   TestCart\n--- PASS: TestCart (0.01s)\nok  \tgithub.com/n/shop/cart\t0.412s\n';
const RSPEC = 'Cart\n  adds an item\n  removes an item\n\nFinished in 0.4 seconds\n12 examples, 1 failure\n';
const PYTEST = '============================= test session starts =============================\ncollected 4 items\n\ntests/test_cart.py ....\n\n============================== 4 passed in 0.12s ==============================\n';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const ORDERS = gen('make-orders.cjs');
const REST = fx('figma-node-rest.json');
const VARS = JSON.parse(fx('figma-variables-local.json'));

// Synthetic Figma REST `/v1/files/<key>/nodes` responses (no client payload).
const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });
const solid = (r, g, b, a = 1, extra = {}) => ({ blendMode: 'NORMAL', type: 'SOLID', color: { r, g, b, a }, ...extra });
const box = (x, y, width, height) => ({ x, y, width, height });
const TL = { vertical: 'TOP', horizontal: 'LEFT' };
const nodesPayload = (doc, extra = {}) => ({
  name: 'Bundle System', role: 'viewer', lastModified: '2026-09-01T10:00:00Z', editorType: 'figma', thumbnailUrl: 'https://example.invalid/thumb.png',
  nodes: { [doc.id]: { document: doc, components: {}, componentSets: {}, schemaVersion: 0, styles: {}, ...extra } },
});
const geometry = (n) => Array.from({ length: n }, (_, i) => ({ windingRule: 'NONZERO', path: `M${i} 0L${i + 1} 1L${i} 2Z`.repeat(6) }));
// Auto-layout card: bound gap/radius/fill, a shadow, an image child, a text child with a bound font
// size, an instance with props, and a hidden subtree (3 nodes) that must be dropped and counted.
const kitchenSink = () => ({
  id: '10:1', name: 'Card / Desktop', type: 'FRAME', scrollBehavior: 'SCROLLS', clipsContent: true,
  absoluteBoundingBox: box(0, 0, 320, 420), absoluteRenderBounds: box(-4, -4, 328, 428), constraints: { vertical: 'TOP', horizontal: 'LEFT_RIGHT' },
  layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', primaryAxisAlignItems: 'CENTER', itemSpacing: 12,
  paddingTop: 16, paddingRight: 16, paddingBottom: 24, paddingLeft: 16, cornerRadius: 8,
  boundVariables: { itemSpacing: alias('VariableID:2:12'), cornerRadius: alias('VariableID:2:13') },
  fills: [solid(1, 1, 1, 1, { boundVariables: { color: alias('VariableID:2:11') } })], strokes: [solid(0.9, 0.9, 0.9)], strokeWeight: 1, strokeAlign: 'INSIDE',
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.08 }, blendMode: 'NORMAL', offset: { x: 0, y: 2 }, radius: 8 }],
  fillGeometry: geometry(20), strokeGeometry: geometry(20),
  children: [
    { id: '10:2', name: 'Hero', type: 'RECTANGLE', absoluteBoundingBox: box(16, 16, 288, 180), constraints: TL, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'ref-hero-0001' }], strokes: [], effects: [], fillGeometry: geometry(20) },
    { id: '10:3', name: 'Heading', type: 'TEXT', characters: 'Build your bundle', absoluteBoundingBox: box(16, 212, 288, 28), constraints: TL, fills: [solid(0, 0, 0)], strokes: [], effects: [],
      style: { fontFamily: 'Inter', fontPostScriptName: 'Inter-SemiBold', fontWeight: 600, fontSize: 16, lineHeightPx: 24, lineHeightUnit: 'PIXELS' }, boundVariables: { fontSize: alias('VariableID:2:14') } },
    { id: '10:4', name: 'CTA', type: 'INSTANCE', componentId: 'C:1', absoluteBoundingBox: box(16, 252, 288, 48), constraints: TL, fills: [], strokes: [], effects: [],
      componentProperties: { 'Label#1:0': { value: 'Add to bundle', type: 'TEXT' } }, overrides: [{ id: '10:5', overriddenFields: ['characters'] }],
      children: [{ id: '10:5', name: 'Label', type: 'TEXT', characters: 'Add to bundle', absoluteBoundingBox: box(40, 266, 240, 20), constraints: TL, fills: [solid(1, 1, 1)], strokes: [], effects: [],
        style: { fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 14, lineHeightPx: 20, lineHeightUnit: 'PIXELS' } }] },
    { id: '10:6', name: 'Legacy banner', type: 'FRAME', visible: false, absoluteBoundingBox: box(16, 320, 288, 60), constraints: TL, fills: [], strokes: [], effects: [],
      children: [
        { id: '10:7', name: 'Old copy', type: 'TEXT', characters: 'SENTINEL-HIDDEN-COPY', absoluteBoundingBox: box(0, 0, 10, 10), constraints: TL, fills: [], strokes: [], effects: [] },
        { id: '10:8', name: 'Old art', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 10, 10), constraints: TL, fills: [], strokes: [], effects: [] },
      ] },
  ],
});
const KITCHEN = nodesPayload(kitchenSink(), { components: { 'C:1': { key: 'ck', name: 'Button / Primary', description: '' } } });
// A row of identical cards where only ids, positions, image refs and text differ: the fold's shape.
const card = (i) => ({
  id: `20:${100 + i}`, name: 'Product Card', type: 'INSTANCE', componentId: 'C:9', absoluteBoundingBox: box(i * 320, 0, 300, 380), constraints: TL,
  fills: [solid(1, 1, 1)], strokes: [], effects: [], cornerRadius: 8, fillGeometry: geometry(4),
  children: [
    { id: `20:${200 + i}`, name: 'Image', type: 'RECTANGLE', absoluteBoundingBox: box(i * 320, 0, 300, 240), constraints: TL, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: `ref-${i}` }], strokes: [], effects: [] },
    { id: `20:${300 + i}`, name: 'Title', type: 'TEXT', characters: `Bundle ${i}`, absoluteBoundingBox: box(i * 320, 260, 300, 20), constraints: TL, fills: [solid(0, 0, 0)], strokes: [], effects: [],
      style: { fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 14, lineHeightPx: 20, lineHeightUnit: 'PIXELS' } },
  ],
});
const CARDS = nodesPayload({ id: '20:1', name: 'Grid', type: 'FRAME', absoluteBoundingBox: box(0, 0, 2560, 380), constraints: TL, layoutMode: 'HORIZONTAL',
  primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'AUTO', itemSpacing: 20, fills: [], strokes: [], effects: [], children: Array.from({ length: 8 }, (_, i) => card(i)) });
// Every visible node id of a document, and every #id token a markdown tree carries (lines and fold cells).
function visibleIds(doc, out = []) {
  if (doc.visible === false) return out;
  out.push(String(doc.id));
  for (const k of doc.children || []) visibleIds(k, out);
  return out;
}
const idsIn = (md) => new Set((md.match(/#[0-9A-Za-z]+[:;][0-9A-Za-z:;_-]+/g) || []).map((x) => x.slice(1)));
const texts = (doc, out = []) => { if (doc.visible === false) return out; if (typeof doc.characters === 'string') out.push(doc.characters); for (const k of doc.children || []) texts(k, out); return out; };

// ES — sniff
{
  const rows = [
    ['page.html', PAGE, 'html', 'html'],
    ['app.log', APPLOG, 'log', 'log'],
    ['test-output.txt', TESTOUT, 'text', 'test-output'],
    ['git-diff.txt', DIFF, 'text', 'diff'],
    ['go-test', GO, 'text', 'test-output'],
    ['rspec', RSPEC, 'text', 'test-output'],
    ['pytest', PYTEST, 'text', 'test-output'],
    ['template-doc', "<!doctype html>\n{% render 'x' %}", 'text', 'template'],
    ['diff-with-head', `diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -1,2 +1,2 @@\n <html>\n-<head>\n+<head lang="en">\n`, 'text', 'diff'],
    ['jql-search-ELC.json', JQL, 'json', 'json'],
    ['mcp-envelope-jira.json', fx('mcp-envelope-jira.json'), 'json', 'json'],
    ['jira-issue-ELC-104.json', fx('jira-issue-ELC-104.json'), 'json', 'json'],
    ['figma-design-context.jsx', fx('figma-design-context.jsx'), 'figma', 'figma-jsx'],
    ['figma-metadata-3326-39542.xml', fx('figma-metadata-3326-39542.xml'), 'text', 'xml'],
    ['jsonl', JSONL, 'jsonl', 'jsonl'],
    ['grep-listing', GREP, 'text', 'prose'],
    ['png', PNG, 'binary', 'magic-bytes'],
    ['empty', '', 'none', 'empty'],
    ['adf', ADF, 'adf', 'adf-doc'],
    ['figma-node-rest.json', REST, 'figma-nodes', 'figma-rest-nodes'],
    ['nodes-kitchen', JSON.stringify(KITCHEN), 'figma-nodes', 'figma-rest-nodes'],
    ['nodes-empty', JSON.stringify({ nodes: {} }), 'json', 'json'],
    ['nodes-no-document', JSON.stringify({ nodes: { '1:1': { components: {} } } }), 'json', 'json'],
    ['nodes-null-entry', JSON.stringify({ nodes: { '1:1': { document: { id: '1:1', type: 'FRAME', children: [] } }, '1:2': null } }), 'json', 'json'],
    ['nodes-untyped-document', JSON.stringify({ nodes: { '1:1': { document: { id: '1:1', absoluteBoundingBox: box(0, 0, 1, 1) } } } }), 'json', 'json'],
  ];
  for (const [name, data, engine, reason] of rows) {
    const s = sniff({ data });
    eq(`ES-${name}`, [s.engine, s.reason], [engine, reason]);
    check(`ES-${name}-confidence`, typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1, String(s.confidence));
  }
  eq('ES-fence', sniff({ data: `Script ran and returned:\n\`\`\`json\n${JQL}\n\`\`\`\n` }).reason, 'fence');
  eq('ES-pdf-string', sniff({ data: '%PDF-1.7\n...' }).engine, 'binary');
  eq('ES-fence-figma-nodes', [sniff({ data: `Saved nodes:\n\`\`\`json\n${REST}\n\`\`\`\n` }).engine, sniff({ data: `Saved nodes:\n\`\`\`json\n${REST}\n\`\`\`\n` }).reason], ['figma-nodes', 'fence']);
  eq('ES-hint-not-read', sniff({ data: JQL, hint: { variables: VARS, filename: 'K1-1-2.nodes.json' } }).engine, 'json');
}

// EC — compress, one row per engine and per guard
function ecRows() {
  const spillDir = '/spill/root';
  const out = {};
  {
    const r = compress({ data: JQL }, { ...O, spillDir });
    out.jql = r;
    eq('EC-jql', [r.v, r.engine, r.decision], [1, 'json', 'compressed']);
    const rows = (r.parts || []).filter((p) => p.kind === 'rows');
    check('EC-jql-rows-part', rows.length >= 1 && rows.every((p) => /^slim-rows-[0-9a-f]{16}\.json$/.test(p.suggestedName) && r.text.includes(`<<full=${spillDir}/${p.suggestedName} `)), JSON.stringify((r.parts || []).map((p) => p.suggestedName)));
    check('EC-jql-rows-payload', rows.every((p) => Array.isArray(JSON.parse(p.payload))), 'a rows part is not a JSON array');
    check('EC-jql-spill', r.spill && r.spill.kind === 'original' && r.spill.payload === JQL && /^slim-original-[0-9a-f]{16}\.json$/.test(r.spill.suggestedName), JSON.stringify(r.spill && r.spill.suggestedName));
    eq('EC-jql-stats', [r.stats.bytesIn, r.stats.bytesOut, r.stats.pct], [bytes(JQL), bytes(r.text), Math.round((1 - bytes(r.text) / bytes(JQL)) * 1000) / 10]);
  }
  {
    const r = compress({ data: JSONL }, O);
    eq('EC-jsonl', [r.engine, r.decision], ['jsonl', 'compressed']);
  }
  {
    const r = compress({ data: APPLOG }, O);
    out.log = r;
    eq('EC-log', [r.engine, r.decision], ['log', 'compressed']);
    const errors = APPLOG.split('\n').filter((l) => / ERROR /.test(l));
    check('EC-log-errors-kept', errors.length >= 5 && errors.every((l) => r.text.includes(l)), `${errors.length} errors`);
    const trace = APPLOG.split('\n').filter((l) => l.startsWith('java.lang.') || l.startsWith('\tat '));
    check('EC-log-trace-kept', trace.length === 9 && trace.every((l) => r.text.includes(l)), `${trace.length} trace lines`);
    check('EC-log-dedupe', / ×\d+$/m.test(r.text), 'no ×N survivor marker');
  }
  {
    const r = compress({ data: fx('figma-design-context.jsx') }, { ...O, spillDir });
    eq('EC-figma', [r.engine, r.decision], ['figma', 'compressed']);
    const ids = (r.parts || []).filter((p) => p.kind === 'ids');
    check('EC-figma-ids-part', ids.length === 1 && /^slim-ids-[0-9a-f]{16}\.json$/.test(ids[0].suggestedName) && r.text.includes(`ids=${spillDir}/${ids[0].suggestedName}`), JSON.stringify(r.parts));
    check('EC-figma-header', r.text.startsWith('<<fnd-jsx-slim>> '), r.text.slice(0, 40));
  }
  {
    const r = compress({ data: PAGE }, O);
    out.page = r;
    eq('EC-html', [r.engine, r.decision], ['html', 'compressed']);
    const hrefs = new Set();
    for (const m of PAGE.matchAll(/<a [^>]*href="([^"]+)"/g)) hrefs.add(m[1]);
    const srcs = [...PAGE.matchAll(/<script [^>]*src="([^"]+)"/g)].map((m) => m[1]);
    check('EC-html-title', r.text.startsWith('# Northwind Ceramics — Spring Catalogue\n'), r.text.slice(0, 60));
    check('EC-html-links', r.text.includes(`\nlinks (${hrefs.size}):\n`), `want links (${hrefs.size})`);
    check('EC-html-scripts', srcs.length === 6 && r.text.includes(`\nscripts (6):\n${srcs.map((s) => `- ${s}`).join('\n')}`), srcs.join(' '));
    check('EC-html-dropped', !r.text.includes('<style') && !r.text.includes('SENTINEL-STYLE-9Q') && !r.text.includes('SENTINEL-SCRIPT-4K') && !r.text.includes('<svg'), 'inline style/script/svg survived');
    check('EC-html-60pct', r.stats.pct >= 60, String(r.stats.pct));
  }
  {
    const r = compress({ data: GREP }, { ...O, engines: ['text'] });
    out.grep = r;
    const lines = GREP.split('\n');
    eq('EC-grep', [r.engine, r.decision], ['text', 'compressed']);
    check('EC-grep-marker', / of 3,000 lines hidden \(/.test(r.text), r.text.slice(0, 120));
    check('EC-grep-ends', r.text.startsWith(`${lines[0]}\n`) && r.text.endsWith(`\n${lines[lines.length - 1]}`), 'first/last line not verbatim');
    eq('EC-grep-window', [r.window.lines_total, r.window.lines_total - r.window.lines_hidden < 3000], [3000, true]);
  }
  {
    eq('EC-test-output-default', [compress({ data: TESTOUT }, O).decision, compress({ data: TESTOUT }, O).reason], ['passthrough', 'plain-gate']);
    const r = compress({ data: TESTOUT }, { ...O, plainBytes: 8192, budgetBytes: 8192 });
    const lines = TESTOUT.split('\n');
    check('EC-test-output-window', r.decision === 'compressed' && r.engine === 'text' && r.text.startsWith(lines.slice(0, 3).join('\n')) && r.text.endsWith(lines.slice(-4).join('\n')), r.text.slice(-200));
    check('EC-test-output-lines-verbatim', r.text.split('\n').filter((l) => !l.startsWith('[slim: ')).every((l) => lines.includes(l)), 'a line was rewritten');
  }
  {
    const r = compress({ data: DIFF }, { ...O, plainBytes: 8192, budgetBytes: 8192 });
    const lines = DIFF.split('\n');
    check('EC-diff-window-only', r.engine === 'text' && r.text.split('\n').filter((l) => !l.startsWith('[slim: ')).every((l) => lines.includes(l)), r.engine);
  }
  {
    const env = JSON.stringify({ isError: true, content: [{ type: 'text', text: JQL }] });
    const r = compress({ data: env }, O);
    eq('EC-error-shape', [r.decision, r.reason], ['passthrough', 'error-shape']);
  }
  {
    const r = compress({ data: ORDERS }, O);
    check('EC-orders-sentinel', r.decision === 'compressed' && !r.text.includes('SENTINEL-ORDER-0217') && r.spill.payload.includes('SENTINEL-ORDER-0217'), r.decision);
  }
  {
    const r = compress({ data: ADF }, O);
    check('EC-adf', r.engine === 'adf' && r.decision === 'compressed' && r.text.startsWith('**Paragraph 0 of the technical approach.**'), r.text.slice(0, 60));
  }
  {
    const r = compress({ data: JQL }, { ...O, engines: ['html'] });
    eq('EC-allow-list', [r.decision, r.reason, r.text === JQL], ['passthrough', 'engine-not-allowed', true]);
    const f = compress({ data: GREP }, { ...O, engine: 'text', plainBytes: 8192, budgetBytes: 4096 });
    check('EC-forced-engine', f.engine === 'text' && bytes(f.text) <= 4096, `${f.engine} ${bytes(f.text)}`);
    const b = compress({ data: JQL }, { maxMs: -1 });
    eq('EC-budget-expired', [b.decision, b.reason], ['passthrough', 'budget-exceeded']);
    // Every engine honours an expired budget, not only json.
    for (const [name, data, o] of [['html', PAGE], ['log', APPLOG], ['figma', fx('figma-design-context.jsx')], ['figma-nodes', REST], ['jsonl', JSONL], ['adf', ADF], ['text', TESTOUT, { plainBytes: 8192 }]]) {
      const x = compress({ data }, { maxMs: -1, ...(o || {}) });
      eq(`EC-budget-expired-${name}`, [x.engine, x.decision, x.reason, x.text === data], [name, 'passthrough', 'budget-exceeded', true]);
    }
    // Unclosed tags cost one bounded scan per `<`: 160 KB of `x<y ` finishes well inside a second.
    const flood = `<!doctype html><html><body>${'x<y '.repeat(40000)}${'<a x="'.repeat(20000)}`;
    const t0 = Date.now();
    const h = compress({ data: flood }, { maxMs: 0 });
    check('EC-html-linear', Date.now() - t0 < 1500 && h.engine === 'html', `${Date.now() - t0} ms ${h.engine} ${h.decision}`);
  }
  return out;
}
const EC = ecRows();

// ET — targetBytes: the trim and fit stages on a crushed body still above the target
{
  const JN = fx('jql-nodes-ELC.json');
  const src = JSON.parse(JN).issues.nodes;
  const target = 32768;
  const spillDir = '/spill/root';
  const r = compress({ data: JN }, { ...O, trace: true, spillDir, targetBytes: target });
  eq('ET-decision', [r.decision, r.engine], ['compressed', 'json']);
  check('ET-stages', ['noise', 'trim', 'fit'].every((s) => r.stats.stages.includes(s)), r.stats.stages.join(' '));
  check('ET-under-target', r.stats.bytesOut <= target && bytes(r.text) === r.stats.bytesOut, String(r.stats.bytesOut));
  check('ET-warnings', r.warnings.some((w) => /^trim: \d+ long strings cut to 300 chars$/.test(w)) && r.warnings.some((w) => /^fit: \d+ of 50 rows offloaded/.test(w)), JSON.stringify(r.warnings));
  const v = JSON.parse(r.text);
  const nodes = v.issues.nodes;
  const kept = nodes.filter((n) => !('_ccr_dropped' in n));
  const byKey = new Map(src.map((n) => [n.key, n]));
  eq('ET-ends-kept', [kept[0].key, kept[0].id, kept[kept.length - 1].key, kept[kept.length - 1].id], ['ELC-1401', src[0].id, 'ELC-1450', src[49].id]);
  check('ET-rows-scalars-intact', kept.every((n) => { const o = byKey.get(n.key); return o && n.id === o.id && n.webUrl === o.webUrl && n.fields.summary === o.fields.summary && n.fields.created === o.fields.created; }), 'an id, url or short string changed');
  const cutRe = /^([\s\S]{299,300})… \[\+(\d+) chars\]$/;
  check('ET-trimmed-form', kept.every((n) => { const o = byKey.get(n.key).fields.description; const m = cutRe.exec(n.fields.description); return m && o.startsWith(m[1]) && o.length === m[1].length + Number(m[2]); }), 'a cut description is not head + [+N chars]');
  const cite = /<<full=(\S+) (\d+)_rows_offloaded>>/.exec(nodes[nodes.length - 1]._ccr_dropped || '');
  const part = cite && (r.parts || []).find((p) => `${spillDir}/${p.suggestedName}` === cite[1]);
  check('ET-rows-part-untrimmed', !!part && JSON.parse(part.payload).every((n) => JSON.stringify(n.fields.description) === JSON.stringify(byKey.get(n.key).fields.description)) && kept.length + Number(cite[2]) === 50, cite && cite[0]);
  check('ET-spill-original', r.spill.payload === JN, 'the original spill changed');
  const again = compress({ data: JN }, { ...O, trace: true, spillDir, targetBytes: target });
  eq('ET-deterministic', { ...again, stats: { ...again.stats, ms: 0 } }, { ...r, stats: { ...r.stats, ms: 0 } });

  const plain = compress({ data: JN }, { ...O, trace: true });
  check('ET-no-target-no-trim', plain.decision === 'compressed' && !plain.stats.stages.includes('trim') && !plain.stats.stages.includes('fit') && plain.warnings.length === 0, plain.stats.stages.join(' '));
  const fieldNames = new Set();
  const names = (x) => { if (x && typeof x === 'object') for (const k of Object.keys(x)) { if (!Array.isArray(x)) fieldNames.add(k); names(x[k]); } };
  names(JSON.parse(plain.text).issues.nodes);
  const missing = [...fieldNames].filter((k) => k !== '_ccr_dropped' && !r.text.includes(`"${k}":`));
  check('ET-field-names-kept', fieldNames.size > 20 && missing.length === 0, missing.join(' '));
  const roomy = compress({ data: JN }, { ...O, trace: true, targetBytes: 1e9 });
  eq('ET-target-met-untouched', roomy.text, plain.text);
  const jql = compress({ data: JQL }, { ...O, spillDir, targetBytes: 1e9 });
  eq('ET-crush-unchanged', jql.text, EC.jql.text);
  // The text cannot reach the target: the row fit stops at two rows and says so.
  const tight = compress({ data: JN }, { ...O, targetBytes: 2000 });
  check('ET-target-not-met', tight.decision === 'compressed' && JSON.parse(tight.text).issues.nodes.filter((n) => n.key).length === 2 && tight.warnings.some((w) => /^targetBytes 2000 not met: \d+ B$/.test(w)), JSON.stringify(tight.warnings));

  // Only prose leaves are cut: an id-named field and a whitespace-free token keep every char.
  const prose = (i) => `row ${i} ${'some words here '.repeat(60)}`;
  const synth = JSON.stringify({ items: Array.from({ length: 6 }, (_, i) => ({ id: i, sortKey: prose(i), token: `${i}-`.repeat(300), body: prose(i) })) });
  const s6 = compress({ data: synth }, { ...O, trace: true, targetBytes: Math.floor(bytes(synth) * 0.8) });
  const items = s6.decision === 'compressed' ? JSON.parse(s6.text).items : [];
  check('ET-only-prose-cut', items.length === 6 && s6.stats.stages.join(' ') === 'trim' && items.every((x, i) => x.sortKey === prose(i) && x.token === `${i}-`.repeat(300))
    && items.some((x) => / \[\+\d+ chars\]$/.test(x.body)), `${s6.decision} ${s6.stats.stages}`);

  for (const bad of [0, -1, '32k', NaN, Infinity]) {
    const b = compress({ data: JN }, { ...O, targetBytes: bad });
    eq(`ET-bad-option-${String(bad)}`, [b.decision, b.reason, b.warnings], ['refused', 'bad-option', ['invalid option: targetBytes']]);
  }
  const strip = (x) => ({ ...x, stats: { ...x.stats, ms: 0 } });
  for (const [name, data, o] of [['html', PAGE], ['log', APPLOG], ['figma', fx('figma-design-context.jsx')], ['text', TESTOUT, { plainBytes: 8192, budgetBytes: 8192 }]]) {
    eq(`ET-ignored-by-${name}`, strip(compress({ data }, { ...O, ...(o || {}), targetBytes: 1024 })), strip(compress({ data }, { ...O, ...(o || {}) })));
  }

  // The prose around a dominant fence counts against the target, so the whole text fits.
  const fenced = `${'The search returned these issues for the requested project and sprint. '.repeat(14)}\n\`\`\`json\n${JN}\n\`\`\`\nNOTE: results are paged.`;
  const fr = compress({ data: fenced }, { ...O, trace: true, spillDir, targetBytes: target });
  check('ET-fenced-under-target', fr.decision === 'compressed' && fr.stats.stages.includes('fence') && fr.stats.bytesOut <= target && !fr.warnings.some((w) => /not met/.test(w)), `${fr.decision} ${fr.stats.bytesOut} ${JSON.stringify(fr.warnings)}`);

  // Trim cuts prose in every row array before fit offloads any row.
  const para = (tag, i, n) => `${tag} ${i} ${'plain words about the change '.repeat(n)}`;
  const two = JSON.stringify({
    issues: Array.from({ length: 20 }, (_, i) => ({ key: `I-${i}`, body: para('issue', i, 140) })),
    comments: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, body: para('comment', i, 88) })),
  });
  const tw = compress({ data: two }, { ...O, trace: true, spillDir, targetBytes: target });
  const twv = tw.decision === 'compressed' ? JSON.parse(tw.text) : { issues: [], comments: [] };
  check('ET-trim-every-array', tw.stats.bytesOut <= target && !tw.stats.stages.includes('fit') && twv.issues.length === 20 && twv.comments.length === 20
    && twv.issues.every((x) => / \[\+\d+ chars\]$/.test(x.body)) && twv.comments.some((x) => / \[\+\d+ chars\]$/.test(x.body)), `${tw.stats.stages} ${twv.issues.length}/${twv.comments.length} ${tw.stats.bytesOut}`);

  // A first row alone above the target walks fit down to two rows; it registers at most two rows
  // parts on the way (plus the crush's one), not one per subset it tries.
  const json = require(path.join(ENGINES, 'json.cjs'));
  const heavy = JSON.parse(JN);
  heavy.issues.nodes[0].labels = Array.from({ length: 4000 }, (_, i) => `label-${i}`);
  let calls = 0;
  const fitRun = json.run(JSON.stringify(heavy), { targetBytes: target }, { deadline: null, part: (kind) => { calls++; return `/spill/${kind}-0123456789abcdef.json`; } });
  check('ET-fit-parts-bounded', fitRun.decision === 'compressed' && calls <= 3 && JSON.parse(fitRun.text).issues.nodes.filter((n) => n.key).length === 2, `${calls} part calls`);
}

// EN — figma-nodes: the REST nodes response as a markdown build tree
{
  const fn = require(path.join(ENGINES, 'figma-nodes.cjs'));
  const k = compress({ data: KITCHEN, hint: { variables: VARS, filename: '/x/ABC123-10-1.nodes.json' } }, { ...O, trace: true, spillDir: '/spill/root' });
  eq('EN-kitchen', [k.engine, k.decision, k.stats.stages], ['figma-nodes', 'compressed', ['nodes']]);
  eq('EN-kitchen-meta', k.meta, { nodes: 5, hidden: 3, folded: 0 });
  const kids = idsIn(k.text);
  const want = visibleIds(KITCHEN.nodes['10:1'].document);
  check('EN-kitchen-ids-lossless', want.every((id) => kids.has(id)), want.filter((id) => !kids.has(id)).join(' '));
  check('EN-kitchen-hidden-dropped', !k.text.includes('SENTINEL-HIDDEN-COPY') && !kids.has('10:7') && !kids.has('10:6') && k.text.includes('3 hidden dropped'), k.text.slice(0, 400));
  check('EN-kitchen-texts', texts(KITCHEN.nodes['10:1'].document).every((t) => k.text.includes(JSON.stringify(t))), 'a TEXT value is missing');
  check('EN-kitchen-variables', k.text.includes('tokens: variables') && k.text.includes('fill:$Core/Surface/Card (#FFFFFF)') && k.text.includes('gap $Core/Space/Gutter (12; var default 20)') && k.text.includes('[$Core/Type/Body Size (16)]/24'), k.text);
  check('EN-kitchen-geometry-dropped', !k.text.includes('NONZERO') && !k.text.includes('overriddenFields') && k.text.includes('props:{Label="Add to bundle"}'), 'geometry or overrides survived');
  check('EN-file-key', k.text.includes('\nfile: ABC123 · "Bundle System"\n'), k.text.slice(0, 200));
  check('EN-header-bytes', k.text.includes(`\nbytes: ${bytes(JSON.stringify(KITCHEN))} → ${bytes(k.text)} (`), /bytes: .*/.exec(k.text)[0]);
  check('EN-spill-json', k.spill && /^slim-original-[0-9a-f]{16}\.json$/.test(k.spill.suggestedName) && k.spill.payload === JSON.stringify(KITCHEN), k.spill && k.spill.suggestedName);

  const raw = compress({ data: KITCHEN }, O);
  check('EN-raw-tokens', raw.decision === 'compressed' && raw.text.includes('tokens: raw values') && raw.text.includes('fill:$var:2:11 (#FFFFFF)') && raw.text.includes('\nfile: (key unknown) · '), raw.text.slice(0, 600));
  for (const [name, hint] of [['array', []], ['string', 'K1-1-2.nodes.json'], ['vars-not-object', { variables: 'x', filename: 7 }]]) {
    const h = compress({ data: KITCHEN, hint }, O);
    eq(`EN-bad-hint-${name}`, [h.decision, h.text], ['compressed', raw.text]);
  }

  const c = compress({ data: CARDS }, O);
  const doc = CARDS.nodes['20:1'].document;
  const cids = idsIn(c.text);
  eq('EN-cards', [c.engine, c.decision, c.meta.nodes, c.meta.hidden, c.meta.folded], ['figma-nodes', 'compressed', 25, 0, 21]);
  check('EN-cards-fold', /\[INSTANCE\] "Product Card" #20:100 .* ×8$/m.test(c.text) && c.text.includes('folds ×7 ('), c.text);
  check('EN-cards-ids-lossless', visibleIds(doc).every((id) => cids.has(id)), visibleIds(doc).filter((id) => !cids.has(id)).join(' '));
  check('EN-cards-texts-and-refs', texts(doc).every((t) => c.text.includes(JSON.stringify(t))) && Array.from({ length: 8 }, (_, i) => `ref-${i}`).every((r) => c.text.includes(r)), 'a folded text or image ref is missing');

  const r = compress({ data: REST }, O);
  const rdoc = JSON.parse(REST).nodes['3326:39542'].document;
  const rids = idsIn(r.text);
  check('EN-rest', r.engine === 'figma-nodes' && r.decision === 'compressed' && r.stats.pct > 75 && r.meta.nodes === visibleIds(rdoc).length, `${r.engine} ${r.decision} ${r.stats.pct} ${JSON.stringify(r.meta)}`);
  check('EN-rest-ids-lossless', visibleIds(rdoc).every((id) => rids.has(id)), 'an id is missing');

  // targetBytes: the deepest level folds first, one level per pass, never past the root's children.
  const strip = (x) => ({ ...x, stats: { ...x.stats, ms: 0 } });
  const depthOf = (n, d = 0) => (n.visible === false ? [] : [[n.id, d], ...(n.children || []).flatMap((k) => depthOf(k, d + 1))]);
  const t1 = compress({ data: REST }, { ...O, trace: true, targetBytes: 27952 });
  const t1ids = idsIn(t1.text);
  check('EN-target-one-fold', r.stats.bytesOut > 27952 && t1.decision === 'compressed' && t1.engine === 'figma-nodes' && t1.stats.bytesOut <= 27952
    && t1.stats.stages.join(' ') === 'nodes depth' && t1.warnings.join() === 'depth: 240 nodes below depth 2 folded to meet targetBytes'
    && /^ {6}… 4 nodes deeper folded$/m.test(t1.text) && t1.text.includes('\nnodes: 303 visible · 0 hidden dropped · 0 folded · 240 below depth 2 folded to fit (the original has them)\n')
    && t1.meta.nodes === r.meta.nodes && t1.text.includes(`\nbytes: ${bytes(REST)} → ${bytes(t1.text)} (`), `${t1.stats.bytesOut} ${t1.stats.stages} ${JSON.stringify(t1.warnings)}`);
  check('EN-target-fold-keeps-shallow-ids', depthOf(rdoc).filter(([, d]) => d <= 2).every(([id]) => t1ids.has(id)) && depthOf(rdoc).filter(([, d]) => d === 3).every(([id]) => !t1ids.has(id)), 'a shallow id is missing or a deep one stayed');
  // The 60 cards differ below the cap (titles, prices, fills): each keeps its own line, none folds as identical.
  check('EN-target-cap-no-false-fold', !/×\d+$/m.test(t1.text) && Array.from({ length: 60 }, (_, i) => `#100:${1000 + i} `).every((id) => t1.text.includes(id)), 'a card folded although its hidden subtree differs');
  const same = JSON.parse(JSON.stringify(CARDS));
  for (const k of same.nodes['20:1'].document.children) { k.children[0].fills[0].imageRef = 'ref-0'; k.children[1].characters = 'Bundle 0'; }
  const capped = (p) => fn.compact(p, { depthCap: 1 }).md;
  check('EN-target-cap-folds-identical', /"Product Card" #20:100 .* ×8$/m.test(capped(same)) && !/×\d+$/m.test(capped(CARDS)), capped(CARDS));
  const t2 = compress({ data: REST }, { ...O, targetBytes: 2000 });
  check('EN-target-two-folds', t2.decision === 'compressed' && t2.stats.bytesOut <= 2000 && t2.warnings.join() === 'depth: 300 nodes below depth 1 folded to meet targetBytes', `${t2.stats.bytesOut} ${JSON.stringify(t2.warnings)}`);
  eq('EN-target-unreachable-whole', strip(compress({ data: REST }, { ...O, targetBytes: 1024 })), strip(r));
  eq('EN-target-under-untouched', strip(compress({ data: REST }, { ...O, targetBytes: r.stats.bytesOut })), strip(r));
  const ft = compress({ data: `Saved nodes:\n\`\`\`json\n${REST}\n\`\`\`\n` }, { ...O, targetBytes: 27952 });
  check('EN-target-fence-counts', ft.decision === 'compressed' && ft.stats.bytesOut <= 27952 && ft.text.startsWith('Saved nodes:\n\n# figma node 3326:39542') && ft.text.includes('deeper folded'), `${ft.stats.bytesOut}`);

  const fenced = `Saved nodes:\n\`\`\`json\n${REST}\n\`\`\`\n`;
  const fr = compress({ data: fenced }, O);
  check('EN-fence', fr.engine === 'figma-nodes' && fr.decision === 'compressed' && fr.text.startsWith('Saved nodes:\n\n# figma node 3326:39542'), fr.text.slice(0, 80));
  check('EN-fence-header-bytes', fr.text.includes(`\nbytes: ${bytes(fenced)} → ${bytes(fr.text)} (`) && fr.stats.bytesOut === bytes(fr.text), /bytes: .*/.exec(fr.text)[0]);
  const trailed = `Saved nodes:\n\`\`\`json\n${REST}\n\`\`\`\nAll nodes fetched — ${'ü'.repeat(40)}.`;
  const tr = compress({ data: trailed }, O);
  check('EN-fence-trailer-header-bytes', tr.decision === 'compressed' && tr.text.endsWith(`${'ü'.repeat(40)}.`) && tr.text.includes(`\nbytes: ${bytes(trailed)} → ${bytes(tr.text)} (`), /bytes: .*/.exec(tr.text)[0]);

  // Long copy (legal text, descriptions) stays whole, on a node line and inside a fold's delta row.
  const long = (i) => `Terms apply ${i}. ${'Offer valid while stocks last and subject to availability. '.repeat(9)}END-SENTINEL-${i}`;
  const longCard = (i) => { const k = card(i); k.children[1].characters = long(i); return k; };
  const LONG = nodesPayload({ ...CARDS.nodes['20:1'].document, children: Array.from({ length: 4 }, (_, i) => longCard(i)) });
  const lt = compress({ data: LONG }, O);
  check('EN-long-text-full', lt.decision === 'compressed' && lt.meta.folded > 0 && [0, 1, 2, 3].every((i) => long(i).length > 500 && lt.text.includes(JSON.stringify(long(i)))) && !/\(\+\d+ chars, \d+ total\)/.test(lt.text), lt.text);
  check('EN-long-text-opt-in-cut', fn.compact(LONG, { maxText: 200 }).md.includes(`(+${long(0).length - 200} chars, ${long(0).length} total)`), 'maxText 200 no longer cuts');

  const forced = compress({ data: JQL }, { ...O, engine: 'figma-nodes' });
  eq('EN-forced-non-nodes', [forced.engine, forced.decision, forced.reason, forced.text === JQL], ['figma-nodes', 'passthrough', 'non-figma-nodes', true]);
  const tiny = JSON.stringify(nodesPayload({ id: '1:1', name: 'A', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1, 1) }));
  eq('EN-no-gain', [compress({ data: tiny }, O).decision, compress({ data: tiny }, O).reason], ['passthrough', 'no-gain']);
  const allHidden = nodesPayload({ id: '1:1', name: 'A', type: 'FRAME', visible: false, absoluteBoundingBox: box(0, 0, 1, 1), fillGeometry: geometry(80), children: [] });
  const ah = compress({ data: allHidden }, O);
  check('EN-hidden-root', ah.decision === 'compressed' && ah.meta.hidden === 1 && ah.text.includes('(the requested node is hidden — visible:false)'), ah.decision);

  const fig = fn.figureLine(c.stats.bytesIn, c.stats.bytesOut, c.meta);
  check('EN-figure', /^figma-nodes: \d+ B → \d+ B \(-\d+\.\d%\) nodes=25 hidden=0 folded=21$/.test(fig) && fig.includes(`(-${c.stats.pct.toFixed(1)}%)`), fig);
  eq('EN-figure-grown', fn.figureLine(100, 150, { nodes: 1, hidden: 2, folded: 3 }), 'figma-nodes: 100 B → 150 B (+50.0%) nodes=1 hidden=2 folded=3');
  eq('EN-key-from-name', [fn.keyFromName('/a/b/AbC123-1-2.nodes.json'), fn.keyFromName('AbC123-1-2.nodes.json'), fn.keyFromName('nodes.json'), fn.keyFromName(undefined)], ['AbC123', 'AbC123', '', '']);
  eq('EN-is-nodes', [fn.isNodesResponse(KITCHEN), fn.isNodesResponse({ nodes: {} }), fn.isNodesResponse(null), fn.isNodesResponse([KITCHEN])], [true, false, false, false]);
}

// EM — media planning: kind from the leading bytes, outputs from probe facts, the figure line
{
  const media = require(path.join(ENGINES, 'media.cjs'));
  const head = (...parts) => Buffer.concat(parts.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x))));
  const box = (brand) => head([0, 0, 0, 0x20], 'ftyp', brand, [0, 0, 2, 0]);
  eq('EM-kind', [
    head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR'), head([0xff, 0xd8, 0xff, 0xe0]), head('GIF89a'), head('RIFF', [1, 2, 3, 4], 'WEBPVP8 '),
    box('isom'), box('qt  '), head([0x1a, 0x45, 0xdf, 0xa3], 'B\u0082\u0084webm'), head([0x1a, 0x45, 0xdf, 0xa3], 'B\u0082\u0088matroska'),
    head('RIFF', [1, 2, 3, 4], 'AVI LIST'), box('heic'), box('avif'), head('{"a":1}'), Buffer.alloc(0), 'not a buffer',
  ].map((b) => media.kindOf(b)), [
    { kind: 'image', format: 'png' }, { kind: 'image', format: 'jpeg' }, { kind: 'image', format: 'gif' }, { kind: 'image', format: 'webp' },
    { kind: 'video', format: 'mp4' }, { kind: 'video', format: 'mov' }, { kind: 'video', format: 'webm' }, { kind: 'video', format: 'mkv' },
    { kind: 'video', format: 'avi' }, null, null, null, null, null,
  ]);

  const img = (w, h, extra) => media.plan({ kind: 'image', format: 'png', name: 'shot', ext: 'png', width: w, height: h, ...extra });
  eq('EM-plan-landscape', img(4000, 3000), { kind: 'image', outputs: [{ rel: 'shot.1568.png' }], source: { w: 4000, h: 3000 }, scale: { w: 1568, h: 1176 }, resized: true });
  eq('EM-plan-portrait', media.plan({ kind: 'image', format: 'jpeg', name: 'p', ext: 'JPG', width: 1000, height: 3000 }).scale, { w: 523, h: 1568 });
  eq('EM-plan-portrait-name', media.plan({ kind: 'image', format: 'jpeg', name: 'p', ext: 'JPG', width: 1000, height: 3000 }).outputs, [{ rel: 'p.1568.jpg' }]);
  eq('EM-plan-small', img(800, 600), { kind: 'image', outputs: [{ rel: 'shot.1568.png' }], source: { w: 800, h: 600 }, scale: { w: 800, h: 600 }, resized: false });
  eq('EM-plan-edge', img(1568, 10).resized, false);
  eq('EM-plan-webp-as-png', media.plan({ kind: 'image', format: 'webp', name: 'w', ext: 'webp', width: 10, height: 10 }).outputs, [{ rel: 'w.1568.png' }]);
  eq('EM-plan-long-edge-opt', media.plan({ kind: 'image', format: 'png', name: 's', ext: 'png', width: 4000, height: 2000 }, { longEdge: 800 }).outputs[0].rel, 's.800.png');
  eq('EM-target', [
    media.target({ kind: 'image', name: 'shot', ext: 'jpg' }), media.target({ kind: 'image', name: 'screenshot', ext: '' }),
    media.target({ kind: 'image', name: 'a', ext: 'WEBP' }), media.target({ kind: 'image', name: 'a', ext: 'dat' }), media.target({ kind: 'image', name: 'a', ext: 'JPG' }),
    media.target({ kind: 'image', name: 's', ext: 'png' }, { longEdge: 800 }), media.target({ kind: 'video', name: 'clip', ext: 'mov' }),
    media.target({ kind: 'image', ext: 'png' }), media.target({ kind: 'audio', name: 'x' }), media.target(null),
  ], ['shot.1568.jpg', 'screenshot.1568.png', 'a.1568.png', 'a.1568.png', 'a.1568.jpg', 's.800.png', 'clip.frames/001.jpg', null, null, null]);
  eq('EM-plan-name-from-ext-not-content', [
    media.plan({ kind: 'image', format: 'webp', name: 'shot', ext: 'jpg', width: 10, height: 10 }).outputs[0].rel,
    media.plan({ kind: 'image', format: 'png', name: 'screenshot', ext: '', width: 10, height: 10 }).outputs[0].rel,
  ], ['shot.1568.jpg', 'screenshot.1568.png']);
  const turned = (rotation, kind = 'video') => media.plan({ kind, format: 'mp4', name: 'phone', ext: 'mp4', width: 1920, height: 1080, durationS: 4, rotation });
  eq('EM-plan-rotated', [turned(-90), turned(90), turned(270), turned(180), turned(0), turned(-90, 'image')].map((p) => [p.source, p.scale]), [
    [{ w: 1080, h: 1920 }, { w: 882, h: 1568 }], [{ w: 1080, h: 1920 }, { w: 882, h: 1568 }], [{ w: 1080, h: 1920 }, { w: 882, h: 1568 }],
    [{ w: 1920, h: 1080 }, { w: 1568, h: 882 }], [{ w: 1920, h: 1080 }, { w: 1568, h: 882 }], [{ w: 1080, h: 1920 }, { w: 882, h: 1568 }],
  ]);

  const vid = (dur, opts) => media.plan({ kind: 'video', format: 'mp4', name: 'clip', ext: 'mp4', width: 1920, height: 1080, durationS: dur }, opts);
  const v7 = vid(7);
  eq('EM-plan-video-7s', [v7.dir, v7.outputs.map((o) => o.rel), v7.outputs.map((o) => o.t), v7.interval, v7.scale, v7.resized, v7.scene],
    ['clip.frames', ['clip.frames/001.jpg', 'clip.frames/002.jpg', 'clip.frames/003.jpg', 'clip.frames/004.jpg'], [0, 2, 4, 6], 2, { w: 1568, h: 882 }, true, false]);
  eq('EM-plan-video-small', [media.plan({ kind: 'video', format: 'mp4', name: 'c', ext: 'mp4', width: 640, height: 360, durationS: 2 }).resized, media.target({ kind: 'video', name: 'c' })], [false, 'c.frames/001.jpg']);
  const v120 = vid(120);
  eq('EM-plan-video-120s', [v120.outputs.length, v120.interval, v120.outputs[23].t, v120.outputs[23].rel], [24, 5, 115, 'clip.frames/024.jpg']);
  eq('EM-plan-video-short', vid(0.4).outputs.map((o) => o.t), [0]);
  eq('EM-plan-video-opts', vid(10, { everyS: 1, maxFrames: 3 }).outputs.map((o) => o.t), [0, 3.333, 6.667]);
  const sc = vid(30, { scene: true });
  eq('EM-plan-scene', [sc.outputs.length, sc.outputs[0].t, sc.interval, sc.scene], [24, null, null, true]);
  eq('EM-plan-refused', [
    media.plan({ kind: 'image', name: 'x', width: 0, height: 10 }), media.plan({ kind: 'video', name: 'x', width: 10, height: 10 }),
    media.plan({ kind: 'video', name: 'x', width: 10, height: 10, durationS: NaN }), media.plan({ kind: 'audio', name: 'x', width: 1, height: 1 }),
    media.plan({ kind: 'image', width: 10, height: 10 }), media.plan(null),
  ], [{ refused: 'no-probe' }, { refused: 'no-probe' }, { refused: 'no-probe' }, { refused: 'not-media' }, { refused: 'no-probe' }, { refused: 'not-media' }]);

  eq('EM-figure', [media.figureLine(5000, 1250, 1), media.figureLine(100, 173, 4), media.figureLine(3, 3, 1)],
    ['media: 5000 B → 1250 B (-75%) frames=1', 'media: 100 B → 173 B (+73%) frames=4', 'media: 3 B → 3 B (-0%) frames=1']);
}

// EQ — jq narrowing: the grammar, the evaluator, and what narrow() refuses
{
  const jq = require(path.join(ENGINES, 'jq.cjs'));
  const DOC = { total: 3, issues: [{ key: 'A-1', fields: { status: { name: 'Open' }, labels: ['x'] } }, { key: 'A-2', fields: { status: { name: 'Done' }, labels: [] } }, { key: 'A-3', fields: {} }], '@type': 'page', '2fa': true };
  const T = JSON.stringify(DOC);
  const val = (src) => { const r = jq.narrow(T, src); return r.decision === 'narrowed' ? r.value : r.reason; };
  eq('EQ-paths', [val('.total'), val('.issues[0].key'), val('issues.1.key'), val('.issues.[2].key'), val('.@type'), val('.2fa')], [3, 'A-1', 'A-2', 'A-3', 'page', true]);
  eq('EQ-fan', [val('.issues[].key'), val('.issues[].fields.status.name'), val('.issues[] | .key')], [['A-1', 'A-2', 'A-3'], ['Open', 'Done', null], ['A-1', 'A-2', 'A-3']]);
  eq('EQ-filters', [val('. | keys'), val('.issues | length'), val('.issues[] | .fields.labels | length'), val('.issues[0] | keys')],
    [['2fa', '@type', 'issues', 'total'], 3, [1, 0, 0], ['fields', 'key']]);
  eq('EQ-multi', val('.total, .issues[1].key'), [3, 'A-2']);
  eq('EQ-unsupported', ['.a | select(.b)', '.. | .x', '.a // 1', '.a?', '.a | add', '.a,', '.["k"]', '.a == 1'].map((e) => jq.narrow(T, e).reason), Array(8).fill('jq-unsupported'));
  check('EQ-unsupported-names-token', jq.narrow(T, '.a | select(.b)').message.startsWith("jq: unsupported syntax near 'select(' — supported: "), jq.narrow(T, '.a | select(.b)').message);
  eq('EQ-whole', ['.', '..', '.[]', '. | .', '., .'].map((e) => jq.narrow(T, e).decision), Array(5).fill('whole'));
  const miss = jq.narrow(T, '.issuez');
  eq('EQ-miss', [miss.reason, miss.message], ['jq-miss', "jq: 'issuez' not found at top level; keys: total, issues, @type, 2fa"]);
  eq('EQ-partial-miss-is-null', val('.issues[].fields.status.name'), ['Open', 'Done', null]);
  eq('EQ-not-json', jq.narrow('plain text, not json', '.a').reason, 'jq-not-json');
  eq('EQ-precision', jq.narrow('{"id":12345678901234567890}', '.id').reason, 'number-precision');
  eq('EQ-jsonl-and-fence', [jq.narrow('{"k":1}\n{"k":2}\n', '.[].k').value, jq.narrow(`Result:\n\`\`\`json\n{"a":{"b":7},"pad":"${'p'.repeat(200)}"}\n\`\`\`\n`, '.a.b').value], [[1, 2], 7]);
  eq('EQ-text-is-json', jq.narrow(T, '.issues[0].fields').text, '{"status":{"name":"Open"},"labels":["x"]}');
  // Inherited members (Object.prototype, an array's or a string's length) are not keys of the document.
  eq('EQ-own-members-only', ['.constructor', '.__proto__', '.issues[0].constructor', '.issues.length', '.toString', '.issues[0].key.length'].map((e) => jq.narrow(T, e).reason), Array(6).fill('jq-miss'));
  eq('EQ-own-proto-key', jq.narrow('{"__proto__":{"a":1},"b":2}', '.__proto__.a').value, 1);
  eq('EQ-inherited-in-fan-misses', val('.issues[].constructor'), 'jq-miss');
  let threw = null;
  try { for (const g of [undefined, null, 42, '', '{', '[]']) for (const e of [undefined, '', '.a', '|', ',,']) jq.narrow(g, e); } catch (e) { threw = e; }
  check('EQ-never-throws', threw === null, String(threw));
}

// EG — guarantees
{
  const circular = {};
  circular.self = circular;
  const garbage = [
    ['undefined', undefined], ['null', null], ['number', 42], ['empty-object', {}], ['circular', { data: circular }],
    ['random-buffer', { data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)) }],
    ['brace-flood', { data: '{'.repeat(1e6) }], ['bad-profile', { data: 'x' }, { profile: 'z' }],
    ['bad-option-type', { data: 'x' }, { plainBytes: 'many' }], ['bad-engine', { data: 'x' }, { engines: ['zip'] }],
    ['number-data', { data: 7 }], ['too-large', { data: 'x'.repeat(2048) }, { maxInputBytes: 1024 }],
  ];
  for (const [name, input, opts] of garbage) {
    let r;
    let threw = null;
    try { r = compress(input, opts); } catch (e) { threw = e; }
    check(`EG-${name}-no-throw`, threw === null, String(threw));
    check(`EG-${name}-shape`, r && r.v === 1 && ['compressed', 'passthrough', 'refused'].includes(r.decision) && typeof r.text === 'string' && Array.isArray(r.warnings) && r.stats && typeof r.stats.bytesIn === 'number', JSON.stringify(r && { ...r, text: undefined }));
    if (r && r.decision !== 'compressed') check(`EG-${name}-reason`, typeof r.reason === 'string' && r.reason.length > 0, JSON.stringify(r.reason));
  }
  eq('EG-refusals', [compress(undefined).reason, compress({ data: circular }).reason, compress({ data: 'x' }, { profile: 'z' }).reason, compress({ data: 'x'.repeat(2048) }, { maxInputBytes: 1024 }).reason, compress({ data: PNG }).reason],
    ['bad-input', 'bad-input', 'bad-option', 'too-large', 'binary']);
  for (const [name, data] of [['undefined', undefined], ['number', 42], ['object', { a: 1 }], ['buffer', PNG]]) {
    let threw = null;
    try { sniff({ data }); sniff(data); } catch (e) { threw = e; }
    check(`EG-sniff-${name}-no-throw`, threw === null, String(threw));
  }
  eq('EG-peek', [peek(JQL).format, peek(PAGE).format, peek(null).format], ['json', 'html', 'text']);

  const strip = (r) => ({ ...r, stats: { ...r.stats, ms: 0 } });
  for (const [name, data, o, hint] of [['jql', JQL], ['page', PAGE], ['log', APPLOG], ['grep', GREP, { engines: ['text'] }], ['figma', fx('figma-design-context.jsx')], ['figma-nodes', REST, {}, { variables: VARS }], ['nodes-cards', JSON.stringify(CARDS)]]) {
    const a = compress({ data, hint }, { ...O, ...(o || {}) });
    const b = compress({ data, hint }, { ...O, ...(o || {}) });
    eq(`EG-deterministic-${name}`, strip(a), strip(b));
  }

  // Never writes: every fs write path throws, and the EC rows still pass.
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'openSync', 'open', 'mkdirSync', 'mkdir', 'renameSync', 'createWriteStream', 'writeSync', 'unlinkSync'];
  const saved = {};
  for (const n of names) { saved[n] = fs[n]; fs[n] = () => { throw new Error(`EG: fs.${n} called`); }; }
  const before = pass;
  const failBefore = fail;
  let threw = null;
  let again;
  try { again = ecRows(); } catch (e) { threw = e; }
  for (const n of names) fs[n] = saved[n];
  check('EG-no-fs-writes', threw === null && fail === failBefore && pass > before, String(threw));
  check('EG-spill-returned-not-written', again && again.jql.spill && again.jql.spill.payload === JQL, 'no spill in the result');
}

// EP — parity
{
  const json = require(path.join(ENGINES, 'json.cjs'));
  const T = json.__test;
  const normJSON = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } };
  let byteExact = 0;
  let valueOnly = 0;
  const dir = path.join(ROOT, 'tests/parity/fixtures/smart_crusher');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const cfg = { markerMode: 'ccr' };
    if (p.config && p.config.min_items_to_analyze != null) cfg.minItemsToAnalyze = p.config.min_items_to_analyze;
    const got = T.crush(p.input.content, cfg);
    const exp = p.output;
    const okByte = got.compressed === exp.compressed;
    const okVal = normJSON(got.compressed) === normJSON(exp.compressed);
    if (okByte) byteExact++; else if (got.wasModified === exp.was_modified && got.strategy === exp.strategy && okVal) valueOnly++;
    check(`EP-crush:${f.replace(/_[0-9a-f]{12}\.json$/, '')}`, got.wasModified === exp.was_modified && got.strategy === exp.strategy && (okByte || okVal), `strategy ${got.strategy} vs ${exp.strategy}`);
  }
  eq('EP-crush-counts', [byteExact, valueOnly], [16, 1]);
  const T0 = { maxItems: T.MAX_ITEMS_AFTER_CRUSH, first: T.FIRST_FRACTION, last: T.LAST_FRACTION, variance: T.VARIANCE_THRESHOLD };
  eq('EP-crush-constants', T0, { maxItems: 15, first: 0.3, last: 0.15, variance: 2 });

  const log = require(path.join(ENGINES, 'log.cjs'));
  const frozen = require(path.join(ROOT, 'plugins/fnd/scripts/log-slim.cjs'));
  const MAP = {
    dedupe_warnings: 'dedupeWarnings', enable_ccr: 'enableCcr', error_context_lines: 'errorContextLines', keep_first_error: 'keepFirstError',
    keep_last_error: 'keepLastError', keep_summary_lines: 'keepSummaryLines', max_errors: 'maxErrors', max_stack_traces: 'maxStackTraces',
    max_total_lines: 'maxTotalLines', max_warnings: 'maxWarnings', min_lines_for_ccr: 'minLinesForCcr', stack_trace_max_lines: 'stackTraceMaxLines',
  };
  const ldir = path.join(ROOT, 'tests/parity/fixtures/log_compressor');
  let upstreamExact = 0;
  for (const f of readdirSync(ldir).filter((x) => x.endsWith('.json')).sort()) {
    const p = JSON.parse(readFileSync(path.join(ldir, f), 'utf8'));
    const cfg = { ccrStore: true };
    for (const [k, v] of Object.entries(p.config || {})) if (MAP[k]) cfg[MAP[k]] = v;
    const got = log.compressLog(p.input, cfg);
    eq(`EP-log:${f.slice(0, 8)}`, got, frozen.compressLog(p.input, cfg));
    if (got.compressed === p.output.compressed) upstreamExact++;
  }
  eq('EP-log-upstream-byte-exact', upstreamExact, 19);
}

// ESP — data spans inside a pasted prompt (spans.cjs): kinds, offsets, prose never a span, already-slim skipped
{
  const { spans, jsonBlobs } = lib;
  const ISSUES = JSON.stringify({ issues: Array.from({ length: 300 }, (_, i) => ({ key: `ACME-${i}`, status: 'open' })) }, null, 2);
  const LOG = Array.from({ length: 400 }, (_, i) => `2026-10-08T10:00:${String(i % 60).padStart(2, '0')}Z ${i % 5 ? 'INFO' : 'WARN'} job ${i} took ${i % 90} ms`).join('\n');
  const ROWS = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: i, sku: `SKU-${i % 40}` })).join('\n');
  const PAGE_DOC = `<!doctype html>\n<html><head><title>T</title></head>\n<body>\n${'<p>synthetic paragraph</p>\n'.repeat(500)}</body></html>`;
  const parts = ['Look at this:\n', ISSUES, '\n\nthen the log\n', LOG, '\n\nrows:\n', ROWS, '\n\npage:\n', PAGE_DOC, '\n\nwhy?'];
  const text = parts.join('');
  const got = spans(text);
  eq('ESP-kinds', got.map((x) => x.kind), ['json', 'log', 'jsonl', 'html']);
  eq('ESP-offsets', got.map((x) => text.slice(x.start, x.end)), [ISSUES, LOG, ROWS, PAGE_DOC]);
  check('ESP-ordered', got.every((x, i) => i === 0 || got[i - 1].end <= x.start), JSON.stringify(got));
  eq('ESP-prose', spans('Plain prose, nothing else. '.repeat(1000)), []);
  eq('ESP-small', spans(`a ${JSON.stringify({ a: 'x'.repeat(4000) })} b ${'words '.repeat(3000)}`), []);
  const fenced = `notes\n\`\`\`\n${LOG}\n\`\`\`\nend`;
  const f = spans(fenced);
  eq('ESP-fence-body', f.map((x) => [x.kind, fenced.slice(x.start, x.end) === LOG]), [['log', true]]);
  const code = `\`\`\`ts\n${Array.from({ length: 900 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n\`\`\``;
  eq('ESP-fenced-code', spans(code), []);
  eq('ESP-already-slim-after', spans(`${ISSUES}\n\nslim: compressed 1 B → 1 B (−0.0%)\n\n<<full=/x original_result>>`), []);
  eq('ESP-already-slim-inside', spans(`${ISSUES.replace('"ACME-0"', '"<<full=/x/fnd-prompt-json-1.json original_result>>"')}`), []);
  const truncated = `{"issues": [${ISSUES}, ${'{"k": 1}, '.repeat(1200)}`;
  eq('ESP-truncated-paste-rail', spans(truncated).filter((x) => x.kind === 'json'), []);
  const adv = '{"a":'.repeat(200000);
  const t0 = Date.now();
  eq('ESP-adversarial-bails', [spans(adv), jsonBlobs(adv).bailed], [[], true]);
  check('ESP-adversarial-fast', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  eq('ESP-min', spans(text, { min: 1e9 }), []);
  eq('ESP-deterministic', JSON.stringify(spans(text)), JSON.stringify(got));
  for (const [name, ask] of [['spaces', '    why does worker-3 keep timing out here? please check'], ['tab', '\twhy does worker-3 keep timing out?'], ['at', '    at what point does it fail?']]) {
    const t = `${LOG}\n${ask}`;
    eq(`ESP-log-indented-question:${name}`, spans(t).map((x) => [x.kind, t.slice(x.start, x.end) === LOG, t.slice(x.end)]), [['log', true, `\n${ask}`]]);
  }
  const FRAMES = '\n    at Worker.run (/srv/app/worker.js:12:7)\n    at async Pool.next (/srv/app/pool.js:40:3)\n\tat com.acme.Job.call(Job.java:88)\n\t... 12 more';
  const traced = `${LOG}${FRAMES}\n\nwhy?`;
  eq('ESP-log-stack-tail-kept', spans(traced).map((x) => traced.slice(x.start, x.end)), [`${LOG}${FRAMES}`]);
  const trailing = `page:\n${PAGE_DOC} why is the header missing?`;
  eq('ESP-html-ends-at-tag', spans(trailing).map((x) => [x.kind, trailing.slice(x.start, x.end) === PAGE_DOC, trailing.slice(x.end)]), [['html', true, ' why is the header missing?']]);
  eq('ESP-jsonBlobs-unclosed', jsonBlobs(`x ${ISSUES.slice(0, -2)} y ${'z'.repeat(9000)}`, 8192).openAt, 2);
}

// EF — the committed fixtures are the generators' output
eq('EF-page', gen('make-page.cjs') === PAGE, true);
eq('EF-app-log', gen('make-log.cjs') === APPLOG, true);
eq('EF-jql-nodes', gen('make-jql-nodes.cjs') === fx('jql-nodes-ELC.json'), true);
check('EF-orders-size', bytes(ORDERS) < 256 * 1024 && bytes(ORDERS) > 150 * 1024 && JSON.parse(ORDERS).orders.length === 240, String(bytes(ORDERS)));

// EL — the layer is pure
{
  const banned = /\bprocess\.|require\(['"](node:)?(fs|fs\/promises|os|child_process|net|http|https|worker_threads|readline)['"]\)|\bset(Timeout|Interval|Immediate)\b|\bglobalThis\b/;
  const files = readdirSync(ENGINES).filter((f) => f.endsWith('.cjs'));
  check('EL-files', ['index.cjs', 'sniff.cjs', 'json.cjs', 'log.cjs', 'html.cjs', 'figma.cjs', 'figma-nodes.cjs', 'adf.cjs', 'media.cjs', 'jq.cjs', 'spans.cjs', 'text-window.cjs', 'util.cjs'].every((f) => files.includes(f)), files.join(' '));
  for (const f of files) {
    const src = readFileSync(path.join(ENGINES, f), 'utf8');
    check(`EL-pure-${f}`, !banned.test(src), (banned.exec(src) || [])[0]);
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    check(`EL-requires-${f}`, reqs.every((r) => r === 'crypto' || /^\.\/[\w-]+\.cjs$/.test(r)), reqs.join(' '));
  }
  check('EL-contract-doc', readFileSync(path.join(ENGINES, 'CONTRACT.md'), 'utf8').includes('compress(input, options)'), 'CONTRACT.md');
}

// EX — the CONTRACT.md microservice example, run as written (its import pointed at this checkout, port 0)
async function serverExample() {
  const doc = readFileSync(path.join(ENGINES, 'CONTRACT.md'), 'utf8');
  const m = /<!-- example:server -->\s*```js\n([\s\S]*?)```/.exec(doc);
  check('EX-found', !!m, 'no example:server block in CONTRACT.md');
  if (!m) return;
  check('EX-ten-lines', m[1].trim().split('\n').length <= 12, `${m[1].trim().split('\n').length} lines`);
  const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slim-ex-')));
  const file = path.join(T, 'server.mjs');
  const src = m[1].replace("'./engines/index.cjs'", JSON.stringify(path.join(ENGINES, 'index.cjs')));
  check('EX-rewrites', src !== m[1] && src.includes('process.env.PORT'), 'the example no longer has the import the test rewrites, or no PORT');
  writeFileSync(file, src);
  const child = spawn('node', [file], { env: { PATH: process.env.PATH, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('no port line')), 10000);
      child.stdout.on('data', (d) => { out += d; const p = /:(\d+)/.exec(out); if (p) { clearTimeout(t); resolve(Number(p[1])); } });
      child.on('exit', (c) => reject(new Error(`exit ${c}`)));
    });
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'text/html' } }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end(PAGE);
    });
    const r = JSON.parse(reply);
    eq('EX-reply', [r.v, r.engine, r.decision, r.text.startsWith('# Northwind')], [1, 'html', 'compressed', true]);
  } catch (e) {
    check('EX-run', false, String(e));
  } finally {
    child.kill();
    rmSync(T, { recursive: true, force: true });
  }
}
await serverExample();

// EX — the CONTRACT.md delivery example, run as written: stdin page → compressed text + a handle to the spill it wrote
{
  const doc = readFileSync(path.join(ENGINES, 'CONTRACT.md'), 'utf8');
  const m = /<!-- example:delivery -->\s*```js\n([\s\S]*?)```/.exec(doc);
  check('EX-delivery-found', !!m, 'no example:delivery block in CONTRACT.md');
  if (m) {
    const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slim-exd-')));
    const file = path.join(T, 'delivery.cjs');
    const src = m[1].replace("'./engines/index.cjs'", JSON.stringify(path.join(ENGINES, 'index.cjs')));
    writeFileSync(file, src);
    const r = spawnSync('node', [file], { input: PAGE, env: { PATH: process.env.PATH, TMPDIR: T }, encoding: 'utf8' });
    const handle = /<<full=(\S+) original_result>>\n$/.exec(r.stdout || '');
    eq('EX-delivery-run', [r.status, (r.stdout || '').startsWith('# Northwind'), !!handle && existsSync(handle[1]) && readFileSync(handle[1], 'utf8') === PAGE],
      [0, true, true]);
    rmSync(T, { recursive: true, force: true });
  }
}

console.log(`slim engines: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
