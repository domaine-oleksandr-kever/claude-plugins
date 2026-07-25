#!/usr/bin/env node
// Fixture suite for plugins/fnd/scripts/json-slim.cjs — the shape-driven JSON compressor.
// Three groups:
//   parity:*   — the array-crush port vs Headroom's vendored SmartCrusher fixtures (byte-parity,
//                or value-parity where JS number semantics prevent byte-parity);
//   unit tests — each pipeline stage, the crush gates, markers, safety rails, the spill-TTL
//                sweep (M5: TTL parsing, prefix/exclude filtering, throttle), CLI;
//   reduction:* — the M1 exit gate: ≥70% byte reduction on the real Jira + Figma fixtures.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Hermetic env: a developer watching the debug log live (FND_MCP_SLIM_DEBUG=1 + FND_MCP_SLIM_DIR
// exported) would otherwise have this suite's CLI runs append fixture noise to the REAL log that
// `--report` aggregates. Cases that need either switch set it on the invocation itself.
delete process.env.FND_MCP_SLIM_DEBUG;
delete process.env.FND_MCP_SLIM_DIR;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIM = path.join(ROOT, 'plugins/fnd/scripts/json-slim.cjs');
const PARITY = path.join(ROOT, 'tests/parity/fixtures/smart_crusher');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const J = require(SLIM);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
const normJSON = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } };

// ---------------------------------------------------------------- parity vs Headroom --
// Every fixture: gate (was_modified) + strategy string must match exactly; the compressed body
// must be byte-identical, OR (where JS 0.0→0 float re-serialization prevents it) value-identical.
let byteExact = 0, valueOnly = 0;
for (const f of readdirSync(PARITY).filter((x) => x.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(path.join(PARITY, f), 'utf8'));
  const c = fx.config || {};
  const cfg = { markerMode: 'ccr' };
  if (c.max_items_after_crush != null) cfg.maxItemsAfterCrush = c.max_items_after_crush;
  if (c.min_items_to_analyze != null) cfg.minItemsToAnalyze = c.min_items_to_analyze;
  const got = J.crush(fx.input.content, cfg);
  const exp = fx.output;
  const okMod = got.wasModified === exp.was_modified;
  const okStrat = got.strategy === exp.strategy;
  const okByte = got.compressed === exp.compressed;
  const okVal = normJSON(got.compressed) === normJSON(exp.compressed);
  if (okByte) byteExact++; else if (okMod && okStrat && okVal) valueOnly++;
  check(`parity:${f.replace(/_[0-9a-f]{12}\.json$/, '')}`, okMod && okStrat && (okByte || okVal),
    `\n  was_modified got=${got.wasModified} exp=${exp.was_modified}` +
    `\n  strategy got=${JSON.stringify(got.strategy)} exp=${JSON.stringify(exp.strategy)}` +
    `\n  body ${okByte ? 'byte-ok' : okVal ? 'value-ok' : 'MISMATCH'}`);
}
check('parity:byte-exact-count', byteExact === 16, `byte-exact ${byteExact}/17 (expected 16)`);
check('parity:value-parity-count', valueOnly === 1, `value-only ${valueOnly}/17 (expected 1: time_series float)`);

// ---------------------------------------------------------------- classifyArray --
eq('classify-dict', J.classifyArray([{ a: 1 }, { a: 2 }]), 'DictArray');
eq('classify-number', J.classifyArray([1, 2, 3]), 'NumberArray');
eq('classify-string', J.classifyArray(['a', 'b']), 'StringArray');
eq('classify-bool', J.classifyArray([true, false]), 'BoolArray');
eq('classify-nested', J.classifyArray([[], [1]]), 'NestedArray');
eq('classify-empty', J.classifyArray([]), 'Empty');
eq('classify-mixed-scalar', J.classifyArray([1, 'a']), 'MixedArray');
eq('classify-mixed-null', J.classifyArray([{ a: 1 }, null]), 'MixedArray'); // one null → Mixed

// ---------------------------------------------------------------- computeOptimalK --
eq('optk-small', J.computeOptimalK(['a', 'b', 'c'], 1, 3, 15), 3); // n<=8 → n
eq('optk-diverse', J.computeOptimalK(Array.from({ length: 40 }, (_, i) => `x${i}`), 1, 3, 15), 15);
eq('optk-identical', J.computeOptimalK(Array.from({ length: 40 }, () => 'same'), 1, 3, 15), 3); // uniq=1 → clamp 3

// ---------------------------------------------------------------- crush gates --
check('crush-nonjson-passthrough', (() => { const r = J.crush('not json at all'); return !r.wasModified && r.strategy === 'passthrough' && r.compressed === 'not json at all'; })(), 'non-JSON must pass verbatim');
check('crush-compact-nochange', (() => { const r = J.crush('[1,2,3]'); return !r.wasModified && r.strategy === 'passthrough'; })(), 'already-compact short array → unmodified');
check('crush-reflow-modified', (() => { const r = J.crush('[1, 2, 3]'); return r.wasModified && r.strategy === 'passthrough'; })(), 'spaced short array → reflow flips wasModified');
check('crush-small-array-passthrough', (() => { const r = J.crush(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])); return normJSON(r.compressed) === normJSON(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])); })(), 'array < minItemsToAnalyze not crushed');

// a 20-item same-shape dict array with an error signal → smart_sample + sentinel marker
const errArray = Array.from({ length: 20 }, (_, i) => ({ id: i, status: i % 7 === 0 ? 'error' : 'ok', msg: `row ${i}` }));
const crushed = J.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: mkdtempSync(path.join(tmpdir(), 'jslim-')) });
check('crush-smart-sample', crushed.strategy.startsWith('smart_sample('), `strategy=${crushed.strategy}`);
const crushedOut = JSON.parse(crushed.compressed);
check('crush-kept-under-budget', crushedOut.filter((x) => !x._ccr_dropped).length <= 15, 'kept ≤ maxItemsAfterCrush');
check('crush-marker-present', crushedOut.some((x) => x._ccr_dropped && /^<<full=.+ \d+_rows_offloaded>>$/.test(x._ccr_dropped)), 'spill marker shape');
check('crush-error-rows-kept', [0, 7, 14].every((i) => crushedOut.some((x) => x.id === i && x.status === 'error')), 'error rows preserved');

// ---------------------------------------------------------------- spill round-trip --
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-spill-'));
  const r = J.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: dir });
  const marker = JSON.parse(r.compressed).find((x) => x._ccr_dropped)._ccr_dropped;
  const m = marker.match(/^<<full=(.+) (\d+)_rows_offloaded>>$/);
  check('spill-marker-parses', !!m, marker);
  if (m) {
    const droppedCount = Number(m[2]);
    const spilled = JSON.parse(readFileSync(m[1], 'utf8'));
    check('spill-file-roundtrips', Array.isArray(spilled) && spilled.length === droppedCount, `file has ${spilled?.length}, marker says ${droppedCount}`);
    const keptCount = JSON.parse(r.compressed).filter((x) => !x._ccr_dropped).length;
    check('spill-count-consistent', keptCount + droppedCount === 20, `${keptCount}+${droppedCount} ≠ 20`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- ccr hash reproducible --
{
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 5 === 0 ? 'error' : 'ok', msg: `line ${i}` }));
  const a = J.crush(JSON.stringify(items), { markerMode: 'ccr' });
  const b = J.crush(JSON.stringify(items), { markerMode: 'ccr' });
  check('ccr-hash-deterministic', a.compressed === b.compressed, 'ccr marker must be stable across runs');
  check('ccr-hash-shape', /<<ccr:[0-9a-f]{12} \d+_rows_offloaded>>/.test(a.compressed), 'ccr marker shape');
}

// ---------------------------------------------------------------- pipeline stages --
const adfDoc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world', marks: [{ type: 'strong' }] }] }] };
eq('stage-adf', J.adfStage({ description: adfDoc }, J.DEFAULTS), { description: 'hello **world**' });
eq('stage-noise-null', J.noiseStage({ a: 1, b: null }, J.DEFAULTS), { a: 1 });
eq('stage-noise-empty', J.noiseStage({ a: 1, b: {}, c: [] }, J.DEFAULTS), { a: 1 });
eq('stage-noise-avatar', J.noiseStage({ name: 'x', avatarUrls: { '48x48': 'http://a' }, iconUrl: 'http://i' }, J.DEFAULTS), { name: 'x' });

// dropRestLinks (M3): a `self` REST-navigation URL is noise; a `self` holding real content is not.
eq('stage-noise-self-rest', J.noiseStage({ id: '1', self: 'https://x.atlassian.net/rest/api/2/status/3' }, J.DEFAULTS), { id: '1' });
eq('stage-noise-self-confluence', J.noiseStage({ _links: { self: 'https://x.atlassian.net/wiki/rest/api/content/9', webui: '/pages/9' } }, J.DEFAULTS), { _links: { webui: '/pages/9' } });
eq('stage-noise-self-content', J.noiseStage({ self: 'my note about myself' }, J.DEFAULTS), { self: 'my note about myself' }); // non-REST string survives
eq('stage-noise-self-nonatlassian', J.noiseStage({ name: 'hook', self: 'https://host/api/v2/webhooks/5' }, J.DEFAULTS), { name: 'hook', self: 'https://host/api/v2/webhooks/5' }); // bare /api/ (non-Atlassian actionable URL) survives
eq('stage-noise-self-object', J.noiseStage({ self: { title: 'me' } }, J.DEFAULTS), { self: { title: 'me' } }); // non-string survives
eq('stage-noise-self-off', J.noiseStage({ self: 'https://x.atlassian.net/rest/api/2/status/3' }, { ...J.DEFAULTS, dropRestLinks: false }), { self: 'https://x.atlassian.net/rest/api/2/status/3' });
check('stage-truncate-datauri', (() => { const big = 'data:image/png;base64,' + 'A'.repeat(500); const r = J.truncateStage({ img: big }, J.DEFAULTS); return r.img.includes('…(len=') && r.img.length < 100; })(), 'data-uri clipped');
eq('stage-truncate-short', J.truncateStage({ s: 'short string' }, J.DEFAULTS), { s: 'short string' });

// ---------------------------------------------------------------- safety rails --
check('safe-error-shape', (() => { const env = JSON.stringify({ errors: [{ message: 'boom' }], data: null }); const r = J.slim(env); return !r.wasModified && r.error === true && r.output === env; })(), 'GraphQL error envelope untouched');
check('safe-usererrors', (() => { const env = JSON.stringify({ data: {}, userErrors: [{ field: 'x', message: 'bad' }] }); const r = J.slim(env); return r.error === true; })(), 'userErrors envelope untouched');
check('safe-nonjson', (() => { const r = J.slim('plain text log line'); return !r.wasModified && r.output === 'plain text log line'; })(), 'non-JSON slim passthrough');

// ---------------------------------------------------------------- preserveFields --
{
  // both arrays are crushable (a rare "error" status is the signal); preserving one exempts it
  const mk = (tag) => Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 6 === 0 ? 'error' : 'ok', v: `${tag}${i}` }));
  const out = J.crushValue({ keepme: mk('x'), other: mk('y') }, { preserveFields: { keepme: true }, markerMode: 'ccr' });
  check('preserve-untouched', out.keepme.length === 30 && !out.keepme.some((x) => x._ccr_dropped), 'preserved key not crushed');
  check('preserve-other-crushed', out.other.length < 30, 'non-preserved key still crushed');
}

// ---------------------------------------------------------------- TOON flag --
{
  const uniform = Array.from({ length: 5 }, (_, i) => ({ a: i, b: `v${i}` }));
  const on = J.toonStage(uniform);
  check('toon-tabularizes', on && on._toon === 'a,b' && Array.isArray(on.rows) && on.rows.length === 5, 'uniform flat array → tabular');
  const off = J.slim(JSON.stringify({ rows: uniform }));
  check('toon-off-by-default', !off.output.includes('_toon'), 'toon must be off unless flagged');
}

// ---------------------------------------------------------------- review regressions --
// finding 1: long prose / ADF-derived markdown is NEVER truncated (only opaque blobs are)
check('trunc-prose-survives', (() => { const prose = 'Acceptance criteria: ' + 'word '.repeat(400); return J.truncateStage({ desc: prose }, J.DEFAULTS).desc === prose; })(), 'long prose must survive');
check('trunc-datauri-clipped', (() => J.truncateStage({ img: 'data:image/png;base64,' + 'A'.repeat(400) }, J.DEFAULTS).img.includes('…(len='))(), 'data-uri still clipped');
check('trunc-data-prose-survives', (() => { const s = 'data: ' + 'the following steps are required. '.repeat(12); return J.truncateStage({ note: s }, J.DEFAULTS).note === s; })(), 'prose starting "data:" is not a data-URI → survives');
check('slim-adf-desc-survives', (() => { const prose = 'Acceptance criteria for this ticket. '.repeat(60); const big = { fields: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: prose }] }] } } }; return J.slim(JSON.stringify(big)).output.includes(prose.trim()); })(), 'ADF-derived prose survives slim (not clipped)');

// finding 2: spill-write failure keeps the array uncrushed (no dangling handle to a missing file)
{
  const badFile = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-ro-')), 'not-a-dir');
  require('node:fs').writeFileSync(badFile, 'x'); // a FILE — using it as a spill parent dir fails
  const r = J.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: path.join(badFile, 'sub') });
  const out = JSON.parse(r.compressed);
  check('spill-fail-keeps-rows', out.length === 20 && !out.some((x) => x._ccr_dropped), 'spill failure → rows kept, no dangling marker');
}

// finding 3: MCP isError envelope guarded; empty errors:[] is a success (still compressed)
check('err-mcp-iserror', J.isErrorShape({ isError: true, content: [{ type: 'text', text: 'boom' }] }) === true, 'MCP isError envelope guarded');
check('err-empty-errors-ok', J.isErrorShape({ data: { x: 1 }, errors: [] }) === false, 'empty errors:[] is not an envelope');
check('err-empty-errors-compresses', (() => { const big = { errors: [], rows: Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 5 ? 'ok' : 'error', v: `r${i}` })) }; const r = J.slim(JSON.stringify(big)); return !r.error && r.ratio > 0; })(), 'success payload with errors:[] still compressed');

// finding 4: large arrays must not RangeError from Math.min/max spread
check('big-number-array-nocrash', (() => { try { return typeof J.crush(JSON.stringify(Array.from({ length: 200000 }, (_, i) => i * 2))).compressed === 'string'; } catch { return false; } })(), '200k number array');
check('big-dict-array-nocrash', (() => { try { return typeof J.crush(JSON.stringify(Array.from({ length: 120000 }, (_, i) => ({ id: i * 3, status: i % 100 ? 'ok' : 'error' })))).compressed === 'string'; } catch { return false; } })(), '120k dict array');

