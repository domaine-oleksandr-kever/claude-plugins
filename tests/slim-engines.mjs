#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/ — slim's compression library — exercised the way an embedder
// would: compress() / sniff() / peek() as pure functions, no environment, no temp dirs (except the
// CONTRACT.md server example), maxMs:0 for determinism. Rows: ES sniff, EC compress, EG guarantees
// (never throws, deterministic, never writes), EP parity against Headroom's fixtures and the frozen
// compressor copies, EF generators equal the committed fixtures, EX the contract's example runs, EL the
// layer's purity.
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
const fx = (f) => readFileSync(path.join(FIX, f), 'utf8');
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
  ];
  for (const [name, data, engine, reason] of rows) {
    const s = sniff({ data });
    eq(`ES-${name}`, [s.engine, s.reason], [engine, reason]);
    check(`ES-${name}-confidence`, typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1, String(s.confidence));
  }
  eq('ES-fence', sniff({ data: `Script ran and returned:\n\`\`\`json\n${JQL}\n\`\`\`\n` }).reason, 'fence');
  eq('ES-pdf-string', sniff({ data: '%PDF-1.7\n...' }).engine, 'binary');
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
    for (const [name, data, o] of [['html', PAGE], ['log', APPLOG], ['figma', fx('figma-design-context.jsx')], ['jsonl', JSONL], ['adf', ADF], ['text', TESTOUT, { plainBytes: 8192 }]]) {
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
  for (const [name, data, o] of [['jql', JQL], ['page', PAGE], ['log', APPLOG], ['grep', GREP, { engines: ['text'] }], ['figma', fx('figma-design-context.jsx')]]) {
    const a = compress({ data }, { ...O, ...(o || {}) });
    const b = compress({ data }, { ...O, ...(o || {}) });
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
  const frozen = require(path.join(ROOT, 'plugins/slim/scripts/log-slim.cjs'));
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

// EF — the committed fixtures are the generators' output
eq('EF-page', gen('make-page.cjs') === PAGE, true);
eq('EF-app-log', gen('make-log.cjs') === APPLOG, true);
check('EF-orders-size', bytes(ORDERS) < 256 * 1024 && bytes(ORDERS) > 150 * 1024 && JSON.parse(ORDERS).orders.length === 240, String(bytes(ORDERS)));

// EL — the layer is pure
{
  const banned = /\bprocess\.|require\(['"](node:)?(fs|fs\/promises|os|child_process|net|http|https|worker_threads|readline)['"]\)|\bset(Timeout|Interval|Immediate)\b|\bglobalThis\b/;
  const files = readdirSync(ENGINES).filter((f) => f.endsWith('.cjs'));
  check('EL-files', ['index.cjs', 'sniff.cjs', 'json.cjs', 'log.cjs', 'html.cjs', 'figma.cjs', 'adf.cjs', 'text-window.cjs', 'util.cjs'].every((f) => files.includes(f)), files.join(' '));
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