// ---------------------------------------------------------------- reduction (M1 exit gate) --
// Fixtures are committed alongside this suite — assert directly so a missing one fails loudly.
const ratio = (file) => J.slim(readFileSync(path.join(FIX, file), 'utf8')).ratio;
check('reduction:jira≥0.70', ratio('jira-issue-ELC-104.json') >= 0.70, `jira ratio ${ratio('jira-issue-ELC-104.json').toFixed(3)}`);
check('reduction:figma≥0.70', ratio('figma-node-rest.json') >= 0.70, `figma ratio ${ratio('figma-node-rest.json').toFixed(3)}`);
{
  const out = JSON.parse(J.slim(readFileSync(path.join(FIX, 'jql-search-ELC.json'), 'utf8')).output);
  check('jql-issues-crushed', out.issues.filter((x) => !x._ccr_dropped).length <= 15 && out.issues.some((x) => x._ccr_dropped), 'issues array crushed + marker');
}
// dropRestLinks materially reduces a JQL page (a `self` on every issue + nested resource).
{
  const raw = readFileSync(path.join(FIX, 'jql-search-ELC.json'), 'utf8');
  const on = J.slim(raw).bytesOut;
  const off = J.slim(raw, { dropRestLinks: false }).bytesOut;
  check('jql-self-drop-helps', off - on > 5000, `self-drop saved ${off - on} B (expected >5000)`);
  check('jql-no-self-links', !JSON.parse(J.slim(raw).output).issues.some((x) => x && x.self), 'no REST self survives on kept issues');
}

// ---------------------------------------------------------------- CLI dual entry --
{
  const inp = readFileSync(path.join(FIX, 'figma-node-rest.json'), 'utf8');
  const out = execFileSync('node', [SLIM], { input: inp, encoding: 'utf8' });
  check('cli-stdin', out.length < inp.length && JSON.parse(out), 'CLI over stdin compresses to valid JSON');
  const outFile = execFileSync('node', [SLIM, path.join(FIX, 'figma-node-rest.json')], { encoding: 'utf8' });
  check('cli-file', outFile.length < inp.length, 'CLI over a file compresses');
  const jqOut = execFileSync('node', [SLIM, '--jq', 'nodes', path.join(FIX, 'figma-node-rest.json')], { encoding: 'utf8' });
  check('cli-jq', JSON.parse(jqOut)['3326:39542'] !== undefined, '--jq narrows to a sub-path');
  // spawnSync (not execFileSync): the missing path now also writes an M12 stderr diagnostic, which we
  // capture here instead of letting it leak into the suite's own output.
  const jqMiss = spawnSync('node', [SLIM, '--jq', 'no.such.path', path.join(FIX, 'figma-node-rest.json')], { encoding: 'utf8' });
  check('cli-jq-missing', jqMiss.stdout.trim() === 'null', '--jq missing path → null, no crash');

  // Non-JSON FILE → hand the path back instead of re-dumping the (whale-sized) content to stdout.
  const xmlPath = path.join(FIX, 'figma-metadata-3326-39542.xml');
  const xmlIn = readFileSync(xmlPath, 'utf8');
  const xmlOut = execFileSync('node', [SLIM, xmlPath], { encoding: 'utf8' });
  check('cli-nonjson-file-handback', xmlOut.includes(xmlPath) && !xmlOut.includes('<frame') && xmlOut.length < 200,
    'non-JSON file → path handback, not a content dump');
  // Non-JSON via STDIN → still passes through verbatim (there is no path to hand back).
  const stdinEcho = execFileSync('node', [SLIM], { input: 'plain text, not json', encoding: 'utf8' });
  check('cli-nonjson-stdin-echo', stdinEcho.trim() === 'plain text, not json',
    'non-JSON stdin → verbatim passthrough (no file to point at)');
}

// ---------------------------------------------------------------- spill-TTL sweep (M5) --
// spillTtlHours contract: default 24, exactly 0 disables, ANY invalid/negative → 24 (never a
// past cutoff that would mass-delete fresh spills).
eq('ttl-default', J.spillTtlHours(undefined), 24);
eq('ttl-empty', J.spillTtlHours(''), 24);
eq('ttl-valid', J.spillTtlHours('12'), 12);
eq('ttl-fractional', J.spillTtlHours('0.5'), 0.5);
eq('ttl-zero-disables', J.spillTtlHours('0'), 0);
eq('ttl-nonnumeric', J.spillTtlHours('abc'), 24);
eq('ttl-negative', J.spillTtlHours('-5'), 24); // a negative TTL must not become "everything is old"

// sweepSpills: seed a stale spill (mtime 1970) + a fresh one + a foreign-named + the debug log,
// then sweep with the default 24 h TTL. Only our-prefixed stale files go; the summary reports 1.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-sweep-'));
  const seed = (name, old) => { const p = path.join(dir, name); writeFileSync(p, '[]'); if (old) utimesSync(p, 1000, 1000); return p; };
  const stale = seed('fnd-crush-STALE.json', true);
  const fresh = seed('fnd-mcp-slim-FRESH.json', false);
  const foreign = seed('other-tool-STALE.json', true);
  const dbg = seed('fnd-mcp-slim-debug.log', true);
  const r = J.sweepSpills(dir);
  check('sweep-stale-deleted', !existsSync(stale), 'our-prefixed stale spill must be deleted');
  check('sweep-fresh-kept', existsSync(fresh), 'a fresh spill must survive (mtime, not a blanket rm)');
  check('sweep-foreign-kept', existsSync(foreign), 'a non-prefixed file must never be touched');
  check('sweep-debug-kept', existsSync(dbg), 'the M6 debug log is excluded by exact name');
  check('sweep-summary', r.swept === 1 && !r.disabled && !r.throttled, `summary ${JSON.stringify(r)}`);
  check('sweep-marker-made', existsSync(path.join(dir, '.fnd-mcp-slim-sweep')), 'throttle marker must be written');
  // throttle: a second sweep sees the fresh marker and skips — a stale file seeded after survives
  const stale2 = seed('fnd-crush-STALE2.json', true);
  const r2 = J.sweepSpills(dir);
  check('sweep-throttled', r2.throttled && existsSync(stale2), `throttle failed ${JSON.stringify(r2)}`);
  rmSync(dir, { recursive: true, force: true });
}
// FND_MCP_SLIM_TTL=0 disables the sweep entirely (env save/restore — don't leak into later cases)
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-sweep0-'));
  const p = path.join(dir, 'fnd-crush-S.json'); writeFileSync(p, '[]'); utimesSync(p, 1000, 1000);
  const prev = process.env.FND_MCP_SLIM_TTL;
  process.env.FND_MCP_SLIM_TTL = '0';
  const r = J.sweepSpills(dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_TTL; else process.env.FND_MCP_SLIM_TTL = prev;
  check('sweep-ttl0-disabled', r.disabled && existsSync(p), `TTL=0 must keep the stale spill ${JSON.stringify(r)}`);
  rmSync(dir, { recursive: true, force: true });
}
// CLI entry sweeps at exit: a pre-seeded stale spill in FND_MCP_SLIM_DIR is gone after the run,
// while stdout stays valid + compressed (the sweep never touches output/exit code).
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-cli-sweep-'));
  const stale = path.join(dir, 'fnd-crush-STALE.json'); writeFileSync(stale, '[]'); utimesSync(stale, 1000, 1000);
  const inp = readFileSync(path.join(FIX, 'figma-node-rest.json'), 'utf8');
  const out = execFileSync('node', [SLIM], { input: inp, encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir } });
  check('cli-sweeps-stale', !existsSync(stale), 'the CLI exit sweep must prune a stale spill');
  check('cli-sweep-output-intact', out.length < inp.length && JSON.parse(out), 'CLI output stays valid + compressed despite the sweep');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- slim() instrumentation (M6) --
// slim() reports the pipeline stages that actually changed bytes + a `reason` on non-compressing
// outcomes — the FND_MCP_SLIM_DEBUG feed. Assert on a real fixture and the passthrough branches.
{
  // `stages` is opt-in (cfg.trace) — the debug feed sets it; a plain slim() call leaves it empty.
  const r = J.slim(readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8'), { trace: true });
  check('slim-stages-array', Array.isArray(r.stages) && r.stages.includes('adf') && r.stages.includes('crush'), `stages ${JSON.stringify(r.stages)}`);
  check('slim-stages-subset', r.stages.every((s) => ['adf', 'noise', 'truncate', 'crush', 'toon'].includes(s)), `unexpected stage in ${JSON.stringify(r.stages)}`);
  eq('slim-stages-off-empty', J.slim(readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8')).stages, []); // trace off ⇒ no bookkeeping
  eq('slim-nonjson-reason', J.slim('plain text, not json').reason, 'non-json');
  eq('slim-nonjson-stages', J.slim('plain text, not json').stages, []);
  eq('slim-error-reason', J.slim(JSON.stringify({ errors: [{ message: 'boom' }] })).reason, 'error-shape');
  check('slim-ok-no-reason', J.slim(JSON.stringify({ a: 1 })).reason === undefined, 'a compressible-shape result carries no reason');
}

// ---------------------------------------------------------------- debug log (M6) --
// debugEnabled(): only 1/true/yes/on turns it on; unset / 0 / false → off (zero side effects).
{
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  const set = (v) => { if (v === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = v; };
  set(undefined); check('dbg-enabled-unset', J.debugEnabled() === false, 'unset → off');
  set('1');       check('dbg-enabled-1', J.debugEnabled() === true, '1 → on');
  set('true');    check('dbg-enabled-true', J.debugEnabled() === true, 'true → on');
  set('0');       check('dbg-enabled-0', J.debugEnabled() === false, '0 → off');
  set('false');   check('dbg-enabled-false', J.debugEnabled() === false, 'false → off');
  set(prev);
}

// debugLog: disabled → creates nothing; enabled → appends one parseable JSONL line with `ts`.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-dbg-'));
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  const logp = path.join(dir, 'fnd-mcp-slim-debug.log');
  delete process.env.FND_MCP_SLIM_DEBUG;
  J.debugLog({ entry: 'cli', decision: 'passthrough' }, dir);
  check('dbg-off-no-file', !existsSync(logp), 'disabled debugLog must not create a file');
  process.env.FND_MCP_SLIM_DEBUG = '1';
  J.debugLog({ entry: 'cli', decision: 'compressed', bytes_in: 100, bytes_out: 40 }, dir);
  J.debugLog({ entry: 'cli', decision: 'passthrough', reason: 'size-gate' }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const lines = readFileSync(logp, 'utf8').trim().split('\n');
  check('dbg-two-lines', lines.length === 2, `got ${lines.length} lines`);
  const first = JSON.parse(lines[0]);
  check('dbg-line-shape', first.entry === 'cli' && first.decision === 'compressed' && typeof first.ts === 'string', `line ${lines[0]}`);
  rmSync(dir, { recursive: true, force: true });
}

// rotation: a log past ~5 MB is renamed to .log.1 before the next line lands in a fresh .log.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-dbgrot-'));
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  const logp = path.join(dir, 'fnd-mcp-slim-debug.log');
  writeFileSync(logp, 'x'.repeat(5 * 1024 * 1024 + 1)); // just over the 5 MB cap
  process.env.FND_MCP_SLIM_DEBUG = '1';
  J.debugLog({ entry: 'cli', decision: 'compressed' }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  check('dbg-rotated', existsSync(`${logp}.1`), 'oversize log rotated to .log.1');
  check('dbg-fresh-line', readFileSync(logp, 'utf8').trim().split('\n').length === 1, 'fresh log holds exactly the new line');
  rmSync(dir, { recursive: true, force: true });
}

// CLI entry logs `entry:"cli"` at exit with a compressed decision + stages (opt-in, no stdout impact).
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-dbgcli-'));
  const out = execFileSync('node', [SLIM, path.join(FIX, 'figma-node-rest.json')],
    { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, FND_MCP_SLIM_DEBUG: '1' } });
  check('cli-dbg-output-intact', JSON.parse(out) && out.length > 0, 'CLI stdout still valid despite debug logging');
  const line = JSON.parse(readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim());
  check('cli-dbg-entry', line.entry === 'cli', `entry ${line.entry}`);
  check('cli-dbg-decision', line.decision === 'compressed', `decision ${line.decision}`);
  check('cli-dbg-tool', typeof line.tool === 'string' && line.tool.endsWith('figma-node-rest.json'), `tool ${line.tool}`);
  check('cli-dbg-stages', Array.isArray(line.stages) && line.stages.length > 0, `stages ${JSON.stringify(line.stages)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- non-json format sniff (M8) --
// slim()'s `format` tag classifies a NON-JSON payload for the FND_MCP_SLIM_DEBUG log — set ONLY on
// the non-json branch (undefined on every compressing / error / success path). Fixed vocabulary:
// html / xml / broken-json / text.
eq('m8-format-xml', J.slim(readFileSync(path.join(FIX, 'figma-metadata-3326-39542.xml'), 'utf8')).format, 'xml');
eq('m8-format-html', J.slim('<!DOCTYPE html><html><body>hi</body></html>').format, 'html');
{
  // A truncated ELC-104 prefix: starts with `{` yet is unparseable → the `broken-json` diagnostic.
  const brokenPrefix = readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8').slice(0, 200);
  eq('m8-format-broken-json', J.slim(brokenPrefix).format, 'broken-json');
}
eq('m8-format-text', J.slim('plain prose, not markup at all').format, 'text');
check('m8-format-absent-on-json', J.slim(JSON.stringify({ a: 1 })).format === undefined, 'a compressible JSON result must carry no format tag');
check('m8-format-absent-on-error', J.slim(JSON.stringify({ errors: [{ message: 'boom' }] })).format === undefined, 'an error-shape result must carry no format tag');

// `project` on EVERY debug line (M8): basename(cwd), added centrally in debugLog(); `format` rides
// through from the caller's record and lands verbatim in the JSONL line.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m8proj-'));
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  process.env.FND_MCP_SLIM_DEBUG = '1';
  J.debugLog({ entry: 'cli', decision: 'compressed' }, dir);
  J.debugLog({ entry: 'cli', decision: 'passthrough', reason: 'non-json', format: 'xml' }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const lines = readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const proj = path.basename(process.cwd());
  check('m8-project-every-line', lines.length === 2 && lines.every((l) => l.project === proj), `project missing/wrong: ${JSON.stringify(lines.map((l) => l.project))}`);
  check('m8-format-in-line', lines[1].format === 'xml', `format not carried into the JSONL line: ${JSON.stringify(lines[1])}`);
  check('m8-format-absent-when-omitted', lines[0].format === undefined, `compressed line must carry no format: ${JSON.stringify(lines[0])}`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- JSONL detection (M9) --
// A bulk-operation line stream (one JSON value per line) is a same-shape array — parseJsonl routes
// it into the normal pipeline instead of slim()'s non-json handback. Strict gate: every non-blank
// line an object/array, ≥2 rows; one failing line rejects the whole payload (a truncated bulk file
// falls back to the path handback — no partial salvage).
check('m9-jsonl-all-objects', (() => { const r = J.parseJsonl('{"id":1,"h":"a"}\n{"id":2,"h":"b"}\n{"id":3,"h":"c"}'); return Array.isArray(r) && r.length === 3 && r[0].id === 1; })(), 'all-object lines → rows');
check('m9-jsonl-array-rows', (() => { const r = J.parseJsonl('[1,2]\n[3,4]'); return Array.isArray(r) && r.length === 2; })(), 'object-or-array lines → rows (arrays count)');
check('m9-jsonl-prose-line-null', J.parseJsonl('{"id":1}\nnot json here\n{"id":2}') === null, 'one prose line among JSON → null');
check('m9-jsonl-bare-scalar-null', J.parseJsonl('42\ntrue\n7') === null, 'bare-scalar lines (42/true) → null, never swallowed as data');
check('m9-jsonl-bare-null-null', J.parseJsonl('{"id":1}\nnull\n{"id":2}') === null, 'a bare null line is not a data row → null');
check('m9-jsonl-single-line-null', J.parseJsonl('{"only":1}') === null, 'a single line → null (≥2 rows required)');
check('m9-jsonl-blank-only-null', J.parseJsonl('\n  \n\t\n') === null, 'no non-blank lines → null');
check('m9-jsonl-bom-trailing-blanks', (() => { const r = J.parseJsonl('\uFEFF{"id":1}\n{"id":2}\n\n   \n'); return Array.isArray(r) && r.length === 2; })(), 'BOM + trailing blank/whitespace lines → ok');

// slim() on a JSONL string → the array flows through noise+crush; output is ONE JSON array, not
// JSONL. Synthetic 500-row bulk-shape product dump (M1 pattern; no committed fixture) — repetitive
// non-id content so the crush spills the tail behind a <<full=…>> marker.
{
  const jsonl = Array.from({ length: 500 }, (_, i) =>
    JSON.stringify({ id: `gid://shopify/Product/${1000 + i}`, status: 'ACTIVE', vendor: 'MAC', productType: 'Lipstick', publishedAt: '2024-01-01' })).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m9-'));
  const r = J.slim(jsonl, { spillDir: dir });
  check('m9-slim-modified', r.wasModified && r.bytesOut < r.bytesIn, `wasModified=${r.wasModified} ${r.bytesIn}->${r.bytesOut}`);
  check('m9-slim-is-array', (() => { try { return Array.isArray(JSON.parse(r.output)); } catch { return false; } })(), 'compressed JSONL re-serializes as ONE JSON array');
  check('m9-slim-crush-ran', r.output.includes('_ccr_dropped'), 'crush ran (dropped rows behind a <<full=…>> marker)');
  check('m9-slim-reduction', r.ratio >= 0.70, `≥70% reduction, got ${(r.ratio * 100).toFixed(1)}%`);
  check('m9-slim-no-reason', r.reason === undefined && r.format === undefined, 'a compressed JSONL result carries no non-json reason/format');
  // trace on → the pipeline records `jsonl` alongside the byte-changing stages; off ⇒ empty.
  const rt = J.slim(jsonl, { trace: true, spillDir: dir });
  check('m9-slim-trace-stage', rt.stages.includes('jsonl') && rt.stages.includes('crush'), `stages ${JSON.stringify(rt.stages)}`);
  eq('m9-slim-trace-off-empty', J.slim(jsonl, { spillDir: dir }).stages, []);
  // {jsonl:false} → today's non-json behavior, byte-identical (format still sniffed → broken-json).
  const off = J.slim(jsonl, { jsonl: false });
  check('m9-jsonl-off-nonjson', !off.wasModified && off.reason === 'non-json' && off.output === jsonl, 'jsonl:false → non-json passthrough, verbatim');
  check('m9-jsonl-off-format', off.format === 'broken-json', 'jsonl:false → format still sniffed (leading { → broken-json)');
  rmSync(dir, { recursive: true, force: true });
}

// A MIXED-type JSONL stream (object rows + array rows — parseJsonl blesses both) crushes via the
// mixed path. Rows the dict subgroup drops must NOT vanish silently: sampleMixedArray appends ONE
// {_ccr_dropped:…} sentinel over the whole array with a working spill handle (the M9 CLI never
// spills the whole original the way the M2 hook does). Guards the medium-severity silent-drop bug.
{
  const objRows = Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: i, status: 'ACTIVE', vendor: 'MAC', productType: 'Lipstick' }));
  const arrRows = Array.from({ length: 20 }, (_, i) => JSON.stringify([i, `x${i}`, true]));
  const jsonl = objRows.concat(arrRows).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m9mix-'));
  const r = J.slim(jsonl, { spillDir: dir });
  const out = JSON.parse(r.output);
  const markers = out.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && x._ccr_dropped);
  check('m9-mixed-drop-marked', markers.length === 1 && /^<<full=.+ \d+_rows_offloaded>>$/.test(markers[0]._ccr_dropped),
    `mixed drop must carry exactly one full= sentinel; got ${JSON.stringify(markers.map((m) => m._ccr_dropped))}`);
  // No row is lost silently: kept real rows + offloaded count reconcile to the 40 inputs, and the
  // spill file actually holds the dropped rows (recoverable, not a dangling handle).
  const m = markers[0]._ccr_dropped.match(/full=(\S+) (\d+)_rows_offloaded/);
  const spillPath = m[1], offloaded = Number(m[2]);
  const keptReal = out.filter((x) => !(x && typeof x === 'object' && !Array.isArray(x) && x._ccr_dropped)).length;
  check('m9-mixed-no-silent-loss', keptReal + offloaded === 40, `kept ${keptReal} + offloaded ${offloaded} != 40 inputs`);
  check('m9-mixed-spill-roundtrips', existsSync(spillPath) && JSON.parse(readFileSync(spillPath, 'utf8')).length === offloaded,
    `spill file must hold the ${offloaded} dropped rows`);
  rmSync(dir, { recursive: true, force: true });
}

// non-JSONL text → unchanged non-json/format behavior; a truly truncated payload stays broken-json.
check('m9-nonjsonl-prose-text', (() => { const r = J.slim('a plain prose line\nanother prose line'); return r.reason === 'non-json' && r.format === 'text'; })(), 'multi-line prose stays non-json/text');
check('m9-broken-json-preserved', (() => { const r = J.slim('{"id":1,\n"unterminated'); return r.reason === 'non-json' && r.format === 'broken-json'; })(), 'a truncated JSON payload still tags broken-json (no false JSONL salvage)');

// ------------------------------------------------- M9b Gate A: CLI output cap — huge JSON document --
// One huge JSON document over the inline cap (a wide-signal crush, or a null-heavy dump that
// noise-drops but does not sample) is spilled + summarized, never dumped to context. capOutput is the
// CLI seam for that ONE case; the cap is overridden via cfg (NOT env) so the test needs no real whale.
// (A JSONL file never reaches capOutput — it profiles upstream in the CLI.)
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-capA-'));
  const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `entity-${i}`, blob: 'x'.repeat(40) }));
  const output = JSON.stringify(arr);
  const res = { output, bytesIn: 500000, bytesOut: Buffer.byteLength(output), ratio: 1 - Buffer.byteLength(output) / 500000 };
  const cap = J.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 100, spillDir: dir });
  check('m9b-capA-fires', !!cap && typeof cap.handback === 'string' && typeof cap.spillOut === 'string', `capOutput must fire over cap: ${JSON.stringify(cap)}`);
  check('m9b-capA-stats-line', /→ .*bytes/.test(cap.handback) && cap.handback.includes('30 rows kept'), `stats line / rows-kept missing:\n${cap.handback}`);
  check('m9b-capA-first-row', cap.handback.includes('first row') && cap.handback.includes('"id":0'), 'first-row shape sample missing');
  check('m9b-capA-both-paths', cap.handback.includes(cap.spillOut) && cap.handback.includes('/some/bulk.jsonl'), 'slimmed-spill + original path must both appear');
  // M12: the hint spells the SYNTAX (`<dot.path>`, not `<path>` — which read like a file path) and
  // carries a one-token example taken from the data (an array body → index `0`).
  check('m9b-capA-jq-hint', cap.handback.includes('--jq <dot.path>') && cap.handback.includes('(e.g. --jq 0)'), `--jq narrow hint missing/unreworded:\n${cap.handback}`);
  check('m9b-capA-spill-roundtrips', existsSync(cap.spillOut) && readFileSync(cap.spillOut, 'utf8') === output, 'spill must hold the exact slimmed output');
  check('m9b-capA-undercap-null', J.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 10_000_000, spillDir: dir }) === null, '≤ cap → null (caller prints the body unchanged)');
  check('m9b-capA-stdin-null', J.capOutput(res, null, { cliOutCap: 100, spillDir: dir }) === null, 'no fileArg (stdin) → null even over cap (no path to point at)');
  rmSync(dir, { recursive: true, force: true });
}
// spill-failure → null so the CLI falls back to printing (never lose the result)
{
  const badParent = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-capAro-')), 'not-a-dir');
  writeFileSync(badParent, 'x'); // a FILE — using it as a spill parent dir fails
  const output = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: i })));
  const res = { output, bytesIn: 999999, bytesOut: Buffer.byteLength(output), ratio: 0.9 };
  check('m9b-capA-spill-fail-null', J.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 10, spillDir: path.join(badParent, 'sub') }) === null, 'a spill-write failure returns null → CLI prints the body (never lose the result)');
}
// M12: the one-token example is only emitted when the CLI's own dot-walk can actually address that
// key. A key holding a dot/bracket splits or normalizes into something else (`weird.key` → two
// segments, `a[0]` → `a.0`), and a key holding a SPACE would split the pasted command line — the file
// argument silently becomes the key fragment and the run dies on ENOENT. Unaddressable → the syntax
// hint stands alone, no misleading example.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-capAkey-'));
  const capFor = (obj) => {
    const output = JSON.stringify(obj);
    return J.capOutput({ output, bytesIn: 500000, bytesOut: Buffer.byteLength(output), ratio: 0.9 }, '/some/in.json', { cliOutCap: 2, spillDir: dir });
  };
  for (const [label, obj] of [
    ['dotted', { 'weird.key': 1, b: 2 }],
    ['bracketed', { 'a[0]': 1, b: 2 }],
    ['spaced', { 'my key': 1 }],
    ['empty-key', { '': 1 }],
  ]) {
    const h = capFor(obj).handback;
    check(`m12-capA-no-bogus-example:${label}`, h.includes('--jq <dot.path>') && !h.includes('(e.g. --jq '),
      `an unaddressable first key must not be advertised as an example:\n${h}`);
  }
  // …while a plain key still gets its example (the ergonomics win the guard must not eat)
  check('m12-capA-plain-key-example', capFor({ product_id: 1, b: 2 }).handback.includes('(e.g. --jq product_id)'),
    'a dot-walkable first key must still be shown as the example');
  rmSync(dir, { recursive: true, force: true });
}

// NB a JSONL FILE via the CLI never reaches capOutput at all — it profiles upstream (the CLI
// scripts-sim J-cases cover that end-to-end). capOutput is the non-JSONL huge-document seam only.

// ---------------------------------------------------------------- M9b Gate B: streaming profile --
// profileLines feeds raw line strings through the SAME accumulator streamProfile runs over a file
// stream — a small synthetic exercises counts / nulls / distinct-cap / samples / parse-failure
// tolerance without a real whale (the >8 MB gate is a CLI concern, tested in scripts-sim).
{
  const good = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i, status: i % 2 ? 'ACTIVE' : 'DRAFT', note: i % 5 === 0 ? null : `n${i}` }));
  const lines = good.concat(['', '   ', 'not json at all', '42', JSON.stringify({ id: 999, extra: 'x' })]);
  const p = J.profileLines(lines, { file: '/x/bulk.jsonl', bytes: 12345 });
  check('m9b-prof-meta', p.profile === true && p.file === '/x/bulk.jsonl' && p.bytes === 12345, `profile meta wrong: ${JSON.stringify({ profile: p.profile, file: p.file, bytes: p.bytes })}`);
  check('m9b-prof-rows', p.rows === 51, `object rows: got ${p.rows} (50 good + 1 extra; blanks skipped)`);
  check('m9b-prof-parsefail-tolerated', p.parseFailures === 2, `parse failures tolerated + counted: got ${p.parseFailures} (prose line + bare scalar 42)`);
  check('m9b-prof-presence', p.keys.id.present === 51 && p.keys.status.present === 50, `presence: ${JSON.stringify({ id: p.keys.id.present, status: p.keys.status.present })}`);
  check('m9b-prof-nulls', p.keys.note.null === 10, `note nulls: got ${p.keys.note.null} (i%5===0 over 50 rows)`);
  check('m9b-prof-type', p.keys.status.type === 'str', `status type: ${p.keys.status.type}`);
  check('m9b-prof-samples', p.samples.head.length === 5 && p.samples.tail.length === 5 && p.samples.reservoir.length === 10, `sample sizes: ${JSON.stringify({ h: p.samples.head.length, t: p.samples.tail.length, r: p.samples.reservoir.length })}`);
  check('m9b-prof-sample-content', p.samples.head[0].id === 0 && p.samples.tail[p.samples.tail.length - 1].id === 999, 'head=first rows, tail=last rows');
}
// distinct cap at 1000: 1500 unique values → distinct reported as 1000 with the capped flag
{
  const p = J.profileLines(Array.from({ length: 1500 }, (_, i) => JSON.stringify({ v: `unique-${i}` })), {});
  check('m9b-prof-distinct-cap', p.keys.v.distinct === 1000 && p.keys.v.distinctCapped === true, `distinct cap: ${JSON.stringify(p.keys.v)}`);
}
// ARRAY-row JSONL (tuple rows, `[1,2,3]` per line) is legitimate bulk data — parseJsonl accepts object
// OR array rows, so profileFeed must too. Regression: arrays were counted as parseFailures → a valid
// array-row file profiled as rows:0/empty-keys. Now they profile by index-key ("0","1",…).
{
  const p = J.profileLines(['[1,2,3]', '[4,5,6]', '[7,8,9]'], { file: '/x/arr.jsonl' });
  check('m9b-prof-array-rows', p.rows === 3 && p.parseFailures === 0, `array rows counted, not failed: ${JSON.stringify({ rows: p.rows, pf: p.parseFailures })}`);
  check('m9b-prof-array-index-keys', !!p.keys['0'] && p.keys['0'].present === 3 && p.keys['2'].type === 'number', `index-key stats: ${JSON.stringify(p.keys)}`);
  check('m9b-prof-array-samples', Array.isArray(p.samples.head[0]) && p.samples.head[0][0] === 1, `array rows appear verbatim in samples: ${JSON.stringify(p.samples.head[0])}`);
}
// A WIDE row (200 keys of long names) must NOT blow the profile past PROFILE_BYTE_CAP (8000). A count
// cap alone doesn't bound bytes — keys are trimmed by BYTES via a binary search and the drop recorded
// in keysTruncated. Regression: the size ladder only trimmed samples, so keys emitted 22 KB.
{
  const wide = {}; for (let i = 0; i < 200; i++) wide[`key_${i}_${'x'.repeat(50)}`] = `v${i}`;
  const line = JSON.stringify(wide);
  const p = J.profileLines([line, line, line], { file: '/x/wide.jsonl' });
  const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
  check('m9b-prof-wide-cap', bytes <= 8000, `wide profile must fit the byte cap: got ${bytes} B`);
  check('m9b-prof-wide-truncated', p.keysTruncated > 0 && Object.keys(p.keys).length < 200, `keysTruncated=${p.keysTruncated}, shown=${Object.keys(p.keys).length}`);
  check('m9b-prof-wide-rows', p.rows === 3, `rows still counted under the cap: ${p.rows}`);
}
// A single monster key name (bigger than the whole cap) collapses to keys:{} with keysTruncated set —
// the binary search converges at 0 rather than looping (the base profile without keys is tiny).
{
  const mega = { ['m'.repeat(20000)]: 1, b: 2 };
  const line = JSON.stringify(mega);
  const p = J.profileLines([line, line], { file: '/x/mega.jsonl' });
  const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
  check('m9b-prof-mega-key-cap', bytes <= 8000 && Object.keys(p.keys).length === 0 && p.keysTruncated === 2, `mega key collapses under cap: ${bytes} B, shown ${Object.keys(p.keys).length}, trunc ${p.keysTruncated}`);
}
// streamProfile over a real (small) file — the async path the CLI Gate B uses; O(samples) memory.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-prof-'));
  const f = path.join(dir, 'rows.jsonl');
  writeFileSync(f, Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: i, k: `v${i}` })).join('\n') + '\n');
  const p = await J.streamProfile(f);
  check('m9b-streamprofile', p.profile === true && p.rows === 12 && p.file === f && p.bytes > 0, `streamProfile: ${JSON.stringify({ rows: p.rows, file: p.file, bytes: p.bytes })}`);
  rmSync(dir, { recursive: true, force: true });
}
// Gate-A output spill (fnd-slim-out-*) is swept by the same mtime TTL — stale gone, fresh kept.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-sweepout-'));
  const seed = (name, old) => { const p = path.join(dir, name); writeFileSync(p, '[]'); if (old) utimesSync(p, 1000, 1000); return p; };
  const stale = seed('fnd-slim-out-STALE.json', true);
  const fresh = seed('fnd-slim-out-FRESH.json', false);
  const r = J.sweepSpills(dir);
  check('m9b-sweep-out-stale', !existsSync(stale), 'stale fnd-slim-out-* must be swept');
  check('m9b-sweep-out-fresh', existsSync(fresh), 'fresh fnd-slim-out-* must survive');
  check('m9b-sweep-out-summary', r.swept === 1, `summary ${JSON.stringify(r)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ================================================================ M10 — log compressor ==
const L = require(path.join(ROOT, 'plugins/fnd/scripts/log-slim.cjs'));
const LOG_PARITY = path.join(ROOT, 'tests/parity/fixtures/log_compressor');

// --- UPSTREAM parity fixtures for the log compressor ---
// These 20 fixtures are VERBATIM recordings from the Headroom repository
// (tests/parity/fixtures/log_compressor/, Apache-2.0 — see tests/parity/NOTICE), the same
// third-party oracle the smart_crusher fixtures come from. This block pins our port BYTE-EXACT
// against upstream's recorded `compressed`/meta, EXCEPT where one of the three enumerated,
// intentional deviations of the port applies — and every relaxation is pinpointed to exactly one
// named deviation (no blanket fuzzy matching).
//
// Two things are asserted per fixture:
//   (1) INTEGRITY. Upstream's field is named `input_sha256` but the recorder actually stores the
//       sha256 of the CANONICAL fixture payload `{transform, input, config, fn}` (recorder.py
//       `_canonical_digest`), and the filename is its first 16 hex chars — it is NOT the sha256 of
//       the input STRING (none of the 20 are). We recompute that canonical digest here (Python
//       json.dumps semantics: sorted keys, `, `/`: ` separators, ensure_ascii — all inputs are
//       ASCII) and assert it equals both the stored field and the filename, which detects any
//       tampering of the recorded input or config.
//   (2) PARITY. compressLog(input, {…fixture config, ccrStore:true}) reproduces upstream's
//       `compressed` byte-for-byte, plus format_detected / cache_key / compressed_line_count /
//       stats / compression_ratio — except the omitted-lines TRAILER on the one compressing
//       fixture, which upstream reports with per-level TOTALS (`1 ERROR, 300 INFO`, listing a KEPT
//       error) while our port reports lines ACTUALLY dropped (`297 INFO`) — DEVIATION #1, the
//       honesty fix. There, ONLY the single `[N lines omitted: …]` line is exempt from the
//       byte-compare: every other line (including the CCR marker) must still match upstream
//       byte-for-byte, our trailer is re-derived independently from upstream's own body+stats and
//       asserted, and compression_ratio is recomputed for our (shorter-trailer) output.
// Deviation #3 (the CCR `[N lines compressed to M. Retrieve more: hash=…]` marker) IS exercised
// here under `ccrStore:true` and matches upstream byte-for-byte; the runtime omits it. Deviation #2
// (warning-dedupe ` ×N` annotation) is not reached by any upstream fixture (the one compressing
// case has zero warnings) and is covered by the dedupe unit tests below instead.
const LOG_CFG_MAP = {
  dedupe_warnings: 'dedupeWarnings', enable_ccr: 'enableCcr', error_context_lines: 'errorContextLines',
  keep_first_error: 'keepFirstError', keep_last_error: 'keepLastError', keep_summary_lines: 'keepSummaryLines',
  max_errors: 'maxErrors', max_stack_traces: 'maxStackTraces', max_total_lines: 'maxTotalLines',
  max_warnings: 'maxWarnings', min_lines_for_ccr: 'minLinesForCcr', stack_trace_max_lines: 'stackTraceMaxLines',
};
// Upstream recorder identity for the log compressor (recorder.py wraps LogCompressor.compress).
const LOG_FIXTURE_FN = 'headroom.transforms.log_compressor.LogCompressor.compress';
// Reproduce Python `json.dumps(obj, sort_keys=True)` for the ASCII scalar/dict payloads the recorder
// digests (bool→true/false, int verbatim, string via JS JSON.stringify which matches ensure_ascii for
// ASCII, `, `/`: ` separators). Used only to recompute upstream's canonical fixture digest.
const pyJson = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ': ' + pyJson(v[k])).join(', ') + '}';
};
const OMIT_TRAILER_RE = /^\[\d+ lines omitted: .*\]$/;
// Independently re-derive our-semantics omitted trailer from UPSTREAM's own body lines + stats totals:
// for each level, dropped = total(level) − kept(level), where kept is classified off the upstream body
// with the port's own leaf classifier. This is deviation #1's rule applied to upstream data — it must
// equal the trailer our port actually emitted.
const deriveOurTrailer = (bodyLines, stats, omitted) => {
  const parts = [];
  for (const [label, level, total] of [['ERROR', 'error', stats.errors], ['FAIL', 'fail', stats.fails], ['WARN', 'warn', stats.warnings], ['INFO', 'info', stats.info]]) {
    const kept = bodyLines.reduce((n, ln) => n + (L.classifyLevel(ln) === level ? 1 : 0), 0);
    const dropped = (total || 0) - kept;
    if (dropped > 0) parts.push(`${dropped} ${label}`);
  }
  return `[${omitted} lines omitted: ${parts.join(', ')}]`;
};
let logByteExact = 0; // fully byte+meta identical to upstream (no deviation reached)
let logDeviation1 = []; // fixtures whose trailer hits deviation #1 (byte-exact everywhere else)
let logCcrMarker = []; // fixtures that reproduce the deviation-#3 CCR marker under ccrStore:true
for (const f of readdirSync(LOG_PARITY).filter((x) => x.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '');
  const fx = JSON.parse(readFileSync(path.join(LOG_PARITY, f), 'utf8'));
  // (1) integrity: recompute upstream's canonical fixture digest; it pins field + filename.
  const digest = createHash('sha256').update(pyJson({ transform: fx.transform || 'log_compressor', input: fx.input, config: fx.config || {}, fn: LOG_FIXTURE_FN }), 'utf8').digest('hex');
  check(`log-parity-digest:${id}`, digest === fx.input_sha256 && digest.slice(0, 16) === id,
    `canonical fixture digest mismatch (tampered input/config?)\n  stored: ${fx.input_sha256}\n  file:   ${id}\n  actual: ${digest}`);
  // (2) parity
  const cfg = { ccrStore: true };
  for (const [k, v] of Object.entries(fx.config || {})) if (LOG_CFG_MAP[k]) cfg[LOG_CFG_MAP[k]] = v;
  const got = L.compressLog(fx.input, cfg);
  const exp = fx.output;
  // meta that is INVARIANT under the trailer deviation (stats totals, selected line count, format, and
  // the MD5-of-original cache_key are all unaffected by the trailer text) — always pinned to upstream.
  const okMeta = got.format_detected === exp.format_detected && (got.cache_key || null) === (exp.cache_key || null) &&
    got.compressed_line_count === exp.compressed_line_count && JSON.stringify(got.stats) === JSON.stringify(exp.stats);
  if (got.cache_key) logCcrMarker.push(id); // ccrStore:true emitted the deviation-#3 marker
  if (got.compressed === exp.compressed) {
    // No deviation reached → full byte-exact parity, ratio included.
    const okRatio = Math.abs(got.compression_ratio - exp.compression_ratio) < 1e-9;
    if (okMeta && okRatio) logByteExact++;
    check(`log-parity:${id}`, okMeta && okRatio,
      `byte-exact body but meta/ratio MISMATCH\n  ratio got ${got.compression_ratio} exp ${exp.compression_ratio}`);
    continue;
  }
  // Bodies differ → the ONLY permitted cause is deviation #1 (the omitted trailer). Everything else
  // must be byte-identical; anything else here is a REAL port bug.
  const g = got.compressed.split('\n');
  const e = exp.compressed.split('\n');
  const ti = e.findIndex((ln) => OMIT_TRAILER_RE.test(ln));
  const sameLen = g.length === e.length;
  const onlyTrailerDiffers = sameLen && ti >= 0 && g.every((ln, i) => i === ti || ln === e[i]);
  const expTrailerTotals = ti >= 0 && exp.compressed && (() => { // upstream trailer uses TOTALS (lists a kept error / exceeds omitted)
    const m = e[ti].match(/^\[(\d+) lines omitted: (.*)\]$/);
    if (!m) return false;
    const sum = m[2].split(', ').reduce((a, p) => a + Number(p.split(' ')[0]), 0);
    return sum > Number(m[1]); // 1 ERROR + 300 INFO = 301 > 297 omitted → totals-semantics
  })();
  const bodyLines = g.slice(0, exp.compressed_line_count); // our selected body (pre-trailer/marker)
  const wantTrailer = deriveOurTrailer(bodyLines, exp.stats, Number((e[ti].match(/^\[(\d+)/) || [])[1]));
  const gotTrailerOk = ti >= 0 && g[ti] === wantTrailer;
  // ratio is recomputed for OUR output: our trailer is shorter (drops the kept-level term), so our
  // compressed byte length — and thus our ratio — is legitimately smaller than upstream's. The port
  // measures ratio on the body+trailer BEFORE the CCR marker is appended, so strip the trailing marker.
  const ourBody = got.cache_key ? got.compressed.slice(0, got.compressed.lastIndexOf('\n[')) : got.compressed;
  const ratioRecomputed = Buffer.byteLength(ourBody, 'utf8') / Math.max(1, Buffer.byteLength(fx.input, 'utf8'));
  const okRatioSelf = Math.abs(got.compression_ratio - ratioRecomputed) < 1e-9 && got.compression_ratio < exp.compression_ratio;
  const pass = okMeta && onlyTrailerDiffers && expTrailerTotals && gotTrailerOk && okRatioSelf;
  if (pass) logDeviation1.push(id);
  check(`log-parity:${id} [deviation#1 trailer]`, pass,
    `\n  onlyTrailerDiffers=${onlyTrailerDiffers} expTotals=${expTrailerTotals} gotTrailerOk=${gotTrailerOk} okMeta=${okMeta} okRatioSelf=${okRatioSelf}` +
    `\n  got trailer: ${JSON.stringify(g[ti])}\n  exp trailer: ${JSON.stringify(e[ti])}\n  want (ours):  ${JSON.stringify(wantTrailer)}`);
}
// 19 fixtures are fully byte+meta identical to upstream; exactly 1 (the sole compressing case) hits the
// deviation-#1 trailer and is byte-identical everywhere else. That 1 also reproduces the deviation-#3
// CCR marker under ccrStore:true.
check('log-parity:byte-exact-count', logByteExact === 19, `fully byte-exact ${logByteExact}/20 (expected 19; 1 is deviation-#1 trailer parity)`);
check('log-parity:deviation1-count', logDeviation1.length === 1, `deviation-#1 fixtures ${JSON.stringify(logDeviation1)} (expected exactly 1)`);
check('log-parity:ccr-marker-covered', logCcrMarker.length >= 1, `no fixture exercises the deviation-#3 CCR marker under ccrStore:true (got ${JSON.stringify(logCcrMarker)})`);
const logParityTotal = logByteExact + logDeviation1.length;

// --- detector truth table ---
const mkLog = (line, n) => Array.from({ length: n }, () => line).join('\n');
check('log-detect-pytest', J.detectLog(['=== FAILURES ===', 'FAILED tests/test_a.py::test_x', '    assert 1 == 2', '=== ERRORS ===', 'ERROR tests/test_b.py', '1 failed, 2 passed'].join('\n')).isLog, 'pytest output → log');
check('log-detect-npm', J.detectLog(mkLog('npm ERR! code ELIFECYCLE', 10)).isLog, 'npm output → log');
check('log-detect-console-spam', J.detectLog(mkLog('[WARNING] slow frame skipped', 20)).isLog, 'console WARN spam → log');
check('log-detect-markdown-not', !J.detectLog(['## Heading', '', 'A paragraph of ordinary documentation prose describing an API.', 'Another sentence with a `code` span and a [link](http://x).', '', '- bullet one', '- bullet two', '', 'Closing remarks with no build keywords at all.'].join('\n')).isLog, 'markdown docs → NOT log');
check('log-detect-docs-chunk-not', !J.detectLog(['## Fetching products', '', 'Use the products connection to page through a catalogue. Each edge exposes a cursor.', '```graphql', 'query { products(first: 10) { edges { node { id } } } }', '```', 'Pagination is cursor-based; keep requesting until hasNextPage is false.'].join('\n')).isLog, 'shopify docs-chunk → NOT log');
check('log-detect-prose-not', !J.detectLog('The quick brown fox jumps over the lazy dog. '.repeat(30)).isLog, 'prose → NOT log');
check('log-detect-xml-not', !J.detectLog('<frame id="1">' + '<node x="1"/>'.repeat(50) + '</frame>').isLog, 'figma XML → NOT log');
// ratio boundary: 3 rule-lines in 10 (ratio 0.3, no error hits) → conf 0.45 < 0.5; 4 in 10 → conf 0.5
{
  const belowLines = ['===', '===', '==='].concat(Array.from({ length: 7 }, (_, i) => `plain text ${i}`));
  const aboveLines = ['===', '===', '===', '==='].concat(Array.from({ length: 6 }, (_, i) => `plain text ${i}`));
  check('log-detect-conf-below', !J.detectLog(belowLines.join('\n')).isLog, `conf ${J.detectLog(belowLines.join('\n')).confidence.toFixed(3)} must be < 0.5`);
  check('log-detect-conf-above', J.detectLog(aboveLines.join('\n')).isLog, `conf ${J.detectLog(aboveLines.join('\n')).confidence.toFixed(3)} must be ≥ 0.5`);
  // ratio gate: 1 match in 20 lines → ratio 0.05 < 0.1 → not a log regardless of the base 0.3
  check('log-detect-ratio-gate', !J.detectLog(['ERROR boom'].concat(Array.from({ length: 19 }, (_, i) => `text ${i}`)).join('\n')).isLog, 'ratio < 0.1 → NOT log');
}

// --- scoring units ---
eq('log-score-error', L.scoreLogLine({ level: 'error', isStackTrace: false, isSummary: false }), 1.0);
eq('log-score-warn', L.scoreLogLine({ level: 'warn', isStackTrace: false, isSummary: false }), 0.5);
eq('log-score-info', L.scoreLogLine({ level: 'info', isStackTrace: false, isSummary: false }), 0.1);
eq('log-score-trace', L.scoreLogLine({ level: 'trace', isStackTrace: false, isSummary: false }), 0.02);
eq('log-score-caps-at-one', L.scoreLogLine({ level: 'error', isStackTrace: true, isSummary: true }), 1.0); // 1.0+0.3+0.4 → capped
eq('log-score-in-trace-boost', L.scoreLogLine({ level: 'info', isStackTrace: true, isSummary: false }), 0.4); // 0.1+0.3

// --- dedupe units (conservative + ×N annotation) ---
{
  const distinct = L.dedupeSimilar([{ lineNumber: 0, content: 'segfault at 0xdeadbeef in thread main', level: 'warn' }, { lineNumber: 1, content: 'heap overflow at 0xcafef00d in thread worker', level: 'warn' }]);
  check('log-dedupe-preserves-distinct', distinct.length === 2, `distinct message prefixes stay separate, got ${distinct.length}`);
  const repeated = L.dedupeSimilar([{ lineNumber: 0, content: 'warning: file /tmp/a/123 issue', level: 'warn' }, { lineNumber: 1, content: 'warning: file /tmp/b/999 issue', level: 'warn' }]);
  check('log-dedupe-collapses-repeated', repeated.length === 1, `same normalized suffix collapses, got ${repeated.length}`);
  check('log-dedupe-annotates-xN', repeated[0].content.endsWith(' ×2'), `survivor annotated ×N, got ${JSON.stringify(repeated[0].content)}`);
  eq('log-normalize-suffix-only', L.normalizeForDedupe('ECONNREFUSED: connect to 10.0.0.1:5432 failed'), 'ECONNREFUSED: connect to N.N.N.N:N failed');
}

// --- frame-collapse unit (Rust-only pass): an oversized Java chained trace ---
{
  const lines = ['Exception in thread "main" java.lang.IllegalStateException: boom', 'at com.example.App.handle(App.java:10)', 'at com.example.App.dispatch(App.java:20)'];
  for (let i = 0; i < 30; i++) lines.push(`at java.base/java.util.stream.Op${i}.eval(Op${i}.java:${i + 1})`);
  lines.push('Caused by: java.io.IOException: disk gone');
  lines.push('at com.example.Disk.read(Disk.java:77)');
  for (let i = 0; i < 30; i++) lines.push(`at java.base/java.lang.Thread${i}.run(Thread.java:${i + 1})`);
  lines.push('... 17 more');
  const parsed = L.parseLogLines(lines, {});
  const stack = parsed.filter((l) => l.isStackTrace);
  const collapsed = L.collapseTraceFrames(stack, 3, 5);
  const kept = collapsed.kept.map((l) => l.content).join('\n');
  check('log-collapse-marker', /\[\.\.\. \d+ frames collapsed\]/.test(kept), 'a collapse marker is emitted');
  check('log-collapse-keeps-chain-head', kept.includes('Caused by: java.io.IOException'), 'chain head survives');
  check('log-collapse-keeps-app-frame', kept.includes('com.example.Disk.read'), 'app frame survives');
  check('log-collapse-keeps-more-summary', kept.includes('... 17 more'), 'elided-frames summary survives');
  check('log-collapse-drops-deep-runtime', !kept.includes('Thread25.run'), 'deep runtime tail collapsed away');
  check('log-collapse-dropped-indices', collapsed.droppedIndices.length > 0, 'runtime frames recorded as dropped');
}

// --- {log:false} → old behavior; slim() integration + trace stage ---
{
  const bigLog = mkLog('INFO processing request id=abc', 60) + '\nERROR boom\nERROR kapow';
  const off = J.slim(bigLog, { log: false });
  check('log-off-passthrough', !off.wasModified && off.reason === 'non-json' && off.output === bigLog, 'log:false → byte-identical non-json passthrough');
  const on = J.slim(bigLog, { log: true });
  check('log-on-compresses', on.wasModified && on.bytesOut < on.bytesIn && on.output.includes('ERROR boom') && on.output.includes('ERROR kapow'), 'log:true → compressed, both errors kept');
  const traced = J.slim(bigLog, { log: true, trace: true });
  check('log-on-trace-stage', Array.isArray(traced.stages) && traced.stages.includes('log'), `trace on → stages has 'log', got ${JSON.stringify(traced.stages)}`);
  const noTrace = J.slim(bigLog, { log: true, trace: false });
  check('log-off-trace-empty', noTrace.stages.length === 0, 'trace off → stages stays empty');
  // a SHORT log (< minLinesForCcr) passes through byte-identical even when detected
  const shortLog = mkLog('WARN retrying', 5);
  const sres = J.slim(shortLog, { log: true });
  check('log-short-passthrough', !sres.wasModified && sres.output === shortLog, 'short log → byte-identical passthrough (no gain)');
}

// --- finding 1: prose/markdown that MENTIONS error words is NOT a log → byte-identical passthrough ---
// A 55-line troubleshooting doc that says "error"/"failed"/"warning" in ordinary sentences must stay
// below the detector gate (the case-insensitive substring scan false-positived it and mangled it).
{
  const base = ['# Troubleshooting the checkout integration', '', 'When the checkout call fails, the storefront logs an error and the customer', 'sees a generic failure page. Below are the common causes and how to resolve.', '', '## Symptoms', '', '- A 500 error from the payment gateway means the request failed validation.', '- A warning in the console about a missing metafield is usually harmless.', '- If the theme editor shows a failed publish, re-save the section and retry.', ''];
  const md = base.slice();
  for (let i = 0; i < 44; i++) md.push(`Paragraph ${i}: the request occasionally fails and logs an error, but a warning here is expected and no failure is surfaced to the buyer.`);
  const doc = md.join('\n');
  check('log-detect-prose-mentions-not', !J.detectLog(doc).isLog, `55-line error-discussing doc must NOT detect as log (conf ${J.detectLog(doc).confidence.toFixed(3)})`);
  const pr = J.slim(doc, { log: true });
  check('log-prose-mentions-passthrough', !pr.wasModified && pr.reason === 'non-json' && pr.output === doc, 'error-discussing prose → byte-identical passthrough');
  // a CHANGELOG-style doc (>=50 lines, headed "Fixed"/"Error handling") must also pass through
  const chg = ['# Changelog', ''];
  for (let i = 0; i < 60; i++) chg.push(`- Fixed a bug where the API returned an error on failed pagination (#${1000 + i}).`);
  const chgDoc = chg.join('\n');
  check('log-changelog-passthrough', !J.slim(chgDoc, { log: true }).wasModified, 'error-mentioning CHANGELOG → byte-identical passthrough');
  // genuine lowercase-level logs (cargo/gcc `warning:` / `error[E…]`) must STILL detect as log
  const cargo = [];
  for (let i = 0; i < 12; i++) cargo.push(`warning: unused variable: \`x${i}\``);
  cargo.push('error[E0308]: mismatched types');
  check('log-detect-lowercase-levels', J.detectLog(cargo.join('\n')).isLog, 'lowercase cargo/gcc levels still detect as log');
}

// --- finding 2: the global cap must keep the guaranteed FIRST + LAST error, not the lowest line #s ---
// Many score-1.0 error/fail lines overflow adaptiveMax; the sole distinct final failure (highest line
// number) is exactly what a reader needs, and a plain score+lineNumber sort would evict it.
{
  const lines = [];
  for (let i = 0; i < 24; i++) lines.push('ERROR generic failure alpha');
  for (let i = 0; i < 24; i++) lines.push('FAILED build step beta');
  lines.push('ERROR zzz_LAST_UNIQUE happened');
  lines.push('done');
  const r = L.compressLog(lines.join('\n'), {});
  check('log-cap-keeps-last-error', r.compressed.includes('ERROR zzz_LAST_UNIQUE happened'), 'keepLastError line survives the adaptive global cap');
  check('log-cap-keeps-first-error', r.compressed.split('\n')[0].includes('ERROR generic failure alpha'), 'keepFirstError line survives the adaptive global cap');
}

// --- findings 4 & 6: the omitted trailer reports OMITTED per-level counts, never totals ---
// A kept error must not be listed as omitted, and the per-level breakdown must not exceed the omitted
// total.
{
  const l = [];
  for (let i = 0; i < 60; i++) l.push(`INFO processing ${i}`);
  l.push('ERROR the one and only failure');
  const r = L.compressLog(l.join('\n'), {});
  const trailer = r.compressed.split('\n').find((x) => x.includes('lines omitted')) || '';
  check('log-trailer-error-kept-not-omitted', r.compressed.includes('ERROR the one and only failure') && !/\bERROR\b/.test(trailer), `kept ERROR must not appear in the omitted trailer, got ${JSON.stringify(trailer)}`);
  const m = trailer.match(/^\[(\d+) lines omitted: (.*)\]$/);
  const omittedTotal = m ? Number(m[1]) : NaN;
  const breakdownSum = m ? m[2].split(', ').reduce((a, p) => a + Number(p.split(' ')[0]), 0) : NaN;
  check('log-trailer-breakdown-le-omitted', m && breakdownSum <= omittedTotal, `breakdown sum ${breakdownSum} must be ≤ omitted ${omittedTotal} (${JSON.stringify(trailer)})`);
  check('log-trailer-info-count-is-dropped', /\b57 INFO\b/.test(trailer), `INFO count must be the 57 dropped (60 total − 3 kept context), got ${JSON.stringify(trailer)}`);
}

// ================================================================ M11 — fenced-payload unwrap ==
// A tool wraps its payload in prose + a markdown fence ("Script ran…\n```json\n<payload>\n```",
// chrome-devtools evaluate_script) which the whole JSON pipeline can't parse. unwrapFence detects a
// DOMINANT fence (body ≥ 80% of bytes) and slim() re-runs the pipeline on the body, preamble on top;
// an incompressible / minority fence leaves the WHOLE original byte-identical.
{
  const payload = JSON.stringify({ products: Array.from({ length: 40 }, (_, i) => ({ id: i, note: 'x'.repeat(40) })) });
  const wrapped = `Script ran on page and returned:\n\`\`\`json\n${payload}\n\`\`\``;
  // unwrapFence unit — a dominant fenced body: verbatim body, kept preamble, physical-line offset
  const uw = J.unwrapFence(wrapped);
  check('m11-unwrap-body', uw && uw.body === payload, 'dominant fence → body is the payload verbatim');
  check('m11-unwrap-preamble', uw && uw.preamble === 'Script ran on page and returned:', `preamble kept: ${JSON.stringify(uw && uw.preamble)}`);
  check('m11-unwrap-offset', uw && uw.offset === 2, `offset = physical lines before the body (prose + fence = 2), got ${uw && uw.offset}`);
  // no-preamble fence (opening fence is line 0) → empty preamble, offset 1
  const uw0 = J.unwrapFence(`\`\`\`json\n${payload}\n\`\`\``);
  check('m11-unwrap-no-preamble', uw0 && uw0.preamble === '' && uw0.offset === 1, `no-preamble: preamble=${JSON.stringify(uw0 && uw0.preamble)} offset=${uw0 && uw0.offset}`);
  // dominance guard — a docs chunk whose code block is a MINORITY of bytes → null (byte-identical doc)
  const doc = ['## Fetching products', '', 'Use the products connection to page through a catalogue. Each edge exposes a cursor and a node.', '```graphql', 'query { products(first: 10) { edges { node { id } } } }', '```', 'Pagination is cursor-based; keep requesting until hasNextPage is false. See the reference.'].join('\n');
  check('m11-dominance-guard', J.unwrapFence(doc) === null, 'a small code block in a doc is not dominant → null');
  // unterminated fence → null (old behavior); tilde fence → null (unsupported, no crash); long trailer → null
  check('m11-unterminated', J.unwrapFence(`intro\n\`\`\`json\n${payload}`) === null, 'no closing fence → null');
  check('m11-tilde-null', J.unwrapFence(`intro\n~~~json\n${payload}\n~~~`) === null, 'tilde fence → null (no crash)');
  check('m11-long-trailer', J.unwrapFence(`\`\`\`json\n${payload}\n\`\`\`\na\nb\nc\nd\ne`) === null, 'a long trailer → not a single dominant fence → null');
  // opening fence past the preamble window → null (a deep-in-a-doc fence is never unwrapped)
  check('m11-preamble-window', J.unwrapFence(`a\nb\nc\nd\n\`\`\`json\n${payload}\n\`\`\``) === null, 'opening fence after the preamble window → null');

  // slim() on a fenced JSON payload → compressed, preamble on top, trace stages lead with 'fence'
  const r = J.slim(wrapped, { trace: true });
  check('m11-slim-json-compresses', r.wasModified && r.bytesOut < r.bytesIn, `fenced JSON compresses: ${r.bytesIn}→${r.bytesOut}`);
  check('m11-slim-json-preamble', r.output.startsWith('Script ran on page and returned:\n'), 'preamble kept on top of the slimmed body');
  check('m11-slim-json-stages', r.stages[0] === 'fence' && r.stages.includes('crush'), `stages lead with 'fence' + include 'crush', got ${JSON.stringify(r.stages)}`);
  check('m11-slim-body-parses', (() => { try { return Array.isArray(JSON.parse(r.output.slice(r.output.indexOf('\n') + 1)).products); } catch { return false; } })(), 'the slimmed body under the preamble is valid crushed JSON');
  // {fence:false} → byte-identical non-json passthrough; trace off → compressed but stages empty
  const off = J.slim(wrapped, { fence: false });
  check('m11-fence-off', !off.wasModified && off.reason === 'non-json' && off.output === wrapped, 'fence:false → byte-identical non-json passthrough');
  const noTrace = J.slim(wrapped, { fence: true, trace: false });
  check('m11-trace-off-empty', noTrace.wasModified && noTrace.stages.length === 0, 'trace off → compressed but stages stays empty');
  // docs chunk with a small code block → byte-identical passthrough (dominance guard end-to-end)
  const dr = J.slim(doc);
  check('m11-docs-passthrough', !dr.wasModified && dr.reason === 'non-json' && dr.output === doc, 'docs-chunk with a small code block → byte-identical passthrough');
  // a DOMINANT fence whose body is NOT compressible (a big graphql query) → WHOLE original byte-identical
  const bigQuery = 'query {\n' + Array.from({ length: 400 }, (_, i) => `  field_${i}(first: 10) { edges { node { id title handle } } }`).join('\n') + '\n}';
  const fencedQuery = `Here is the generated query:\n\`\`\`graphql\n${bigQuery}\n\`\`\``;
  const qr = J.slim(fencedQuery);
  check('m11-dominant-incompressible', !qr.wasModified && qr.output === fencedQuery, 'a dominant but incompressible fenced body → whole original unchanged (never a bare unwrapped body)');

  // fenced JSONL body via slim (the HOOK path) → crushed as one array, stages ['fence','jsonl','crush']
  const jsonlBody = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: i, status: 'ACTIVE', vendor: 'MAC', note: 'x'.repeat(20) })).join('\n');
  const fencedJsonl = `Bulk export returned:\n\`\`\`jsonl\n${jsonlBody}\n\`\`\``;
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m11-'));
  const rj = J.slim(fencedJsonl, { trace: true, spillDir: dir });
  check('m11-fenced-jsonl-crush', rj.wasModified && rj.bytesOut < rj.bytesIn, 'fenced JSONL via slim (hook) crushes like an array');
  eq('m11-fenced-jsonl-stages', rj.stages, ['fence', 'jsonl', 'crush']);
  check('m11-fenced-jsonl-sentinel', rj.output.includes('_ccr_dropped'), 'crush sentinel present (rows offloaded, not printed)');
  rmSync(dir, { recursive: true, force: true });

  // fenced log text via slim → signal-selected, stages ['fence','log'], ERROR kept, logCompressed rides
  const logBody = Array.from({ length: 300 }, () => '[WARN] frame budget exceeded: draw skipped').join('\n') + '\n[ERROR] renderer teardown\n[ERROR] device lost';
  const fencedLog = `Console output:\n\`\`\`\n${logBody}\n\`\`\``;
  const rlog = J.slim(fencedLog, { trace: true });
  eq('m11-fenced-log-stages', rlog.stages, ['fence', 'log']);
  check('m11-fenced-log-error-kept', rlog.wasModified && rlog.output.includes('[ERROR] renderer teardown'), 'fenced log signal-selects, ERROR kept');
  check('m11-fenced-log-logcompressed', rlog.logCompressed === true, 'logCompressed flag propagates through the fence');

  // ── M11 fenced-result invariants ──────────────────────────────────────────────────────────────
  // A FENCED result over the inline cap: capOutput must spill ONLY the pure JSON body (so the
  // fnd-slim-out-* spill parses and the advertised `--jq <spill>` recovery works) and sample a REAL
  // row, with the prose preamble + trailer riding on the handback. A spill that carried the
  // "Script ran…" preamble would be invalid JSON and sample `shape: (none)`.
  const capDir = mkdtempSync(path.join(tmpdir(), 'jslim-m11cap-'));
  const capRes = J.slim(`Script ran on page and returned:\n\`\`\`json\n${payload}\n\`\`\`\nNOTE: truncated.`, { spillDir: capDir });
  const cap = J.capOutput(capRes, path.join(capDir, 'whale.txt'), { cliOutCap: 50, spillDir: capDir });
  check('m11-cap-spill-valid-json', !!cap && (() => { try { return Array.isArray(JSON.parse(readFileSync(cap.spillOut, 'utf8')).products); } catch { return false; } })(), 'Gate-A spill of a fenced result is valid JSON (body only, preamble stripped)');
  check('m11-cap-sample-real', !!cap && /(shape|first row): \{/.test(cap.handback) && !cap.handback.includes('(none)'), `handback samples a real row, not (none): ${cap && cap.handback.split('\n').find((l) => /shape|first row/.test(l))}`);
  check('m11-cap-preamble-top', !!cap && cap.handback.startsWith('Script ran on page and returned:\n'), 'the tool prose preamble rides on top of the Gate-A handback');
  check('m11-cap-trailer-kept', !!cap && cap.handback.includes('NOTE: truncated.'), 'the fenced trailer rides on the Gate-A handback');
  // a NON-fenced result: capOutput spills res.output unchanged (no regression), no preamble line
  const plainRes = J.slim(JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, note: 'y'.repeat(60) }))), { spillDir: capDir });
  const capPlain = J.capOutput(plainRes, path.join(capDir, 'plain.json'), { cliOutCap: 50, spillDir: capDir });
  check('m11-cap-plain-unchanged', !!capPlain && readFileSync(capPlain.spillOut, 'utf8') === plainRes.output && !/^\n/.test(capPlain.handback), 'a non-fenced result still spills res.output verbatim, no preamble prepended');
  rmSync(capDir, { recursive: true, force: true });

  // A CRLF-delimited fence still unwraps and compresses (the fence regex tolerates a trailing \r).
  const crlf = `Script ran on page and returned:\r\n\`\`\`json\r\n${payload}\r\n\`\`\``;
  const uwc = J.unwrapFence(crlf);
  check('m11-crlf-unwrap', !!uwc && (() => { try { return Array.isArray(JSON.parse(uwc.body).products); } catch { return false; } })(), 'CRLF-delimited fence unwraps, body parses');
  const rcrlf = J.slim(crlf, { trace: true });
  check('m11-crlf-compresses', rcrlf.wasModified && rcrlf.stages[0] === 'fence' && rcrlf.stages.includes('crush'), `CRLF fenced JSON compresses via the fence branch: ${JSON.stringify(rcrlf.stages)}`);

  // A substantive trailer after the closing fence is captured and carried into the output; a
  // bare trailing newline is NOT a trailer.
  const withTrailer = `Result:\n\`\`\`json\n${payload}\n\`\`\`\nNOTE: truncated at 40 rows.`;
  const uwt = J.unwrapFence(withTrailer);
  check('m11-trailer-captured', !!uwt && uwt.trailer === 'NOTE: truncated at 40 rows.', `trailer captured: ${JSON.stringify(uwt && uwt.trailer)}`);
  const rt = J.slim(withTrailer);
  check('m11-trailer-in-output', rt.wasModified && rt.output.endsWith('NOTE: truncated at 40 rows.'), 'trailer carried into the compressed output');
  const uwn = J.unwrapFence(`Result:\n\`\`\`json\n${payload}\n\`\`\`\n`);
  check('m11-trailing-newline-not-trailer', !!uwn && uwn.trailer === '', `a bare final newline is not a trailer: ${JSON.stringify(uwn && uwn.trailer)}`);

  // Offset-aware stream profiling (Gate B): skipLeading + fenceAware skip the fence wrapper so a
  // fenced JSONL whale profiles only its real rows (parseFailures 0), matching the ≤8 MB unwrap path.
  // Without the opts the raw stream counts the wrapper lines as parse failures — the contrast the
  // raw-profile check below pins.
  const spDir = mkdtempSync(path.join(tmpdir(), 'jslim-m11sp-'));
  const spFile = path.join(spDir, 'fenced.jsonl');
  writeFileSync(spFile, `Script returned:\n\`\`\`jsonl\n${Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i, handle: 'p' + i })).join('\n')}\n\`\`\`\n`);
  const profFence = await J.streamProfile(spFile, {}, { skipLeading: 2, fenceAware: true });
  const profRaw = await J.streamProfile(spFile, {});
  check('m11-streamprofile-fence-skips-wrapper', profFence.parseFailures === 0 && profFence.rows === 10, `fence-aware profile: failures=${profFence.parseFailures} rows=${profFence.rows}`);
  check('m11-streamprofile-raw-counts-wrapper', profRaw.parseFailures > 0, `raw profile counts the wrapper lines as failures: ${profRaw.parseFailures}`);
  rmSync(spDir, { recursive: true, force: true });

  // A BOM-prefixed opening fence must be detected by the shared findOpeningFence helper (it strips a
  // leading BOM before matching) so the ≤8 MB unwrap path and the >8 MB Gate B scan classify a
  // BOM+fenced whale identically — the raw FENCE_OPEN regex alone misses the "﻿```json" line.
  const bomLines = ['﻿```json', JSON.stringify({ a: 1 }), '```'];
  check('m11-bom-fence-helper', J.findOpeningFence(bomLines, 3) === 0, `findOpeningFence detects a BOM-prefixed fence at 0: ${J.findOpeningFence(bomLines, 3)}`);
  const bomUnwrap = J.unwrapFence(`﻿\`\`\`json\n${payload}\n\`\`\``);
  check('m11-bom-fence-unwrap', !!bomUnwrap && (() => { try { return Array.isArray(JSON.parse(bomUnwrap.body).products); } catch { return false; } })(), 'unwrapFence unwraps a BOM-prefixed fenced body');
  // Gate B mirror at small scale: computing skipLeading with the shared helper over a BOM-prefixed
  // fenced JSONL head, then stream-profiling the body, sees zero parse failures — the >8 MB path no
  // longer diverges from the ≤8 MB path on the BOM case.
  const bomDir = mkdtempSync(path.join(tmpdir(), 'jslim-m11bom-'));
  const bomFile = path.join(bomDir, 'bom.jsonl');
  writeFileSync(bomFile, `﻿\`\`\`jsonl\n${Array.from({ length: 6 }, (_, i) => JSON.stringify({ id: i })).join('\n')}\n\`\`\`\n`);
  const bomSkip = J.findOpeningFence(readFileSync(bomFile, 'utf8').split('\n', 4), 3) + 1; // Gate B: skipLeading = index + 1
  const bomProf = await J.streamProfile(bomFile, {}, { skipLeading: bomSkip, fenceAware: true });
  check('m11-bom-gateb-profiles-clean', bomSkip === 1 && bomProf.parseFailures === 0 && bomProf.rows === 6, `BOM+fence Gate B: skip=${bomSkip} failures=${bomProf.parseFailures} rows=${bomProf.rows}`);
  rmSync(bomDir, { recursive: true, force: true });
}

// ================================================================ M12 — --jq path ergonomics ==
// The dot-walk now accepts the jq-ish spellings a human actually types (a leading `.`, `[N]` indices)
// and a MISSING path says so on stderr while stdout keeps printing `null`; a value that really IS null
// stays silent. Full jq is out of scope — quoted keys are documented as unsupported.
{
  // path-normalization table: jq-ish spelling → the plain dot-walk segments
  const norm = [
    ['.a[0].b', 'a.0.b'],
    ['a.0.b', 'a.0.b'],
    ['.products[0].title', 'products.0.title'],
    ['[1]', '1'],
    ['[10][2]', '10.2'],
    ['.', ''],
    ['..', ''],
    ['.a.', 'a.'], // a trailing dot survives normalization; the segment filter drops it at walk time
    ['["a.b"]', '["a.b"]'], // quoted keys are NOT supported (only [N] is rewritten) — documented, not a feature
  ];
  for (const [input, want] of norm) eq(`m12-normjq:${input}`, J.normalizeJqPath(input), want);
  // …and the unsupported quoted key really does walk as two plain segments, not one key with a dot
  eq('m12-normjq-quoted-segments', J.normalizeJqPath('["a.b"]').split('.').filter(Boolean), ['["a', 'b"]']);

  const arrDir = mkdtempSync(path.join(tmpdir(), 'jslim-m12-'));
  const runJq = (p, file) => spawnSync('node', [SLIM, '--jq', p, file], { encoding: 'utf8' });
  // `.a[0].b` ≡ `a.0.b` — byte-identical stdout for both spellings of the same path
  const nestFile = path.join(arrDir, 'nest.json');
  writeFileSync(nestFile, JSON.stringify({ a: [{ b: 'hit' }] }));
  const dotted = runJq('a.0.b', nestFile);
  const jqish = runJq('.a[0].b', nestFile);
  check('m12-jq-equivalent-spellings', dotted.stdout === jqish.stdout && dotted.stdout.trim() === '"hit"',
    `'.a[0].b' must resolve exactly like 'a.0.b': ${JSON.stringify(dotted.stdout)} vs ${JSON.stringify(jqish.stdout)}`);

  const arrFile = path.join(arrDir, 'arr.json');
  writeFileSync(arrFile, JSON.stringify([{ title: 'zero' }, { title: 'one', tags: null }]));
  eq('m12-jq-bracket-index', runJq('[1].title', arrFile).stdout.trim(), '"one"');
  eq('m12-jq-leading-dot-index', runJq('.[0].title', arrFile).stdout.trim(), '"zero"');
  // bare `.` = identity: the WHOLE document (still slimmed, never narrowed) and no diagnostic
  const ident = runJq('.', nestFile);
  check('m12-jq-identity', ident.stdout.trim() === JSON.stringify({ a: [{ b: 'hit' }] }) && ident.stderr === '',
    `bare '.' selects the whole value silently: ${JSON.stringify(ident.stdout)} / ${JSON.stringify(ident.stderr)}`);

  // MISSING path → stdout null + ONE stderr diagnostic naming the failing segment, where the walk got
  // to, and what was addressable there
  const miss = runJq('produtcs.0', arrFile);
  eq('m12-jq-missing-stdout', miss.stdout.trim(), 'null');
  check('m12-jq-missing-diag', /--jq: 'produtcs' not found at top level; length: 2/.test(miss.stderr),
    `stderr diagnostic missing/wrong: ${JSON.stringify(miss.stderr)}`);
  const missDeep = runJq('1.titel', arrFile);
  check('m12-jq-missing-deep-diag', /--jq: 'titel' not found at '1'; keys: title, tags/.test(missDeep.stderr),
    `deep diagnostic must name the resolved prefix + keys: ${JSON.stringify(missDeep.stderr)}`);
  // NULL-VALUED path → stdout null too, but SILENT (a real value, not a typo)
  const nul = runJq('1.tags', arrFile);
  eq('m12-jq-null-stdout', nul.stdout.trim(), 'null');
  eq('m12-jq-null-silent', nul.stderr, '');
  rmSync(arrDir, { recursive: true, force: true });
}

// ============================================ M12b — shapeHint (the stub's "what is in that file") ==
// One line telling the model what the spilled whale IS before it decides to open it: parseable JSON →
// `array of N` / its top-level keys; anything else → a collapsed preview of the head. `format` doubles
// as the M8 tag so the stub can name the payload honestly.
{
  eq('m12b-hint-array', J.shapeHint(JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }])), { format: 'json', hint: 'array of 3' });
  eq('m12b-hint-keys', J.shapeHint(JSON.stringify({ products: [], pageInfo: {} })), { format: 'json', hint: 'keys: products, pageInfo' });
  // more than 8 top-level keys → the first 8 + an honest overflow count
  const wide = {};
  for (let i = 0; i < 11; i++) wide[`k${i}`] = i;
  eq('m12b-hint-keys-capped', J.shapeHint(JSON.stringify(wide)),
    { format: 'json', hint: 'keys: k0, k1, k2, k3, k4, k5, k6, k7 …(+3)' });
  eq('m12b-hint-empty-object', J.shapeHint('{}'), { format: 'json', hint: 'object with no keys' });
  // a leading BOM / whitespace must not hide the JSON
  eq('m12b-hint-bom', J.shapeHint('﻿\n  {"a":1}'), { format: 'json', hint: 'keys: a' });
  // non-JSON → preview + the M8 format tag, whitespace collapsed to one line
  eq('m12b-hint-text', J.shapeHint('Build failed\n  at line 4\n'), { format: 'text', hint: 'starts with: Build failed at line 4' });
  eq('m12b-hint-html', J.shapeHint('<!doctype html><html><body>hi</body></html>').format, 'html');
  // looks like JSON but does not parse → `broken-json` (the upstream-truncation gem), preview not keys
  const broken = J.shapeHint(`{"rows":[${'{"id":1},'.repeat(50)}`);
  check('m12b-hint-broken-json', broken.format === 'broken-json' && broken.hint.startsWith('starts with: {"rows"'), JSON.stringify(broken));
  // the preview is capped at ~200 chars and marked as cut — a whale must never inline itself here
  const long = J.shapeHint('a'.repeat(50000));
  check('m12b-hint-preview-capped', long.hint.length <= 215 && long.hint.endsWith('…'), `preview ${long.hint.length} chars: ${long.hint.slice(0, 60)}`);
  // …and a NON-JSON whale is head-only work: no regex ever runs over the whole payload
  const t0 = Date.now();
  J.shapeHint(`https://cdn.example.com/a/b/c?x=1&y=2#z`.repeat(30000)); // ~1.2 MB, URL-dense, no spaces
  check('m12b-hint-bounded', Date.now() - t0 < 100, `shapeHint took ${Date.now() - t0} ms on a 1 MB non-JSON payload`);
  // a JSON whale DOES pay one full-payload JSON.parse (the hint is worthless without it) — it must
  // stay a linear scan that yields the real shape, not a stall
  const bigJson = JSON.stringify({ products: Array.from({ length: 14000 }, (_, i) => ({ id: i, handle: `product-${i}`, url: `https://cdn.example.com/p/${i}?v=1` })), pageInfo: { hasNextPage: true } });
  check('m12b-hint-json-whale-size', bigJson.length > 1000000, `fixture is ${bigJson.length} B, wanted > 1 MB`);
  const t1 = Date.now();
  const bigHint = J.shapeHint(bigJson);
  check('m12b-hint-json-whale', bigHint.format === 'json' && bigHint.hint === 'keys: products, pageInfo' && Date.now() - t1 < 500,
    `${JSON.stringify(bigHint)} in ${Date.now() - t1} ms`);
  eq('m12b-hint-nonstring', J.shapeHint(undefined), { format: 'text', hint: 'starts with: ' });
}

// ================================ M13 — jsx-slim (Figma design-context compactor) ==
// A generated React/Tailwind payload from Figma dev-mode `get_design_context` is compacted
// losslessly: a className dictionary (legend on top, `class=C17` at the use sites), a node-id
// legend whose `n17 → full id` map goes to a SPILL FILE, and a ×N fold of identical repeated
// sibling subtrees. The detector is deliberately narrow — generic HTML/XML/Liquid must pass
// through byte-identical (the corruption rail), and the whole stage only ever emits a real
// byte win.
{
  const jsxFixture = readFileSync(path.join(FIX, 'figma-design-context.jsx'), 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m13-'));

  // --- detector: only Figma-generated JSX (data-node-id + className + var(--), each ≥3) ---
  check('m13-detect-fixture', J.detectJsx(jsxFixture), 'the real design-context fixture detects as Figma JSX');
  const liquid = Array.from({ length: 200 }, (_, i) =>
    `{% if section.settings.show_${i} %}\n  <div class="card" style="color: var(--color-text-${i}, #000);">{{ product.title }}</div>\n{% endif %}`).join('\n');
  check('m13-detect-liquid-not', !J.detectJsx(liquid), 'a Liquid section using var(--…) must NOT detect');
  const lr = J.slim(liquid, { spillDir: dir });
  check('m13-liquid-passthrough', !lr.wasModified && lr.output === liquid && lr.reason === 'non-json', 'Liquid passes through byte-identical');
  const plainJsx = Array.from({ length: 200 }, (_, i) =>
    `  <div className="flex items-center gap-2" style={{ color: "var(--x, #fff)" }}>Item ${i}</div>`).join('\n');
  check('m13-detect-plain-jsx-not', !J.detectJsx(plainJsx), 'hand-written JSX without data-node-id must NOT detect');
  check('m13-plain-jsx-passthrough', J.slim(plainJsx, { spillDir: dir }).output === plainJsx, 'non-Figma JSX passes through byte-identical');
  check('m13-detect-html-not', !J.detectJsx(`<!doctype html><html><body>${'<div class="a" style="color:var(--x)">hi</div>'.repeat(500)}</body></html>`), 'plain HTML must NOT detect');
  // two hits of each signature is below the threshold
  const thin = ['<div className="a" data-node-id="1:1" style={{ c: "var(--x)" }} />',
    '<div className="b" data-node-id="1:2" style={{ c: "var(--y)" }} />'].join('\n');
  check('m13-detect-threshold', !J.detectJsx(thin), '2 hits of each signature is below JSX_MIN_HITS');

  // --- slim() integration ---
  const r = J.slim(jsxFixture, { trace: true, spillDir: dir });
  check('m13-slim-compresses', r.wasModified && r.bytesOut < r.bytesIn, `fixture compresses: ${r.bytesIn}→${r.bytesOut}`);
  eq('m13-slim-stages', r.stages, ['jsx']);
  check('m13-trace-off-empty', J.slim(jsxFixture, { spillDir: dir }).stages.length === 0, 'trace off → compressed but stages stays empty');
  const off = J.slim(jsxFixture, { jsx: false, spillDir: dir });
  check('m13-jsx-off', !off.wasModified && off.reason === 'non-json' && off.output === jsxFixture, 'jsx:false → byte-identical non-json passthrough');
  check('m13-header-on-top', r.output.startsWith('<<fnd-jsx-slim>>'), 'the legend header leads the compacted body');
  check('m13-detect-idempotent', !J.detectJsx(r.output), 'an already-compacted payload never compacts twice');
  check('reduction:figma-jsx≥0.60', r.ratio >= 0.60, `figma design-context ratio ${r.ratio.toFixed(3)}`);

  // --- className legend: complete, and every entry reconstructs BYTE-EXACTLY ---
  const head = r.output.split('\n');
  const vars = {}, classes = {};
  for (const line of head.slice(1)) {
    if (line === '') break;
    const v = /^\$(\d+): (.*)$/.exec(line);
    if (v) { vars[v[1]] = v[2]; continue; }
    const c = /^C(\d+): (.*)$/.exec(line);
    if (c) classes[c[1]] = c[2];
  }
  const expand = (s) => s.replace(/\$(\d+)/g, (_, n) => vars[n]);
  const originals = [...jsxFixture.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
  const counts = new Map();
  for (const v of originals) counts.set(v, (counts.get(v) || 0) + 1);
  const repeated = [...new Set(originals.filter((v) => counts.get(v) >= 2))];
  check('m13-legend-complete', Object.keys(classes).length === repeated.length && repeated.length > 5,
    `legend holds every repeated className: ${Object.keys(classes).length} entries vs ${repeated.length} repeated values`);
  check('m13-legend-byte-parity', repeated.every((v, i) => expand(classes[String(i + 1)]) === v),
    'every legend entry expands to the byte-exact original className string');
  check('m13-legend-vars-used', Object.keys(vars).length > 0 && Object.values(classes).some((c) => c.includes('$')),
    `the var(--…) second pass fired: ${Object.keys(vars).length} tokens`);
  const refs = [...new Set((r.output.match(/class=C(\d+)/g) || []).map((s) => s.slice(7)))];
  check('m13-refs-resolve', refs.length > 0 && refs.every((n) => classes[n] !== undefined), 'every class=CN reference resolves in the legend');

  // --- node-id map: written to a spill, complete, byte-exact ---
  // `ids=`, never `full=`: that token means "the original result" everywhere else (the hook marker,
  // the crush marker, the README), and a loose scan must not pick the id map out of this header.
  const idFile = /ids=(\S*fnd-jsx-ids-[^ ;]*)/.exec(head[0]);
  check('m13-idmap-named', !!idFile && existsSync(idFile[1]) && path.dirname(idFile[1]) === dir, `the node-id map is spilled beside the other spills: ${idFile && idFile[1]}`);
  check('m13-no-full-token', !r.output.includes('full='), 'the compacted body never spends the `full=` handle on anything but the original result');
  const map = idFile ? JSON.parse(readFileSync(idFile[1], 'utf8')) : {};
  const origIds = [...new Set([...jsxFixture.matchAll(/data-node-id="([^"]*)"/g)].map((m) => m[1]))];
  check('m13-idmap-complete', Object.keys(map).length === origIds.length && origIds.every((v, i) => map[`n${i + 1}`] === v),
    `the map holds every node id byte-exact: ${Object.keys(map).length} of ${origIds.length}`);
  const idRefs = [...new Set((r.output.match(/#n\d+/g) || []))];
  check('m13-idrefs-resolve', idRefs.length > 0 && idRefs.every((x) => typeof map[x.slice(1)] === 'string'), 'every #nN reference resolves in the map');
  check('m13-ids-out-of-band', !r.output.includes('data-node-id="'), 'no data-node-id attribute survives inline');

  // --- no byte win → whole original, and no orphan map left on disk ---
  const winDir = mkdtempSync(path.join(tmpdir(), 'jslim-m13w-'));
  const tiny = ['<div className="a1" data-node-id="1:1" style={{ c: "var(--x,#fff)" }}>one</div>',
    '<div className="b2" data-node-id="1:2" style={{ c: "var(--y,#000)" }}>two</div>',
    '<div className="c3" data-node-id="1:3" style={{ c: "var(--z,#111)" }}>three</div>'].join('\n');
  const tr = J.slim(tiny, { spillDir: winDir });
  check('m13-nowin-passthrough', !tr.wasModified && tr.output === tiny && tr.reason === 'non-json', 'unique-only classNames, no byte win → byte-identical passthrough');
  check('m13-nowin-no-orphan', readdirSync(winDir).filter((f) => f.startsWith('fnd-jsx-ids-')).length === 0, 'a losing run leaves no orphan node-id map on disk');
  rmSync(winDir, { recursive: true, force: true });

  // --- ×N sibling fold ---
  const card = (id, txt) => [`      <div class=C1 #n${id} data-name="Column">`, '        <p class=C2>', `          ${txt}`, '        </p>', '      </div>'];
  const same = ['  <div class=C0>', ...card(1, 'Copy'), ...card(2, 'Copy'), ...card(3, 'Copy'), '  </div>'].join('\n');
  const fSame = J.foldSiblings(same);
  check('m13-fold-node-id-only', fSame.folded === 2 && fSame.code.includes('×2 more, identical except (node-id): [#n2] [#n3]'),
    `identical-but-for-the-id siblings fold: ${fSame.code.split('\n').find((l) => l.includes('×'))}`);
  const diff = ['  <div class=C0>', ...card(1, 'Hydrating Serum'), ...card(2, 'Firming Cream'), ...card(3, 'Brightening Oil'), '  </div>'].join('\n');
  const fDiff = J.foldSiblings(diff);
  check('m13-fold-text-listed', fDiff.folded === 2 &&
    fDiff.code.includes('×2 more, identical except (node-id, text): [#n2, "Firming Cream"] [#n3, "Brightening Oil"]'),
    `siblings with real diffs fold WITH the diffs listed: ${fDiff.code.split('\n').find((l) => l.includes('×'))}`);
  const styled = ['  <div class=C0>', ...card(1, 'A'), ...card(2, 'B').map((l) => l.replace('class=C1', 'class=C9')), '  </div>'].join('\n');
  check('m13-fold-class-differs-kept', J.foldSiblings(styled).folded === 0, 'a differing class ref keeps both siblings in full (conservative gate)');
  const runs = ['  <div class=C0>',
    ...Array.from({ length: 3 }, (_, i) => [`    <div class=C1 #n${i * 3 + 1}>`, `      <span class=C2 #n${i * 3 + 2}>`, `      <span class=C2 #n${i * 3 + 3}>`, '    </div>']).flat(),
    '  </div>'].join('\n');
  check('m13-fold-id-range', J.foldSiblings(runs).code.includes('[#n4–#n6] [#n7–#n9]'),
    `contiguous node-id runs collapse to a range: ${J.foldSiblings(runs).code.split('\n').find((l) => l.includes('×'))}`);
  check('m13-fold-none', J.foldSiblings('  <a class=C1 #n1>\n  <b class=C2 #n2>').folded === 0, 'nothing to fold → the code comes back unchanged');

  // Slot PRESENCE is part of the skeleton, so a sibling carrying a value can never fold into one
  // that carries none. Without that mark `>text<` canonicalized like `><` (and an own-line text node
  // like a whitespace-only line) with a different slot COUNT: the exemplar's list then either hid the
  // duplicates' values under a "nothing dropped" header, or indexed past the end and threw.
  const inline = (id, txt) => `    <p class=C1 #n${id} data-name="L">${txt}</p>`;
  const emptyFirst = ['  <div class=C0>', '    <p class=C1 #n1 data-name="L"></p>', inline(2, 'Hydrating Serum'), inline(3, 'Firming Cream'), '  </div>'].join('\n');
  const fEmptyFirst = J.foldSiblings(emptyFirst);
  check('m13-fold-empty-vs-text-nofold', !fEmptyFirst.code.includes('×1 more, identical */}') &&
    fEmptyFirst.code.includes('Hydrating Serum') && fEmptyFirst.code.includes('Firming Cream'),
    `an empty element never folds a text-bearing sibling away: ${JSON.stringify(fEmptyFirst.code)}`);
  const emptyLast = ['  <div class=C0>', inline(1, 'Hydrating Serum'), '    <p class=C1 #n2 data-name="L"></p>', '  </div>'].join('\n');
  check('m13-fold-text-vs-empty-nothrow', J.foldSiblings(emptyLast).folded === 0 && J.foldSiblings(emptyLast).code === emptyLast,
    'the reverse order does not throw either — the shapes simply differ');
  const blankLine = ['  <div class=C0>', '    <p class=C1 #n1>', '      ', '    </p>',
    '    <p class=C1 #n2>', '      Hello there', '    </p>', '    <p class=C1 #n3>', '      Hello there', '    </p>', '  </div>'].join('\n');
  const fBlank = J.foldSiblings(blankLine);
  check('m13-fold-blank-vs-textline', (fBlank.code.match(/Hello there/g) || []).length === 2 || fBlank.code.includes('"Hello there"'),
    `a whitespace-only line never folds an own-line text node away: ${JSON.stringify(fBlank.code)}`);
  // Trailing whitespace lives in the slot value, not the skeleton, so a repeat that differs only
  // there is listed rather than dropped under an "identical" claim.
  const trailing = ['  <div class=C0>', '    <p class=C1 #n1>', '      Copy', '    </p>',
    '    <p class=C1 #n2>', '      Copy   ', '    </p>', '  </div>'].join('\n');
  const fTrail = J.foldSiblings(trailing);
  check('m13-fold-trailing-ws-listed', fTrail.folded === 0 || fTrail.code.includes('"Copy   "'),
    `a trailing-whitespace-only difference is never silently identical: ${JSON.stringify(fTrail.code)}`);
  // Two slots of the SAME kind in one subtree — the listed value names which one it came from.
  const twoNames = (inner) => ['    <div class=C1 data-name="Fixed">', `      <span class=C2 data-name="${inner}">`, '    </div>'];
  const fTwo = J.foldSiblings(['  <div class=C0>', ...twoNames('A'), ...twoNames('B'), ...twoNames('C'), '  </div>'].join('\n'));
  check('m13-fold-same-kind-qualified', fTwo.folded === 2 && fTwo.code.includes('[name#2:"B"] [name#2:"C"]'),
    `a repeated kind is listed with its ordinal: ${fTwo.code.split('\n').find((l) => l.includes('×'))}`);

  // --- legend collision safety: a `$` anywhere in a className disables the $N pass entirely ---
  const dollarBody = Array.from({ length: 40 }, (_, i) =>
    `  <div className="w-[var(--space\\/lg,40px)] cost-[$${'x'}] pad-${i % 2}" data-node-id="9:${i}" data-name="N${i}">t${i}</div>`).join('\n');
  const dr = J.slim(dollarBody, { spillDir: dir });
  check('m13-dollar-no-var-pass', dr.wasModified && !/\n\$\d+: /.test(dr.output) && dr.output.includes('var(--space\\/lg,40px)'),
    'a `$` in a className value skips the $N pass; entries stay verbatim');

  // --- Gate A on a compacted body that is NOT JSON (the first shape that can reach it) ---
  const cap = J.capOutput(r, path.join(dir, 'design-context.jsx'), { cliOutCap: 50, spillDir: dir });
  check('m13-cap-nonjson-handback', !!cap && cap.handback.includes('not JSON — read the slimmed body windowed') &&
    !cap.handback.includes('--jq <dot.path>') && !/\n {2}(first row|shape): /.test(cap.handback),
    `a non-JSON slimmed body must not sample a row or advertise --jq:\n${cap && cap.handback}`);
  check('m13-cap-spill-byte-exact', !!cap && readFileSync(cap.spillOut, 'utf8') === r.output, 'the Gate-A spill holds the compacted body verbatim');

  // --- the MCP block envelope: the shape a design-context result keeps when spilled whole ---
  // `[{type:'text',text:'<the JSX>'}]` parses as JSON, so it never reaches the non-JSON branch; the
  // stage unwraps a PURE text-block envelope instead of leaving the whale to the JSON pipeline.
  const envelope = JSON.stringify([{ type: 'text', text: jsxFixture }]);
  const er = J.slim(envelope, { trace: true, spillDir: dir });
  eq('m13-envelope-stages', er.stages, ['jsx']);
  check('m13-envelope-compresses', er.wasModified && er.ratio >= 0.60 && er.output.startsWith('<<fnd-jsx-slim>>'),
    `a text-block envelope compacts through the jsx stage: ${er.bytesIn}→${er.bytesOut} (${(er.ratio * 100).toFixed(1)}%)`);
  const mixed = JSON.stringify([{ type: 'text', text: jsxFixture }, { type: 'image', data: 'x' }]);
  check('m13-envelope-mixed-not', !J.slim(mixed, { trace: true, spillDir: dir }).stages.includes('jsx'),
    'a mixed-block envelope is left to the JSON pipeline (only a pure text envelope unwraps)');
  const jsonArr = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row ${i}`, type: 'text' })));
  check('m13-envelope-plain-json-untouched', !J.slim(jsonArr, { trace: true, spillDir: dir }).stages.includes('jsx'),
    'a plain JSON array of records never reaches the jsx stage');
  // The lone-block shape an MCP result also arrives in — same purity rail, same compaction.
  const single = JSON.stringify({ type: 'text', text: jsxFixture });
  const sr = J.slim(single, { trace: true, spillDir: dir });
  eq('m13-single-block-stages', sr.stages, ['jsx']);
  check('m13-single-block-compresses', sr.wasModified && sr.ratio >= 0.60 && sr.output.startsWith('<<fnd-jsx-slim>>'),
    `a lone {type,text} block compacts too: ${sr.bytesIn}→${sr.bytesOut} (${(sr.ratio * 100).toFixed(1)}%)`);

  // --- only a PURE envelope unwraps: unwrapping keeps the text alone, so anything beside it would be
  // dropped under a "nothing dropped" header. A sibling field or a rich block declines the stage and
  // the value goes to the JSON pipeline instead, which compresses it with every field intact.
  const cursored = J.slim(JSON.stringify({ content: [{ type: 'text', text: jsxFixture }], _meta: { nextCursor: 'c-42' } }), { trace: true, spillDir: dir });
  check('m13-envelope-sibling-not', !cursored.stages.includes('jsx') && JSON.parse(cursored.output)._meta.nextCursor === 'c-42',
    'an envelope sibling (_meta.nextCursor) declines the unwrap and survives the JSON pipeline');
  const annotated = J.slim(JSON.stringify([{ type: 'text', text: jsxFixture, annotations: { audience: ['user'] } }]), { trace: true, spillDir: dir });
  check('m13-block-annotations-not', !annotated.stages.includes('jsx') && JSON.parse(annotated.output)[0].annotations.audience[0] === 'user',
    'a block-level field (annotations) declines the unwrap and survives too');
  const rich = J.slim(JSON.stringify({
    content: [{ type: 'text', text: jsxFixture, annotations: { audience: ['user'] } }],
    _meta: { nextCursor: 'c-42' },
    structuredContent: { nodeId: '13920:240398' },
  }), { trace: true, spillDir: dir });
  const richOut = JSON.parse(rich.output);
  check('m13-envelope-rich-fields-kept', !rich.stages.includes('jsx') && !rich.output.startsWith('<<fnd-jsx-slim>>') &&
    richOut._meta.nextCursor === 'c-42' && richOut.structuredContent.nodeId === '13920:240398' &&
    richOut.content[0].annotations.audience[0] === 'user',
    'all three fields survive a full MCP envelope — the jsx stage never eats them');

  // --- the ids= path is the LAST clause when nothing else fired (no className dictionary, no fold);
  // a sentence period glued to it would make the naive read (token up to whitespace) an ENOENT.
  const idsDir = mkdtempSync(path.join(tmpdir(), 'jslim-m13i-'));
  const uniqueCards = Array.from({ length: 60 }, (_, i) =>
    `  <div className="unique-card-${i} gap-[var(--space\\/sm,16px)]" data-node-id="I13920:2404${i};19010:8137" data-name="Card ${i}">card ${i}</div>`).join('\n');
  const ur = J.slim(uniqueCards, { spillDir: idsDir });
  const uhead = ur.output.split('\n')[0];
  const naive = /ids=(\S+)/.exec(uhead);
  check('m13-ids-clause-last', ur.wasModified && !/class=C/.test(ur.output) && !uhead.includes('×N more'),
    `unique classNames and no folds leave the ids= clause last: ${uhead.slice(0, 80)}`);
  check('m13-ids-path-readable', !!naive && existsSync(naive[1]),
    `the ids= token read naively (up to whitespace) is a real file: ${naive && naive[1]}`);
  rmSync(idsDir, { recursive: true, force: true });

  // --- fuzz: mixed line kinds must never throw and never drop a value ---
  // Own-line text, inline text, empty elements and self-closing images in one tree are what made the
  // skeleton ambiguous; the rail is that every copy string survives either in the body or in a fold's
  // diff list. Seeded LCG so a failure is reproducible.
  let seed = 20260725;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let fuzzThrew = null, fuzzLost = null;
  for (let c = 0; c < 400 && !fuzzThrew && !fuzzLost; c++) {
    const texts = [];
    const body = ['<div className="root bg-[var(--c-bg,#fff)]" data-node-id="0:0" data-name="Root">'];
    const kids = 2 + rnd(4);
    for (let k = 0; k < kids; k++) {
      const open = `  <div className="card gap-[var(--space,8px)]" data-node-id="0:${k}" data-name="Card">`;
      const t = `copy-${c}-${k}`;
      switch (rnd(4)) {
        case 0: body.push(open, `    ${t}`, '  </div>'); texts.push(t); break;
        case 1: body.push(`  <p className="card gap-[var(--space,8px)]" data-node-id="0:${k}">${t}</p>`); texts.push(t); break;
        case 2: body.push(`  <p className="card gap-[var(--space,8px)]" data-node-id="0:${k}"></p>`); break;
        default: body.push(open, '    ', '  </div>'); break;
      }
    }
    body.push('</div>');
    const src = body.join('\n');
    let out;
    try { out = J.slim(src, { spillDir: dir }).output; } catch (e) { fuzzThrew = `${e.message} on\n${src}`; break; }
    for (const t of texts) if (!out.includes(t)) { fuzzLost = `${t} missing from\n${out}`; break; }
  }
  check('m13-fuzz-no-throw', !fuzzThrew, `mixed-shape siblings never throw: ${fuzzThrew}`);
  check('m13-fuzz-no-loss', !fuzzLost, `mixed-shape siblings never lose copy: ${fuzzLost}`);

  // --- a 200 KB payload on ONE physical line stays linear-time (no regex backtracking) ---
  const oneLine = jsxFixture.replace(/\n/g, ' ').repeat(4);
  const t13 = Date.now();
  const big = J.slim(oneLine, { spillDir: dir });
  check('m13-single-line-bounded', big.wasModified && Date.now() - t13 < 1000,
    `${Buffer.byteLength(oneLine, 'utf8')} B on one line took ${Date.now() - t13} ms`);
  // …and so does a DEEPLY nested one: the fold walk used to rebuild every subtree's skeleton
  // character by character at each level, which cost bytes × nesting depth.
  const deep = [];
  for (let i = 0; i < 800; i++) deep.push(`${' '.repeat(i)}<div className="lvl-${i} bg-[var(--c-${i},#fff)]" data-node-id="9:${i}" data-name="L${i}">`);
  for (let i = 799; i >= 0; i--) deep.push(`${' '.repeat(i)}</div>`);
  const deepText = deep.join('\n');
  const t14 = Date.now();
  const deepRes = J.slim(deepText, { spillDir: dir });
  check('m13-deep-nesting-bounded', deepRes.wasModified && Date.now() - t14 < 1000,
    `${Buffer.byteLength(deepText, 'utf8')} B at depth 800 took ${Date.now() - t14} ms`);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`json-slim fixtures: ${pass} passed, ${fail} failed  (smart-crusher parity ${byteExact} byte + ${valueOnly} value of 17; log-compressor upstream parity ${logParityTotal}/20 = ${logByteExact} byte-exact + ${logDeviation1.length} deviation#1-trailer)`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
