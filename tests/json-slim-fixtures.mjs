#!/usr/bin/env node
// Fixture suite for plugins/fnd/scripts/json-slim.cjs — the shape-driven JSON compressor — and for
// plugins/fnd/scripts/scratch-hygiene.cjs, the project-side playwright sweep + `.git/info/exclude`
// stamp that used to live inside it. The split is nearly invisible to the rows below: the project
// pass is still reached through `J.sweepSpills`, so the pw-* rows assert the WIRING as well as the
// code, while the excl-* rows and the PLAYWRIGHT_OUT_REL reads address `H` — scratch-hygiene — direct.
// Three groups:
//   parity:*   — the array-crush port vs Headroom's vendored SmartCrusher fixtures (byte-parity,
//                or value-parity where JS number semantics prevent byte-parity);
//   unit tests — each pipeline stage, the crush gates, markers, safety rails, the spill-TTL
//                sweep (M5: TTL parsing, prefix/exclude filtering, throttle, the playwright
//                output-dir pass and its .git/info/exclude stamp), CLI;
//   reduction:* — the M1 exit gate: ≥70% byte reduction on the real Jira + Figma fixtures.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync, existsSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Hermetic env: a developer watching the debug log live (FND_MCP_SLIM_DEBUG=1 + FND_MCP_SLIM_DIR
// exported) would otherwise have this suite's CLI runs append fixture noise to the REAL log that
// `--report` aggregates. FND_WHALE_GUIDE and FND_NOGAIN_MEMO are scrubbed for the same reason on the
// other side: the R6 and B2 cases assert the one-shot / no-gain-memo rules, and both refusals advertise
// their own `=0` switch to the model — the switches a developer is most likely to have exported while
// debugging must not turn this suite red. Cases that need any of the four set it on the invocation
// itself.
delete process.env.FND_MCP_SLIM_DEBUG;
delete process.env.FND_MCP_SLIM_DIR;
delete process.env.FND_WHALE_GUIDE;
delete process.env.FND_NOGAIN_MEMO;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIM = path.join(ROOT, 'plugins/fnd/scripts/json-slim.cjs');
const HYG = path.join(ROOT, 'plugins/fnd/scripts/scratch-hygiene.cjs');
const PARITY = path.join(ROOT, 'tests/parity/fixtures/smart_crusher');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const J = require(SLIM);
const H = require(HYG);
// A mis-rename in the 246-site J.→T. sweep would otherwise surface as a bare TypeError with no row
// name, or — for a row that reads a symbol as a value — as a silent `undefined`. Fail at the call
// site, named. Symbols pass straight through so util.inspect/`then`-probing cannot trip it.
const T = new Proxy(J.__test, { get(o, k) { if (typeof k === 'symbol') return o[k]; if (!(k in o)) throw new Error(`unknown __test export: ${String(k)}`); return o[k]; } });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
const normJSON = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } };

// ------------------------------------------------------------------- module surface --
// Nothing else enumerates what json-slim.cjs publishes, so an export added by habit, or one deleted
// with the row that used it, would leave nothing red. Two pins: the production half (what another
// FILE may reach for) and the test half. TEST_EXPORTS is one named constant on purpose — later
// changes to the __test list have a single edit site, which is the difference between a stale pin
// and a green suite.
const TEST_EXPORTS = ['DEFAULTS', 'FENCE_DOMINANCE', 'FENCE_PREAMBLE_MAX', 'FENCE_TRAILER_MAX', 'FIRST_FRACTION', 'LAST_FRACTION', 'MAX_ITEMS_AFTER_CRUSH', 'PRESERVE_CHANGE_POINTS', 'STREAM_GATE_BYTES', 'STRING_LIMIT', 'VARIANCE_THRESHOLD', 'adfStage', 'analyseDictArray', 'blockText', 'capOutput', 'classifyArray', 'computeOptimalK', 'crush', 'crushValue', 'debugEnabled', 'debugLevel', 'detectJsx', 'envelopeInner', 'evalJqExpr', 'findOpeningFence', 'foldSiblings', 'isErrorShape', 'jqExprWhole', 'nogainMemoEnabled', 'nogainStamp', 'nogainStatePath', 'noiseStage', 'normalizeJqPath', 'numberPrecisionLoss', 'parseJqExpr', 'parseJsonl', 'profileLines', 'soleBlockText', 'spillTtlHours', 'streamProfile', 'truncateStage', 'unwrapFence', 'whaleGuidance', 'whaleGuideEnabled', 'whaleGuideFullBlock', 'whaleGuideStamp', 'whaleGuideStatePath', 'whaleReminder'];
// a new top-level export must declare itself production or move under __test
eq('exports-surface', Object.keys(J).sort(), ['JQ_GRAMMAR_HINT', '__test', 'buildReport', 'debugLog', 'shapeHint', 'slim', 'sweepSpills', 'writeSpill']);
// a deleted __test export silently turns its rows into TypeErrors; pin the list instead. Read
// J.__test here, not the T Proxy, so the row measures the module and not the trap.
eq('exports-test-surface', Object.keys(J.__test).sort(), TEST_EXPORTS);
// The hygiene module's whole surface, for the same reason: it is small enough that an export added
// by habit would never be noticed, and its only suite is this one.
eq('hygiene-exports-surface', Object.keys(H).sort(), ['PLAYWRIGHT_OUT_REL', 'ensureFndTmpExcluded', 'sweepPlaywrightOut']);
// …and it must not drag the compressor back in. The point of the split is that the PreToolUse
// screenshot guard loads ~110 lines instead of a ~230 KB module graph, and a stray top-level require
// here would undo that silently — nothing else measures module load. Same Module._load probe
// hooks-sim M87 uses, in a child so the parent's already-loaded json-slim cannot mask it.
{
  const probe = `const M=require('module'),l=M._load;M._load=function(r){if(/json-slim\\.cjs$/.test(r))process.stderr.write('LOADED-JSON-SLIM\\n');return l.apply(this,arguments)};require(process.argv[1]);`;
  const r = spawnSync(process.execPath, ['-e', probe, HYG], { encoding: 'utf8' });
  check('hygiene-no-compressor', r.status === 0 && !/LOADED-JSON-SLIM/.test(r.stderr || ''),
    `scratch-hygiene.cjs must not require json-slim.cjs (status ${r.status}): ${(r.stderr || '').trim()}`);
}
// DEFAULTS is the CONFIGURABLE surface: every key here must have a real override somewhere (the hook,
// the CLI, or a fixture). Numbers the code merely reads belong in json-slim.cjs's tuning-constants
// block, where they cost no property lookup per crushed item and read as what they are.
eq('defaults-surface', Object.keys(T.DEFAULTS).sort(),
  ['cliOutCap', 'deadline', 'dropRestLinks', 'enableMarker', 'envelope', 'fence', 'jsonl', 'jsx', 'log', 'markerMode', 'minItemsToAnalyze', 'preserveFields', 'spillDir', 'trace']);
// The M11 tuning numbers are otherwise pinned only IMPLICITLY, by m11-dominance-guard /
// m11-preamble-window / m11-long-trailer having been built around these exact values.
check('fence-const-pinned', T.FENCE_DOMINANCE === 0.8 && T.FENCE_PREAMBLE_MAX === 3 && T.FENCE_TRAILER_MAX === 3,
  `M11 fence constants drifted: dominance=${T.FENCE_DOMINANCE} preamble=${T.FENCE_PREAMBLE_MAX} trailer=${T.FENCE_TRAILER_MAX}`);
// Without this row these two are pinned by nothing at all — STREAM_GATE_BYTES only implicitly, by the
// cases that actually write an 8 MB file, and it is interpolated into two user-facing messages.
check('tuning-consts-pinned', T.STRING_LIMIT === 200 && T.STREAM_GATE_BYTES === 8 * 1024 * 1024,
  `stringLimit/stream-gate constants drifted: STRING_LIMIT=${T.STRING_LIMIT} STREAM_GATE_BYTES=${T.STREAM_GATE_BYTES}`);

// ---------------------------------------------------------------- parity vs Headroom --
// Every fixture: gate (was_modified) + strategy string must match exactly; the compressed body
// must be byte-identical, OR (where JS 0.0→0 float re-serialization prevents it) value-identical.
//
// Every config key upstream recorded is CLASSIFIED, in exactly one of the three tables below. The
// harness used to map two of the fifteen and ignore the rest, so five more passed only because
// upstream's corpus happens to carry this port's own default values — a diet could have moved
// firstFraction or varianceThreshold and stayed green. Mirrors the log side's LOG_CFG_MAP.
const CRUSH_CFG_MAP = { min_items_to_analyze: 'minItemsToAnalyze' }; // still a DEFAULTS knob (the CLI overrides it)
// Recorded upstream values this port keeps as tuning CONSTANTS: assert agreement, don't feed them in.
const CRUSH_CONST_MAP = {
  max_items_after_crush: 'MAX_ITEMS_AFTER_CRUSH', first_fraction: 'FIRST_FRACTION', last_fraction: 'LAST_FRACTION',
  variance_threshold: 'VARIANCE_THRESHOLD', preserve_change_points: 'PRESERVE_CHANGE_POINTS',
};
// Recorded by upstream, with nothing on this side to pin them against — each with its reason.
const CRUSH_UPSTREAM_ONLY = {
  dedup_identical_items: "upstream's dedup switch — this port dedups unconditionally in the string sampler (json-slim.cjs sampleStringArray, \"dedup by raw string\") and never consults a flag, so there is nothing to pin",
  enabled: 'upstream master switch — our port is only called when compression is wanted',
  factor_out_constants: 'constant-factoring transform, not ported (false in every fixture)',
  include_summaries: 'per-field summary emission, not ported (false in every fixture)',
  min_tokens_to_crush: 'upstream pre-crush token budget — the recorded fixtures show it is NOT applied inside SmartCrusher.crush (a 9-byte input is recorded was_modified:true), so it is inert here; the fnd side gates by bytes at the hook',
  similarity_threshold: 'query-similarity path — the non-deterministic half we did not port',
  toin_confidence_threshold: 'ditto',
  uniqueness_threshold: 'ditto',
  use_feedback_hints: 'query/feedback path — deliberately not ported',
};
const seenCfgKeys = new Set();
const unclassifiedCfgKeys = [];
const constDisagreements = [];
let byteExact = 0, valueOnly = 0;
for (const f of readdirSync(PARITY).filter((x) => x.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(path.join(PARITY, f), 'utf8'));
  const c = fx.config || {};
  const cfg = { markerMode: 'ccr' };
  for (const k of Object.keys(c)) {
    seenCfgKeys.add(k);
    if (CRUSH_CFG_MAP[k]) { if (c[k] != null) cfg[CRUSH_CFG_MAP[k]] = c[k]; continue; }
    if (CRUSH_CONST_MAP[k]) {
      if (c[k] !== T[CRUSH_CONST_MAP[k]]) constDisagreements.push(`${f}: ${k}=${JSON.stringify(c[k])} but ${CRUSH_CONST_MAP[k]}=${JSON.stringify(T[CRUSH_CONST_MAP[k]])}`);
      continue;
    }
    if (k in CRUSH_UPSTREAM_ONLY) continue;
    unclassifiedCfgKeys.push(`${f}: ${k}`);
  }
  const got = T.crush(fx.input.content, cfg);
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
check('parity:cfg-keys-classified', unclassifiedCfgKeys.length === 0,
  `unclassified fixture config key '${unclassifiedCfgKeys[0]}' — map it, pin it against a constant, or declare it upstream-only with a reason`);
check('parity:const-agreement', constDisagreements.length === 0,
  `this port's constant disagrees with upstream's recorded config — ${constDisagreements[0]}`);
{
  const mapped = [...Object.keys(CRUSH_CFG_MAP), ...Object.keys(CRUSH_CONST_MAP)];
  const rotten = mapped.filter((k) => !seenCfgKeys.has(k));
  check('parity:map-not-rotten', rotten.length === 0,
    `mapping entries no fixture carries any more: ${rotten.join(', ')} — a refreshed corpus must not leave a dead mapping`);
}
check('parity:cfg-coverage-count', seenCfgKeys.size === 15,
  `saw ${seenCfgKeys.size} distinct fixture config keys, expected 15 — a refreshed corpus that ADDS a knob must trip the classifier, not pass silently`);

// ---------------------------------------------------------------- classifyArray --
eq('classify-dict', T.classifyArray([{ a: 1 }, { a: 2 }]), 'DictArray');
eq('classify-number', T.classifyArray([1, 2, 3]), 'NumberArray');
eq('classify-string', T.classifyArray(['a', 'b']), 'StringArray');
eq('classify-bool', T.classifyArray([true, false]), 'BoolArray');
eq('classify-nested', T.classifyArray([[], [1]]), 'NestedArray');
eq('classify-empty', T.classifyArray([]), 'Empty');
eq('classify-mixed-scalar', T.classifyArray([1, 'a']), 'MixedArray');
eq('classify-mixed-null', T.classifyArray([{ a: 1 }, null]), 'MixedArray'); // one null → Mixed

// ---------------------------------------------------------------- computeOptimalK --
eq('optk-small', T.computeOptimalK(['a', 'b', 'c'], 1, 3, 15), 3); // n<=8 → n
eq('optk-diverse', T.computeOptimalK(Array.from({ length: 40 }, (_, i) => `x${i}`), 1, 3, 15), 15);
eq('optk-identical', T.computeOptimalK(Array.from({ length: 40 }, () => 'same'), 1, 3, 15), 3); // uniq=1 → clamp 3

// ---------------------------------------------------------------- crush gates --
check('crush-nonjson-passthrough', (() => { const r = T.crush('not json at all'); return !r.wasModified && r.strategy === 'passthrough' && r.compressed === 'not json at all'; })(), 'non-JSON must pass verbatim');
check('crush-compact-nochange', (() => { const r = T.crush('[1,2,3]'); return !r.wasModified && r.strategy === 'passthrough'; })(), 'already-compact short array → unmodified');
check('crush-reflow-modified', (() => { const r = T.crush('[1, 2, 3]'); return r.wasModified && r.strategy === 'passthrough'; })(), 'spaced short array → reflow flips wasModified');
check('crush-small-array-passthrough', (() => { const r = T.crush(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])); return normJSON(r.compressed) === normJSON(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])); })(), 'array < minItemsToAnalyze not crushed');

// a 20-item same-shape dict array with an error signal → smart_sample + sentinel marker
const errArray = Array.from({ length: 20 }, (_, i) => ({ id: i, status: i % 7 === 0 ? 'error' : 'ok', msg: `row ${i}` }));
const crushed = T.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: mkdtempSync(path.join(tmpdir(), 'jslim-')) });
check('crush-smart-sample', crushed.strategy.startsWith('smart_sample('), `strategy=${crushed.strategy}`);
const crushedOut = JSON.parse(crushed.compressed);
check('crush-kept-under-budget', crushedOut.filter((x) => !x._ccr_dropped).length <= 15, 'kept ≤ MAX_ITEMS_AFTER_CRUSH');
check('crush-marker-present', crushedOut.some((x) => x._ccr_dropped && /^<<full=.+ \d+_rows_offloaded>>$/.test(x._ccr_dropped)), 'spill marker shape');
check('crush-error-rows-kept', [0, 7, 14].every((i) => crushedOut.some((x) => x.id === i && x.status === 'error')), 'error rows preserved');

// ---------------------------------------------------------------- spill round-trip --
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-spill-'));
  const r = T.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: dir });
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
  const a = T.crush(JSON.stringify(items), { markerMode: 'ccr' });
  const b = T.crush(JSON.stringify(items), { markerMode: 'ccr' });
  check('ccr-hash-deterministic', a.compressed === b.compressed, 'ccr marker must be stable across runs');
  check('ccr-hash-shape', /<<ccr:[0-9a-f]{12} \d+_rows_offloaded>>/.test(a.compressed), 'ccr marker shape');
}

// ---------------------------------------------------------------- pipeline stages --
const adfDoc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world', marks: [{ type: 'strong' }] }] }] };
eq('stage-adf', T.adfStage({ description: adfDoc }, T.DEFAULTS), { description: 'hello **world**' });
eq('stage-noise-null', T.noiseStage({ a: 1, b: null }, T.DEFAULTS), { a: 1 });
eq('stage-noise-empty', T.noiseStage({ a: 1, b: {}, c: [] }, T.DEFAULTS), { a: 1 });
eq('stage-noise-avatar', T.noiseStage({ name: 'x', avatarUrls: { '48x48': 'http://a' }, iconUrl: 'http://i' }, T.DEFAULTS), { name: 'x' });

// dropRestLinks (M3): a `self` REST-navigation URL is noise; a `self` holding real content is not.
eq('stage-noise-self-rest', T.noiseStage({ id: '1', self: 'https://x.atlassian.net/rest/api/2/status/3' }, T.DEFAULTS), { id: '1' });
eq('stage-noise-self-confluence', T.noiseStage({ _links: { self: 'https://x.atlassian.net/wiki/rest/api/content/9', webui: '/pages/9' } }, T.DEFAULTS), { _links: { webui: '/pages/9' } });
eq('stage-noise-self-content', T.noiseStage({ self: 'my note about myself' }, T.DEFAULTS), { self: 'my note about myself' }); // non-REST string survives
eq('stage-noise-self-nonatlassian', T.noiseStage({ name: 'hook', self: 'https://host/api/v2/webhooks/5' }, T.DEFAULTS), { name: 'hook', self: 'https://host/api/v2/webhooks/5' }); // bare /api/ (non-Atlassian actionable URL) survives
eq('stage-noise-self-object', T.noiseStage({ self: { title: 'me' } }, T.DEFAULTS), { self: { title: 'me' } }); // non-string survives
eq('stage-noise-self-off', T.noiseStage({ self: 'https://x.atlassian.net/rest/api/2/status/3' }, { ...T.DEFAULTS, dropRestLinks: false }), { self: 'https://x.atlassian.net/rest/api/2/status/3' });
check('stage-truncate-datauri', (() => { const big = 'data:image/png;base64,' + 'A'.repeat(500); const r = T.truncateStage({ img: big }, T.DEFAULTS); return r.img.includes('…(len=') && r.img.length < 100; })(), 'data-uri clipped');
eq('stage-truncate-short', T.truncateStage({ s: 'short string' }, T.DEFAULTS), { s: 'short string' });

// ---------------------------------------------------------------- safety rails --
check('safe-error-shape', (() => { const env = JSON.stringify({ errors: [{ message: 'boom' }], data: null }); const r = J.slim(env); return !r.wasModified && r.error === true && r.output === env; })(), 'GraphQL error envelope untouched');
check('safe-usererrors', (() => { const env = JSON.stringify({ data: {}, userErrors: [{ field: 'x', message: 'bad' }] }); const r = J.slim(env); return r.error === true; })(), 'userErrors envelope untouched');
check('safe-nonjson', (() => { const r = J.slim('plain text log line'); return !r.wasModified && r.output === 'plain text log line'; })(), 'non-JSON slim passthrough');

// ---------------------------------------------------------------- preserveFields --
{
  // both arrays are crushable (a rare "error" status is the signal); preserving one exempts it
  const mk = (tag) => Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 6 === 0 ? 'error' : 'ok', v: `${tag}${i}` }));
  const out = T.crushValue({ keepme: mk('x'), other: mk('y') }, { preserveFields: { keepme: true }, markerMode: 'ccr' });
  check('preserve-untouched', out.keepme.length === 30 && !out.keepme.some((x) => x._ccr_dropped), 'preserved key not crushed');
  check('preserve-other-crushed', out.other.length < 30, 'non-preserved key still crushed');
}

// ---------------------------------------------------------------- review regressions --
// finding 1: long prose / ADF-derived markdown is NEVER truncated (only opaque blobs are)
check('trunc-prose-survives', (() => { const prose = 'Acceptance criteria: ' + 'word '.repeat(400); return T.truncateStage({ desc: prose }, T.DEFAULTS).desc === prose; })(), 'long prose must survive');
check('trunc-datauri-clipped', (() => T.truncateStage({ img: 'data:image/png;base64,' + 'A'.repeat(400) }, T.DEFAULTS).img.includes('…(len='))(), 'data-uri still clipped');
check('trunc-data-prose-survives', (() => { const s = 'data: ' + 'the following steps are required. '.repeat(12); return T.truncateStage({ note: s }, T.DEFAULTS).note === s; })(), 'prose starting "data:" is not a data-URI → survives');
check('slim-adf-desc-survives', (() => { const prose = 'Acceptance criteria for this ticket. '.repeat(60); const big = { fields: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: prose }] }] } } }; return J.slim(JSON.stringify(big)).output.includes(prose.trim()); })(), 'ADF-derived prose survives slim (not clipped)');

// finding 2: spill-write failure keeps the array uncrushed (no dangling handle to a missing file)
{
  const badFile = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-ro-')), 'not-a-dir');
  require('node:fs').writeFileSync(badFile, 'x'); // a FILE — using it as a spill parent dir fails
  const r = T.crush(JSON.stringify(errArray), { markerMode: 'spill', spillDir: path.join(badFile, 'sub') });
  const out = JSON.parse(r.compressed);
  check('spill-fail-keeps-rows', out.length === 20 && !out.some((x) => x._ccr_dropped), 'spill failure → rows kept, no dangling marker');
}

// finding 3: MCP isError envelope guarded; empty errors:[] is a success (still compressed)
check('err-mcp-iserror', T.isErrorShape({ isError: true, content: [{ type: 'text', text: 'boom' }] }) === true, 'MCP isError envelope guarded');
check('err-empty-errors-ok', T.isErrorShape({ data: { x: 1 }, errors: [] }) === false, 'empty errors:[] is not an envelope');
check('err-empty-errors-compresses', (() => { const big = { errors: [], rows: Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 5 ? 'ok' : 'error', v: `r${i}` })) }; const r = J.slim(JSON.stringify(big)); return !r.error && r.ratio > 0; })(), 'success payload with errors:[] still compressed');

// finding 4: large arrays must not RangeError from Math.min/max spread
check('big-number-array-nocrash', (() => { try { return typeof T.crush(JSON.stringify(Array.from({ length: 200000 }, (_, i) => i * 2))).compressed === 'string'; } catch { return false; } })(), '200k number array');
check('big-dict-array-nocrash', (() => { try { return typeof T.crush(JSON.stringify(Array.from({ length: 120000 }, (_, i) => ({ id: i * 3, status: i % 100 ? 'ok' : 'error' })))).compressed === 'string'; } catch { return false; } })(), '120k dict array');

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
  // spawnSync for the stdin runs: a lossy stdin body also names its recovery copy on stderr, captured
  // here rather than leaked into the suite's own output.
  const out = spawnSync('node', [SLIM], { input: inp, encoding: 'utf8' }).stdout;
  check('cli-stdin', out.length < inp.length && JSON.parse(out), 'CLI over stdin compresses to valid JSON');
  // stderr ignored, not inherited: a compressed file run names its original there, and this case is
  // about stdout — the note would otherwise land in the suite's own output.
  const outFile = execFileSync('node', [SLIM, path.join(FIX, 'figma-node-rest.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

// ------------------------------------------------------- CLI stdin recovery net --
// A FILE run needs no recovery copy — the caller already holds the path, and every lossy branch names
// it. STDIN had none: `noise` dropped fields and `truncate` clipped strings, and the handed-back body
// was the only copy left (the crush spill holds the DROPPED ROWS, not the original). A lossy stdin body
// now rides on the same content-addressed original-spill the hook gives every compressed MCP result.
{
  const lossy = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, empty: null, big: 'y'.repeat(1500) })) });
  const dirs = [];
  const run = (input, args, env) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jslim-stdin-'));
    dirs.push(dir);
    const r = spawnSync('node', [SLIM, ...(args || [])], { input, encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, ...(env || {}) } });
    const originals = readdirSync(dir).filter((f) => /^fnd-mcp-slim-[0-9a-f]{16}.*\.json$/.test(f)); // not the debug log, which shares the prefix
    return { ...r, dir, originals, read: (f) => readFileSync(path.join(dir, f), 'utf8') };
  };
  const r = run(lossy);
  check('b4.4-stdin-original-spilled', r.originals.length === 1 && r.read(r.originals[0]) === lossy,
    `a lossy stdin body must leave the original on disk: ${JSON.stringify(r.originals)}`);
  check('b4.4-stdin-original-named', r.originals.length === 1 && r.stderr.includes(path.join(r.dir, r.originals[0])),
    `the run must NAME the recovery copy: stderr=${JSON.stringify(r.stderr)}`);
  check('b4.4-stdin-stdout-still-json', (() => { try { return !!JSON.parse(r.stdout); } catch { return false; } })(),
    `stdout stays the machine-readable body — the pointer belongs on the side channel: ${r.stdout.slice(0, 80)}`);
  // The debug line's ONE handback path (`spill`) is what --report pairs recoveries on, and `spills` is
  // the on-disk inventory: both must name the copy this run handed the model.
  const d = run(lossy, [], { FND_MCP_SLIM_DEBUG: '1' });
  const line = JSON.parse(d.read('fnd-mcp-slim-debug.log').trim().split('\n').pop());
  check('b4.4-stdin-debug-spill', d.originals.length === 1 && line.spill === path.join(d.dir, d.originals[0]) && line.spills.includes(line.spill),
    `debug line must name the original: spill=${line.spill} spills=${JSON.stringify(line.spills)}`);
  // A passthrough loses nothing, so it must NOT start littering the spill dir.
  const pass = run('plain text, not json');
  check('b4.4-stdin-passthrough-no-spill', pass.originals.length === 0 && pass.stdout.trim() === 'plain text, not json',
    `a lossless passthrough must write no original: ${JSON.stringify(pass.originals)}`);
  // Under `--jq` the copy holds the NARROWED subtree the stages consumed, not the piped stream — it is
  // still the complete undo for the body being printed, but calling it "the original" sends a caller
  // that reads it looking for a stream it will not find.
  const nq = run(lossy, ['--jq', 'rows']);
  check('dr2-stdin-narrowed-named', nq.originals.length === 1 && nq.stderr.includes('narrowed input spilled to') && !nq.stderr.includes('original spilled to'),
    `a --jq run must not call its subtree copy the original: stderr=${JSON.stringify(nq.stderr)}`);
  // An IDENTITY selector (`--jq .` / `..` / a trailing dot) narrows nothing, so the copy is labelled
  // "the original" — and it must BE the piped bytes. The narrowing walk re-serializes its result into
  // `raw`, which collapsed a piped JSONL stream into one JSON array line: the spill lost every line
  // boundary the `sed -n`/`readline` guidance addresses, under a label promising the stream itself.
  const jsonl = Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: i, empty: null, big: 'y'.repeat(400) })).join('\n');
  const idq = run(jsonl, ['--jq', '.']);
  check('dr2-stdin-identity-jq-byte-exact', idq.originals.length === 1 && idq.read(idq.originals[0]) === jsonl,
    `an identity --jq must spill the piped bytes, not a re-serialization: ${idq.originals.length === 1 ? JSON.stringify(idq.read(idq.originals[0]).slice(0, 90)) : JSON.stringify(idq.originals)}`);
  check('dr2-stdin-identity-jq-labelled-original', idq.stderr.includes('original spilled to') && !idq.stderr.includes('narrowed input'),
    `an identity selector narrows nothing, so the copy is the original: stderr=${JSON.stringify(idq.stderr)}`);
  // Spill dir unwritable (a FILE where the dir belongs) → no recovery copy exists, so the ORIGINAL is
  // the only honest answer; a lossy body with no net must never be emitted.
  const blocked = mkdtempSync(path.join(tmpdir(), 'jslim-stdinx-'));
  const asFile = path.join(blocked, 'not-a-dir');
  writeFileSync(asFile, 'x');
  const fail = spawnSync('node', [SLIM], { input: lossy, encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: asFile } });
  check('b4.4-stdin-spill-failure-passthrough', fail.stdout.trim() === lossy,
    `unspillable original → verbatim passthrough, not an unrecoverable slim: ${fail.stdout.length} B out of ${lossy.length}`);
  rmSync(blocked, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------- spill-TTL sweep (M5) --
// spillTtlHours contract: default 24, exactly 0 disables, ANY invalid/negative → 24 (never a
// past cutoff that would mass-delete fresh spills).
eq('ttl-default', T.spillTtlHours(undefined), 24);
eq('ttl-empty', T.spillTtlHours(''), 24);
eq('ttl-valid', T.spillTtlHours('12'), 12);
eq('ttl-fractional', T.spillTtlHours('0.5'), 0.5);
eq('ttl-zero-disables', T.spillTtlHours('0'), 0);
eq('ttl-nonnumeric', T.spillTtlHours('abc'), 24);
eq('ttl-negative', T.spillTtlHours('-5'), 24); // a negative TTL must not become "everything is old"

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
// The sweep's SECOND target (v0.64.1): the bundled playwright server's --output-dir, which lives in
// the PROJECT, not in the shared spill dir — the server resolves that relative flag against its own
// cwd. Reached only when sweepSpills() is handed a project dir, so the whole pass is opt-in.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-pw-'));
  const proj = mkdtempSync(path.join(tmpdir(), 'jslim-pwproj-'));
  const out = path.join(proj, H.PLAYWRIGHT_OUT_REL);
  mkdirSync(path.join(out, 'session-1'), { recursive: true });
  const seed = (rel, old) => { const f = path.join(out, rel); writeFileSync(f, 'x'); if (old) utimesSync(f, 1000, 1000); return f; };
  const stale = seed('page-1970.png', true);
  const nested = seed('session-1/console-1970.log', true); // playwright nests per-session dirs
  const fresh = seed('page-now.yml', false);
  const r = J.sweepSpills(dir, proj);
  check('pw-stale-deleted', !existsSync(stale), 'a stale playwright artefact must be pruned');
  check('pw-nested-deleted', !existsSync(nested), 'the pass must recurse into per-session subdirs');
  check('pw-fresh-kept', existsSync(fresh), 'a fresh artefact must survive (mtime, not a blanket rm)');
  check('pw-dir-kept', existsSync(path.join(out, 'session-1')), 'directories are left standing — a live session may own one');
  check('pw-summary', r.swept === 2, `both pruned files must count in the summary ${JSON.stringify(r)}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}
// A project playwright never wrote in is the common case: no dir, no error, no work.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-pw-none-'));
  const proj = mkdtempSync(path.join(tmpdir(), 'jslim-pwproj-none-'));
  const r = J.sweepSpills(dir, proj);
  check('pw-missing-noop', r.swept === 0 && !r.disabled && !r.throttled, `missing output dir must be a no-op ${JSON.stringify(r)}`);
  check('pw-missing-nomkdir', !existsSync(path.join(proj, '.claude')), 'the sweep must not CREATE the scratch dir');
  rmSync(dir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}
// The throttle lives in a marker file inside the spill root, and the root is never CREATED here (a
// typo'd FND_MCP_SLIM_DIR must not grow a tree). So when the marker cannot be claimed the window can
// never close, and the project pass — a recursive walk plus two git forks — would run on EVERY hook
// invocation. The observable: with an unwritable spill root the stale artefact simply survives, on
// the second call as on the first.
{
  const proj = mkdtempSync(path.join(tmpdir(), 'jslim-pwproj-nospill-'));
  const out = path.join(proj, H.PLAYWRIGHT_OUT_REL);
  mkdirSync(out, { recursive: true });
  const stale = path.join(out, 'page-1970.png'); writeFileSync(stale, 'x'); utimesSync(stale, 1000, 1000);
  const missing = path.join(tmpdir(), 'jslim-does-not-exist-' + Date.now());
  const r1 = J.sweepSpills(missing, proj);
  const r2 = J.sweepSpills(missing, proj);
  check('pw-unclaimed-marker-skips', existsSync(stale) && r1.swept === 0 && r2.swept === 0,
    `an unclaimable throttle marker must not leave the project pass running unthrottled ${JSON.stringify([r1, r2])}`);
  check('pw-nospill-nomkdir', !existsSync(missing), 'the sweep must never create the spill root');
  rmSync(proj, { recursive: true, force: true });
}
// Symlinks are not followed on the way IN: the walk deletes by mtime with no name filter, so a
// symlinked component would aim it at the link's target. The plugin's own worktree flow symlinks
// `<wt>/.claude/tasks`, so a part-symlinked `.claude` subtree is a live shape, not a hypothetical.
for (const [label, linkAt] of [['playwright', H.PLAYWRIGHT_OUT_REL], ['dotclaude', '.claude']]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-pwlink-'));
  const proj = mkdtempSync(path.join(tmpdir(), 'jslim-pwlinkproj-'));
  const victim = mkdtempSync(path.join(tmpdir(), 'jslim-pwvictim-'));
  // The victim carries the same shape the sweep expects to find, so only the lstat rail can save it.
  mkdirSync(path.join(victim, '.claude/fnd-tmp/playwright'), { recursive: true });
  const keep = path.join(victim, '.claude/fnd-tmp/playwright/page-1970.png');
  writeFileSync(keep, 'x'); utimesSync(keep, 1000, 1000);
  const link = path.join(proj, linkAt);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(path.join(victim, linkAt), link, 'dir');
  const r = J.sweepSpills(dir, proj);
  check(`pw-symlink-${label}-skipped`, existsSync(keep) && r.swept === 0,
    `a symlinked path component must skip the pass, not redirect it ${JSON.stringify(r)}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  rmSync(victim, { recursive: true, force: true });
}

// ensureFndTmpExcluded: keep the scratch root out of `git status` without touching the client's
// TRACKED .gitignore. Best-effort — every branch below must stay silent and never throw.
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const gitInit = (d) => spawnSync('git', ['init', '-q', d], { encoding: 'utf8' }).status === 0;
if (gitOk) {
  {
    const proj = mkdtempSync(path.join(tmpdir(), 'jslim-excl-'));
    gitInit(proj);
    const excl = path.join(proj, '.git/info/exclude');
    H.ensureFndTmpExcluded(proj);
    const body = readFileSync(excl, 'utf8');
    const hits = body.split('\n').filter((l) => l.trim() === '/.claude/fnd-tmp/').length;
    check('excl-appended', hits === 1, `exactly one exclude line expected, got ${hits}`);
    H.ensureFndTmpExcluded(proj);
    const hits2 = readFileSync(excl, 'utf8').split('\n').filter((l) => l.trim() === '/.claude/fnd-tmp/').length;
    check('excl-idempotent', hits2 === 1, `a second call must not append again, got ${hits2}`);
    rmSync(proj, { recursive: true, force: true });
  }
  // The stamp is ANCHORED at the repo root, but the session's project dir may sit deeper in the repo
  // (`cd packages/theme && claude`). An unprefixed `/.claude/fnd-tmp/` would then match nothing — and
  // the "already stamped" scan would keep the correct line out forever. git's own verdict is the
  // assertion that matters here; the literal is only how it gets there.
  {
    const proj = mkdtempSync(path.join(tmpdir(), 'jslim-excl-sub-'));
    gitInit(proj);
    const rel = 'packages/theme';
    mkdirSync(path.join(proj, rel, '.claude/fnd-tmp'), { recursive: true });
    H.ensureFndTmpExcluded(path.join(proj, rel));
    const body = readFileSync(path.join(proj, '.git/info/exclude'), 'utf8');
    check('excl-subdir-prefixed', body.split('\n').some((l) => l.trim() === `/${rel}/.claude/fnd-tmp/`),
      `the stamp must carry the project's prefix inside the repo: ${JSON.stringify(body)}`);
    const ci = spawnSync('git', ['check-ignore', '-q', `${rel}/.claude/fnd-tmp`], { cwd: proj, encoding: 'utf8' });
    check('excl-subdir-ignored', ci.status === 0, `git must actually ignore the stamped dir, status ${ci.status}`);
    // …and a second call adds nothing — the stamp it just wrote is now git's own answer.
    H.ensureFndTmpExcluded(path.join(proj, rel));
    const hits = readFileSync(path.join(proj, '.git/info/exclude'), 'utf8')
      .split('\n').filter((l) => l.trim() === `/${rel}/.claude/fnd-tmp/`).length;
    check('excl-subdir-idempotent', hits === 1, `a second call must not append again, got ${hits}`);
    rmSync(proj, { recursive: true, force: true });
  }
  // An exclude file whose last byte is not a newline is legal and not rare (hand-edited ones often
  // are); appending blind would glue our pattern onto the developer's last one, breaking both.
  {
    const proj = mkdtempSync(path.join(tmpdir(), 'jslim-excl-nonl-'));
    gitInit(proj);
    const excl = path.join(proj, '.git/info/exclude');
    writeFileSync(excl, '# mine\nscratch.txt');
    H.ensureFndTmpExcluded(proj);
    const lines = readFileSync(excl, 'utf8').split('\n');
    check('excl-bridges-newline', lines.includes('scratch.txt') && lines.includes('/.claude/fnd-tmp/'),
      `the developer's last pattern must survive intact: ${JSON.stringify(lines)}`);
    rmSync(proj, { recursive: true, force: true });
  }
  // A repo that already ignores `.claude` its own way needs no stamp — check-ignore decides.
  {
    const proj = mkdtempSync(path.join(tmpdir(), 'jslim-excl-ignored-'));
    gitInit(proj);
    writeFileSync(path.join(proj, '.gitignore'), '.claude\n');
    H.ensureFndTmpExcluded(proj);
    const body = readFileSync(path.join(proj, '.git/info/exclude'), 'utf8');
    check('excl-skips-ignored', !body.includes('fnd-tmp'), 'no line may be added when git already ignores the dir');
    rmSync(proj, { recursive: true, force: true });
  }
}
// No repo (and, on a host without git, no git either) → nothing to exclude from, and no throw.
{
  const proj = mkdtempSync(path.join(tmpdir(), 'jslim-excl-nogit-'));
  let threw = false;
  try { H.ensureFndTmpExcluded(proj); } catch (_) { threw = true; }
  check('excl-nogit-silent', !threw && !existsSync(path.join(proj, '.git')), 'outside a repo the stamp is a silent no-op');
  rmSync(proj, { recursive: true, force: true });
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
  const out = spawnSync('node', [SLIM], { input: inp, encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir } }).stdout;
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
  check('slim-stages-subset', r.stages.every((s) => ['adf', 'noise', 'truncate', 'crush'].includes(s)), `unexpected stage in ${JSON.stringify(r.stages)}`);
  eq('slim-stages-off-empty', J.slim(readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8')).stages, []); // trace off ⇒ no bookkeeping
  eq('slim-nonjson-reason', J.slim('plain text, not json').reason, 'non-json');
  eq('slim-nonjson-stages', J.slim('plain text, not json').stages, []);
  eq('slim-error-reason', J.slim(JSON.stringify({ errors: [{ message: 'boom' }] })).reason, 'error-shape');
  check('slim-ok-no-reason', J.slim(JSON.stringify({ a: 1 })).reason === undefined, 'a compressible-shape result carries no reason');
}

// ---------------------------------------------------------------- debug log (M6) --
// debugEnabled(): only 1/true/yes/on turns it on; unset / 0 / false → off (zero side effects).
// debugLevel() (B4.10c) splits that into 1 = key events, ≥2 = everything incl. sub-gate lines.
{
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  const set = (v) => { if (v === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = v; };
  set(undefined); check('dbg-enabled-unset', T.debugEnabled() === false, 'unset → off');
  set('1');       check('dbg-enabled-1', T.debugEnabled() === true, '1 → on');
  set('true');    check('dbg-enabled-true', T.debugEnabled() === true, 'true → on');
  set('0');       check('dbg-enabled-0', T.debugEnabled() === false, '0 → off');
  set('false');   check('dbg-enabled-false', T.debugEnabled() === false, 'false → off');
  // Any integer ≥ 2 must mean the full feed — never off.
  set(undefined); check('b4.10c-level-unset', T.debugLevel() === 0, 'unset → level 0');
  set('0');       check('b4.10c-level-0', T.debugLevel() === 0, '0 → level 0');
  set('1');       check('b4.10c-level-1', T.debugLevel() === 1, '1 → level 1');
  set('true');    check('b4.10c-level-true', T.debugLevel() === 1, 'true → level 1');
  set('on');      check('b4.10c-level-on', T.debugLevel() === 1, 'on → level 1');
  set('2');       check('b4.10c-level-2', T.debugLevel() === 2 && T.debugEnabled() === true, '2 → level 2 (and still enabled)');
  set(' 2 ');     check('b4.10c-level-2-padded', T.debugLevel() === 2, 'whitespace-padded 2 → level 2');
  set('3');       check('b4.10c-level-3', T.debugLevel() === 2, 'any integer ≥2 → the full feed, never off');
  set('verbose'); check('b4.10c-level-junk', T.debugLevel() === 0, 'an unknown value → off (never a partial feed)');
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
  // NOT a `size-gate` record: at level 1 that sub-gate reason is filtered out (B4.10c).
  J.debugLog({ entry: 'cli', decision: 'passthrough', reason: 'no-gain' }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const lines = readFileSync(logp, 'utf8').trim().split('\n');
  check('dbg-two-lines', lines.length === 2, `got ${lines.length} lines`);
  const first = JSON.parse(lines[0]);
  check('dbg-line-shape', first.entry === 'cli' && first.decision === 'compressed' && typeof first.ts === 'string', `line ${lines[0]}`);
  rmSync(dir, { recursive: true, force: true });
}

// B4.10c: the verbosity split, decided on the FINAL `reason` — never on the emitting branch. The
// platform-overflow (missed-whale) event comes out of the very same sub-gate branch in the hook, and
// it is the one number the MAX_MCP_OUTPUT_TOKENS decision rests on, so it must always be logged.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-subgate-'));
  const logp = path.join(dir, 'fnd-mcp-slim-debug.log');
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  process.env.FND_MCP_SLIM_DEBUG = '1';
  J.debugLog({ entry: 'hook', decision: 'passthrough', reason: 'size-gate', bytes_in: 900, bytes_out: 900 }, dir);
  check('b4.10c-subgate-quiet-at-1', !existsSync(logp), 'a size-gate record at level 1 must not even create the log');
  J.debugLog({ entry: 'hook', decision: 'passthrough', reason: 'platform-overflow', spill: '/p/tool-results/w.txt' }, dir);
  J.debugLog({ entry: 'hook', decision: 'compressed', bytes_in: 900, bytes_out: 100 }, dir);
  J.debugLog({ entry: 'hook', decision: 'stubbed', reason: 'weak-gain' }, dir);
  const at1 = readFileSync(logp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('b4.10c-key-events-at-1', at1.length === 3 && at1[0].reason === 'platform-overflow' && at1[0].spill === '/p/tool-results/w.txt',
    `level 1 must keep every key event: ${JSON.stringify(at1.map((l) => l.reason))}`);
  process.env.FND_MCP_SLIM_DEBUG = '2';
  J.debugLog({ entry: 'hook', decision: 'passthrough', reason: 'size-gate', bytes_in: 900, bytes_out: 900 }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const at2 = readFileSync(logp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('b4.10c-subgate-at-2', at2.length === 4 && at2[3].reason === 'size-gate', `level 2 must log the sub-gate line: ${at2.length} lines`);
  // B4.11: each line carries the level it was COLLECTED at, so a file that straddles the switch — the
  // documented "flip to 2, investigate, flip back" workflow — can still be read apart. Inferring it from
  // the reasons present cannot: a =2 log whose results all exceeded the gate holds no size-gate line.
  check('b4.11-lvl-per-line', at2.slice(0, 3).every((l) => l.lvl === 1) && at2[3].lvl === 2,
    `each line must carry its collection level: ${JSON.stringify(at2.map((l) => l.lvl))}`);
  rmSync(dir, { recursive: true, force: true });
}

// B4.10a: `spills` is deduped and CAPPED in debugLog — a payload with many crushable arrays writes one
// spill per array, and an uncapped list would grow a single line toward the rotation threshold. An
// EMPTY list is dropped: "this run left nothing on disk" is the absence of the field.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-spilllog-'));
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  process.env.FND_MCP_SLIM_DEBUG = '1';
  const many = Array.from({ length: 12 }, (_, i) => `/tmp/fnd-crush-${i}.json`);
  J.debugLog({ entry: 'hook', decision: 'compressed', spills: many }, dir);
  J.debugLog({ entry: 'hook', decision: 'compressed', spills: ['/tmp/fnd-crush-a.json', '/tmp/fnd-crush-a.json'] }, dir);
  J.debugLog({ entry: 'hook', decision: 'passthrough', reason: 'no-gain', spills: [] }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const lines = readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('b4.10a-spills-capped', lines[0].spills.length === 8 && lines[0].spills_n === 12, `capped list + total: ${JSON.stringify(lines[0].spills)} n=${lines[0].spills_n}`);
  check('b4.10a-spills-deduped', lines[1].spills.length === 1 && lines[1].spills_n === undefined, `one path twice must log once: ${JSON.stringify(lines[1])}`);
  check('b4.10a-spills-empty-dropped', lines[2].spills === undefined && lines[2].spills_n === undefined, `an empty list must not be logged: ${JSON.stringify(lines[2])}`);
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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FND_MCP_SLIM_DIR: dir, FND_MCP_SLIM_DEBUG: '1' } });
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

// `project` on EVERY debug line (M8), added centrally in debugLog(); `format` rides through from the
// caller's record and lands verbatim in the JSONL line. The expectation is the LITERAL repo name: this
// suite always runs against the repo it lives in, so the B4.10b walk must resolve to it whatever the
// cwd or an ambient CLAUDE_PROJECT_DIR says. (Re-deriving it from the resolver's own algorithm would
// pass under any resolver, including the basename(cwd) one B4.10b replaced — the resolver's branches are
// pinned in the `b4.10b-*` block below.)
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m8proj-'));
  const prev = process.env.FND_MCP_SLIM_DEBUG;
  process.env.FND_MCP_SLIM_DEBUG = '1';
  J.debugLog({ entry: 'cli', decision: 'compressed' }, dir);
  J.debugLog({ entry: 'cli', decision: 'passthrough', reason: 'non-json', format: 'xml' }, dir);
  if (prev === undefined) delete process.env.FND_MCP_SLIM_DEBUG; else process.env.FND_MCP_SLIM_DEBUG = prev;
  const lines = readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const proj = path.basename(ROOT);
  check('m8-project-every-line', lines.length === 2 && lines.every((l) => l.project === proj), `project missing/wrong: ${JSON.stringify(lines.map((l) => l.project))}`);
  // B4.11: the collection level rides on every line too — `--report` reads it instead of guessing from
  // the reasons it happens to see.
  check('b4.11-lvl-on-every-line', lines.every((l) => l.lvl === 1), `lvl missing/wrong: ${JSON.stringify(lines.map((l) => l.lvl))}`);
  check('m8-format-in-line', lines[1].format === 'xml', `format not carried into the JSONL line: ${JSON.stringify(lines[1])}`);
  check('m8-format-absent-when-omitted', lines[0].format === undefined, `compressed line must carry no format: ${JSON.stringify(lines[0])}`);
  rmSync(dir, { recursive: true, force: true });
}

// B4.10b: the `project` tag resolver — the nearest `.git` ANCESTOR walking up from the cwd wins, else
// CLAUDE_PROJECT_DIR, else the cwd's own basename. Live logs attributed 154 of 476 events to
// `scratchpad`/`tmp` because the tag was basename(cwd) alone. The WALK leads because it is the only rule
// both entry points can run: Claude Code exports CLAUDE_PROJECT_DIR to hooks but not to the Bash tool, so
// env-first tagged one session's hook and CLI lines differently. Every case runs in a CHILD with an
// explicit cwd + env (an ambient CLAUDE_PROJECT_DIR would mask the walk, and a child also proves the
// in-process memo cannot leak between cases).
{
  const base = mkdtempSync(path.join(tmpdir(), 'jslim-proj-'));
  const gitFileRepo = path.join(base, 'worktree-repo');   // `.git` as a FILE (worktree/submodule form)
  const gitDirRepo = path.join(base, 'plain-repo');       // `.git` as a directory
  // The cwd-basename fallback needs a cwd with NO `.git` above it, which a shared tmpdir cannot promise
  // (a TMPDIR inside a dotfiles/$HOME repo would resolve to that repo and the case could never be
  // established — it went red on exactly that setup). Nesting deeper than PROJECT_WALK_MAX ends the walk
  // by exhaustion instead, which is the same branch and depends on nothing above `base`.
  const orphan = path.join(base, 'no-repo-here', ...Array(65).fill('n'), 'deep');
  mkdirSync(path.join(gitFileRepo, 'a', 'scratchpad'), { recursive: true });
  mkdirSync(path.join(gitDirRepo, '.git'), { recursive: true });
  mkdirSync(path.join(gitDirRepo, 'sub'), { recursive: true });
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(gitFileRepo, '.git'), 'gitdir: /elsewhere/.git/worktrees/w\n');
  const tagFrom = (cwd, env) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jslim-projlog-'));
    const childEnv = { ...process.env, FND_MCP_SLIM_DEBUG: '1' };
    delete childEnv.CLAUDE_PROJECT_DIR; // ambient value would mask every walk case
    Object.assign(childEnv, env || {});
    execFileSync('node', ['-e',
      `require(${JSON.stringify(SLIM)}).debugLog({entry:'cli',decision:'passthrough',reason:'no-gain'},${JSON.stringify(dir)})`],
      { cwd, env: childEnv, encoding: 'utf8' });
    const tag = JSON.parse(readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim()).project;
    rmSync(dir, { recursive: true, force: true });
    return tag;
  };
  // The repo the cwd sits in beats the env var: the CLI never receives CLAUDE_PROJECT_DIR, so a hook that
  // preferred it tagged the same session's lines with a different name (a monorepo launched in a subdir
  // logged `web` from the hook and `myrepo` from the CLI — up to three buckets for one repo).
  eq('b4.10b-git-beats-env', tagFrom(path.join(gitFileRepo, 'a', 'scratchpad'), { CLAUDE_PROJECT_DIR: path.join(base, 'chosen-project') }), 'worktree-repo');
  eq('b4.10b-env-fallback-no-git', tagFrom(orphan, { CLAUDE_PROJECT_DIR: path.join(base, 'chosen-project') }), 'chosen-project');
  eq('b4.10b-env-trailing-slash', tagFrom(orphan, { CLAUDE_PROJECT_DIR: `${path.join(base, 'chosen-project')}${path.sep}` }), 'chosen-project');
  eq('b4.10b-env-blank-ignored', tagFrom(path.join(gitDirRepo, 'sub'), { CLAUDE_PROJECT_DIR: '   ' }), 'plain-repo');
  eq('b4.10b-git-file-ancestor', tagFrom(path.join(gitFileRepo, 'a', 'scratchpad')), 'worktree-repo');
  eq('b4.10b-git-dir-ancestor', tagFrom(path.join(gitDirRepo, 'sub')), 'plain-repo');
  eq('b4.10b-git-root-itself', tagFrom(gitDirRepo), 'plain-repo');
  eq('b4.10b-no-git-cwd-basename', tagFrom(orphan), 'deep');
  rmSync(base, { recursive: true, force: true });
}

// ============================================ B4.10a — content-addressed spills + spill sink ==
// Two telemetry defects, both measured on the live debug log: (1) the crush / jsx-id-map spill paths
// were never logged, so "did this run orphan a file?" was unanswerable; (2) UUID names meant 23
// distinct payloads produced 1030 files / 307 MB per TTL window.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-wsp-'));
  const a = J.writeSpill(dir, 'fnd-crush-', 'hello');
  const b = J.writeSpill(dir, 'fnd-crush-', 'hello');
  check('b4.10a-writespill-name', !!a && /^fnd-crush-[0-9a-f]{16}\.json$/.test(path.basename(a.path)) && path.dirname(a.path) === dir,
    `content-hash name: ${a && a.path}`);
  check('b4.10a-writespill-dedup', !!a && !!b && a.path === b.path && a.created === true && b.created === false && readdirSync(dir).length === 1,
    `identical content must reuse one file: ${JSON.stringify(readdirSync(dir))}`);
  // The sweep prunes by MTIME, so a reused spill must be touched or it can expire while a fresh
  // `full=` handle names it.
  const old = Date.now() / 1000 - 3 * 24 * 3600;
  utimesSync(a.path, old, old);
  J.writeSpill(dir, 'fnd-crush-', 'hello');
  check('b4.10a-writespill-mtime-refresh', statSync(a.path).mtimeMs > Date.now() - 60000,
    `a reused spill must be re-dated: mtime ${new Date(statSync(a.path).mtimeMs).toISOString()}`);
  // A same-name file of a DIFFERENT size (a hash collision, or the 0-byte truncation this repo
  // already hit once) is never overwritten and never handed back as if it were ours.
  writeFileSync(a.path, 'hello world');
  const c = J.writeSpill(dir, 'fnd-crush-', 'hello');
  check('b4.10a-writespill-collision', !!c && c.path !== a.path && c.created === true &&
    readFileSync(a.path, 'utf8') === 'hello world' && readFileSync(c.path, 'utf8') === 'hello',
    `a size mismatch must take a distinct name: ${c && c.path}`);
  // …and the RETRY name is content-addressed too, so a poisoned base name (the 0-byte truncation above is
  // the real-world trigger) does not silently restore the one-file-per-call regression for that payload's
  // whole TTL window: five more calls must all land on the same second name.
  const retries = new Set();
  for (let i = 0; i < 5; i++) { const r = J.writeSpill(dir, 'fnd-crush-', 'hello'); retries.add(r && r.path); }
  check('b4.11-writespill-retry-dedups', retries.size === 1 && retries.has(c.path) &&
    readdirSync(dir).filter((f) => f.startsWith('fnd-crush-')).length === 2,
    `a poisoned base name must still dedup on the retry name: ${JSON.stringify([...retries])} / ${JSON.stringify(readdirSync(dir))}`);
  // A same-name/same-size file this user cannot READ is never deduped: statSync needs no read
  // permission (a shared-tmpdir neighbour's 0600 spill), so handing it back would put an unreadable
  // path behind a live handle — while the EPERM'd mtime refresh silently lets the sweep prune it.
  // Root reads through 000 modes, so the case only asserts for a non-root uid.
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    const locked = J.writeSpill(dir, 'fnd-mcp-slim-', 'locked');
    chmodSync(locked.path, 0o000);
    const l2 = J.writeSpill(dir, 'fnd-mcp-slim-', 'locked');
    check('b4.10a-writespill-unreadable-not-deduped', !!l2 && l2.created === true && l2.path !== locked.path,
      `an unreadable same-name/same-size file must not be handed back: ${JSON.stringify(l2)}`);
    chmodSync(locked.path, 0o600);
    check('b4.10a-writespill-unreadable-untouched', readFileSync(locked.path, 'utf8') === 'locked',
      'the foreign file is never modified');
  }
  check('b4.10a-writespill-no-tmp', readdirSync(dir).every((f) => !f.includes('.tmp-')), `a tmp file leaked: ${JSON.stringify(readdirSync(dir))}`);
  const notDir = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-wspf-')), 'a-file');
  writeFileSync(notDir, 'x');
  check('b4.10a-writespill-failure-null', J.writeSpill(path.join(notDir, 'sub'), 'fnd-crush-', 'hello') === null,
    'an unwritable spill dir must return null (the callers depend on the failure path)');
  rmSync(dir, { recursive: true, force: true });
}

// Dedup end-to-end: three identical slim() runs leave ONE spill file (pre-fix: three) and the
// `<<full=…>>` handle is byte-identical across them.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-dedup-'));
  const payload = JSON.stringify({ rows: errArray });
  const markers = [];
  for (let i = 0; i < 3; i++) {
    const out = J.slim(payload, { spillDir: dir }).output;
    markers.push(/<<full=[^>]+>>/.exec(out)[0]);
  }
  const files = () => readdirSync(dir).filter((f) => f.startsWith('fnd-crush-'));
  check('b4.10a-dedup-one-file', files().length === 1, `3 identical runs left ${files().length} spill files`);
  check('b4.10a-dedup-marker-stable', markers[0] === markers[1] && markers[1] === markers[2], `handles differ across runs: ${JSON.stringify(markers)}`);
  J.slim(JSON.stringify({ rows: errArray.map((r) => ({ ...r, msg: `${r.msg} v2` })) }), { spillDir: dir });
  check('b4.10a-dedup-distinct-payload', files().length === 2, `a different payload must add a file: ${JSON.stringify(files())}`);
  rmSync(dir, { recursive: true, force: true });
}

// The spill SINK: a caller-supplied array that collects every file this call wrote, so the hook/CLI
// debug line can name them. Not a DEFAULTS key on purpose — `{...DEFAULTS}` copies the array
// reference, so a default sink would accumulate paths for the whole process lifetime.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-sink-'));
  const sink = [];
  const r = J.slim(JSON.stringify({ rows: errArray }), { spillDir: dir, spillSink: sink });
  check('b4.10a-sink-crush', sink.length === 1 && existsSync(sink[0]) && path.basename(sink[0]).startsWith('fnd-crush-') &&
    r.output.includes(`full=${sink[0]}`), `the crush spill must reach the sink: ${JSON.stringify(sink)}`);
  check('b4.10a-sink-not-in-defaults', T.DEFAULTS.spillSink === undefined, 'spillSink must never be a DEFAULTS key (shared array reference)');
  // A fenced body's inner slim() gets `{...cfg, fence:false}` — the sink must survive that spread
  // (and every other one), or the fence path silently loses its spill paths. The subject is the SINK, so
  // the fence's byte WIN is deliberately not part of the assertion: this fixture wins by ~114 B, and the
  // `<<full=…>>` marker embeds the spill path, so a spill dir longer than 117 chars (a long TMPDIR on a
  // CI runner) flips wasModified while the sink stays correct. The fence win is pinned by the M11 cases.
  const fenceSink = [];
  const fenced = `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ rows: errArray })}\n\`\`\``;
  J.slim(fenced, { spillDir: dir, spillSink: fenceSink });
  check('b4.10a-sink-through-fence', fenceSink.length === 1 && existsSync(fenceSink[0]) &&
    path.basename(fenceSink[0]).startsWith('fnd-crush-'), `a fenced body's inner crush spill must reach the caller's sink: ${JSON.stringify(fenceSink)}`);
  // Gate A's own spill lands there too (the CLI's exit line then names every file it wrote).
  const capSink = [];
  const cap = T.capOutput({ output: JSON.stringify({ a: 'x'.repeat(200) }), bytesIn: 1000, bytesOut: 300, ratio: 0.7 },
    path.join(dir, 'src.json'), { cliOutCap: 50, spillDir: dir, spillSink: capSink });
  check('b4.10a-sink-gate-a', !!cap && capSink.length === 1 && capSink[0] === cap.spillOut, `Gate A's spill must reach the sink: ${JSON.stringify(capSink)}`);
  // A passthrough writes nothing, so the sink stays empty (an empty sink is what makes an ORPHAN
  // claim in the log meaningful).
  const quiet = [];
  J.slim('plain prose, not json at all', { spillDir: dir, spillSink: quiet });
  eq('b4.10a-sink-empty-on-passthrough', quiet, []);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- JSONL detection (M9) --
// A bulk-operation line stream (one JSON value per line) is a same-shape array — parseJsonl routes
// it into the normal pipeline instead of slim()'s non-json handback. Strict gate: every non-blank
// line an object/array, ≥2 rows; one failing line rejects the whole payload (a truncated bulk file
// falls back to the path handback — no partial salvage).
check('m9-jsonl-all-objects', (() => { const r = T.parseJsonl('{"id":1,"h":"a"}\n{"id":2,"h":"b"}\n{"id":3,"h":"c"}'); return Array.isArray(r) && r.length === 3 && r[0].id === 1; })(), 'all-object lines → rows');
check('m9-jsonl-array-rows', (() => { const r = T.parseJsonl('[1,2]\n[3,4]'); return Array.isArray(r) && r.length === 2; })(), 'object-or-array lines → rows (arrays count)');
check('m9-jsonl-prose-line-null', T.parseJsonl('{"id":1}\nnot json here\n{"id":2}') === null, 'one prose line among JSON → null');
check('m9-jsonl-bare-scalar-null', T.parseJsonl('42\ntrue\n7') === null, 'bare-scalar lines (42/true) → null, never swallowed as data');
check('m9-jsonl-bare-null-null', T.parseJsonl('{"id":1}\nnull\n{"id":2}') === null, 'a bare null line is not a data row → null');
check('m9-jsonl-single-line-null', T.parseJsonl('{"only":1}') === null, 'a single line → null (≥2 rows required)');
check('m9-jsonl-blank-only-null', T.parseJsonl('\n  \n\t\n') === null, 'no non-blank lines → null');
check('m9-jsonl-bom-trailing-blanks', (() => { const r = T.parseJsonl('\uFEFF{"id":1}\n{"id":2}\n\n   \n'); return Array.isArray(r) && r.length === 2; })(), 'BOM + trailing blank/whitespace lines → ok');

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
  const cap = T.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 100, spillDir: dir });
  check('m9b-capA-fires', !!cap && typeof cap.handback === 'string' && typeof cap.spillOut === 'string', `capOutput must fire over cap: ${JSON.stringify(cap)}`);
  check('m9b-capA-stats-line', /→ .*bytes/.test(cap.handback) && cap.handback.includes('30 rows kept'), `stats line / rows-kept missing:\n${cap.handback}`);
  check('m9b-capA-first-row', cap.handback.includes('first row') && cap.handback.includes('"id":0'), 'first-row shape sample missing');
  check('m9b-capA-both-paths', cap.handback.includes(cap.spillOut) && cap.handback.includes('/some/bulk.jsonl'), 'slimmed-spill + original path must both appear');
  // M12: the hint spells the SYNTAX (`<jq-path>`, not `<path>` — which read like a file path) and
  // carries a one-token example taken from the data (an array body → index `0`), now over a line
  // naming the grammar the evaluator accepts (M15) — a reader who only sees the handback still
  // learns that `[]`, `,` and `| keys` / `| length` are on the table.
  check('m9b-capA-jq-hint', cap.handback.includes('--jq <jq-path>') && cap.handback.includes('(e.g. --jq 0)')
    && /<jq-path>: dot paths \(\.a\.b, \.a\[0\]\), '\[\]' iteration, ',' multi-select, '\| keys' \/ '\| length'/.test(cap.handback),
    `--jq narrow hint missing/unreworded:\n${cap.handback}`);
  check('m9b-capA-spill-roundtrips', existsSync(cap.spillOut) && readFileSync(cap.spillOut, 'utf8') === output, 'spill must hold the exact slimmed output');
  check('m9b-capA-undercap-null', T.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 10_000_000, spillDir: dir }) === null, '≤ cap → null (caller prints the body unchanged)');
  check('m9b-capA-stdin-null', T.capOutput(res, null, { cliOutCap: 100, spillDir: dir }) === null, 'no fileArg (stdin) → null even over cap (no path to point at)');
  rmSync(dir, { recursive: true, force: true });
}
// spill-failure → null so the CLI falls back to printing (never lose the result)
{
  const badParent = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-capAro-')), 'not-a-dir');
  writeFileSync(badParent, 'x'); // a FILE — using it as a spill parent dir fails
  const output = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: i })));
  const res = { output, bytesIn: 999999, bytesOut: Buffer.byteLength(output), ratio: 0.9 };
  check('m9b-capA-spill-fail-null', T.capOutput(res, '/some/bulk.jsonl', { cliOutCap: 10, spillDir: path.join(badParent, 'sub') }) === null, 'a spill-write failure returns null → CLI prints the body (never lose the result)');
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
    return T.capOutput({ output, bytesIn: 500000, bytesOut: Buffer.byteLength(output), ratio: 0.9 }, '/some/in.json', { cliOutCap: 2, spillDir: dir });
  };
  for (const [label, obj] of [
    ['dotted', { 'weird.key': 1, b: 2 }],
    ['bracketed', { 'a[0]': 1, b: 2 }],
    ['spaced', { 'my key': 1 }],
    ['empty-key', { '': 1 }],
  ]) {
    const h = capFor(obj).handback;
    check(`m12-capA-no-bogus-example:${label}`, h.includes('--jq <jq-path>') && !h.includes('(e.g. --jq '),
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
  const p = T.profileLines(lines, { file: '/x/bulk.jsonl', bytes: 12345 });
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
  const p = T.profileLines(Array.from({ length: 1500 }, (_, i) => JSON.stringify({ v: `unique-${i}` })), {});
  check('m9b-prof-distinct-cap', p.keys.v.distinct === 1000 && p.keys.v.distinctCapped === true, `distinct cap: ${JSON.stringify(p.keys.v)}`);
}
// ARRAY-row JSONL (tuple rows, `[1,2,3]` per line) is legitimate bulk data — parseJsonl accepts object
// OR array rows, so profileFeed must too. Regression: arrays were counted as parseFailures → a valid
// array-row file profiled as rows:0/empty-keys. Now they profile by index-key ("0","1",…).
{
  const p = T.profileLines(['[1,2,3]', '[4,5,6]', '[7,8,9]'], { file: '/x/arr.jsonl' });
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
  const p = T.profileLines([line, line, line], { file: '/x/wide.jsonl' });
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
  const p = T.profileLines([line, line], { file: '/x/mega.jsonl' });
  const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
  check('m9b-prof-mega-key-cap', bytes <= 8000 && Object.keys(p.keys).length === 0 && p.keysTruncated === 2, `mega key collapses under cap: ${bytes} B, shown ${Object.keys(p.keys).length}, trunc ${p.keysTruncated}`);
}
// streamProfile over a real (small) file — the async path the CLI Gate B uses; O(samples) memory.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-prof-'));
  const f = path.join(dir, 'rows.jsonl');
  writeFileSync(f, Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: i, k: `v${i}` })).join('\n') + '\n');
  const p = await T.streamProfile(f);
  check('m9b-streamprofile', p.profile === true && p.rows === 12 && p.file === f && p.bytes > 0, `streamProfile: ${JSON.stringify({ rows: p.rows, file: p.file, bytes: p.bytes })}`);
  rmSync(dir, { recursive: true, force: true });
}
// The accumulator must be bounded in KEY COUNT and in per-key distinct BYTES, not just in what it
// EMITS. A JSONL whose rows each carry a fresh key name (an id-keyed map dumped row per line) built one
// Set per key name for the whole stream, and PROFILE_DISTINCT_CAP counted 1000 values without weighing
// them, so 1000 × 100 KB was retained whole. Both were OOMs on a real whale — the very file Gate B
// exists to make tractable.
{
  function* uniqueKeyRows(n) { for (let i = 0; i < n; i++) yield JSON.stringify({ ['k' + i]: `v${i}`, id: i }); }
  const p = T.profileLines(uniqueKeyRows(20000), { file: '/x/idmap.jsonl' });
  check('b4.2-prof-key-build-cap',
    p.rows === 20000 && Object.keys(p.keys).length <= 200 && p.keysTruncatedAtLeast > 0 && p.keysCapped === true,
    `unbounded key set: rows=${p.rows} shown=${Object.keys(p.keys).length} trunc=${p.keysTruncatedAtLeast} capped=${p.keysCapped}`);
  // Past the build cap the dropped-key count saturates at (build cap − shown), so the exact field would
  // tell a reader of a 20,000-key dump that 266 keys were dropped. The profile is the ONLY artifact a
  // JSONL whale ever puts in context, so the number has to name itself as a floor.
  check('dr2-prof-key-floor-named', p.keysTruncated === undefined && p.keysTruncatedAtLeast === 400 - Object.keys(p.keys).length,
    `a capped count must be emitted as a floor, never as an exact total: ${JSON.stringify({ exact: p.keysTruncated, floor: p.keysTruncatedAtLeast })}`);
  // Below the build cap the key set is EXACT, so a wide-but-finite row keeps reporting an exact count.
  const wide = {}; for (let i = 0; i < 200; i++) wide[`key_${i}`] = i;
  const pw = T.profileLines([JSON.stringify(wide)], {});
  check('b4.2-prof-key-cap-exact-below-build', pw.keysCapped === undefined,
    `a 200-key row is under the build cap — no floor flag: ${JSON.stringify(pw.keysCapped)}`);
}
// 50 distinct 4 KB values are 200 KB of retained strings under a count cap of 1000 — the byte budget
// must cap them and SAY it did (distinct then reads as a floor, like keysTruncated).
{
  const p = T.profileLines(Array.from({ length: 50 }, (_, i) => JSON.stringify({ v: `${'x'.repeat(4096)}${i}` })), {});
  check('b4.2-prof-distinct-bytes', p.keys.v.distinct < 50 && p.keys.v.distinctCapped === true,
    `fat values must byte-cap the distinct set: ${JSON.stringify({ distinct: p.keys.v.distinct, capped: p.keys.v.distinctCapped })}`);
}
// The memory envelope itself, asserted the only non-flaky way: a CHILD with a 64 MB heap ceiling, where
// the unbounded accumulator aborts (exit 134, "heap out of memory") instead of profiling. Rows are
// generated lazily so the OOM can only come from the accumulator, never from the input array.
{
  const boundedProfile = (gen, n) => spawnSync('node', ['--max-old-space-size=64', '-e',
    `const J=require(${JSON.stringify(SLIM)}).__test;function*g(){${gen}}` +
    `const p=J.profileLines(g(),{});process.stdout.write(String(p.rows))`], { encoding: 'utf8', maxBuffer: 1 << 20 });
  const keys = boundedProfile(`for(let i=0;i<${20e4};i++)yield JSON.stringify({['k'+i]:'v'+i,id:i});`);
  check('b4.2-prof-mem-keys', keys.status === 0 && keys.stdout === '200000',
    `200k unique-key rows must profile in 64 MB: status=${keys.status} ${String(keys.stderr).split('\n')[0]}`);
  const fat = boundedProfile(`const s='x'.repeat(1e5);for(let i=0;i<1000;i++)yield JSON.stringify({v:s+i});`);
  check('b4.2-prof-mem-distinct', fat.status === 0 && fat.stdout === '1000',
    `1000 × 100 KB distinct values must profile in 64 MB: status=${fat.status} ${String(fat.stderr).split('\n')[0]}`);
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
check('log-detect-pytest', L.detectLog(['=== FAILURES ===', 'FAILED tests/test_a.py::test_x', '    assert 1 == 2', '=== ERRORS ===', 'ERROR tests/test_b.py', '1 failed, 2 passed'].join('\n')).isLog, 'pytest output → log');
check('log-detect-npm', L.detectLog(mkLog('npm ERR! code ELIFECYCLE', 10)).isLog, 'npm output → log');
check('log-detect-console-spam', L.detectLog(mkLog('[WARNING] slow frame skipped', 20)).isLog, 'console WARN spam → log');
check('log-detect-markdown-not', !L.detectLog(['## Heading', '', 'A paragraph of ordinary documentation prose describing an API.', 'Another sentence with a `code` span and a [link](http://x).', '', '- bullet one', '- bullet two', '', 'Closing remarks with no build keywords at all.'].join('\n')).isLog, 'markdown docs → NOT log');
check('log-detect-docs-chunk-not', !L.detectLog(['## Fetching products', '', 'Use the products connection to page through a catalogue. Each edge exposes a cursor.', '```graphql', 'query { products(first: 10) { edges { node { id } } } }', '```', 'Pagination is cursor-based; keep requesting until hasNextPage is false.'].join('\n')).isLog, 'shopify docs-chunk → NOT log');
check('log-detect-prose-not', !L.detectLog('The quick brown fox jumps over the lazy dog. '.repeat(30)).isLog, 'prose → NOT log');
check('log-detect-xml-not', !L.detectLog('<frame id="1">' + '<node x="1"/>'.repeat(50) + '</frame>').isLog, 'figma XML → NOT log');
// ratio boundary: 3 rule-lines in 10 (ratio 0.3, no error hits) → conf 0.45 < 0.5; 4 in 10 → conf 0.5
{
  const belowLines = ['===', '===', '==='].concat(Array.from({ length: 7 }, (_, i) => `plain text ${i}`));
  const aboveLines = ['===', '===', '===', '==='].concat(Array.from({ length: 6 }, (_, i) => `plain text ${i}`));
  check('log-detect-conf-below', !L.detectLog(belowLines.join('\n')).isLog, `conf ${L.detectLog(belowLines.join('\n')).confidence.toFixed(3)} must be < 0.5`);
  check('log-detect-conf-above', L.detectLog(aboveLines.join('\n')).isLog, `conf ${L.detectLog(aboveLines.join('\n')).confidence.toFixed(3)} must be ≥ 0.5`);
  // ratio gate: 1 match in 20 lines → ratio 0.05 < 0.1 → not a log regardless of the base 0.3
  check('log-detect-ratio-gate', !L.detectLog(['ERROR boom'].concat(Array.from({ length: 19 }, (_, i) => `text ${i}`)).join('\n')).isLog, 'ratio < 0.1 → NOT log');
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
  check('log-detect-prose-mentions-not', !L.detectLog(doc).isLog, `55-line error-discussing doc must NOT detect as log (conf ${L.detectLog(doc).confidence.toFixed(3)})`);
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
  check('log-detect-lowercase-levels', L.detectLog(cargo.join('\n')).isLog, 'lowercase cargo/gcc levels still detect as log');
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
  const uw = T.unwrapFence(wrapped);
  check('m11-unwrap-body', uw && uw.body === payload, 'dominant fence → body is the payload verbatim');
  check('m11-unwrap-preamble', uw && uw.preamble === 'Script ran on page and returned:', `preamble kept: ${JSON.stringify(uw && uw.preamble)}`);
  check('m11-unwrap-offset', uw && uw.offset === 2, `offset = physical lines before the body (prose + fence = 2), got ${uw && uw.offset}`);
  // no-preamble fence (opening fence is line 0) → empty preamble, offset 1
  const uw0 = T.unwrapFence(`\`\`\`json\n${payload}\n\`\`\``);
  check('m11-unwrap-no-preamble', uw0 && uw0.preamble === '' && uw0.offset === 1, `no-preamble: preamble=${JSON.stringify(uw0 && uw0.preamble)} offset=${uw0 && uw0.offset}`);
  // dominance guard — a docs chunk whose code block is a MINORITY of bytes → null (byte-identical doc)
  const doc = ['## Fetching products', '', 'Use the products connection to page through a catalogue. Each edge exposes a cursor and a node.', '```graphql', 'query { products(first: 10) { edges { node { id } } } }', '```', 'Pagination is cursor-based; keep requesting until hasNextPage is false. See the reference.'].join('\n');
  check('m11-dominance-guard', T.unwrapFence(doc) === null, 'a small code block in a doc is not dominant → null');
  // unterminated fence → null (old behavior); tilde fence → null (unsupported, no crash); long trailer → null
  check('m11-unterminated', T.unwrapFence(`intro\n\`\`\`json\n${payload}`) === null, 'no closing fence → null');
  check('m11-tilde-null', T.unwrapFence(`intro\n~~~json\n${payload}\n~~~`) === null, 'tilde fence → null (no crash)');
  check('m11-long-trailer', T.unwrapFence(`\`\`\`json\n${payload}\n\`\`\`\na\nb\nc\nd\ne`) === null, 'a long trailer → not a single dominant fence → null');
  // opening fence past the preamble window → null (a deep-in-a-doc fence is never unwrapped)
  check('m11-preamble-window', T.unwrapFence(`a\nb\nc\nd\n\`\`\`json\n${payload}\n\`\`\``) === null, 'opening fence after the preamble window → null');

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
  const cap = T.capOutput(capRes, path.join(capDir, 'whale.txt'), { cliOutCap: 50, spillDir: capDir });
  check('m11-cap-spill-valid-json', !!cap && (() => { try { return Array.isArray(JSON.parse(readFileSync(cap.spillOut, 'utf8')).products); } catch { return false; } })(), 'Gate-A spill of a fenced result is valid JSON (body only, preamble stripped)');
  check('m11-cap-sample-real', !!cap && /(shape|first row): \{/.test(cap.handback) && !cap.handback.includes('(none)'), `handback samples a real row, not (none): ${cap && cap.handback.split('\n').find((l) => /shape|first row/.test(l))}`);
  check('m11-cap-preamble-top', !!cap && cap.handback.startsWith('Script ran on page and returned:\n'), 'the tool prose preamble rides on top of the Gate-A handback');
  check('m11-cap-trailer-kept', !!cap && cap.handback.includes('NOTE: truncated.'), 'the fenced trailer rides on the Gate-A handback');
  // a NON-fenced result: capOutput spills res.output unchanged (no regression), no preamble line
  const plainRes = J.slim(JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, note: 'y'.repeat(60) }))), { spillDir: capDir });
  const capPlain = T.capOutput(plainRes, path.join(capDir, 'plain.json'), { cliOutCap: 50, spillDir: capDir });
  check('m11-cap-plain-unchanged', !!capPlain && readFileSync(capPlain.spillOut, 'utf8') === plainRes.output && !/^\n/.test(capPlain.handback), 'a non-fenced result still spills res.output verbatim, no preamble prepended');
  rmSync(capDir, { recursive: true, force: true });

  // A CRLF-delimited fence still unwraps and compresses (the fence regex tolerates a trailing \r).
  const crlf = `Script ran on page and returned:\r\n\`\`\`json\r\n${payload}\r\n\`\`\``;
  const uwc = T.unwrapFence(crlf);
  check('m11-crlf-unwrap', !!uwc && (() => { try { return Array.isArray(JSON.parse(uwc.body).products); } catch { return false; } })(), 'CRLF-delimited fence unwraps, body parses');
  const rcrlf = J.slim(crlf, { trace: true });
  check('m11-crlf-compresses', rcrlf.wasModified && rcrlf.stages[0] === 'fence' && rcrlf.stages.includes('crush'), `CRLF fenced JSON compresses via the fence branch: ${JSON.stringify(rcrlf.stages)}`);

  // A substantive trailer after the closing fence is captured and carried into the output; a
  // bare trailing newline is NOT a trailer.
  const withTrailer = `Result:\n\`\`\`json\n${payload}\n\`\`\`\nNOTE: truncated at 40 rows.`;
  const uwt = T.unwrapFence(withTrailer);
  check('m11-trailer-captured', !!uwt && uwt.trailer === 'NOTE: truncated at 40 rows.', `trailer captured: ${JSON.stringify(uwt && uwt.trailer)}`);
  const rt = J.slim(withTrailer);
  check('m11-trailer-in-output', rt.wasModified && rt.output.endsWith('NOTE: truncated at 40 rows.'), 'trailer carried into the compressed output');
  const uwn = T.unwrapFence(`Result:\n\`\`\`json\n${payload}\n\`\`\`\n`);
  check('m11-trailing-newline-not-trailer', !!uwn && uwn.trailer === '', `a bare final newline is not a trailer: ${JSON.stringify(uwn && uwn.trailer)}`);

  // Offset-aware stream profiling (Gate B): skipLeading + fenceAware skip the fence wrapper so a
  // fenced JSONL whale profiles only its real rows (parseFailures 0), matching the ≤8 MB unwrap path.
  // Without the opts the raw stream counts the wrapper lines as parse failures — the contrast the
  // raw-profile check below pins.
  const spDir = mkdtempSync(path.join(tmpdir(), 'jslim-m11sp-'));
  const spFile = path.join(spDir, 'fenced.jsonl');
  writeFileSync(spFile, `Script returned:\n\`\`\`jsonl\n${Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i, handle: 'p' + i })).join('\n')}\n\`\`\`\n`);
  const profFence = await T.streamProfile(spFile, {}, { skipLeading: 2, fenceAware: true });
  const profRaw = await T.streamProfile(spFile, {});
  check('m11-streamprofile-fence-skips-wrapper', profFence.parseFailures === 0 && profFence.rows === 10, `fence-aware profile: failures=${profFence.parseFailures} rows=${profFence.rows}`);
  check('m11-streamprofile-raw-counts-wrapper', profRaw.parseFailures > 0, `raw profile counts the wrapper lines as failures: ${profRaw.parseFailures}`);
  rmSync(spDir, { recursive: true, force: true });

  // A BOM-prefixed opening fence must be detected by the shared findOpeningFence helper (it strips a
  // leading BOM before matching) so the ≤8 MB unwrap path and the >8 MB Gate B scan classify a
  // BOM+fenced whale identically — the raw FENCE_OPEN regex alone misses the "﻿```json" line.
  const bomLines = ['﻿```json', JSON.stringify({ a: 1 }), '```'];
  check('m11-bom-fence-helper', T.findOpeningFence(bomLines, 3) === 0, `findOpeningFence detects a BOM-prefixed fence at 0: ${T.findOpeningFence(bomLines, 3)}`);
  const bomUnwrap = T.unwrapFence(`﻿\`\`\`json\n${payload}\n\`\`\``);
  check('m11-bom-fence-unwrap', !!bomUnwrap && (() => { try { return Array.isArray(JSON.parse(bomUnwrap.body).products); } catch { return false; } })(), 'unwrapFence unwraps a BOM-prefixed fenced body');
  // Gate B mirror at small scale: computing skipLeading with the shared helper over a BOM-prefixed
  // fenced JSONL head, then stream-profiling the body, sees zero parse failures — the >8 MB path no
  // longer diverges from the ≤8 MB path on the BOM case.
  const bomDir = mkdtempSync(path.join(tmpdir(), 'jslim-m11bom-'));
  const bomFile = path.join(bomDir, 'bom.jsonl');
  writeFileSync(bomFile, `﻿\`\`\`jsonl\n${Array.from({ length: 6 }, (_, i) => JSON.stringify({ id: i })).join('\n')}\n\`\`\`\n`);
  const bomSkip = T.findOpeningFence(readFileSync(bomFile, 'utf8').split('\n', 4), 3) + 1; // Gate B: skipLeading = index + 1
  const bomProf = await T.streamProfile(bomFile, {}, { skipLeading: bomSkip, fenceAware: true });
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
    ['.a.', 'a.'], // a trailing dot survives normalization — the PARSER (M15) refuses it, exit 2
    ['["a.b"]', '["a.b"]'], // quoted keys are NOT supported (only [N] is rewritten) — documented, not a feature
  ];
  for (const [input, want] of norm) eq(`m12-normjq:${input}`, T.normalizeJqPath(input), want);
  // …normalization is SPELLING only: both of those reach the M15 parser, which refuses them by name
  // rather than walking whatever the rewrite left behind
  eq('m12-normjq-trailing-dot-refused', T.parseJqExpr('.a.').bad, '.');
  eq('m12-normjq-quoted-refused', T.parseJqExpr('["a.b"]').bad, '["a.b"]');

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
  // bare `.` = identity: the WHOLE document (still slimmed, never narrowed) and no --jq diagnostic.
  // stderr is not asserted EMPTY here: identity narrows nothing, so this run re-dumps the document and
  // the B2 decline notice rides along on stderr, exactly as it would without `--jq`.
  const ident = runJq('.', nestFile);
  check('m12-jq-identity', ident.stdout.trim() === JSON.stringify({ a: [{ b: 'hit' }] }) && !ident.stderr.includes('--jq:'),
    `bare '.' selects the whole value with no path diagnostic: ${JSON.stringify(ident.stdout)} / ${JSON.stringify(ident.stderr)}`);

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
  check('m13-detect-fixture', T.detectJsx(jsxFixture), 'the real design-context fixture detects as Figma JSX');
  const liquid = Array.from({ length: 200 }, (_, i) =>
    `{% if section.settings.show_${i} %}\n  <div class="card" style="color: var(--color-text-${i}, #000);">{{ product.title }}</div>\n{% endif %}`).join('\n');
  check('m13-detect-liquid-not', !T.detectJsx(liquid), 'a Liquid section using var(--…) must NOT detect');
  const lr = J.slim(liquid, { spillDir: dir });
  check('m13-liquid-passthrough', !lr.wasModified && lr.output === liquid && lr.reason === 'non-json', 'Liquid passes through byte-identical');
  const plainJsx = Array.from({ length: 200 }, (_, i) =>
    `  <div className="flex items-center gap-2" style={{ color: "var(--x, #fff)" }}>Item ${i}</div>`).join('\n');
  check('m13-detect-plain-jsx-not', !T.detectJsx(plainJsx), 'hand-written JSX without data-node-id must NOT detect');
  check('m13-plain-jsx-passthrough', J.slim(plainJsx, { spillDir: dir }).output === plainJsx, 'non-Figma JSX passes through byte-identical');
  check('m13-detect-html-not', !T.detectJsx(`<!doctype html><html><body>${'<div class="a" style="color:var(--x)">hi</div>'.repeat(500)}</body></html>`), 'plain HTML must NOT detect');
  // two hits of each signature is below the threshold
  const thin = ['<div className="a" data-node-id="1:1" style={{ c: "var(--x)" }} />',
    '<div className="b" data-node-id="1:2" style={{ c: "var(--y)" }} />'].join('\n');
  check('m13-detect-threshold', !T.detectJsx(thin), '2 hits of each signature is below JSX_MIN_HITS');

  // --- slim() integration ---
  const r = J.slim(jsxFixture, { trace: true, spillDir: dir });
  check('m13-slim-compresses', r.wasModified && r.bytesOut < r.bytesIn, `fixture compresses: ${r.bytesIn}→${r.bytesOut}`);
  eq('m13-slim-stages', r.stages, ['jsx']);
  check('m13-trace-off-empty', J.slim(jsxFixture, { spillDir: dir }).stages.length === 0, 'trace off → compressed but stages stays empty');
  const off = J.slim(jsxFixture, { jsx: false, spillDir: dir });
  check('m13-jsx-off', !off.wasModified && off.reason === 'non-json' && off.output === jsxFixture, 'jsx:false → byte-identical non-json passthrough');
  check('m13-header-on-top', r.output.startsWith('<<fnd-jsx-slim>>'), 'the legend header leads the compacted body');
  check('m13-detect-idempotent', !T.detectJsx(r.output), 'an already-compacted payload never compacts twice');
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
  // Read NAIVELY — a whitespace-delimited token, the way a model or a shell one-liner reads it: any
  // clause after `ids=` glues a `; ` onto the path and the documented recovery ENOENTs. The real
  // fixture folds siblings, so this holds only while the ids= clause stays LAST.
  const idFile = /ids=(\S+)/.exec(head[0]);
  check('m13-idmap-named', !!idFile && existsSync(idFile[1]) && path.dirname(idFile[1]) === dir, `the node-id map is spilled beside the other spills: ${idFile && idFile[1]}`);
  check('b4.3-ids-naive-read-with-fold', head[0].includes('×N more') && !!idFile && /fnd-jsx-ids-[0-9a-f]{16}\.json$/.test(idFile[1]) && existsSync(idFile[1]),
    `with the fold clause present the naive ids= token must still be a real file: ${JSON.stringify(idFile && idFile[1])}`);
  // B4.10a: the map's path reaches the caller's spill sink, so a debug line can name it.
  const jsxSink = [];
  const jr = J.slim(jsxFixture, { spillDir: dir, spillSink: jsxSink });
  check('b4.10a-sink-jsx-ids', jsxSink.length === 1 && existsSync(jsxSink[0]) &&
    path.basename(jsxSink[0]).startsWith('fnd-jsx-ids-') && jr.output.includes(`ids=${jsxSink[0]}`),
    `the node-id map must reach the sink: ${JSON.stringify(jsxSink)}`);
  check('m13-no-full-token', !r.output.includes('full='), 'the compacted body never spends the `full=` handle on anything but the original result');
  const map = idFile && existsSync(idFile[1]) ? JSON.parse(readFileSync(idFile[1], 'utf8')) : {};
  const origIds = [...new Set([...jsxFixture.matchAll(/data-node-id="([^"]*)"/g)].map((m) => m[1]))];
  check('m13-idmap-complete', Object.keys(map).length === origIds.length && origIds.every((v, i) => map[`n${i + 1}`] === v),
    `the map holds every node id byte-exact: ${Object.keys(map).length} of ${origIds.length}`);
  const idRefs = [...new Set((r.output.match(/#n\d+/g) || []))];
  check('m13-idrefs-resolve', idRefs.length > 0 && idRefs.every((x) => typeof map[x.slice(1)] === 'string'), 'every #nN reference resolves in the map');
  check('m13-ids-out-of-band', !r.output.includes('data-node-id="'), 'no data-node-id attribute survives inline');

  // --- no byte win → whole original; the already-written map is LEFT for the TTL sweep: its name is
  // content-addressed, so an identical map may be behind a CONCURRENT process's live `ids=` handle, and
  // an unlink here could break that handle mid-flight ---
  const winDir = mkdtempSync(path.join(tmpdir(), 'jslim-m13w-'));
  const tiny = ['<div className="a1" data-node-id="1:1" style={{ c: "var(--x,#fff)" }}>one</div>',
    '<div className="b2" data-node-id="1:2" style={{ c: "var(--y,#000)" }}>two</div>',
    '<div className="c3" data-node-id="1:3" style={{ c: "var(--z,#111)" }}>three</div>'].join('\n');
  const winSink = [];
  const tr = J.slim(tiny, { spillDir: winDir, spillSink: winSink });
  check('m13-nowin-passthrough', !tr.wasModified && tr.output === tiny && tr.reason === 'non-json', 'unique-only classNames, no byte win → byte-identical passthrough');
  const nowinMaps = readdirSync(winDir).filter((f) => f.startsWith('fnd-jsx-ids-'));
  check('m13-nowin-map-kept', nowinMaps.length === 1, `a declined run leaves its map to the TTL sweep, never unlinks: ${JSON.stringify(nowinMaps)}`);
  // …and the sink names the file the run left on disk (B4.10a: the log's spills inventory is complete).
  check('b4.10a-sink-nowin-names-map', winSink.length === 1 && existsSync(winSink[0]) &&
    path.basename(winSink[0]).startsWith('fnd-jsx-ids-'),
    `the declined run's map must reach the sink: ${JSON.stringify(winSink)}`);
  rmSync(winDir, { recursive: true, force: true });

  // B4.10a: content-addressed names make an id map SHARED across calls — a written map is never
  // unlinked. Same three node ids in the same order ⇒ same map bytes ⇒ same file: the winning
  // payload's live `ids=` handle must survive the declining payload that follows it.
  const shareDir = mkdtempSync(path.join(tmpdir(), 'jslim-m13s-'));
  const sharedIds = ['1:1', '1:2', '1:3']; // the same three ids `tiny` uses → byte-identical map
  const winner = Array.from({ length: 12 }, (_, i) =>
    `<div className="content-stretch flex flex-col gap-[var(--space\\/sm,16px)] items-center relative shrink-0 w-full" data-node-id="${sharedIds[i % 3]}" data-name="Card ${i}">card ${i}</div>`).join('\n');
  const wr = J.slim(winner, { spillDir: shareDir });
  const sharedMap = /ids=(\S+)/.exec(wr.output.split('\n')[0]);
  const decl = J.slim(tiny, { spillDir: shareDir });
  check('b4.10a-shared-idmap-kept', !!sharedMap && existsSync(sharedMap[1]) && !decl.wasModified,
    `a map an earlier live ids= handle names must survive a later declining run: ${sharedMap && sharedMap[1]}`);
  rmSync(shareDir, { recursive: true, force: true });

  // --- ×N sibling fold ---
  const card = (id, txt) => [`      <div class=C1 #n${id} data-name="Column">`, '        <p class=C2>', `          ${txt}`, '        </p>', '      </div>'];
  const same = ['  <div class=C0>', ...card(1, 'Copy'), ...card(2, 'Copy'), ...card(3, 'Copy'), '  </div>'].join('\n');
  const fSame = T.foldSiblings(same);
  check('m13-fold-node-id-only', fSame.folded === 2 && fSame.code.includes('×2 more, identical except (node-id): [#n2] [#n3]'),
    `identical-but-for-the-id siblings fold: ${fSame.code.split('\n').find((l) => l.includes('×'))}`);
  const diff = ['  <div class=C0>', ...card(1, 'Hydrating Serum'), ...card(2, 'Firming Cream'), ...card(3, 'Brightening Oil'), '  </div>'].join('\n');
  const fDiff = T.foldSiblings(diff);
  check('m13-fold-text-listed', fDiff.folded === 2 &&
    fDiff.code.includes('×2 more, identical except (node-id, text): [#n2, "Firming Cream"] [#n3, "Brightening Oil"]'),
    `siblings with real diffs fold WITH the diffs listed: ${fDiff.code.split('\n').find((l) => l.includes('×'))}`);
  const styled = ['  <div class=C0>', ...card(1, 'A'), ...card(2, 'B').map((l) => l.replace('class=C1', 'class=C9')), '  </div>'].join('\n');
  check('m13-fold-class-differs-kept', T.foldSiblings(styled).folded === 0, 'a differing class ref keeps both siblings in full (conservative gate)');
  const runs = ['  <div class=C0>',
    ...Array.from({ length: 3 }, (_, i) => [`    <div class=C1 #n${i * 3 + 1}>`, `      <span class=C2 #n${i * 3 + 2}>`, `      <span class=C2 #n${i * 3 + 3}>`, '    </div>']).flat(),
    '  </div>'].join('\n');
  check('m13-fold-id-range', T.foldSiblings(runs).code.includes('[#n4–#n6] [#n7–#n9]'),
    `contiguous node-id runs collapse to a range: ${T.foldSiblings(runs).code.split('\n').find((l) => l.includes('×'))}`);
  check('m13-fold-none', T.foldSiblings('  <a class=C1 #n1>\n  <b class=C2 #n2>').folded === 0, 'nothing to fold → the code comes back unchanged');

  // Slot PRESENCE is part of the skeleton, so a sibling carrying a value can never fold into one
  // that carries none. Without that mark `>text<` canonicalized like `><` (and an own-line text node
  // like a whitespace-only line) with a different slot COUNT: the exemplar's list then either hid the
  // duplicates' values under a "nothing dropped" header, or indexed past the end and threw.
  const inline = (id, txt) => `    <p class=C1 #n${id} data-name="L">${txt}</p>`;
  const emptyFirst = ['  <div class=C0>', '    <p class=C1 #n1 data-name="L"></p>', inline(2, 'Hydrating Serum'), inline(3, 'Firming Cream'), '  </div>'].join('\n');
  const fEmptyFirst = T.foldSiblings(emptyFirst);
  check('m13-fold-empty-vs-text-nofold', !fEmptyFirst.code.includes('×1 more, identical */}') &&
    fEmptyFirst.code.includes('Hydrating Serum') && fEmptyFirst.code.includes('Firming Cream'),
    `an empty element never folds a text-bearing sibling away: ${JSON.stringify(fEmptyFirst.code)}`);
  const emptyLast = ['  <div class=C0>', inline(1, 'Hydrating Serum'), '    <p class=C1 #n2 data-name="L"></p>', '  </div>'].join('\n');
  check('m13-fold-text-vs-empty-nothrow', T.foldSiblings(emptyLast).folded === 0 && T.foldSiblings(emptyLast).code === emptyLast,
    'the reverse order does not throw either — the shapes simply differ');
  const blankLine = ['  <div class=C0>', '    <p class=C1 #n1>', '      ', '    </p>',
    '    <p class=C1 #n2>', '      Hello there', '    </p>', '    <p class=C1 #n3>', '      Hello there', '    </p>', '  </div>'].join('\n');
  const fBlank = T.foldSiblings(blankLine);
  check('m13-fold-blank-vs-textline', (fBlank.code.match(/Hello there/g) || []).length === 2 || fBlank.code.includes('"Hello there"'),
    `a whitespace-only line never folds an own-line text node away: ${JSON.stringify(fBlank.code)}`);
  // Trailing whitespace lives in the slot value, not the skeleton, so a repeat that differs only
  // there is listed rather than dropped under an "identical" claim.
  const trailing = ['  <div class=C0>', '    <p class=C1 #n1>', '      Copy', '    </p>',
    '    <p class=C1 #n2>', '      Copy   ', '    </p>', '  </div>'].join('\n');
  const fTrail = T.foldSiblings(trailing);
  check('m13-fold-trailing-ws-listed', fTrail.folded === 0 || fTrail.code.includes('"Copy   "'),
    `a trailing-whitespace-only difference is never silently identical: ${JSON.stringify(fTrail.code)}`);
  // Two slots of the SAME kind in one subtree — the listed value names which one it came from.
  const twoNames = (inner) => ['    <div class=C1 data-name="Fixed">', `      <span class=C2 data-name="${inner}">`, '    </div>'];
  const fTwo = T.foldSiblings(['  <div class=C0>', ...twoNames('A'), ...twoNames('B'), ...twoNames('C'), '  </div>'].join('\n'));
  check('m13-fold-same-kind-qualified', fTwo.folded === 2 && fTwo.code.includes('[name#2:"B"] [name#2:"C"]'),
    `a repeated kind is listed with its ordinal: ${fTwo.code.split('\n').find((l) => l.includes('×'))}`);

  // --- legend collision safety: a `$` anywhere in a className disables the $N pass entirely ---
  const dollarBody = Array.from({ length: 40 }, (_, i) =>
    `  <div className="w-[var(--space\\/lg,40px)] cost-[$${'x'}] pad-${i % 2}" data-node-id="9:${i}" data-name="N${i}">t${i}</div>`).join('\n');
  const dr = J.slim(dollarBody, { spillDir: dir });
  check('m13-dollar-no-var-pass', dr.wasModified && !/\n\$\d+: /.test(dr.output) && dr.output.includes('var(--space\\/lg,40px)'),
    'a `$` in a className value skips the $N pass; entries stay verbatim');

  // --- Gate A on a compacted body that is NOT JSON (the first shape that can reach it) ---
  const cap = T.capOutput(r, path.join(dir, 'design-context.jsx'), { cliOutCap: 50, spillDir: dir });
  check('m13-cap-nonjson-handback', !!cap && cap.handback.includes('not JSON — read the slimmed body windowed') &&
    !cap.handback.includes('--jq <jq-path>') && !/\n {2}(first row|shape): /.test(cap.handback),
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

// ==================================== data-loss rails: fenced error shape + BOM routing ==
// Two entry-path bugs, both reproduced in live debug-log traffic, both ending in a LOST result:
//   B1.2 — a fenced ERROR envelope declines every stage, so it used to reach the generic `non-json`
//          return; the hook's stub guard then saw no error and replaced the failure with a ~1 KB stub;
//   B4.1 — the entry JSON.parse is the only reader here that does NOT strip a leading BOM, so one
//          invisible character misrouted a 99 %-compressible payload to `non-json` (→ stubbed).
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-rails-'));

  // --- B1.2: a fenced error envelope reports error-shape, whole result verbatim ---
  const errBody = JSON.stringify({
    errors: Array.from({ length: 300 }, (_, i) => ({
      message: `PERMISSION DENIED on field ${i} — the app is missing the read_products scope`,
      locations: [{ line: i, column: 7 }], extensions: { code: 'ACCESS_DENIED' },
    })),
  });
  const fencedErr = `Script ran on page and returned:\n\`\`\`json\n${errBody}\n\`\`\``;
  check('b1.2-fixture-over-stub-threshold', Buffer.byteLength(fencedErr, 'utf8') > 32768,
    `the fenced envelope must exceed the hook's 32 KB stub threshold: ${Buffer.byteLength(fencedErr, 'utf8')} B`);
  const fe = J.slim(fencedErr, { spillDir: dir });
  check('b1.2-fenced-error-shape', fe.error === true && fe.reason === 'error-shape' && !fe.wasModified && fe.output === fencedErr,
    `a fenced error envelope must be flagged error-shape, verbatim: ${JSON.stringify({ error: fe.error, reason: fe.reason, same: fe.output === fencedErr })}`);
  // a fenced NON-error body that simply does not compress keeps the old vocabulary
  const fencedPlain = `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ note: 'lorem ipsum dolor sit amet '.repeat(200) })}\n\`\`\``;
  const fp = J.slim(fencedPlain, { spillDir: dir });
  check('b1.2-fenced-plain-still-non-json', !fp.error && fp.reason === 'non-json' && fp.output === fencedPlain,
    `an incompressible non-error fenced body stays a non-json passthrough: ${JSON.stringify({ error: fp.error, reason: fp.reason })}`);
  // the same envelope UNFENCED already reported error-shape — the fence path must not be the odd one out
  const ue = J.slim(errBody, { spillDir: dir });
  check('b1.2-unfenced-parity', ue.error === true && ue.reason === fe.reason, `unfenced reason ${ue.reason} vs fenced ${fe.reason}`);

  // …and the CLI answers an OVER-CAP error FILE with its path, never the envelope: `json-slim.cjs <path>`
  // IS the documented whale recovery (hooks/mcp-whale.md), so printing a verbatim passthrough pours the
  // whale back into context — and Gate A would spill a full-size DUPLICATE of the file the caller already
  // named and label it `slimmed output`. Fenced and plain.
  const cliDir = mkdtempSync(path.join(tmpdir(), 'jslim-rails-cli-'));
  const cliEnv = { ...process.env, FND_MCP_SLIM_DIR: cliDir };
  for (const [name, body] of Object.entries({ fencedOverCap: fencedErr, plainOverCap: errBody })) {
    const p = path.join(cliDir, `err-${name}.txt`);
    writeFileSync(p, body);
    const out = execFileSync('node', [SLIM, p], { encoding: 'utf8', env: cliEnv });
    check(`b1.2-cli-handback-${name}`, out.includes(p) && out.includes('nothing to compress (error envelope)') && !out.includes('ACCESS_DENIED') && out.length < p.length + 120,
      `an over-cap error file must be answered with its path (${Buffer.byteLength(body, 'utf8')} B in, ${out.length} B out): ${out.slice(0, 200)}`);
  }
  // UNDER the inline cap the envelope IS the answer the reader came for — a path costs a second Read just
  // to learn the run failed, and a 133 B "PERMISSION DENIED" is no whale. Fenced and bare.
  const smallFencedErr = `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ errors: Array.from({ length: 100 }, (_, i) => ({ message: `PERMISSION DENIED on field ${i}`, extensions: { code: 'ACCESS_DENIED' } })) })}\n\`\`\``;
  const tinyErr = JSON.stringify({ isError: true, message: 'PERMISSION DENIED: the app is missing read_products' });
  check('b1.2-inline-fixtures-under-cap', Buffer.byteLength(smallFencedErr, 'utf8') < 49152 && Buffer.byteLength(tinyErr, 'utf8') < 49152,
    `the inline fixtures must sit below the 49152 B cap: ${Buffer.byteLength(smallFencedErr, 'utf8')} / ${Buffer.byteLength(tinyErr, 'utf8')} B`);
  for (const [name, body] of Object.entries({ fencedSmall: smallFencedErr, tiny: tinyErr })) {
    const p = path.join(cliDir, `err-inline-${name}.txt`);
    writeFileSync(p, body);
    // spawnSync: an envelope printed inline is also a body handed back UNCHANGED, so the B2 decline
    // notice rides on stderr — inherited, it would print into this suite's own output.
    const out = spawnSync('node', [SLIM, p], { encoding: 'utf8', env: cliEnv }).stdout;
    check(`b1.2-cli-inline-${name}`, out.includes('PERMISSION DENIED') && !out.includes('nothing to compress'),
      `an under-cap error envelope must print, not hand back a path (${Buffer.byteLength(body, 'utf8')} B in): ${out.slice(0, 200)}`);
  }
  check('b1.2-cli-no-duplicate-spill', readdirSync(cliDir).filter((f) => f.startsWith('fnd-slim-out-')).length === 0,
    `Gate A must not duplicate an error file it did not compress: ${readdirSync(cliDir).join(', ')}`);
  // A `--jq` selection is a sub-value the file path does NOT answer, so a narrowed error still prints.
  const jqErrPath = path.join(cliDir, 'jq-err.json');
  writeFileSync(jqErrPath, JSON.stringify({ payload: { errors: [{ message: 'boom' }] } }));
  const jqErrOut = execFileSync('node', [SLIM, '--jq', 'payload', jqErrPath], { encoding: 'utf8', env: cliEnv });
  check('b1.2-cli-jq-narrowed-error-prints', !jqErrOut.includes('nothing to compress') && JSON.parse(jqErrOut).errors[0].message === 'boom',
    `a narrowed error value must still be printed: ${jqErrOut.slice(0, 200)}`);
  rmSync(cliDir, { recursive: true, force: true });

  // --- B4.1: a leading BOM is stripped once at the entry, like every other reader here ---
  // Written as an ESCAPE, never as a literal U+FEFF: an invisible fixture character survives on editor
  // luck, and if it is ever dropped every check below silently degrades into a restatement of the
  // plain-payload baseline — green with the rail entirely absent. The fixture guard pins it too.
  const BOM = '\uFEFF';
  const rowsJson = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, note: 'padding-padding-padding' })) });
  const bomJson = BOM + rowsJson;
  check('b4.1-fixture-bom-present', bomJson.charCodeAt(0) === 0xFEFF && Buffer.byteLength(bomJson, 'utf8') === Buffer.byteLength(rowsJson, 'utf8') + 3,
    `the BOM fixtures must actually carry a 3-byte U+FEFF: ${JSON.stringify({ first: bomJson.charCodeAt(0), delta: Buffer.byteLength(bomJson, 'utf8') - Buffer.byteLength(rowsJson, 'utf8') })}`);
  const plainRes = J.slim(rowsJson, { spillDir: dir });
  const bomRes = J.slim(bomJson, { spillDir: dir });
  check('b4.1-plain-baseline', plainRes.wasModified && plainRes.ratio > 0.9, `baseline ratio ${plainRes.ratio.toFixed(3)}`);
  check('b4.1-bom-json-compresses', bomRes.wasModified && bomRes.reason === undefined && Math.abs(bomRes.ratio - plainRes.ratio) < 0.001,
    `BOM+JSON must compress like the same payload without it: ${JSON.stringify({ reason: bomRes.reason, bom: bomRes.ratio, plain: plainRes.ratio })}`);
  // bytesIn counts the ARGUMENT (BOM included) — the caller's byte, not the stripped string's
  check('b4.1-bom-bytes-accounted', bomRes.bytesIn === plainRes.bytesIn + 3 && bomRes.bytesOut === plainRes.bytesOut,
    `accounting runs on the argument: ${bomRes.bytesIn}/${bomRes.bytesOut} vs ${plainRes.bytesIn}/${plainRes.bytesOut}`);
  // BOM + a dominant fence — the two strippers compose (unwrapFence has always stripped its own leading
  // BOM, so this pins the composition, not the entry rail)
  const bf = J.slim(`${BOM}Script ran on page and returned:\n\`\`\`json\n${rowsJson}\n\`\`\``, { trace: true, spillDir: dir });
  check('b4.1-bom-fenced-compresses', bf.wasModified && bf.stages[0] === 'fence' && bf.ratio > 0.9,
    `BOM+fenced JSON compresses through the fence branch: ${JSON.stringify({ stages: bf.stages, ratio: bf.ratio })}`);
  // crush() parses independently of slim() — same rail there
  check('b4.1-bom-crush', T.crush(bomJson, { spillDir: dir }).wasModified, 'crush() strips a leading BOM too');
  // A passthrough hands back the EXACT argument, BOM and all: the CLI prints res.output verbatim on the
  // never-lose-the-result branch, so a `wasModified:false` result that differs from its input is a
  // silent mutation — and bytesIn/bytesOut must describe that same argument (no phantom gain).
  const btIn = `${BOM}Build failed\n  at line 4\n`;
  const bt = J.slim(btIn, { spillDir: dir });
  check('b4.1-bom-nonjson-passthrough', !bt.wasModified && bt.reason === 'non-json' && bt.output === btIn && bt.bytesOut === bt.bytesIn,
    `BOM+prose stays a byte-identical passthrough: ${JSON.stringify({ reason: bt.reason, same: bt.output === btIn, bytesIn: bt.bytesIn, bytesOut: bt.bytesOut })}`);
  const tinyIn = `${BOM}{"a":1}`; // JSON the stages cannot improve — the pipeline branch's own passthrough
  const tiny = J.slim(tinyIn, { spillDir: dir });
  check('b4.1-unimprovable-json-passthrough', !tiny.wasModified && tiny.output === tinyIn && tiny.bytesOut === tiny.bytesIn,
    `an unimprovable payload passes through byte-identical: ${JSON.stringify({ wasModified: tiny.wasModified, out: tiny.output, bytesIn: tiny.bytesIn, bytesOut: tiny.bytesOut })}`);
  const bcIn = `${BOM}not json at all`;
  const bc = T.crush(bcIn, { spillDir: dir });
  check('b4.1-crush-passthrough-verbatim', !bc.wasModified && bc.compressed === bcIn, 'crush() hands back its exact argument on a passthrough');
  // a BOM-prefixed error envelope must reach the error rail, not the non-json branch
  const bomErr = BOM + errBody;
  const be = J.slim(bomErr, { spillDir: dir });
  check('b4.1-bom-error-shape', be.error === true && be.reason === 'error-shape' && be.output === bomErr,
    `BOM+error envelope: ${JSON.stringify({ error: be.error, reason: be.reason, same: be.output === bomErr })}`);

  // Gate A parses the body it spills to sample its shape — a BOM'd passthrough body used to fail that
  // parse, so the handback said "not JSON", dropped the shape sample and withheld the `--jq` recovery
  // hint for a payload `--jq` handles fine. Fixture: >48 KB of already-minimal JSON, so the body Gate A
  // spills IS the argument, BOM and all.
  const bomCliDir = mkdtempSync(path.join(tmpdir(), 'jslim-bom-cli-'));
  const bomCliEnv = { ...process.env, FND_MCP_SLIM_DIR: bomCliDir };
  const flat = {};
  for (let i = 0; i < 1400; i++) flat[`field_${i}`] = `value-${i}-abcdefghijklmnop`;
  const flatJson = JSON.stringify(flat);
  check('b4.1-cap-fixture', Buffer.byteLength(flatJson, 'utf8') > 49152 && !J.slim(flatJson, { spillDir: dir }).wasModified,
    `Gate A needs an over-cap payload no stage can improve: ${Buffer.byteLength(flatJson, 'utf8')} B, modified=${J.slim(flatJson, { spillDir: dir }).wasModified}`);
  const capOut = {};
  for (const [name, body] of Object.entries({ plain: flatJson, bom: BOM + flatJson })) {
    const p = path.join(bomCliDir, `cap-${name}.json`);
    writeFileSync(p, body);
    capOut[name] = execFileSync('node', [SLIM, p], { encoding: 'utf8', env: bomCliEnv });
  }
  const shapeOf = (s) => (/\n {2}shape: (.*)/.exec(s) || [])[1];
  check('b4.1-cap-bom-sampled-as-json', !capOut.bom.includes('not JSON') && capOut.bom.includes('(e.g. --jq field_0)')
    && shapeOf(capOut.bom) !== undefined && shapeOf(capOut.bom) === shapeOf(capOut.plain),
    `a BOM'd spill body must sample and advertise --jq like its non-BOM twin: ${capOut.bom.slice(0, 300)}`);
  // …and the pre-slim `--jq` narrowing parses the file itself, so `--jq k0 <bom-file>` must not exit 1
  const jqBomPath = path.join(bomCliDir, 'jq-bom.json');
  writeFileSync(jqBomPath, `${BOM}${JSON.stringify({ k0: { handle: 'alpha', qty: 3 } })}`);
  const jqBomOut = execFileSync('node', [SLIM, '--jq', 'k0', jqBomPath], { encoding: 'utf8', env: bomCliEnv });
  check('b4.1-cli-jq-bom-narrows', JSON.parse(jqBomOut).handle === 'alpha',
    `--jq must narrow into a BOM-prefixed file: ${jqBomOut.slice(0, 200)}`);

  // A faulted transform gets the same carve-out as an error envelope: bare, the file IS the answer, but a
  // `--jq` selection is a sub-value the path does not point at, so discarding it would lose the selection.
  // `marks` as a STRING is the deterministic fault (adf-to-md maps over it) — the guard keeps a future
  // tolerant converter from turning both checks below into vacuous passes.
  const badAdfJson = JSON.stringify({ payload: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'boom', marks: 'bold' }] }] } });
  check('cli-transform-error-fixture', J.slim(badAdfJson, { spillDir: dir }).reason === 'transform-error',
    `the fixture must actually fault a stage: reason=${J.slim(badAdfJson, { spillDir: dir }).reason}`);
  const taPath = path.join(bomCliDir, 'bad-adf.json');
  writeFileSync(taPath, badAdfJson);
  const taBare = execFileSync('node', [SLIM, taPath], { encoding: 'utf8', env: bomCliEnv });
  const taJq = execFileSync('node', [SLIM, '--jq', 'payload', taPath], { encoding: 'utf8', env: bomCliEnv });
  check('cli-transform-error-handback', taBare.includes('nothing to compress (transform error)') && taBare.includes(taPath),
    `a bare transform-error run names the file: ${taBare.slice(0, 200)}`);
  check('cli-transform-error-jq-prints', !taJq.includes('nothing to compress') && JSON.parse(taJq).content[0].content[0].text === 'boom',
    `a narrowed transform-error run must still print the selection: ${taJq.slice(0, 200)}`);
  rmSync(bomCliDir, { recursive: true, force: true });

  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------- B4.11: the intentional decline (verdict: by design) --
// A uniform array of UNIQUE ENTITIES — same keys on every row, per-row distinct strings, no error row,
// no rare enum value, no numeric outlier or change-point — is REFUSED by the crushability gate: every
// row that a 15-row sample would drop is unique content, so sampling would misrepresent the result.
// Upstream ships the identical gate and asserts the refusal in its own unit test
// (smart_crusher/analyzer.rs `crushability_unique_entities_no_signal_skips`), so the 0 % these payloads
// report is honest, not a missed win. Pinned in BOTH directions: a change that starts sampling unique
// entities fails the skip cases, and a change that simply stops crushing fails the contrast cases.
{
  const N = 60;
  const uniqueEntities = Array.from({ length: N }, (_, i) => ({
    id: `gid://shopify/Product/${7000000000 + i}`,
    handle: `product-handle-${i}`,
    title: `Product Title Number ${i}`,
    url: `https://shop.example.com/products/product-handle-${i}`,
  }));
  const uq = T.analyseDictArray(uniqueEntities, T.DEFAULTS);
  eq('b4.11-skip-unique-entities', [uq.crushable, uq.strategy, uq.reason], [false, 'skip', 'unique_entities_no_signal']);
  const rawUnique = JSON.stringify({ products: uniqueEntities });
  const rUnique = J.slim(rawUnique, { markerMode: 'ccr' });
  check('b4.11-skip-byte-identical',
    !rUnique.wasModified && rUnique.output === rawUnique && rUnique.bytesOut === rUnique.bytesIn && rUnique.ratio === 0,
    `a skipped array must pass through untouched (no re-serialization): ${JSON.stringify({ mod: rUnique.wasModified, same: rUnique.output === rawUnique, bytesIn: rUnique.bytesIn, bytesOut: rUnique.bytesOut })}`);

  // The sibling gate, for rows with no id-like field: every column sits at uniqueRatio 0.9 (54 distinct
  // of 60 — the last 6 rows repeat the first 6), which keeps idConfidence at 0 (its hard gate needs
  // >0.95 for a string field) while maxUniqueness stays above the 0.8 branch.
  const noIdField = Array.from({ length: N }, (_, i) => {
    const j = i < 54 ? i : i - 54;
    return { handle: `handle-${j}`, title: `Title Number ${j}`, vendor: `Vendor ${j} Inc` };
  });
  const nq = T.analyseDictArray(noIdField, T.DEFAULTS);
  eq('b4.11-skip-no-id-field', [nq.crushable, nq.strategy, nq.reason], [false, 'skip', 'medium_uniqueness_no_signal']);
  const rawNoId = JSON.stringify({ items: noIdField });
  check('b4.11-skip-no-id-byte-identical', J.slim(rawNoId, { markerMode: 'ccr' }).output === rawNoId, 'the id-less skip branch also passes through untouched');

  // Second declining path, one gate later: errorItems substring-scans the whole serialized row, KEY
  // NAMES included, so `hasError:false` on every row reads as N error rows → crushable:true. Over
  // budget, prioritizeIndices keeps ALL signal indices, so the crush drops nothing, writes no sentinel
  // and no spill — the same 0 %, but from a `crushable:true` analysis (upstream behaves identically).
  const falseErrorFlag = Array.from({ length: N }, (_, i) => ({
    id: `req-${1000 + i}`,
    url: `https://api.example.com/v1/items/${i}`,
    hasError: false,
    label: `Request number ${i} label`,
  }));
  const fq = T.analyseDictArray(falseErrorFlag, T.DEFAULTS);
  check('b4.11-crushable-error-keyword-in-key-name',
    fq.crushable === true && fq.reason === 'unique_entities_with_signal' && fq.sig.errors.size === N,
    `a key name carrying "error" flags every row: ${JSON.stringify({ crushable: fq.crushable, reason: fq.reason, errors: fq.sig.errors.size })}`);
  const flagOut = T.crushValue({ requests: falseErrorFlag }, { markerMode: 'ccr' });
  check('b4.11-crushable-zero-drop',
    flagOut.requests.length === N && !flagOut.requests.some((x) => x && x._ccr_dropped)
      && JSON.stringify(flagOut.requests) === JSON.stringify(falseErrorFlag),
    `all-signal rows must survive whole, with no drop sentinel: ${JSON.stringify({ len: flagOut.requests.length, sentinel: flagOut.requests.some((x) => x && x._ccr_dropped) })}`);
  const rawFlag = JSON.stringify({ requests: falseErrorFlag });
  check('b4.11-zero-drop-byte-identical', J.slim(rawFlag, { markerMode: 'ccr' }).output === rawFlag, 'a zero-drop crush must not report a gain');

  // Contrast — the three pins above must not be satisfiable by breaking the crush. The SAME entity
  // shape crushes once a signal appears, and low-uniqueness rows crush without one.
  const ratioOf = (items, key) => J.slim(JSON.stringify({ [key]: items }), { markerMode: 'ccr' }).ratio;
  const withErrorRow = uniqueEntities.map((r, i) => (i === 41 ? { ...r, note: 'sync failed' } : r));
  const withOutlier = uniqueEntities.map((r, i) => ({ ...r, inventory: i === 17 ? 99999 : 3 + (i % 4) }));
  const repetitive = Array.from({ length: N }, (_, i) => ({ id: i, status: i % 2 ? 'ok' : 'pending', kind: 'widget' }));
  check('b4.11-flip-error-row-crushes', T.analyseDictArray(withErrorRow, T.DEFAULTS).crushable === true && ratioOf(withErrorRow, 'products') > 0.5,
    `one error row must flip the same shape to crushable: ${(ratioOf(withErrorRow, 'products') * 100).toFixed(1)} %`);
  check('b4.11-flip-numeric-outlier-crushes', T.analyseDictArray(withOutlier, T.DEFAULTS).crushable === true && ratioOf(withOutlier, 'products') > 0.5,
    `a 2σ numeric outlier must flip the same shape to crushable: ${(ratioOf(withOutlier, 'products') * 100).toFixed(1)} %`);
  check('b4.11-contrast-repetitive-crushes', ratioOf(repetitive, 'rows') > 0.5,
    `low-uniqueness rows must still crush: ${(ratioOf(repetitive, 'rows') * 100).toFixed(1)} %`);

  // …and this shape is what a `no-gain` debug line means: the CLI prints the payload verbatim and logs
  // the decline, so `--report`'s top passthrough reason can be read as "unique entities", not "broken".
  // Printing it IS the contract for an explicit CLI run under the inline cap (over it, Gate A spills and
  // summarizes) — the context hazard was the STUB telling the model to make that run on a payload it had
  // just declined to show, which is why a `no-gain` stub now names `--jq` instead (hooks-sim M67).
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'jslim-b411-'));
    const p = path.join(dir, 'unique-entities.json');
    writeFileSync(p, rawUnique);
    // spawnSync, not execFileSync: the decline now also states itself on stderr (B2 Layer 3), and an
    // inherited stderr would print that notice into this suite's own output.
    const r = spawnSync('node', [SLIM, p], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, FND_MCP_SLIM_DEBUG: '1' } });
    const stdout = r.stdout;
    check('b4.11-cli-prints-verbatim', stdout === `${rawUnique}\n`, `a declined payload is handed back byte-identical: ${stdout.length} vs ${rawUnique.length + 1} B`);
    check('b4.11-cli-names-the-decline', /deliberate decline, not an error/.test(r.stderr),
      `the 0 % result must say it is a decision, not a failure: ${JSON.stringify(r.stderr)}`);
    const line = JSON.parse(readFileSync(path.join(dir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n')[0]);
    eq('b4.11-cli-logs-no-gain', [line.decision, line.reason, line.pct, line.stages], ['passthrough', 'no-gain', 0, []]);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- B4.6/B4.8: superlinear scans + the wall-clock budget --
// Two reproduced stalls and the ceiling that bounds whatever the next one is. A PostToolUse hook that
// runs for 37 s is worse than no compression: the tool result waits on it.
{
  // The .NET PDB frame detector was `/^\s*at .+\) in .+:line \d+/`. Two unpinned `.+` before a literal
  // that a long non-matching line never satisfies = catastrophic backtracking: measured 593 ms at
  // 125 KB, 2.3 s at 250 KB, 9.3 s at 500 KB, 37.7 s at 998 KB — a clean 4× per doubling. Pinning the
  // FIRST quantifier to `[^)]+` removes it (the tail `.+` has a single start position, so it stays
  // linear). detectLog is the observable seam: a lone frame line scores ratio 1.0 → confidence 0.8.
  const t0 = Date.now();
  const evil = '   at F' + ') in :line '.repeat(90728); // 998,007 B, one line, dense in `) in `, never matches
  const evilIsLog = L.detectLog(evil).isLog;
  const evilMs = Date.now() - t0;
  check('b4.6-dotnet-frame-linear', evilMs < 500, `detectLog over a 998 KB adversarial frame line took ${evilMs} ms (was ~37,700 ms)`);
  check('b4.6-dotnet-frame-no-false-log', evilIsLog === false, 'the adversarial line matches no pattern, so it is not a log');
  // Match equivalence on real frames. `[T]` in the method name is deliberate: it keeps the generic
  // JS/Java frame pattern (`at [\w.$/]+\(`) from matching, so `isLog` speaks for the .NET pattern alone.
  const frame = (l) => L.detectLog(l).isLog;
  check('b4.6-dotnet-frame-windows-path',
    frame('   at MyApp.Service.Run[T](Int32 id) in C:\\Program Files\\App\\Service.cs:line 42'),
    'a PDB path containing SPACES must still match (the reason the tail stays `.+` instead of `\\S+`)');
  check('b4.6-dotnet-frame-plain', frame('   at Foo.Bar[T](String s) in /src/Foo.cs:line 7'), 'an ordinary .NET PDB frame matches');
  check('b4.6-dotnet-frame-minimal', frame('   at F[T](x) in x y:line 3'), 'the minimal shape matches');
  check('b4.6-dotnet-frame-needs-line-number', !frame('   at F[T](x) in x y:line'), 'no line NUMBER → no match');
  // Documented narrowing: `[^)]+` cannot span a nested `)`, so a frame whose ARGUMENT list contains
  // parentheses no longer matches. .NET method signatures do not nest them; the linearity is worth it.
  check('b4.6-dotnet-frame-nested-parens-narrowed',
    !frame('   at A.B[T](Nested(x)) in /src/A.cs:line 7'),
    'a nested-paren argument list is outside the pinned pattern (documented narrowing)');
  // …and the narrowing costs nothing on a real trace, which is what bounds it: an ordinary dotted
  // frame is also caught by the JS/Java pattern (`at <dotted>(`), and the compressor's own .NET
  // recognition is substring-based (isDotnetFrame), not this regex. So a nested-paren trace still
  // detects and still marks every frame — identically to its nested-paren-free twin.
  const dotnetTrace = (arg) => ['Unhandled exception. System.InvalidOperationException: boom',
    ...Array.from({ length: 60 }, (_, i) => `   at MyApp.Svc.Run(${arg(i)}) in /src/Svc.cs:line ${i + 1}`)].join('\n');
  // Byte ratio is NOT the invariant here (the two argument texts differ in length) — the structure is.
  const traceShape = (s) => [L.detectLog(s).isLog, L.parseLogLines(s.split('\n'), {}).filter((e) => e.isStackTrace).length,
    L.compressLog(s, {}).compressed_line_count];
  eq('b4.6-nested-parens-trace-still-compresses', traceShape(dotnetTrace((i) => `Nested(${i})`)), traceShape(dotnetTrace((i) => `Int32 i${i}`)));

  // `analyseDictArray` runs ~7 passes over rows × unionKeys. With per-row-unique key names that union
  // is rows × keys, so the cost is quadratic in bytes: 151 KB → 577 ms, 618 KB → 10.2 s, 1.28 MB →
  // 45.2 s (28.4 s of it inside the hook). Measured throughput is 1.3–2.9e6 row×key ops/s, so the
  // shipped 4e6 pre-gate caps one (uninterruptible) call at ~2–3 s; 2e6 was rejected because an
  // ordinary 300k × 7 dump is already 2.1e6 ops. Real payloads with this shape exist (per-row-aliased
  // GraphQL fields, metafield-keyed maps), which is why it declines instead of crashing.
  const wide = Array.from({ length: 2000 }, (_, r) => {
    const o = {};
    for (let k = 0; k < 40; k++) o[`k${r}_${k}`] = `v${r}-${k}`;
    return o;
  });
  const w0 = Date.now();
  const wq = T.analyseDictArray(wide, T.DEFAULTS);
  const wms = Date.now() - w0;
  eq('b4.8-analyse-ops-gate', [wq.crushable, wq.strategy, wq.reason], [false, 'skip', 'analysis_too_wide']);
  check('b4.8-analyse-ops-gate-fast', wms < 1000, `a 2000×40 unique-key array must decline fast, took ${wms} ms (was ~45,000 ms)`);
  // …and the gate must sit far above every parity-sized array: the same shapes still analyse normally.
  const normal = Array.from({ length: 200 }, (_, i) => ({ id: i, status: i % 2 ? 'ok' : 'pending', kind: 'widget' }));
  check('b4.8-analyse-gate-clears-normal', T.analyseDictArray(normal, T.DEFAULTS).crushable === true,
    'an ordinary array is nowhere near the ops cap');
  // The ops PRODUCT on its own, which nothing above reaches: the case above trips the union cap first
  // (per-row key names), and the tall-narrow dump below sits under the product. A SHARED but very wide
  // schema hits only the backstop — union 2000 is exactly at the cap (the check is `>`), 2100 × 2000 =
  // 4.2e6 is over it. Measured with the backstop removed: 2190 ms, versus ~70 ms declined.
  const shapedWide = Array.from({ length: 2100 }, (_, r) => {
    const o = {};
    for (let k = 0; k < 2000; k++) o[`k${k}`] = (r + k) % 97;
    return o;
  });
  const s0 = Date.now();
  const sq = T.analyseDictArray(shapedWide, T.DEFAULTS);
  const sms = Date.now() - s0;
  eq('dr2-analyse-ops-backstop', [sq.crushable, sq.strategy, sq.reason], [false, 'skip', 'analysis_too_wide']);
  check('dr2-analyse-ops-backstop-fast', sms < 700, `the ops backstop must decline before the passes, took ${sms} ms (ungated: ~2190 ms)`);

  // The budget itself: `cfg.deadline` is an absolute ms timestamp threaded from the hook. An expiry
  // hands the ORIGINAL back — never a half-transformed value — and reports its own reason so the
  // debug log and `--report` can tell it apart from a genuine decline. Absent ⇒ no budget at all,
  // which is what keeps the CLI and every other fixture in this file on today's behavior.
  const raw = JSON.stringify({ rows: Array.from({ length: 600 }, (_, i) => ({ id: i, note: 'padding-padding-padding' })) });
  const spent = J.slim(raw, { deadline: Date.now() - 1, markerMode: 'ccr' });
  check('b4.8-deadline-passthrough',
    !spent.wasModified && spent.output === raw && spent.reason === 'budget-exceeded' && spent.bytesOut === spent.bytesIn,
    `an expired deadline must hand the original back verbatim: ${JSON.stringify({ mod: spent.wasModified, reason: spent.reason, same: spent.output === raw })}`);
  const roomy = J.slim(raw, { deadline: Date.now() + 60000, markerMode: 'ccr' });
  const none = J.slim(raw, { markerMode: 'ccr' });
  check('b4.8-deadline-roomy-compresses', roomy.wasModified && roomy.output === none.output,
    'a deadline in the future must not change the output by one byte');
  check('b4.8-no-deadline-unchanged', none.wasModified && none.bytesOut < none.bytesIn, 'no deadline ⇒ no budget');
  // An error envelope is verbatim by contract, and the hook's stub gate reads that fact off the slim
  // result — so the parse + envelope rails must run BEFORE any deadline is consulted, or an expired
  // budget would report a failure as a plain passthrough the guard is allowed to stub away.
  const envelope = JSON.stringify({ errors: Array.from({ length: 20 }, (_, i) => ({ message: `insufficient permissions for field ${i}` })), data: null });
  const spentErr = J.slim(envelope, { deadline: Date.now() - 1 });
  eq('b4.8-deadline-error-rail-first', [spentErr.reason, spentErr.error === true, spentErr.output === envelope], ['error-shape', true, true]);
  // …including a FENCED envelope, whose rail lives one recursion deeper (M11/B1.2).
  const fencedErr = `Tool output:\n\`\`\`json\n${envelope}\n\`\`\``;
  const spentFenced = J.slim(fencedErr, { deadline: Date.now() - 1 });
  eq('b4.8-deadline-fenced-error-rail', [spentFenced.reason, spentFenced.output === fencedErr], ['error-shape', true]);

  // Every fixture above expires the deadline BEFORE the pipeline starts, so it only ever exercises the
  // top-of-route gate. The signal has to survive the walk too: the catch-alls between processValue and
  // slim() must not swallow it into "skip the crush stage", which reports a clean compression over a
  // HALF-transformed body and leaves the aborted walk's crush spills behind unnamed.
  // `deadline` is compared with `>`, so an object with a valueOf() counter expires on an exact tick —
  // a wall-clock budget calibrated against a measured run would land wherever the machine is that day.
  const walkDoc = { dead: null, blocks: [] };
  for (let b = 0; b < 40; b++) {
    walkDoc.blocks.push(Array.from({ length: 60 }, (_, r) => ({ id: `${b}-${r}`, name: `row ${r}`, status: r % 5 ? 'ok' : 'err', qty: r })));
  }
  const walkRaw = JSON.stringify(walkDoc);
  const walkDir = mkdtempSync(path.join(tmpdir(), 'jslim-walkbudget-'));
  const created = [];
  let ticks = 0;
  const expiresOnTick = (n) => ({ valueOf: () => (++ticks > n ? -Infinity : Infinity) });
  const mid = J.slim(walkRaw, { spillDir: walkDir, spillCreatedSink: created, deadline: expiresOnTick(12) });
  eq('dr2-budget-inside-walk', [mid.reason, mid.wasModified, mid.output === walkRaw], ['budget-exceeded', false, true]);
  check('dr2-budget-inside-walk-reached', created.length > 0,
    `the fixture must expire INSIDE the crush walk (spills written: ${created.length}) or it re-tests the top-of-route gate`);
  rmSync(walkDir, { recursive: true, force: true });

  // The ops product alone is not the quadratic signal: an ordinary fixed-schema bulk dump reaches it on
  // row count alone (a 7-key JSONL dump lost ALL compression past ~285k rows), while the shape the gate
  // exists for blows the union itself up. Gate on the union, keep the product as the runtime backstop.
  const tall = Array.from({ length: 300000 }, (_, i) => ({
    id: `gid://shopify/ProductVariant/${i}`, sku: `SKU-${i % 900}`, qty: i % 50,
    status: i % 7 ? 'ACTIVE' : 'DRAFT', price: `${(i % 90) + 1}.00`, title: `Variant ${i % 900}`, vendor: 'acme',
  }));
  const t0tall = Date.now();
  const tq = T.analyseDictArray(tall, T.DEFAULTS);
  check('dr2-analyse-tall-narrow-crushes', tq.crushable === true,
    `a 300k×7 fixed-schema dump must still analyse: ${tq.strategy}/${tq.reason} in ${Date.now() - t0tall} ms`);
}

// ------------------------------------------- R6: the whale-guidance block is one-shot per session --
// The full recovery block is identical on every re-profile of the same file, so only the FIRST profile
// per (session, path) prints it; later ones get a one-line reminder. The profile itself must never
// change — the switch governs guidance prose only.
{
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: i, handle: `${tag}-${i}`, ok: i % 2 === 0 })).join('\n') + '\n';
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-whaleguide-'));
  const fileA = path.join(dir, 'feed-a.jsonl');
  const fileB = path.join(dir, 'feed-b.jsonl');
  writeFileSync(fileA, rows(40, 'a'));
  writeFileSync(fileB, rows(40, 'b'));
  const profile = (file, env) => spawnSync('node', [SLIM, file], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, ...(env || {}) } }).stdout;
  // the full block is recognizable by its copy-paste templates, the reminder by its own opening
  const isFull = (out) => out.includes('node -e ') && out.includes('filter rows (adapt');
  const isReminder = (out) => out.includes('json-slim: profile only —') && !out.includes('node -e ');
  // the profile JSON minus its RANDOM reservoir sample, which differs run to run by design
  const bodyOf = (out) => {
    const p = JSON.parse(out.split('\n').find((l) => l.startsWith('{')));
    delete p.samples.reservoir;
    return JSON.stringify(p);
  };

  const first = profile(fileA);
  check('r6-first-run-full-block', isFull(first) && first.includes(fileA), `the first profile of a file must carry the full guidance:\n${first}`);
  const second = profile(fileA);
  check('r6-second-run-reminder', isReminder(second), `a repeat profile of the same file must collapse to the one-liner:\n${second}`);
  check('r6-reminder-keeps-identity', second.includes(fileA) && second.includes('40 rows'),
    `the reminder must still name the file and the row count (a profile without them is unusable):\n${second}`);
  check('r6-reminder-is-one-line', second.trimEnd().split('\n').pop().length > 0 && /json-slim: profile only —[^\n]*$/.test(second.trimEnd()),
    `the reminder must be a single trailing line:\n${second}`);
  check('r6-profile-body-unchanged', bodyOf(first) === bodyOf(second) && bodyOf(first).includes('"profile":true'),
    'suppressing guidance must not change WHAT is profiled (the profile JSON must be byte-identical)');
  check('r6-reminder-is-smaller', Buffer.byteLength(T.whaleReminder(fileA, 40)) < Buffer.byteLength(T.whaleGuidance(fileA, 40, 0)),
    'the reminder must be shorter than the block it replaces');

  // a DIFFERENT whale in the same dir/session gets its own full block (the commands are path-specific)
  check('r6-new-path-full-block', isFull(profile(fileB)) && isReminder(profile(fileB)),
    'a new file path must print the full block once, then collapse for that path too');
  check('r6-per-path-isolation', isReminder(profile(fileA)), 'profiling another file must not re-arm the first file');

  // TTL: the stamp is a fixed window, so an old stamp re-prints the full block
  const stateA = T.whaleGuideStatePath(dir, fileA);
  check('r6-state-file-is-a-dotfile', path.basename(stateA).startsWith('.') && readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.jsonl')).length === 0,
    `the state file must be a dotfile and the spill dir must gain no listed entry: ${JSON.stringify(readdirSync(dir))}`);
  writeFileSync(stateA, JSON.stringify({ p: fileA, t: Date.now() - 3 * 60 * 60 * 1000 }));
  check('r6-ttl-expiry-full-block', isFull(profile(fileA)), 'a stamp older than the TTL must re-print the full block');
  check('r6-ttl-rearmed', isReminder(profile(fileA)), 'and the fresh stamp must suppress again');

  // corruption / a foreign path behind the same name → full block (never strand the model)
  for (const [label, body] of [['truncated', '{"p":"'], ['garbage', 'not json at all'], ['empty', ''], ['other-path', JSON.stringify({ p: '/somewhere/else.jsonl', t: Date.now() })], ['no-stamp', JSON.stringify({ p: fileA })]]) {
    writeFileSync(stateA, body);
    check(`r6-corrupt-state-full-block:${label}`, isFull(profile(fileA)), `an unusable state file must fall back to the full block (${label})`);
  }

  // the switch: 0/false/no/off disable the suppression entirely
  check('r6-switch-off-always-full', isFull(profile(fileA, { FND_WHALE_GUIDE: '0' })) && isFull(profile(fileA, { FND_WHALE_GUIDE: '0' })),
    'FND_WHALE_GUIDE=0 must print the full block every time');
  check('r6-switch-on-still-suppresses', isReminder(profile(fileA, { FND_WHALE_GUIDE: '1' })),
    'FND_WHALE_GUIDE=1 (or unset) keeps the one-shot behavior');
  {
    const prev = process.env.FND_WHALE_GUIDE;
    const states = {};
    for (const v of ['0', 'false', 'NO', 'off', ' 0 ']) { process.env.FND_WHALE_GUIDE = v; states[v] = T.whaleGuideEnabled(); }
    for (const v of ['1', 'true', 'on', '', 'junk']) { process.env.FND_WHALE_GUIDE = v; states[`+${v}`] = T.whaleGuideEnabled(); }
    delete process.env.FND_WHALE_GUIDE;
    states['+unset'] = T.whaleGuideEnabled();
    if (prev === undefined) delete process.env.FND_WHALE_GUIDE; else process.env.FND_WHALE_GUIDE = prev;
    eq('r6-switch-parsing', Object.entries(states).map(([k, v]) => `${k}=${v}`).join(' '),
      '0=false false=false NO=false off=false  0 =false +1=true +true=true +on=true +=true +junk=true +unset=true');
  }

  // an unwritable state location must not break the profile — it just always prints the full block
  {
    const roDir = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-whalero-')), 'not-a-dir');
    writeFileSync(roDir, 'x'); // a FILE used as the spill dir → mkdir/write both fail
    check('r6-unwritable-state-full-block', T.whaleGuideFullBlock(path.join(roDir, 'sub'), fileA) === true,
      'a state file that cannot be written falls back to the full block, never to silence');
  }

  // the sweep prunes stale hint files (they are pure hints) while keeping fresh ones
  {
    const swDir = mkdtempSync(path.join(tmpdir(), 'jslim-whalesweep-'));
    const stale = T.whaleGuideStatePath(swDir, '/tmp/stale.jsonl');
    const fresh = T.whaleGuideStatePath(swDir, '/tmp/fresh.jsonl');
    writeFileSync(stale, '{}'); writeFileSync(fresh, '{}');
    const old = Date.now() / 1000 - 40 * 3600;
    utimesSync(stale, old, old);
    J.sweepSpills(swDir);
    check('r6-stale-state-swept', !existsSync(stale) && existsSync(fresh),
      'the TTL sweep must prune stale whale-guide hints and keep fresh ones');
    rmSync(swDir, { recursive: true, force: true });
  }

  // The reminder must stand ALONE: the reader of a repeat profile may not hold the first block (a
  // spawned subagent inherits the session id, a /compact drops the earlier transcript, concurrent
  // runs race the stamp), so the per-file FACTS — path, rows, sed/grep forms — ride on every one.
  check('r6-reminder-self-sufficient',
    ["sed -n '<N>p'", 'grep <pattern>', 'FND_WHALE_GUIDE=0', 'never pull the file into context'].every((s) => T.whaleReminder(fileA, 40, 0).includes(s)),
    `the reminder must carry the single-row commands, the don't-read-it imperative, and the switch on its own:\n${T.whaleReminder(fileA, 40, 0)}`);

  // A fenced JSONL spill (the M11 shape) — the fence OFFSET is a per-file fact, not guidance prose:
  // dropping it on the repeat would make every `sed -n '<row>p'` off by the wrapper lines, silently.
  {
    const fdir = mkdtempSync(path.join(tmpdir(), 'jslim-whalefence-'));
    const fenced = path.join(fdir, 'fenced.jsonl');
    writeFileSync(fenced, `Script ran on page and returned:\n\`\`\`json\n${rows(40, 'f').trimEnd()}\n\`\`\`\n`);
    const one = profile(fenced, { FND_MCP_SLIM_DIR: fdir });
    const two = profile(fenced, { FND_MCP_SLIM_DIR: fdir });
    check('r6-fence-first-run-offset', isFull(one) && /row number \+ 2/.test(one), `the fenced first run must state the offset:\n${one}`);
    check('r6-fence-reminder-keeps-offset', isReminder(two) && /row number \+ 2/.test(two) && two.includes("sed -n '<N>p'"),
      `the reminder must repeat the fence offset — a sed line number is unusable without it:\n${two}`);
    check('r6-reminder-single-line', two.trimEnd().split('\n').filter((l) => l.startsWith('json-slim: profile only')).length === 1 &&
      /json-slim: profile only —[^\n]*$/.test(two.trimEnd()), `the reminder must stay one line:\n${two}`);
    rmSync(fdir, { recursive: true, force: true });
  }

  // The state key is the RESOLVED path: two different files spelled the same relatively (`data.jsonl`
  // in two cwds) must each get their own block — sharing one entry also defeats the `st.p` guard,
  // because both strings are identical.
  {
    const cdir = mkdtempSync(path.join(tmpdir(), 'jslim-whalecwd-'));
    const state = path.join(cdir, 'state');
    mkdirSync(state); // a profile run never creates the spill tree itself
    mkdirSync(path.join(cdir, 'a')); mkdirSync(path.join(cdir, 'b'));
    writeFileSync(path.join(cdir, 'a', 'data.jsonl'), rows(30, 'a'));
    writeFileSync(path.join(cdir, 'b', 'data.jsonl'), rows(30, 'b'));
    const rel = (sub) => spawnSync('node', [SLIM, 'data.jsonl'],
      { cwd: path.join(cdir, sub), encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: state } }).stdout;
    check('r6-relative-path-not-shared', isFull(rel('a')) && isFull(rel('b')) && isReminder(rel('a')),
      'two different files spelled `data.jsonl` from different cwds must not share one suppression entry');
    rmSync(cdir, { recursive: true, force: true });
  }

  // A stamp from the FUTURE (clock stepped back by an NTP correction / VM resume) must not suppress
  // until the sweep happens to prune it: a negative age is unexpected content, so → full block.
  writeFileSync(stateA, JSON.stringify({ p: fileA, t: Date.now() + 10 * 24 * 60 * 60 * 1000 }));
  check('r6-future-stamp-full-block', isFull(profile(fileA)), 'a future-dated stamp must fall back to the full block, not suppress forever');

  // The DECISION never writes the stamp — it lands only after the block reached stdout
  // (emitProfile order). A regression that re-merges the stamp into the decision would record
  // blocks a broken pipe (`| head -1`) never delivered.
  {
    const sdir = mkdtempSync(path.join(tmpdir(), 'jslim-whalestamp-'));
    const sfile = path.join(sdir, 'stamp.jsonl');
    writeFileSync(sfile, rows(30, 's'));
    const sstate = T.whaleGuideStatePath(sdir, sfile);
    check('r6-decision-does-not-stamp', T.whaleGuideFullBlock(sdir, sfile) === true && !existsSync(sstate),
      'whaleGuideFullBlock must decide only — no state file may appear before the block is delivered');
    T.whaleGuideStamp(sdir, sfile);
    check('r6-stamp-then-suppresses', existsSync(sstate) && T.whaleGuideFullBlock(sdir, sfile) === false,
      'whaleGuideStamp must write the state that the next decision honors');
    rmSync(sdir, { recursive: true, force: true });
  }

  // A profile run must not MATERIALIZE the spill tree (a typo'd FND_MCP_SLIM_DIR would silently
  // create directories; at HEAD a profile run created nothing). No root → no stamp → always full.
  {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-whalemiss-')), 'nx', 'a', 'b');
    const mfile = path.join(tmpdir(), `jslim-whalemiss-feed-${process.pid}.jsonl`);
    writeFileSync(mfile, rows(30, 'm'));
    const m1 = profile(mfile, { FND_MCP_SLIM_DIR: missing });
    const m2 = profile(mfile, { FND_MCP_SLIM_DIR: missing });
    check('r6-missing-dir-not-created', !existsSync(missing) && isFull(m1) && isFull(m2),
      'a profile run must never create the spill tree; without it every run prints the full block');
    rmSync(mfile, { force: true });
  }

  // A planted symlink at the (predictable) state name must be neither READ through nor WRITTEN
  // through: the read opens O_NOFOLLOW (→ full block), the stamp's rename replaces the LINK
  // itself, and the link's target survives byte-identical.
  {
    const ldir = mkdtempSync(path.join(tmpdir(), 'jslim-whalelink-'));
    const lfile = path.join(ldir, 'link.jsonl');
    writeFileSync(lfile, rows(30, 'l'));
    const victim = path.join(ldir, 'victim.txt');
    writeFileSync(victim, 'IMPORTANT VICTIM CONTENT');
    const lstate = T.whaleGuideStatePath(ldir, lfile);
    symlinkSync(victim, lstate);
    const l1 = profile(lfile, { FND_MCP_SLIM_DIR: ldir });
    check('r6-symlink-state-not-followed',
      isFull(l1) && readFileSync(victim, 'utf8') === 'IMPORTANT VICTIM CONTENT' && !lstatSync(lstate).isSymbolicLink(),
      'a planted symlink must not be read through or overwritten through; the stamp replaces the link itself');
    check('r6-symlink-replaced-then-suppresses', isReminder(profile(lfile, { FND_MCP_SLIM_DIR: ldir })),
      'after the link is replaced by a real stamp the suppression works normally');
    rmSync(ldir, { recursive: true, force: true });
  }

  // A consumer that stops reading (`| head -1`) closes the pipe while the guidance write is
  // still queued; the EPIPE surfaces on a later tick, and with the stamp callback keeping the
  // event loop alive it crashed the CLI (unhandled 'error' on stdout) after the consumer had
  // its bytes. Truncation by the reader must be a quiet success: exit 0, no stack on stderr.
  // (When the race resolves the other way the write just succeeds — same observable result.)
  // Spawns bash (the suite's only shell dependency) — a real pipe and PIPESTATUS are the point.
  {
    const pdir = mkdtempSync(path.join(tmpdir(), 'jslim-whalepipe-'));
    const pfile = path.join(pdir, 'pipe.jsonl');
    writeFileSync(pfile, rows(500, 'p'));
    const r = spawnSync('bash', ['-c', `node "$1" "$2" | head -1; echo "\${PIPESTATUS[0]}"`, '--', SLIM, pfile],
      { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: pdir } });
    const plines = r.stdout.trim().split('\n');
    check('r6-broken-pipe-no-crash',
      plines.pop() === '0' && /"profile":true/.test(plines[0] || '') && !/EPIPE|Unhandled 'error'/.test(r.stderr),
      `a broken pipe must exit 0 AFTER the consumer got its line, with a quiet stderr, got stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    rmSync(pdir, { recursive: true, force: true });
  }

  // `guide` on the debug line — the field --report needs to measure how often suppression fires and
  // to catch an always-suppress regression in the field.
  {
    const ddir = mkdtempSync(path.join(tmpdir(), 'jslim-whaledbg-'));
    const dfile = path.join(ddir, 'dbg.jsonl');
    writeFileSync(dfile, rows(40, 'd'));
    profile(dfile, { FND_MCP_SLIM_DIR: ddir, FND_MCP_SLIM_DEBUG: '2' });
    profile(dfile, { FND_MCP_SLIM_DIR: ddir, FND_MCP_SLIM_DEBUG: '2' });
    const lines = readFileSync(path.join(ddir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    eq('r6-debug-guide-field', lines.filter((l) => l.profile).map((l) => l.guide).join(','), 'full,reminder');
    rmSync(ddir, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------- B2: the CLI's no-gain re-run guards (slim-out + memo) --
// A live week: 22 CLI runs re-slimmed files that could not shrink — json-slim's own Gate-A output spills
// and files a previous run had already declined — each re-printing the WHOLE file for 0 gain. The guards
// answer those in one line. Pinned in both directions: the refusals must fire on a repeat, and they must
// NEVER fire on a narrowing `--jq` (the documented recovery), on a changed file, or on a first run.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-b2-'));
  // The unique-entities shape the crushability gate skips by design (see b4.11) — the one payload this
  // suite knows json-slim declines, at any size, without a stage running.
  const entities = (n) => JSON.stringify({
    products: Array.from({ length: n }, (_, i) => ({
      id: `gid://shopify/Product/${7000000000 + i}`,
      handle: `product-handle-${i}`,
      title: `Product Title Number ${i}`,
      url: `https://shop.example.com/products/product-handle-${i}`,
    })),
  });
  // One pinned session id for the whole block, set on THIS process so the children inherit it and
  // T.nogainStatePath() computes the same key the CLI does — a developer's real session id would
  // otherwise make every planted-state case address a file the CLI never reads.
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'b2-fixture-session';
  const run = (args, env) => spawnSync('node', [SLIM, ...args],
    { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, ...(env || {}) } });
  const isRefusal = (r) => r.status === 0 && /^json-slim: /.test(r.stdout) && r.stdout.trimEnd().split('\n').length === 1;
  const debugLines = (d) => readFileSync(path.join(d, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // 1 — json-slim's OWN Gate-A output spill: already slimmed, so the run is refused before the body is
  // ever read. Only this prefix; a spilled ORIGINAL (fnd-mcp-slim-) is exactly what the CLI is for.
  {
    const sdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2out-'));
    const body = entities(60);
    const slimOut = path.join(sdir, 'fnd-slim-out-deadbeefdeadbeef.json');
    const original = path.join(sdir, 'fnd-mcp-slim-deadbeefdeadbeef.json');
    writeFileSync(slimOut, body); writeFileSync(original, body);
    const r = run([slimOut], { FND_MCP_SLIM_DIR: sdir, FND_MCP_SLIM_DEBUG: '2' });
    check('b2-slim-out-refused', isRefusal(r) && r.stdout.includes("IS json-slim's own slimmed output")
      && r.stdout.includes(`${Buffer.byteLength(body)} B`) && !r.stdout.includes('gid://'),
      `a fnd-slim-out-* file must be refused in one line, never re-printed:\n${r.stdout.slice(0, 300)}`);
    const orig = run([original], { FND_MCP_SLIM_DIR: sdir, FND_MCP_SLIM_DEBUG: '2' });
    check('b2-spilled-original-not-refused', orig.stdout === `${body}\n`,
      'a spilled ORIGINAL (fnd-mcp-slim-) is the intended CLI input and must never be refused');
    // …and the narrowing recovery the refusal itself advertises still works on the same file
    const nq = run(['--jq', 'products.0.handle', slimOut], { FND_MCP_SLIM_DIR: sdir, FND_MCP_SLIM_DEBUG: '2' });
    eq('b2-slim-out-jq-bypasses', nq.stdout.trim(), '"product-handle-0"');
    eq('b2-slim-out-debug', debugLines(sdir).map((l) => `${l.reason}${l.narrowed ? '+narrowed' : ''}`),
      ['already-slim-out', 'no-gain', 'no-gain+narrowed']);
    // …and the off switch reaches this refusal too — it names FND_NOGAIN_MEMO=0, so that must WORK
    const forced = run([slimOut], { FND_MCP_SLIM_DIR: sdir, FND_NOGAIN_MEMO: '0' });
    check('b2-slim-out-switch-forces-run', forced.stdout === `${body}\n` && r.stdout.includes('FND_NOGAIN_MEMO=0'),
      'the slim-out refusal must advertise the switch that overrides it, and the switch must run the file');
    rmSync(sdir, { recursive: true, force: true });
  }

  // 1b — Layer 1 stops at the stream gate: past it the file belongs to Gate B, whose big-document
  // guidance (`head -c`, split into rows) is the only usable advice for a file json-slim will not load
  // whole. The refusal's `--jq` hint would send the reader into streamJqRefusal instead.
  {
    const gdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2gate-'));
    const huge = path.join(gdir, 'fnd-slim-out-cafebabecafebabe.json');
    // one line, > 8 MB, NOT a JSONL row stream — the shape Gate B answers with bigDocNotice
    writeFileSync(huge, `[${Array.from({ length: 150000 }, (_, i) => `{"id":${i},"handle":"product-handle-${i}","vendor":"MAC"}`).join(',')}]`);
    const r = run([huge], { FND_MCP_SLIM_DIR: gdir });
    check('b2-slim-out-over-stream-gate', statSync(huge).size > 8 * 1024 * 1024
      && r.stdout.includes('is NOT a JSONL row stream') && !r.stdout.includes("IS json-slim's own slimmed output"),
      `a fnd-slim-out-* spill past the stream gate must keep Gate B's answer:\n${r.stdout.slice(0, 300)}`);
    rmSync(gdir, { recursive: true, force: true });
  }

  // 2 — the memo lifecycle on a ≥4 KB incompressible file: body + the loud decline, then a one-line
  // refusal, then the body again once the file itself changes (the stamp pins size+mtime).
  const big = path.join(dir, 'unique-entities.json');
  const bigBody = entities(60);
  writeFileSync(big, bigBody);
  const first = run([big], { FND_MCP_SLIM_DEBUG: '2' });
  check('b2-first-run-prints-body', first.stdout === `${bigBody}\n`, 'the first run still hands the declined payload back byte-identical');
  check('b2-first-run-says-decline', /deliberate decline, not an error/.test(first.stderr) && /Do NOT re-run json-slim/.test(first.stderr)
    && first.stderr.includes(`${Buffer.byteLength(bigBody)} B printed unchanged`),
    `the decline must be stated on stderr — the field pattern was "decline → immediate re-run":\n${JSON.stringify(first.stderr)}`);
  const second = run([big], { FND_MCP_SLIM_DEBUG: '2' });
  check('b2-second-run-refused', isRefusal(second) && second.stdout.includes('already passed through uncompressed this session')
    && second.stdout.includes('FND_NOGAIN_MEMO=0') && !second.stdout.includes('gid://'),
    `a repeat run must answer in one line, naming the recoveries and the off switch:\n${second.stdout.slice(0, 300)}`);
  const memoState = T.nogainStatePath(dir, big);
  check('b2-state-is-a-dotfile', path.basename(memoState).startsWith('.')
    && readdirSync(dir).filter((f) => !f.startsWith('.') && f !== 'unique-entities.json' && f !== 'fnd-mcp-slim-debug.log').length === 0,
    `the memo state must be a dotfile and add no listed entry: ${JSON.stringify(readdirSync(dir))}`);
  // A file rewritten between runs may well compress — the stamp's size+mtime pin must let it through
  const touched = Date.now() / 1000 + 5;
  utimesSync(big, touched, touched);
  const third = run([big], { FND_MCP_SLIM_DEBUG: '2' });
  check('b2-changed-file-invalidates', third.stdout === `${bigBody}\n`, 'a changed mtime must invalidate the memo, not refuse the new bytes');
  eq('b2-memo-debug-reasons', debugLines(dir).map((l) => l.reason), ['no-gain', 'no-gain-memo', 'no-gain']);
  const memoLine = debugLines(dir)[1];
  check('b2-memo-debug-bytes', memoLine.bytes_in === Buffer.byteLength(bigBody) && memoLine.bytes_out < 400 && memoLine.decision === 'passthrough',
    `the refusal must log the file it did NOT print and the few bytes it did: ${JSON.stringify(memoLine)}`);

  // 3 — the off switch: with FND_NOGAIN_MEMO=0 both runs print the body, whatever state exists on disk
  {
    const odir = mkdtempSync(path.join(tmpdir(), 'jslim-b2off-'));
    const f = path.join(odir, 'off.json');
    writeFileSync(f, bigBody);
    const a = run([f], { FND_MCP_SLIM_DIR: odir, FND_NOGAIN_MEMO: '0' });
    const b = run([f], { FND_MCP_SLIM_DIR: odir, FND_NOGAIN_MEMO: '0' });
    check('b2-switch-off-never-refuses', a.stdout === `${bigBody}\n` && b.stdout === `${bigBody}\n`,
      'FND_NOGAIN_MEMO=0 must keep both runs printing the body');
    // …and the switch parses like FND_WHALE_GUIDE's (the shared falsey vocabulary)
    const prev = process.env.FND_NOGAIN_MEMO;
    const states = {};
    for (const v of ['0', 'false', 'NO', 'off', ' 0 ']) { process.env.FND_NOGAIN_MEMO = v; states[v] = T.nogainMemoEnabled(); }
    for (const v of ['1', 'true', 'on', '', 'junk']) { process.env.FND_NOGAIN_MEMO = v; states[`+${v}`] = T.nogainMemoEnabled(); }
    delete process.env.FND_NOGAIN_MEMO;
    states['+unset'] = T.nogainMemoEnabled();
    if (prev === undefined) delete process.env.FND_NOGAIN_MEMO; else process.env.FND_NOGAIN_MEMO = prev;
    eq('b2-switch-parsing', Object.entries(states).map(([k, v]) => `${k}=${v}`).join(' '),
      '0=false false=false NO=false off=false  0 =false +1=true +true=true +on=true +=true +junk=true +unset=true');
    rmSync(odir, { recursive: true, force: true });
  }

  // 4 — a narrowing `--jq` with a LIVE memo: narrowing is the recovery the refusal advertises, so it
  // must answer the sub-path. The identity selector is NOT narrowing — it re-dumps, so it is refused.
  {
    const jdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2jq-'));
    const f = path.join(jdir, 'memo-jq.json');
    writeFileSync(f, bigBody);
    run([f], { FND_MCP_SLIM_DIR: jdir }); // arm the memo
    const narrow = run(['--jq', 'products.1.handle', f], { FND_MCP_SLIM_DIR: jdir });
    eq('b2-jq-bypasses-memo', narrow.stdout.trim(), '"product-handle-1"');
    check('b2-jq-quiet-under-memo', narrow.stderr === '', `a narrowed run answers a sub-path — no decline notice: ${JSON.stringify(narrow.stderr)}`);
    check('b2-identity-jq-still-refused', isRefusal(run(['--jq', '.', f], { FND_MCP_SLIM_DIR: jdir })),
      "`--jq .` narrows nothing and re-dumps the whole file, so the memo must still answer it");
    rmSync(jdir, { recursive: true, force: true });
  }

  // 4b — the bypass that is not `--jq`. `--stats` is a MEASUREMENT run that hooks/mcp-whale.md
  // promises will report the 0.0 %; a refusal answers it with no measurement at all.
  {
    const fdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2flags-'));
    const f = path.join(fdir, 'flags.json');
    writeFileSync(f, bigBody);
    run([f], { FND_MCP_SLIM_DIR: fdir }); // arm the memo with a PLAIN decline
    const stats = run(['--stats', f], { FND_MCP_SLIM_DIR: fdir });
    check('b2-stats-bypasses-memo', stats.stdout === `${bigBody}\n` && /0\.0% reduction/.test(stats.stderr),
      `--stats must still measure the decline it is asked about: ${JSON.stringify(stats.stderr)}`);
    rmSync(fdir, { recursive: true, force: true });
  }

  // 4c — an identity `--jq .` prints a RE-SERIALIZED value, not the file's bytes: a pretty-printed file
  // re-serializes 20.4 % smaller, so that run reports 0 % while a PLAIN run on the same file would have
  // saved exactly those bytes. Stamping it blocked the win it measured against different input.
  {
    const rdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2reser-'));
    const pretty = path.join(rdir, 'pretty.json');
    const prettyBody = JSON.stringify(JSON.parse(bigBody), null, 2);
    writeFileSync(pretty, prettyBody);
    const ident = run(['--jq', '.', pretty], { FND_MCP_SLIM_DIR: rdir });
    check('b2-identity-jq-declines-reserialized', ident.stdout === `${bigBody}\n`,
      'the identity selector re-serializes: it prints the compact value, not the pretty file');
    check('b2-identity-jq-does-not-stamp', readdirSync(rdir).every((n) => !n.startsWith('.fnd-nogain-')),
      `a re-serialized decline must not speak for the file's own bytes: ${JSON.stringify(readdirSync(rdir))}`);
    const plain = run([pretty], { FND_MCP_SLIM_DIR: rdir });
    check('b2-plain-run-after-identity-jq-compresses',
      !isRefusal(plain) && plain.stdout === `${bigBody}\n` && Buffer.byteLength(plain.stdout) < Buffer.byteLength(prettyBody),
      `the plain run must still deliver its 20.4 %: ${plain.stdout.slice(0, 160)}`);
    check('b2-compressing-run-does-not-stamp', readdirSync(rdir).every((n) => !n.startsWith('.fnd-nogain-')),
      'a run that COMPRESSED is not a decline and must leave no memo');
    rmSync(rdir, { recursive: true, force: true });
  }

  // 5 — under the floor a refusal saves nothing, so a small decline is never remembered
  {
    const tdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2small-'));
    const f = path.join(tdir, 'small.json');
    const small = entities(15); // 2,459 B — below NOGAIN_FLOOR_BYTES
    writeFileSync(f, small);
    const a = run([f], { FND_MCP_SLIM_DIR: tdir });
    const b = run([f], { FND_MCP_SLIM_DIR: tdir });
    check('b2-below-floor-no-memo', Buffer.byteLength(small) < 4096 && a.stdout === `${small}\n` && b.stdout === `${small}\n`
      && readdirSync(tdir).every((n) => !n.startsWith('.fnd-nogain-')),
      `a sub-4 KB decline must neither refuse nor leave state: ${JSON.stringify(readdirSync(tdir))}`);
    check('b2-below-floor-still-loud', /deliberate decline/.test(b.stderr), 'the stderr notice is not floored — it is what stops the re-run');
    rmSync(tdir, { recursive: true, force: true });
  }

  // 6 — unusable state → do the WORK (a wrong refusal hides the file; a wrong run only costs what it
  // cost the first time). Corruption, a foreign path behind the hash name, a stale stamp, a stamp from
  // the FUTURE (clock stepped back by NTP / a VM resume), and a stat that no longer matches.
  {
    const cdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2corrupt-'));
    const f = path.join(cdir, 'corrupt.json');
    writeFileSync(f, bigBody);
    const st = statSync(f);
    const state = T.nogainStatePath(cdir, f);
    const stamps = {
      truncated: '{"p":"',
      garbage: 'not json at all',
      empty: '',
      'other-path': JSON.stringify({ p: '/somewhere/else.json', t: Date.now(), size: st.size, mtimeMs: st.mtimeMs }),
      'no-stamp': JSON.stringify({ p: f, size: st.size, mtimeMs: st.mtimeMs }),
      expired: JSON.stringify({ p: f, t: Date.now() - 3 * 60 * 60 * 1000, size: st.size, mtimeMs: st.mtimeMs }),
      future: JSON.stringify({ p: f, t: Date.now() + 10 * 24 * 60 * 60 * 1000, size: st.size, mtimeMs: st.mtimeMs }),
      'stale-size': JSON.stringify({ p: f, t: Date.now(), size: st.size - 1, mtimeMs: st.mtimeMs }),
      'stale-mtime': JSON.stringify({ p: f, t: Date.now(), size: st.size, mtimeMs: st.mtimeMs + 1000 }),
    };
    for (const [label, body] of Object.entries(stamps)) {
      writeFileSync(state, body);
      check(`b2-unusable-state-runs:${label}`, run([f], { FND_MCP_SLIM_DIR: cdir }).stdout === `${bigBody}\n`,
        `an unusable memo must fall back to the normal run (${label})`);
    }
    // the same state written HONESTLY does refuse — otherwise every case above passes on a broken key
    writeFileSync(state, JSON.stringify({ p: f, t: Date.now(), size: st.size, mtimeMs: st.mtimeMs }));
    check('b2-valid-state-refuses', isRefusal(run([f], { FND_MCP_SLIM_DIR: cdir })),
      'a valid stamp for the unchanged file must refuse — the control for the fallback cases above');
    // a planted symlink at the (predictable) state name is neither read through nor written through
    const victim = path.join(cdir, 'victim.txt');
    writeFileSync(victim, 'IMPORTANT VICTIM CONTENT');
    rmSync(state, { force: true });
    symlinkSync(victim, state);
    const linked = run([f], { FND_MCP_SLIM_DIR: cdir });
    check('b2-symlink-state-not-followed',
      linked.stdout === `${bigBody}\n` && readFileSync(victim, 'utf8') === 'IMPORTANT VICTIM CONTENT' && !lstatSync(state).isSymbolicLink(),
      'the O_NOFOLLOW read falls through to the work, and the stamp replaces the LINK, never its target');
    rmSync(cdir, { recursive: true, force: true });
  }

  // 7 — the sweep prunes aged memo dotfiles (they are pure hints) and keeps fresh ones
  {
    const swDir = mkdtempSync(path.join(tmpdir(), 'jslim-b2sweep-'));
    const stale = T.nogainStatePath(swDir, '/tmp/stale-nogain.json');
    const fresh = T.nogainStatePath(swDir, '/tmp/fresh-nogain.json');
    writeFileSync(stale, '{}'); writeFileSync(fresh, '{}');
    const old = Date.now() / 1000 - 40 * 3600;
    utimesSync(stale, old, old);
    J.sweepSpills(swDir);
    check('b2-stale-memo-swept', !existsSync(stale) && existsSync(fresh),
      'the TTL sweep must prune stale no-gain memos and keep fresh ones');
    rmSync(swDir, { recursive: true, force: true });
  }

  // 8 — `--report`: a refusal printed ONE line, so it is not a context dump ("gained nothing" must not
  // count it) — and it gets its own count, since "how often did the guard fire" is the tax it removed.
  {
    const ev = (extra) => JSON.stringify({ ts: '2026-08-01T10:00:00.000Z', project: 'elc', lvl: 2, entry: 'cli', decision: 'passthrough', bytes_in: 40000, bytes_out: 40000, pct: 0, stages: [], spill: null, ...extra });
    const rep = J.buildReport([
      ev({ tool: '/tmp/a.json', reason: 'no-gain' }),
      ev({ tool: '/tmp/b.json', reason: 'no-gain-memo', bytes_out: 318 }),
      ev({ tool: '/tmp/fnd-slim-out-c.json', reason: 'already-slim-out', bytes_out: 214 }),
    ], { file: '/tmp/x.log' });
    check('b2-report-counts-refusals', rep.includes('1 gained nothing') && rep.includes('2 refused by the no-gain/slim-out guard (no body printed)'),
      `only the real re-dump may count as "gained nothing", and both refusals must be counted:\n${rep}`);
    check('b2-report-lists-reasons', /passthrough reasons:.*no-gain-memo/.test(rep) && /passthrough reasons:.*already-slim-out/.test(rep),
      `the refusal reasons ride on the reasons map with no extra work:\n${rep}`);
    const clean = J.buildReport([ev({ tool: '/tmp/a.json', reason: 'no-gain' })], { file: '/tmp/x.log' });
    check('b2-report-omits-fragment-when-zero', !clean.includes('refused by the no-gain/slim-out guard'),
      `a log with no refusals must not grow the cli line:\n${clean}`);
  }

  // 9 — the split the shared state-file helper introduces. stateRead() answers null on every fault and
  // never a caller's ANSWER: what null PRINTS is a one-line literal at each call site, and the two
  // literals point OPPOSITE ways — the guide prints MORE, the memo does the WORK. No existing row can
  // see that split (each side only ever exercised its own copy of the machinery), so pin both
  // directions independently, through two different faults, plus the record shape and the write order.
  {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'jslim-state-nx-')), 'nx', 'a', 'b');
    check('state-safe-direction-guide', T.whaleGuideFullBlock(missing, big) === true && !existsSync(missing),
      "the guide's safe direction is PRINT the full block: a state root that does not exist must not suppress, and must not be created");
  }
  {
    const mdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2nostate-'));
    const f = path.join(mdir, 'nostate.json');
    writeFileSync(f, bigBody);
    const missing = path.join(mdir, 'nx', 'root');
    const a = run([f], { FND_MCP_SLIM_DIR: missing });
    const b = run([f], { FND_MCP_SLIM_DIR: missing });
    check('state-safe-direction-memo',
      a.stdout === `${bigBody}\n` && b.stdout === `${bigBody}\n`
      && /deliberate decline, not an error/.test(a.stderr) && /deliberate decline, not an error/.test(b.stderr)
      && !existsSync(path.join(mdir, 'nx')),
      `the memo's safe direction is DO THE WORK: with no state root BOTH runs must print the body and the decline notice, and neither may create the root: ${JSON.stringify(readdirSync(mdir))}`);
    rmSync(mdir, { recursive: true, force: true });
  }
  // the mirror fault: a root that EXISTS but cannot be written, so stateRead's open failure and
  // stateWrite's write failure are both exercised rather than only `existsSync` answering false.
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    const rdir = mkdtempSync(path.join(tmpdir(), 'jslim-b2ro-'));
    const f = path.join(rdir, 'ro.json');
    writeFileSync(f, bigBody);
    const root = path.join(rdir, 'state');
    mkdirSync(root);
    chmodSync(root, 0o500); // searchable, NOT writable
    const a = run([f], { FND_MCP_SLIM_DIR: root });
    const b = run([f], { FND_MCP_SLIM_DIR: root });
    check('state-safe-direction-memo-unwritable',
      a.stdout === `${bigBody}\n` && b.stdout === `${bigBody}\n` && readdirSync(root).length === 0,
      `an unwritable state root must still print the body on every run and leave no state: ${JSON.stringify(readdirSync(root))}`);
    chmodSync(root, 0o700);
    rmSync(rdir, { recursive: true, force: true });
  }
  {
    const sdir = mkdtempSync(path.join(tmpdir(), 'jslim-state-shape-'));
    const f = path.join(sdir, 'shape.json');
    writeFileSync(f, bigBody);
    T.whaleGuideStamp(sdir, f);
    run([f], { FND_MCP_SLIM_DIR: sdir }); // a plain decline arms the memo
    const gRec = JSON.parse(readFileSync(T.whaleGuideStatePath(sdir, f), 'utf8'));
    const nRec = JSON.parse(readFileSync(T.nogainStatePath(sdir, f), 'utf8'));
    eq('state-record-shapes-differ', `${Object.keys(gRec).sort().join(',')} | ${Object.keys(nRec).sort().join(',')}`,
      'p,t | mtimeMs,p,size,t');
    rmSync(sdir, { recursive: true, force: true });
  }
  {
    const base = mkdtempSync(path.join(tmpdir(), 'jslim-state-mkdir-'));
    const f = path.join(base, 'mk.json');
    writeFileSync(f, bigBody);
    const missing = path.join(base, 'nx', 'root');
    T.whaleGuideStamp(missing, f);
    const r = run([f], { FND_MCP_SLIM_DIR: missing });
    check('state-stamp-never-mkdirs', !existsSync(path.join(base, 'nx')) && r.stdout === `${bigBody}\n`,
      `neither stamp may materialize the spill tree — a typo'd FND_MCP_SLIM_DIR must not grow directories: ${JSON.stringify(readdirSync(base))}`);
    rmSync(base, { recursive: true, force: true });
  }
  {
    const tdir = mkdtempSync(path.join(tmpdir(), 'jslim-state-tmp-'));
    // the stamp's `extra()` stats the file it pins; point it at a path that is not there, so the
    // record cannot be built. Built FIRST, before the tmp is minted → nothing is left behind.
    T.nogainStamp(tdir, path.join(tdir, 'gone.json'));
    check('state-stamp-no-orphan-tmp', readdirSync(tdir).length === 0,
      `the record is built before the tmp is minted, so a stat failure leaves nothing on disk (HEAD's nogainStamp order): ${JSON.stringify(readdirSync(tdir))}`);
    rmSync(tdir, { recursive: true, force: true });
  }
  if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
  rmSync(dir, { recursive: true, force: true });
}

// ==================================== M14 — the MCP text-block envelope rail (the CLI blind spot) ==
// The mcp-slim hook spills a whale ORIGINAL as the MCP content-block envelope, so the payload is a
// JSON-encoded STRING in `[0].text`. The hook unwraps that structurally (it slims each block's text);
// the CLI — the recovery path the stub guidance points the model at — did not: a plain run found
// nothing to compress in a 1-element array and printed the whole file back at 0 %, and no `--jq` path
// could reach the payload (the walk cannot descend into an escaped string). These cases pin the rail
// that unwraps it, and the three places it must NOT fire: an impure envelope, an incompressible inner,
// and the identity selector.
{
  const ENV_FIX = path.join(FIX, 'mcp-envelope-jira.json');
  const envRaw = readFileSync(ENV_FIX, 'utf8');
  const innerRaw = JSON.parse(envRaw)[0].text;
  const wrap = (text) => JSON.stringify([{ type: 'text', text }]);
  // Tolerant, so a rail that regresses into a DECLINE (stdout = the file back, or a memo refusal line)
  // reports a named failure here instead of throwing out of the suite.
  const parseOut = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

  // ---- envelopeInner: the purity gate and what counts as an inner payload
  eq('m14-inner-array-shape', T.envelopeInner(JSON.parse(wrap('{"a":1}'))), { text: '{"a":1}', value: { a: 1 } });
  eq('m14-inner-lone-block', T.envelopeInner({ type: 'text', text: '{"a":1}' }), { text: '{"a":1}', value: { a: 1 } });
  eq('m14-inner-content-shape', T.envelopeInner({ content: [{ type: 'text', text: '{"a":1}' }] }), { text: '{"a":1}', value: { a: 1 } });
  // …and the shapes that are NOT an envelope for this purpose: unwrapping them would DROP a field
  // while the printed body claims to be the whole payload (the DR/M49 rule blockText already owns).
  eq('m14-inner-meta-refused', T.envelopeInner([{ type: 'text', text: '{"a":1}', _meta: { nextCursor: 'c1' } }]), null);
  eq('m14-inner-annotations-refused', T.envelopeInner([{ type: 'text', text: '{"a":1}', annotations: { audience: ['user'] } }]), null);
  eq('m14-inner-structured-refused', T.envelopeInner({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }), null);
  eq('m14-inner-mixed-blocks-refused', T.envelopeInner([{ type: 'text', text: '{"a":1}' }, { type: 'image', data: 'x' }]), null);
  // …and a MULTI-block PURE text envelope, which blockText would happily JOIN: an envelope's blocks
  // are independent results, so the join is not a document. Two compact JSON blocks read as two JSONL
  // rows and a prose+fence pair reads as one fenced payload — both describe something nobody sent.
  eq('m14-inner-two-json-blocks-refused', T.envelopeInner([{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '{"b":2}' }]), null);
  eq('m14-inner-two-fence-halves-refused',
    T.envelopeInner([{ type: 'text', text: 'Script returned:\n```json' }, { type: 'text', text: `{"rows":[1,2,3]}\n\`\`\`` }]), null);
  // the sole-block gate itself, and the join blockText keeps for the jsx stage (whose detector accepts
  // a joined text only when every signature of ONE Figma payload is in it)
  eq('m14-sole-block-lone', T.soleBlockText({ type: 'text', text: 'a' }), 'a');
  eq('m14-sole-block-one-element', T.soleBlockText([{ type: 'text', text: 'a' }]), 'a');
  eq('m14-sole-block-content-shape', T.soleBlockText({ content: [{ type: 'text', text: 'a' }] }), 'a');
  eq('m14-sole-block-two-refused', T.soleBlockText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), null);
  eq('m14-sole-block-impure-refused', T.soleBlockText([{ type: 'text', text: 'a', _meta: { nextCursor: 'c' } }]), null);
  eq('m14-blocktext-still-joins', T.blockText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  eq('m14-inner-prose-refused', T.envelopeInner(JSON.parse(wrap('PERMISSION DENIED: the token cannot read this issue'))), null);
  // a JSONL inner is deliberately outside the rail — its rows must PROFILE, and a profile's line
  // recipes cannot address lines that only exist inside an escaped string (see the M1.5 case below)
  eq('m14-inner-jsonl-refused', T.envelopeInner(JSON.parse(wrap('{"id":1}\n{"id":2}\n{"id":3}'))), null);
  // an M11-fenced inner IS a payload — the fence is the tool's prose wrapper, not the data
  const fencedBody = JSON.stringify({ rows: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `row-${i}` })) });
  eq('m14-inner-fenced', T.envelopeInner(JSON.parse(wrap(`Script ran on page and returned:\n\`\`\`json\n${fencedBody}\n\`\`\``))).value,
    JSON.parse(fencedBody));

  // ---- slim(): the win is the INNER body, measured against the ENVELOPE's bytes
  {
    const env = J.slim(envRaw, { trace: true });
    const inner = J.slim(innerRaw, { trace: true });
    check('m14-slim-unwraps', env.wasModified && env.envelopeUnwrapped === true && env.output === inner.output,
      `the printed body must be the slimmed INNER payload, never rewrapped: ${JSON.stringify(env.output.slice(0, 80))}`);
    check('m14-slim-bytes-are-the-envelope', env.bytesIn === Buffer.byteLength(envRaw, 'utf8') && env.bytesOut === inner.bytesOut,
      `bytesIn is the envelope file (what the caller would otherwise have paid): ${env.bytesIn} / ${env.bytesOut}`);
    check('m14-slim-ratio', env.ratio > 0.7, `the jira-envelope fixture must gain like the hook does: ${(env.ratio * 100).toFixed(1)} %`);
    eq('m14-slim-stage-tag', env.stages.slice(0, 2), ['envelope', 'adf']);
    eq('m14-slim-stages-off-empty', J.slim(envRaw).stages, []); // trace off ⇒ no bookkeeping, like every other stage
    // the rail is a pipeline knob like fence/jsx/log — off ⇒ exactly the pre-M14 result
    const off = J.slim(envRaw, { envelope: false });
    check('m14-slim-knob-off', off.wasModified === false && off.output === envRaw,
      'envelope:false must reproduce the old decline (the whole original, untouched)');
  }
  // an inner that does NOT slim leaves the WHOLE original envelope untouched — never a bare unwrapped
  // body, which is the :1827 decline rule the fence rail already obeys
  {
    const tiny = wrap('{"a":1}');
    const r = J.slim(tiny);
    check('m14-slim-incompressible-inner-declines', r.wasModified === false && r.output === tiny,
      `an incompressible inner keeps today's decline of the whole envelope: ${JSON.stringify(r.output)}`);
  }
  // an ERROR payload inside the envelope is handed back verbatim (write-gating reads these) — the
  // fenced-error rail's reason, one level further in
  {
    const err = wrap(JSON.stringify({ isError: true, errors: [{ message: 'permission denied' }], detail: 'x'.repeat(400) }));
    const r = J.slim(err);
    check('m14-slim-inner-error-verbatim', r.wasModified === false && r.error === true && r.reason === 'error-shape' && r.output === err,
      `an inner error envelope must not be compressed: ${JSON.stringify(r).slice(0, 160)}`);
  }
  // …and on an EXPIRED budget too: the JSON-route gate probes the envelope's inner before it may say
  // `budget-exceeded` — a reason the hook's stub guard is allowed to replace, while an error envelope
  // is verbatim by contract (b4.8-deadline-error-rail-first, one wrapping level further in).
  {
    const err = wrap(JSON.stringify({ isError: true, errors: [{ message: 'permission denied' }], detail: 'x'.repeat(400) }));
    const r = J.slim(err, { deadline: Date.now() - 1 });
    eq('m14-slim-inner-error-outlives-budget', [r.reason, r.error === true, r.output === err], ['error-shape', true, true]);
  }

  // ---- CLI
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m14-'));
  const run = (args, env) => spawnSync('node', [SLIM, ...args], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, ...(env || {}) } });
  const NOTE = /unwrapped MCP text envelope \(\[0\]\.text\)/;
  {
    const r = run(['--stats', ENV_FIX]);
    const printed = r.stdout.trim();
    check('m14-cli-prints-inner', printed === J.slim(innerRaw).output,
      `stdout must be the slimmed inner payload: ${printed.slice(0, 80)}`);
    check('m14-cli-notes-the-unwrap', NOTE.test(r.stderr) && /the original stays at/.test(r.stderr),
      `one stderr line must say the body is not the file's shape: ${JSON.stringify(r.stderr)}`);
    check('m14-cli-no-decline-notice', !/deliberate decline/.test(r.stderr),
      `the run that used to decline must no longer claim one: ${JSON.stringify(r.stderr)}`);
    // --stats speaks about the envelope FILE in → the printed body out (M1 step 2)
    const m = /json-slim: (\d+) → (\d+) bytes \(([\d.]+)% reduction\)/.exec(r.stderr);
    check('m14-cli-stats-envelope-bytes', !!m && Number(m[1]) === statSync(ENV_FIX).size && Number(m[3]) > 70,
      `--stats must measure the envelope file, not the inner: ${JSON.stringify(r.stderr)}`);
  }
  // the debug line carries the `envelope` stage, so --report can count the rail in the field
  {
    const ddir = mkdtempSync(path.join(tmpdir(), 'jslim-m14dbg-'));
    const r = spawnSync('node', [SLIM, ENV_FIX], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: ddir, FND_MCP_SLIM_DEBUG: '1' } });
    const line = JSON.parse(readFileSync(path.join(ddir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').pop());
    check('m14-cli-debug-line', line.decision === 'compressed' && line.stages[0] === 'envelope' && line.bytes_in === statSync(ENV_FIX).size,
      `${JSON.stringify(line)} / ${r.stderr}`);
    rmSync(ddir, { recursive: true, force: true });
  }
  // --jq resolves THROUGH the envelope: the live failure was `null` + "'fields' not found at top
  // level; length: 1" on every path a model could guess
  {
    const hit = run(['--jq', '.fields.summary', ENV_FIX]);
    eq('m14-jq-through-envelope', hit.stdout.trim(), JSON.stringify(JSON.parse(innerRaw).fields.summary));
    check('m14-jq-notes-the-unwrap', NOTE.test(hit.stderr) && !/--jq:/.test(hit.stderr),
      `a resolved path notes the unwrap once and raises no diagnostic: ${JSON.stringify(hit.stderr)}`);
    // back-compat: `0.text` addresses the TRANSPORT on purpose and must keep resolving on the envelope
    const bc = run(['--jq', '0.text', ENV_FIX]);
    check('m14-jq-0text-backcompat', bc.stdout.trim() === JSON.stringify(innerRaw) && !NOTE.test(bc.stderr),
      `'--jq 0.text' must resolve on the envelope, with no unwrap: ${bc.stdout.slice(0, 60)} / ${JSON.stringify(bc.stderr)}`);
    // `0` is the SAME selector one field shallower — it names the block, and the rail must not answer
    // it with the noise-stripped payload while `0.text` comes back verbatim (one spelling, two
    // meanings). A path that RESOLVED on the envelope has had the rail's one turn already.
    const zero = run(['--jq', '0', ENV_FIX]);
    const block = parseOut(zero.stdout);
    check('m14-jq-0-keeps-the-block',
      !!block && block.type === 'text' && block.text === innerRaw && !NOTE.test(zero.stderr),
      `'--jq 0' must print the block it addressed, unwrapped by nobody: ${zero.stdout.slice(0, 80)} / ${JSON.stringify(zero.stderr)}`);
    // identity is the "re-dump everything" spelling — it keeps dumping the document it was given
    const ident = run(['--jq', '.', ENV_FIX]);
    const dumped = parseOut(ident.stdout);
    check('m14-jq-identity-keeps-envelope', Array.isArray(dumped) && dumped.length === 1 && dumped[0].text === innerRaw && !NOTE.test(ident.stderr),
      `'--jq .' must not silently start answering with the payload: ${ident.stdout.slice(0, 60)} / ${JSON.stringify(ident.stderr)}`);
    // a miss at BOTH levels reports the INNER location: `length: 1` describes a wrapper nobody asked
    // about, while the payload's keys are what name the spelling to try next
    const missTop = run(['--jq', '.nosuch', ENV_FIX]);
    eq('m14-jq-double-miss-stdout', missTop.stdout.trim(), 'null');
    check('m14-jq-double-miss-inner-keys',
      /--jq: 'nosuch' not found at top level; keys: expand, id, self, key, fields/.test(missTop.stderr) && !/length: 1/.test(missTop.stderr),
      `the diagnostic must describe the payload, not the envelope: ${JSON.stringify(missTop.stderr)}`);
    const missDeep = run(['--jq', '.fields.nosuch', ENV_FIX]);
    check('m14-jq-double-miss-deep', /--jq: 'nosuch' not found at 'fields'; keys: summary, description/.test(missDeep.stderr),
      `a deep inner miss reports where it got to inside the payload: ${JSON.stringify(missDeep.stderr)}`);
  }
  // the two shapes that must keep declining, byte-for-byte
  {
    const prose = path.join(dir, 'prose-envelope.json');
    writeFileSync(prose, wrap('PERMISSION DENIED — the API token cannot read this issue. '.repeat(40)));
    const r = run([prose]);
    check('m14-cli-prose-inner-declines', r.stdout === `${readFileSync(prose, 'utf8')}\n` && !NOTE.test(r.stderr) && /deliberate decline/.test(r.stderr),
      `a prose inner keeps today's decline of the WHOLE original: ${r.stdout.length} B / ${JSON.stringify(r.stderr)}`);
    const impure = path.join(dir, 'impure-envelope.json');
    writeFileSync(impure, JSON.stringify([{ type: 'text', text: JSON.parse(envRaw)[0].text, _meta: { nextCursor: 'page-2' } }]));
    const r2 = run([impure, '--stats']);
    const kept = parseOut(r2.stdout);
    check('m14-cli-impure-envelope-not-unwrapped', !NOTE.test(r2.stderr) && !!kept && kept[0]._meta.nextCursor === 'page-2',
      `a block carrying _meta must stay with the JSON pipeline, cursor intact: ${JSON.stringify(r2.stderr)}`);
  }
  // M1.5 — a JSONL inner still PROFILES (JSONL is never crushed), but the recipes cannot point at the
  // envelope: its "lines" are one escaped string. The unwrapped body is spilled and the profile speaks
  // about THAT file, while the debug line keeps naming the argument (--report pairs whales by path).
  {
    const jdir = mkdtempSync(path.join(tmpdir(), 'jslim-m14jsonl-'));
    const rows = Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: i, handle: `product-${i}`, status: i % 3 ? 'active' : 'draft' })).join('\n');
    const jfile = path.join(jdir, 'jsonl-envelope.json');
    writeFileSync(jfile, wrap(rows));
    const r = spawnSync('node', [SLIM, jfile], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: jdir, FND_MCP_SLIM_DEBUG: '1' } });
    const profile = parseOut(r.stdout.split('\n')[0]) || {};
    const spill = profile.file;
    check('m14-jsonl-profiles-the-spill',
      profile.profile === true && profile.rows === 40 && typeof spill === 'string' && path.basename(spill).startsWith('fnd-mcp-slim-'),
      `the profile must describe a spill of the unwrapped body: ${JSON.stringify(profile).slice(0, 200)}`);
    check('m14-jsonl-spill-is-the-inner-body', typeof spill === 'string' && existsSync(spill) && readFileSync(spill, 'utf8') === rows,
      'the spilled body must be the inner payload byte-for-byte — every sed/grep recipe addresses it');
    check('m14-jsonl-guidance-points-at-the-spill', typeof spill === 'string' && r.stdout.includes(`sed -n '<N>p' '${spill}'`) && !r.stdout.includes(jfile),
      `the recipes must address the spill, never the envelope: ${r.stdout.slice(-400)}`);
    check('m14-jsonl-notes-the-unwrap', NOTE.test(r.stderr) && typeof spill === 'string' && r.stderr.includes(spill),
      `stderr must name both files: ${JSON.stringify(r.stderr)}`);
    const line = JSON.parse(readFileSync(path.join(jdir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').pop());
    check('m14-jsonl-debug-names-the-argument', line.tool === jfile && line.reason === 'stream-profile' && line.profile === true,
      `--report pairs a whale with the run over ITS path: ${JSON.stringify(line)}`);
    // …and it names the file this run WROTE. B4.10a's inventory is what makes a stray recovery spill
    // visible; a new writer that logs `spills: []` is exactly the orphan the field exists to catch.
    check('m14-jsonl-debug-names-the-spill',
      Array.isArray(line.spills) && line.spills.includes(spill) && line.spill === spill && line.stages[0] === 'envelope',
      `the diverted run must log its own spill and the rail that made it: ${JSON.stringify(line)}`);
    // --report must SEE both: the rail in the stage tally, the file in the spill inventory
    const rep = spawnSync('node', [SLIM, '--report', path.join(jdir, 'fnd-mcp-slim-debug.log')],
      { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: jdir } }).stdout;
    check('m14-jsonl-report-counts-the-rail', /stages:[^\n]*envelope 1/.test(rep) && /spill files: 1 named by 1 event/.test(rep),
      `--report must account for the diverted run: ${rep}`);
    rmSync(jdir, { recursive: true, force: true });
  }
  // the `--jq` twin of that divert: a dot-walk cannot answer for a row stream (the contract forbids
  // `--jq` on JSONL — rows must profile), so a first-segment miss on a JSONL-inner envelope profiles
  // against the spill of the unwrapped body instead of printing the wrapper's `null`
  {
    const jdir = mkdtempSync(path.join(tmpdir(), 'jslim-m14jq-'));
    const rows = Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: i, handle: `h-${i}` })).join('\n');
    const jfile = path.join(jdir, 'jsonl-envelope.json');
    writeFileSync(jfile, wrap(rows));
    const r = spawnSync('node', [SLIM, jfile, '--jq', '.handle'], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: jdir } });
    const profile = parseOut(r.stdout.split('\n')[0]) || {};
    check('m14-jq-jsonl-diverts-to-profile',
      profile.profile === true && profile.rows === 12 && r.stdout.trim() !== 'null'
        && typeof profile.file === 'string' && readFileSync(profile.file, 'utf8') === rows && NOTE.test(r.stderr),
      `--jq on a JSONL-inner envelope must profile, not print null: ${r.stdout.slice(0, 120)} / ${JSON.stringify(r.stderr)}`);
    rmSync(jdir, { recursive: true, force: true });
  }
  // …and the multi-block twin of that same shape must NOT divert: `blockText` would join two compact
  // JSON blocks into something `parseJsonl` calls two rows, so the run would spill an envelope, print a
  // row profile of the caller's own BLOCKS, and hand back `sed -n '1p'` recipes that pull an entire
  // uncompressed block into context. Pre-M14 it declined; it still declines.
  {
    const mdir = mkdtempSync(path.join(tmpdir(), 'jslim-m14multi-'));
    const mfile = path.join(mdir, 'two-block-envelope.json');
    const blocks = [1, 2].map((i) => JSON.stringify({ id: i, name: `alpha-${i}`, desc: 'x'.repeat(50) }));
    writeFileSync(mfile, JSON.stringify(blocks.map((text) => ({ type: 'text', text }))));
    const r = spawnSync('node', [SLIM, mfile, '--stats'], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: mdir } });
    check('m14-multi-block-declines', r.stdout === `${readFileSync(mfile, 'utf8')}\n` && !NOTE.test(r.stderr) && /deliberate decline/.test(r.stderr),
      `a 2-block envelope keeps the whole original: ${r.stdout.slice(0, 120)} / ${JSON.stringify(r.stderr)}`);
    check('m14-multi-block-writes-nothing', !readdirSync(mdir).some((f) => f.startsWith('fnd-mcp-slim-') && f.endsWith('.json')),
      `a 243 B decline must not leave a spill behind: ${readdirSync(mdir).join(', ')}`);
    // the same lesson one level up: a multi-block envelope of REAL payloads is not one document either,
    // so the plain rail leaves it alone rather than printing one block's slimmed body for all three
    const three = JSON.stringify({ content: [innerRaw, innerRaw, innerRaw].map((text) => ({ type: 'text', text })) });
    const rr = J.slim(three);
    check('m14-multi-block-payloads-decline', rr.wasModified === false && rr.output === three,
      'three payload blocks are three results — the rail is single-block by construction');
    rmSync(mdir, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

// ============================= M15 — the supported --jq grammar (real jq, evaluated or refused) ==
// Reader agents write jq, not dot-walks: `.fields | keys`, `.a[].b`, `.x, .y, .z`, and the occasional
// `map(select(…))`. Every one of them used to come back as stdout `null` plus a diagnostic about a
// segment called `fields | keys`, which reads as "wrong path" — so the same file was re-run three to
// seven times with guessed spellings. The CLI now evaluates the subset those expressions use and
// REFUSES the rest by name, with a usage exit code that cannot be mistaken for a miss.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-m15-'));
  const run = (args, env) => spawnSync('node', [SLIM, ...args], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, ...(env || {}) } });
  const doc = {
    fields: {
      status: { name: 'Done' },
      assignee: null,
      updated: '2026-08-30',
      comment: { comments: [{ created: 'c1', body: 'one' }, { created: 'c2', body: 'two' }] },
    },
    a: [{ b: [1, 2] }, { b: [3] }],
    mixed: [{ b: 1 }, { c: 2 }],
    obj: { x: 'ex', y: 'why' },
    s: 'héllo',
    n: -7,
    t: true,
    arr: [10, 20, 30],
  };
  const plain = path.join(dir, 'plain.json');
  writeFileSync(plain, JSON.stringify(doc));
  const jqOut = (expr) => { const r = run(['--jq', expr, plain]); return { v: JSON.parse(r.stdout), err: r.stderr, code: r.status }; };

  // ---- the grammar, parsed (no spawn): what the CLI accepts and what it names as unsupported
  eq('m15-parse-identity', T.parseJqExpr('.').identity, true);
  eq('m15-parse-identity-dotdot', T.parseJqExpr('..').identity, true);
  eq('m15-parse-path-not-identity', T.parseJqExpr('.a').identity, false);
  eq('m15-parse-filter-not-identity', T.parseJqExpr('. | keys').identity, false);
  eq('m15-parse-terms', T.parseJqExpr('.a, .b.c').terms.length, 2);
  eq('m15-parse-iteration-step', T.parseJqExpr('.a[].b').terms[0].segs, ['a', null, 'b']);
  eq('m15-parse-bracket-index', T.parseJqExpr('.a[0].b').terms[0].segs, ['a', '0', 'b']);
  // the unsupported families, each naming the token that put it out of scope
  for (const [expr, token] of [
    ['.a | map(.b)', 'map('],
    ['.a | select(.b == 1)', 'select('],
    ['.a | any', 'any'],
    ['.a?', '?'],
    ['.a // .b', '//'],
    ['.. | .a', '..'],
    ['.a..b', '..'],
    ['.["a"]', '["a"]'],
    ['.a[1:3]', '[1:3]'],
    ['.a == "x"', '=='],
    ['.a | not', 'not'],
    ['.a | keys_unsorted', 'keys_unsorted'],
    ['.a | length > 2', 'length > 2'],
  ]) {
    eq(`m15-unsupported-token:${expr}`, T.parseJqExpr(expr).bad, token);
    // …and every one of them reaches the CLI's refusal, not just the parser: a guard that read a body
    // before refusing, or a branch that swallowed `bad`, would keep the table above green.
    const r = run(['--jq', expr, plain]);
    check(`m15-unsupported-cli:${expr}`, r.status === 2 && r.stdout === '' && r.stderr.includes(`near '${token}'`),
      `${expr} must exit 2 with empty stdout: ${r.status} / ${JSON.stringify(r.stdout)} / ${JSON.stringify(r.stderr)}`);
  }
  // An EMPTY multi-select slot is a syntax error too — parsed as a path it would be the identity
  // selector, i.e. the whole document handed back in that slot (and `.a,` is exactly what the shell
  // leaves when an unquoted `--jq .a, .b` is split).
  for (const expr of ['.a,', ',.a', '.a,,.obj', ',']) eq(`m15-empty-term:${expr}`, T.parseJqExpr(expr).bad, ',');
  // `.a.[0]` is jq's own spelling of `.a[0]` — the `[N]` rewrite glues a dot pair there, which is not
  // the recursive descent the refusal names
  eq('m15-parse-dot-bracket', T.parseJqExpr('.a.[0]').terms[0].segs, ['a', '0']);
  // Keys the dot-walk this replaced could address stay addressable: a digit-LEADING key is ONE segment
  // (not `2` + `fa`, which reads a numeric sibling's value), and a key outside `\w` is still a key.
  eq('m15-parse-digit-leading-key', T.parseJqExpr('.2fa').terms[0].segs, ['2fa']);
  eq('m15-parse-nonword-keys', T.parseJqExpr('.@type.a:b.x/y').terms[0].segs, ['@type', 'a:b', 'x/y']);

  // ---- paths, iteration, multi-select, filters — through the CLI, on a plain JSON file
  eq('m15-cli-keys-object', jqOut('.obj | keys').v, ['x', 'y']);
  eq('m15-cli-keys-array', jqOut('.arr | keys').v, [0, 1, 2]);
  eq('m15-cli-length-array', jqOut('.arr | length').v, 3);
  eq('m15-cli-length-object', jqOut('.obj | length').v, 2);
  eq('m15-cli-length-string', jqOut('.s | length').v, 5); // codepoints, like jq
  eq('m15-cli-length-number', jqOut('.n | length').v, 7); // magnitude, like jq
  eq('m15-cli-length-null', jqOut('.fields.assignee | length').v, 0);
  {
    const r = jqOut('.t | length'); // jq has no length for a boolean — a miss, not a made-up number
    check('m15-cli-length-boolean', r.v === null && r.code === 0
      && /--jq: 'length' is not defined at 't'; value is boolean/.test(r.err),
      `length on a boolean must say so and stay a miss: ${r.v} / ${JSON.stringify(r.err)}`);
  }
  eq('m15-cli-pipe-path', jqOut('.fields | .updated').v, '2026-08-30'); // `.a | .b` ≡ `.a.b`
  // `[]` — over an array, over an object (its values), and flattened across nesting
  eq('m15-cli-iterate-array', jqOut('.a[].b').v, [[1, 2], [3]]);
  eq('m15-cli-iterate-flattens', jqOut('.a[].b[]').v, [1, 2, 3]);
  eq('m15-cli-iterate-object-values', jqOut('.obj[]').v, ['ex', 'why']);
  eq('m15-cli-iterate-field', jqOut('.arr[]').v, [10, 20, 30]);
  // `.[]` at ROOT iterates the document itself
  {
    const rootFix = path.join(dir, 'root-array.json');
    writeFileSync(rootFix, JSON.stringify([{ k: 1 }, { k: 2 }]));
    const r = JSON.parse(run(['--jq', '.[]', rootFix]).stdout);
    eq('m15-cli-iterate-root', r, [{ k: 1 }, { k: 2 }]);
    eq('m15-cli-iterate-root-then-path', JSON.parse(run(['--jq', '.[].k', rootFix]).stdout), [1, 2]);
  }
  // a filter after a fan-out is applied PER ELEMENT, the way jq's stream does it
  eq('m15-cli-iterate-then-length', jqOut('.a[].b | length').v, [2, 1]);
  // a missing key INSIDE a fan-out is jq's null for that element on stdout — but an iteration where
  // NOTHING resolved says which key was wrong ONCE, or a typo is indistinguishable from a real null
  {
    const r = jqOut('.a[].nope');
    const diags = r.err.split('\n').filter((l) => l.includes('--jq:'));
    check('m15-cli-iterate-missing-is-null', JSON.stringify(r.v) === '[null,null]' && diags.length === 1
      && /'nope' not found at 'a\[\]'; keys: b/.test(diags[0]),
      `an all-missed iteration keeps jq's nulls and reports the key once: ${JSON.stringify(r.v)} / ${JSON.stringify(r.err)}`);
    // …and a fan-out where SOME element resolved is a real answer: no diagnostic
    const part = jqOut('.mixed[].b');
    check('m15-cli-iterate-partial-silent', JSON.stringify(part.v) === '[1,null]' && !part.err.includes('--jq:'),
      `a partly-resolved iteration must not warn: ${JSON.stringify(part.v)} / ${JSON.stringify(part.err)}`);
  }
  // `[]` on something that cannot be iterated names the location and the type it found
  {
    const r = jqOut('.s[]');
    check('m15-cli-iterate-scalar-diag', r.v === null && /--jq: '\[\]' needs an array or object at 's'; value is string/.test(r.err),
      `iterating a string must say so: ${JSON.stringify(r.err)}`);
    const k = jqOut('.s | keys');
    check('m15-cli-keys-scalar-diag', k.v === null && /--jq: 'keys' needs an array or object at 's'; value is string/.test(k.err),
      `keys on a string must say so: ${JSON.stringify(k.err)}`);
  }
  // ',' multi-select → ONE array in term order (this CLI has one stdout where jq emits N documents)
  eq('m15-cli-multiselect', jqOut('.fields.status.name, .fields.updated, .n').v, ['Done', '2026-08-30', -7]);
  // …and a missed term is `null` in ITS slot, with one diagnostic per miss
  {
    const r = jqOut('.n, .nope, .alsono');
    const diags = r.err.split('\n').filter((l) => l.includes('--jq:'));
    check('m15-cli-multiselect-misses', JSON.stringify(r.v) === '[-7,null,null]' && diags.length === 2
      && /'nope' not found at top level/.test(diags[0]) && /'alsono' not found at top level/.test(diags[1]),
      `a missed term contributes null and one diagnostic: ${JSON.stringify(r.v)} / ${JSON.stringify(r.err)}`);
  }

  // ---- the five expressions the transcripts actually contained, on a plain document
  eq('m15-real-keys', jqOut('.fields | keys').v, ['assignee', 'comment', 'status', 'updated']);
  eq('m15-real-comments-length', jqOut('.fields.comment.comments | length').v, 2);
  eq('m15-real-multiselect', jqOut('.fields.status, .fields.assignee, .fields.updated').v, [{ name: 'Done' }, null, '2026-08-30']);
  eq('m15-real-comment-created', jqOut('.fields.comment.comments[].created').v, ['c1', 'c2']);
  {
    const r = run(['--jq', '.issues.nodes[0].changelog.histories | map(select(.items[]?.field == "status")) | length', plain]);
    check('m15-real-map-select-refused', r.status === 2 && r.stdout === '' && /unsupported jq syntax near 'map\('/.test(r.stderr),
      `the map(select(…)) transcript line must refuse, not answer null: ${r.status} / ${JSON.stringify(r.stdout)} / ${JSON.stringify(r.stderr)}`);
  }

  // ---- the refusal itself: empty stdout, ONE diagnostic naming the token AND the escape hatch, exit 2
  {
    const r = run(['--jq', '.fields | map(.x)', plain]);
    check('m15-refusal-exit-2', r.status === 2 && r.stdout === '', `exit 2 with no stdout: ${r.status} / ${JSON.stringify(r.stdout)}`);
    check('m15-refusal-names-the-grammar',
      r.stderr.includes(`supported: ${J.JQ_GRAMMAR_HINT}, quoted as one argument ('.a, .b')`)
        && /node json-slim\.cjs <file> --jq '<supported-path>' \| jq '<rest of your expression>'/.test(r.stderr),
      `the refusal must state the grammar and the full-jq escape hatch: ${JSON.stringify(r.stderr)}`);
    // a USAGE error is not the M12 miss contract: that one still prints `null` and exits 0
    const miss = run(['--jq', '.produtcs', plain]);
    check('m15-miss-contract-unchanged', miss.status === 0 && miss.stdout.trim() === 'null'
      && /--jq: 'produtcs' not found at top level; keys: fields, a, mixed, obj, s, n, t, arr/.test(miss.stderr),
      `a plain-path miss keeps its M12 wording and exit 0: ${miss.status} / ${JSON.stringify(miss.stderr)}`);
    // a refusal writes nothing: no pipeline, no spill
    check('m15-refusal-writes-nothing', !readdirSync(dir).some((f) => f.startsWith('fnd-')),
      `a refusal must not spill: ${readdirSync(dir).join(', ')}`);
  }
  // identity and `[N]` are untouched by the new parser
  {
    const ident = run(['--jq', '.', plain]);
    check('m15-identity-unchanged', JSON.parse(ident.stdout).arr.length === 3 && !ident.stderr.includes('--jq:'),
      `bare '.' still dumps the whole document: ${ident.stdout.slice(0, 60)}`);
    eq('m15-bracket-index-unchanged', jqOut('.a[0].b[1]').v, 2);
    eq('m15-bare-dotted-unchanged', jqOut('a.0.b.0').v, 1);
  }
  // keys the dot-walk could address must still resolve to the SAME value: a digit-leading key beside a
  // numeric sibling is the case where a wrong split answers with someone else's value, silently
  {
    const odd = path.join(dir, 'odd-keys.json');
    writeFileSync(odd, JSON.stringify({ 2: { fa: 'numeric-sibling' }, '2fa': 'digit-leading', '@type': 'Product', 'a:b': 'colon', 'my key': 'spaced' }));
    const one = (expr) => { const r = run(['--jq', expr, odd]); return { v: JSON.parse(r.stdout), code: r.status }; };
    eq('m15-cli-digit-leading-key', one('.2fa').v, 'digit-leading');
    eq('m15-cli-numeric-key', one('.2.fa').v, 'numeric-sibling');
    eq('m15-cli-nonword-key', one('.@type').v, 'Product');
    eq('m15-cli-colon-key', one('.a:b').v, 'colon');
    eq('m15-cli-spaced-key', one('my key').v, 'spaced');
  }
  // a fan-out is not a sample: the crush's string-array sampling would hand back a subset of the
  // iteration as if it were the whole list, so `[]` opts out of it exactly like `| keys`
  {
    const many = path.join(dir, 'many-comments.json');
    const created = Array.from({ length: 40 }, (_, i) => ({ created: `2026-08-${String(i % 28 + 1).padStart(2, '0')}` }));
    writeFileSync(many, JSON.stringify({ fields: { comment: { comments: created } } }));
    const fan = JSON.parse(run(['--jq', '.fields.comment.comments[].created', many]).stdout);
    const len = JSON.parse(run(['--jq', '.fields.comment.comments | length', many]).stdout);
    check('m15-cli-fanout-not-sampled', fan.length === len && fan.length === 40 && fan[39] === created[39].created,
      `a 40-element fan-out must answer 40, the same number '| length' reports: ${fan.length} vs ${len}`);
  }
  // a nested `[]` fans one element's whole array into the result — by APPEND, since `push(...rows)`
  // passes one argument per element and dies with a RangeError past ~125k of them
  {
    const wide = { a: [{ b: Array.from({ length: 130_000 }, (_, i) => i) }] };
    for (const expr of ['.a[].b[]', '.a[] | .b[]']) {
      const r = T.evalJqExpr(wide, T.parseJqExpr(expr));
      check(`m15-fanout-no-arg-limit:${expr}`, r.ok && r.value.length === 130_000 && r.value[129_999] === 129_999,
        `a 130k fan-out must survive: ${r.ok} / ${r.value && r.value.length}`);
    }
  }

  // ---- the same expressions THROUGH an MCP text-block envelope (M14's fallback re-runs the whole
  // expression, not a segment list, so a filter resolves inside the payload too)
  {
    const ENV_FIX = path.join(FIX, 'mcp-envelope-jira.json');
    const inner = JSON.parse(JSON.parse(readFileSync(ENV_FIX, 'utf8'))[0].text);
    const NOTE = /unwrapped MCP text envelope \(\[0\]\.text\)/;
    const env = (expr) => { const r = run(['--jq', expr, ENV_FIX]); return { v: JSON.parse(r.stdout), err: r.stderr, code: r.status }; };
    const keys = env('.fields | keys');
    check('m15-env-keys', NOTE.test(keys.err) && JSON.stringify(keys.v) === JSON.stringify(Object.keys(inner.fields).sort()),
      `'.fields | keys' must resolve inside the envelope and list EVERY name: ${JSON.stringify(keys.v)}`);
    eq('m15-env-comments-length', env('.fields.comment.comments | length').v, inner.fields.comment.comments.length);
    eq('m15-env-comment-created', env('.fields.comment.comments[].created').v, inner.fields.comment.comments.map((c) => c.created));
    const multi = env('.fields.status, .fields.assignee, .fields.updated');
    check('m15-env-multiselect', Array.isArray(multi.v) && multi.v.length === 3 && multi.v[2] === inner.fields.updated
      && multi.v[0].name === inner.fields.status.name && NOTE.test(multi.err),
      `a multi-select resolves inside the payload as one 3-slot array: ${JSON.stringify(multi.v).slice(0, 120)}`);
    // an unsupported expression is refused BEFORE any of that — the envelope is never opened
    const bad = run(['--jq', '.fields | map(.status)', ENV_FIX]);
    check('m15-env-unsupported-refused', bad.status === 2 && bad.stdout === '' && !NOTE.test(bad.stderr),
      `the refusal precedes every rail: ${bad.status} / ${JSON.stringify(bad.stderr)}`);
    // a root fan-out over the envelope "succeeds" on the wrapper (it IS an array) — but nothing in it
    // resolved, so the rail still gets its turn and the reader hears which key was wrong
    const rootFan = run(['--jq', '.[].key', ENV_FIX]);
    check('m15-env-root-fanout-retries-inner', NOTE.test(rootFan.stderr) && /'key' not found/.test(rootFan.stderr),
      `an all-missed root fan-out must reach the envelope rail: ${JSON.stringify(rootFan.stderr)}`);
    // a miss at BOTH levels still reports the payload's keys (the M14 rule, now per term)
    const miss = run(['--jq', '.nosuch | keys', ENV_FIX]);
    check('m15-env-miss-reports-inner', miss.stdout.trim() === 'null' && /'nosuch' not found at top level; keys: expand, id, self, key, fields/.test(miss.stderr),
      `a double miss describes the payload, not the wrapper: ${JSON.stringify(miss.stderr)}`);
    // …but a term whose PREFIX resolved on the wrapper is about THIS document: `.content[]` iterated
    // the envelope's own block list, so the miss is `foo` inside a block — re-running the expression
    // against the payload answered with a diagnostic about `content`, a key nobody typed a path to.
    const wrapped = path.join(dir, 'content-envelope.json');
    writeFileSync(wrapped, JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ key: 'ELC-1', fields: { summary: 's' } }) }] }));
    const fanIn = run(['--jq', '.content[].foo', wrapped]);
    check('m15-env-resolved-prefix-stays', JSON.stringify(JSON.parse(fanIn.stdout)) === '[null]'
      && /'foo' not found at 'content\[\]'; keys: type, text/.test(fanIn.stderr) && !NOTE.test(fanIn.stderr),
      `a fan-out with a resolved prefix must report its own miss, not the envelope's: ${JSON.stringify(fanIn.stderr)}`);
  }

  // ---- a JSONL file: every spelling of "the whole file" PROFILES like a plain run. Walking one would
  // leave the reshaped row array for slim() to crush and spill — the one thing the JSONL contract
  // forbids — and a multi-select would hand back N copies of the file. The whole-document test is on
  // the SHAPE the expression selects, so `. | .` and `., .` are as whole as `.` and `.[]`.
  {
    const jl = path.join(dir, 'rows.jsonl');
    writeFileSync(jl, Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: i, handle: `h${i}` })).join('\n'));
    const bytes = Buffer.byteLength(readFileSync(jl, 'utf8'));
    for (const expr of ['.', '.[]', '. | .', '.[] | .', '. | .[]', '., .', '.[], .[]']) {
      const r = run(['--jq', expr, jl]);
      const head = JSON.parse(r.stdout.split('\n')[0]);
      check(`m15-jsonl-whole-profiles:${expr}`, head.profile === true && head.rows === 300
        && Buffer.byteLength(r.stdout) < bytes && !readdirSync(dir).some((f) => f.startsWith('fnd-slim-out-')),
        `'${expr}' on a JSONL must profile and spill nothing: ${r.stdout.slice(0, 120)} / ${readdirSync(dir).join(', ')}`);
    }
    // …and the parser's own answer, so a future spelling is checked without a spawn
    for (const [expr, whole] of [['.', true], ['.[]', true], ['. | .', true], ['.[] | .', true], ['. | .[]', true],
      ['., .', true], ['.[], .[]', true], ['.a', false], ['. | keys', false], ['.[] | .k', false], ['.[][]', false]]) {
      eq(`m15-parse-whole:${expr}`, T.jqExprWhole(T.parseJqExpr(expr)), whole);
    }
  }

  // ---- the same spellings on json-slim's OWN Gate-A output: B2 refuses a re-run in one line, and a
  // whole-document `--jq` is not the narrowing recovery that refusal advertises. The syntactic test
  // this replaced let `. | .` through and printed the file back with `narrowed:true`, which also hid
  // the re-dump from `--report`'s "gained nothing" count.
  {
    const sdir = mkdtempSync(path.join(tmpdir(), 'jslim-m15b2-'));
    const so = path.join(sdir, 'fnd-slim-out-deadbeef.json');
    writeFileSync(so, JSON.stringify({ products: Array.from({ length: 400 }, (_, i) => ({ id: i, handle: `h${i}`, title: 't'.repeat(30) })) }));
    for (const expr of ['.', '. | .', '.[] | .', '. | .[]', '., .']) {
      const r = run(['--jq', expr, so], { FND_MCP_SLIM_DIR: sdir });
      check(`m15-slim-out-whole-refused:${expr}`, r.status === 0 && r.stdout.trimEnd().split('\n').length === 1
        && r.stdout.includes("IS json-slim's own slimmed output"),
        `'${expr}' selects the whole file, so the slim-out guard must answer it in one line: ${r.stdout.slice(0, 200)}`);
    }
    const dl = run(['--jq', '. | .', so], { FND_MCP_SLIM_DIR: sdir, FND_MCP_SLIM_DEBUG: '1' });
    const line = JSON.parse(readFileSync(path.join(sdir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').pop());
    check('m15-slim-out-whole-debug', dl.status === 0 && line.reason === 'already-slim-out' && !line.narrowed,
      `a whole-document re-run is a refusal, never a narrowing: ${JSON.stringify(line)}`);
    // …and over a plain JSON document a root fan-out is a re-dump too: `--report` counts it only if the
    // line does NOT claim to have narrowed (B4.11's flag exempts a run from the "gained nothing" tally).
    const ra = path.join(sdir, 'root-array.json');
    writeFileSync(ra, JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ k: i }))));
    run(['--jq', '.[]', ra], { FND_MCP_SLIM_DIR: sdir, FND_MCP_SLIM_DEBUG: '1' });
    const rootLine = JSON.parse(readFileSync(path.join(sdir, 'fnd-mcp-slim-debug.log'), 'utf8').trim().split('\n').pop());
    check('m15-root-fanout-not-narrowed', !rootLine.narrowed && rootLine.reason === 'no-gain',
      `'.[]' over a JSON array narrows nothing, so the debug line must not claim it did: ${JSON.stringify(rootLine)}`);
    rmSync(sdir, { recursive: true, force: true });
  }

  // ---- the crush-sampler exemption is decided on the RESULT, not on the spelling. `.comments[]` over
  // an array of OBJECTS is the whale query mcp-whale.md advertises: exempting it (because `[]` appeared
  // anywhere in the expression) turned an 832 KB answer into 0.0 % and a Gate-A path handback. Only a
  // scalar list — the enumeration the exemption exists for — may opt out of row sampling.
  {
    const cdir = mkdtempSync(path.join(tmpdir(), 'jslim-m15crush-'));
    const whale = path.join(cdir, 'whale.json');
    const comments = Array.from({ length: 900 }, (_, i) => ({ id: i, author: `user${i % 7}`, created: `2026-08-0${i % 9 + 1}`, body: 'lorem ipsum dolor sit amet '.repeat(12) }));
    writeFileSync(whale, JSON.stringify({ fields: { status: 'Done', assignee: null, updated: '2026-08-30' }, comments }));
    const cq = (expr) => run(['--jq', expr, whale], { FND_MCP_SLIM_DIR: cdir });
    const plainKey = cq('.comments').stdout;
    const fanned = cq('.comments[]').stdout;
    check('m15-fanout-objects-crush', fanned === plainKey && Buffer.byteLength(fanned) < 20_000,
      `'.comments[]' is the same array as '.comments' and must crush the same: ${Buffer.byteLength(fanned)} vs ${Buffer.byteLength(plainKey)}`);
    eq('m15-keys-still-complete', JSON.parse(cq('.fields | keys').stdout), ['assignee', 'status', 'updated']);
    const created = JSON.parse(cq('.comments[].created').stdout);
    check('m15-scalar-fanout-still-complete', created.length === 900 && created[899] === comments[899].created,
      `a scalar fan-out is an enumeration and must come back whole: ${created.length}`);
    rmSync(cdir, { recursive: true, force: true });
  }

  // ---- the debug line of a refused run: its own reason, and `--report` must not count it among the
  // runs that "gained nothing" — it read no body and printed none
  {
    const ddir = mkdtempSync(path.join(tmpdir(), 'jslim-m15dbg-'));
    const denv = { ...process.env, FND_MCP_SLIM_DIR: ddir, FND_MCP_SLIM_DEBUG: '1' };
    const r = spawnSync('node', [SLIM, plain, '--jq', '.fields | map(.x)'], { encoding: 'utf8', env: denv });
    const logPath = path.join(ddir, 'fnd-mcp-slim-debug.log');
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop());
    check('m15-debug-line', r.status === 2 && line.entry === 'cli' && line.reason === 'jq-unsupported'
      && line.decision === 'passthrough' && !line.narrowed,
      `the refusal logs its own reason, not a narrowed no-gain: ${JSON.stringify(line)}`);
    const rep = spawnSync('node', [SLIM, '--report', logPath], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: ddir } }).stdout;
    check('m15-report-ignores-refusals', /passthrough reasons:[^\n]*jq-unsupported 1/.test(rep) && !/gained nothing/.test(rep),
      `--report must show the refusal without counting it as a re-dump: ${rep}`);
    // …and it is not the RECOVERY for a whale either: a refusal read no body, so the overflow it
    // followed is still a missed whale — the two-lever number must not count it as handled
    const whaleLog = path.join(ddir, 'whales.log');
    writeFileSync(whaleLog, [
      JSON.stringify({ ts: '2026-08-28T10:00:00.000Z', entry: 'hook', tool: 'mcp__x__y', decision: 'passthrough', reason: 'platform-overflow', spill: '/tmp/whale-a.json' }),
      JSON.stringify({ ts: '2026-08-28T10:01:00.000Z', entry: 'cli', tool: '/tmp/whale-a.json', decision: 'passthrough', reason: 'jq-unsupported' }),
    ].join('\n'));
    check('m15-report-refusal-is-no-recovery', /missed whales \(platform-overflow never read by any tool\): 1 of 1/.test(J.buildReport(readFileSync(whaleLog, 'utf8').split('\n'), {})),
      `a refusal must not pair with the whale it followed: ${J.buildReport(readFileSync(whaleLog, 'utf8').split('\n'), {})}`);
    rmSync(ddir, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- unknown arguments — the exit-2 usage contract ----------------------------------------------
// `has()` matches an argument by NAME and `fileArg` used to resolve a `-`-prefixed token as the input
// PATH, so before this contract a typo (`--jqq`), a retired flag (`--toon`, `--no-spill`) or `-h`
// silently ran as something other than what was asked. Every unrecognized argument now writes ONE
// diagnostic naming the token and the supported grammar, prints nothing, writes nothing, and exits 2.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-uf-'));
  const f = path.join(dir, 'body.json');
  writeFileSync(f, JSON.stringify({ a: 1, b: [1, 2, 3] }));
  // Debug OFF in this dir (the suite scrubs the four switches at the top) so `uf-writes-nothing`
  // measures a refusal that touched the filesystem not at all — mirroring m15-refusal-writes-nothing.
  const env = { ...process.env, FND_MCP_SLIM_DIR: dir };
  const uf = (argv) => spawnSync('node', [SLIM, ...argv], { encoding: 'utf8', env });

  const toon = uf(['--toon', f]);
  check('uf-retired-toon', toon.status === 2 && /unknown option --toon/.test(toon.stderr) && toon.stdout === '',
    `a retired flag must exit 2 naming the token, never run as a plain compression: ${toon.status} / ${JSON.stringify(toon.stdout.slice(0, 80))} / ${JSON.stringify(toon.stderr)}`);
  const nosp = uf(['--no-spill', f]);
  check('uf-retired-no-spill', nosp.status === 2 && /unknown option --no-spill/.test(nosp.stderr) && nosp.stdout === '',
    `a retired flag must exit 2 naming the token, never run as a plain compression: ${nosp.status} / ${JSON.stringify(nosp.stdout.slice(0, 80))} / ${JSON.stringify(nosp.stderr)}`);
  const typo = uf(['--jqq', '.a', f]);
  check('uf-typo', typo.status === 2 && /unknown option --jqq/.test(typo.stderr) && typo.stdout === '',
    `a typo'd flag must not fall through to a plain compression: ${typo.status} / ${JSON.stringify(typo.stderr)}`);
  // A single-dash token used to be resolved as the input PATH (ENOENT, exit 1);
  // md-to-adf.cjs:77 rejects the same way, for the same reason.
  const dashFirst = uf(['-h', f]);
  const dashLast = uf([f, '-h']);
  check('uf-single-dash', dashFirst.status === 2 && /unknown option -h/.test(dashFirst.stderr) && dashFirst.stdout === ''
    && dashLast.status === 2 && /unknown option -h/.test(dashLast.stderr) && dashLast.stdout === '',
    `-h must be a usage error in either position: ${dashFirst.status}/${JSON.stringify(dashFirst.stderr)} ${dashLast.status}/${JSON.stringify(dashLast.stderr)}`);
  // `--help` used to HANG on stdin (REVIEW-2026-09.md:271); a bare `--` was silently ignored, so
  // `-- file.json` compressed the file. The whitelist's diagnostic names every supported argument,
  // which IS the usage message — no second usage path is needed.
  const helps = [['--help'], ['-h'], ['--', f]].map((argv) => {
    const t0 = Date.now();
    const r = uf(argv);
    return { r, ms: Date.now() - t0 };
  });
  check('uf-help-and-double-dash', helps.every(({ r, ms }) => r.status === 2 && /unknown option/.test(r.stderr) && r.stdout === '' && ms < 1000),
    `--help, -h and a bare -- must each exit 2 promptly with no stdout: ${JSON.stringify(helps.map(({ r, ms }) => [r.status, r.stderr.trim().slice(0, 60), ms]))}`);
  check('uf-names-supported', /--jq <jq-path> \| --stats \| --report \[logfile\] \| --since <ISO>/.test(toon.stderr),
    `the diagnostic must name every supported argument: ${JSON.stringify(toon.stderr)}`);
  // Nothing read, nothing printed, nothing written: no spill, no `.fnd-nogain-*`, no
  // `.fnd-whale-guide-*`, no debug log (debug is off in this dir).
  const before = readdirSync(dir).sort();
  uf(['--bogus', f]);
  check('uf-writes-nothing', JSON.stringify(readdirSync(dir).sort()) === JSON.stringify(before),
    `a usage error must leave the spill dir untouched: before=${JSON.stringify(before)} after=${JSON.stringify(readdirSync(dir).sort())}`);

  // The other half of the whitelist: everything it names still RUNS.
  {
    const log = path.join(dir, 'known.log');
    writeFileSync(log, JSON.stringify({ ts: '2026-08-28T10:00:00.000Z', entry: 'cli', tool: f, decision: 'compressed', reason: 'ok', bytes_in: 100, bytes_out: 50, pct: 50, stages: ['crush'] }) + '\n');
    const runs = [uf(['--stats', f]), uf(['--jq', '.a', f]), uf(['--report', log]), uf(['--report', log, '--since', '2026-01-01T00:00:00.000Z'])];
    check('uf-known-flags-run', runs.every((r) => r.status === 0),
      `every whitelisted argument must still run: ${JSON.stringify(runs.map((r) => [r.status, r.stderr.trim().slice(0, 80)]))}`);
    // A flag's VALUE is skipped by the same list `fileArg` uses, so it can never be mistaken for a
    // flag; and `--since` after a valueless `--report` stays a FLAG (the report reads the default log
    // path, not a file literally named `--since`).
    const valueLast = uf([f, '--jq', '.a']);
    const sinceNotPath = uf(['--report', '--since', '2026-01-01T00:00:00.000Z']);
    check('uf-value-not-a-flag', valueLast.status === 0 && !/unknown option/.test(sinceNotPath.stderr)
      && /no debug log at [^\n]*fnd-mcp-slim-debug\.log/.test(sinceNotPath.stderr),
      `a flag value is not a flag, and --since is not --report's log path: ${valueLast.status}/${JSON.stringify(valueLast.stderr)} ${JSON.stringify(sinceNotPath.stderr)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// The refused run's debug line, and what `--report` does with it: shaped exactly like the m15 block
// above, because a usage error must be the SAME kind of event as the `jq-unsupported` refusal — not a
// one-off rule in the owner's weekly readout.
{
  const ddir = mkdtempSync(path.join(tmpdir(), 'jslim-ufdbg-'));
  const f = path.join(ddir, 'body.json');
  writeFileSync(f, JSON.stringify({ a: 1 }));
  const denv = { ...process.env, FND_MCP_SLIM_DIR: ddir, FND_MCP_SLIM_DEBUG: '1' };
  const r = spawnSync('node', [SLIM, '--bogus', f], { encoding: 'utf8', env: denv });
  const logPath = path.join(ddir, 'fnd-mcp-slim-debug.log');
  const line = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop());
  check('uf-debug-reason', r.status === 2 && line.entry === 'cli' && line.reason === 'unknown-flag'
    && line.decision === 'passthrough' && line.bytes_in === 0 && !line.narrowed,
    `the usage error logs its own reason, not a narrowed no-gain: ${JSON.stringify(line)}`);
  const rep = spawnSync('node', [SLIM, '--report', logPath], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: ddir } }).stdout;
  check('uf-report-not-a-dump', /passthrough reasons:[^\n]*unknown-flag 1/.test(rep) && !/gained nothing/.test(rep),
    `a usage error read no body — it must show as a reason, never as a run that gained nothing: ${rep}`);
  // …and it is not the RECOVERY for a whale either. The cli line MUST carry a non-null `tool`, or the
  // filter's own `e.tool` guard would make this row vacuous.
  const whaleLog = path.join(ddir, 'whales.log');
  writeFileSync(whaleLog, [
    JSON.stringify({ ts: '2026-08-28T10:00:00.000Z', entry: 'hook', tool: 'mcp__x__y', decision: 'passthrough', reason: 'platform-overflow', spill: '/tmp/whale-a.json' }),
    JSON.stringify({ ts: '2026-08-28T10:01:00.000Z', entry: 'cli', tool: '/tmp/whale-a.json', decision: 'passthrough', reason: 'unknown-flag' }),
  ].join('\n'));
  check('uf-report-refusal-is-no-recovery', /missed whales \(platform-overflow never read by any tool\): 1 of 1/.test(J.buildReport(readFileSync(whaleLog, 'utf8').split('\n'), {})),
    `a usage error must not pair with the whale it followed: ${J.buildReport(readFileSync(whaleLog, 'utf8').split('\n'), {})}`);
  rmSync(ddir, { recursive: true, force: true });
}

// ============================ M16 — spill-access events in `--report` (the missed-whale correction) ==
// hooks/spill-access.sh appends `entry:"access"` lines to the SAME debug log the compressor writes.
// They are not compression events, so they may not move a single byte total — and they ARE the answer
// to "did anybody ever open this whale", which is what the missed-whale line was getting wrong.
{
  // The spill name is the PLATFORM's, not ours: real overflow files are opaque (9 random chars), which
  // is the shape both mcp-slim's OVERFLOW_PATH and the access hook have to accept.
  const ov = (extra) => JSON.stringify({ ts: '2026-08-25T09:00:00.000Z', project: 'elc', lvl: 2, entry: 'hook', tool: 'mcp__x__evaluate_script', decision: 'passthrough', reason: 'platform-overflow', bytes_in: 1463, bytes_out: 1463, pct: 0, stages: [], spill: '/p/tool-results/b1z10evqs.txt', ...extra });
  const acc = (extra) => JSON.stringify({ ts: '2026-08-25T09:37:00.000Z', project: 'elc', lvl: 2, entry: 'access', tool: 'Bash', via: 'jq', spill: '/p/tool-results/b1z10evqs.txt', ...extra });

  // 1 — the real case: three targeted jq queries over the spill. The whale was recovered, not missed.
  const rep = J.buildReport([ov(), acc(), acc({ ts: '2026-08-25T09:38:00.000Z' })], { file: '/x.log' });
  check('m16-access-recovers-the-whale', /missed whales \(platform-overflow never read by any tool\): 0 of 1/.test(rep),
    `a spill READ is a recovery, whatever tool did the reading:\n${rep}`);
  check('m16-access-line', /spill reads \(access hook\): 2 {2}\(via: jq 2\)/.test(rep),
    `the access lines get their own line, counted by via:\n${rep}`);
  check('m16-recovery-via-line', /whale recoveries via: jq 1/.test(rep),
    `each whale counts once per DISTINCT via — two jq reads of one spill are one jq recovery:\n${rep}`);

  // 2 — an access line stamped BEFORE the overflow cannot be its recovery (same rule the cli runs obey).
  const early = J.buildReport([ov(), acc({ ts: '2026-08-25T08:00:00.000Z' })], { file: '/x.log' });
  check('m16-earlier-access-is-no-recovery', /missed whales \(platform-overflow never read by any tool\): 1 of 1/.test(early)
    && !/whale recoveries via/.test(early),
    `a read that happened before the spill existed is not a recovery:\n${early}`);

  // 3 — access events carry no bytes and no decision, so they may not appear in ANY compression
  // aggregate: totals, decisions, the cli-run line, the per-tool ranking or the per-project counts.
  const mixed = J.buildReport([
    JSON.stringify({ ts: '2026-08-25T09:00:00.000Z', project: 'elc', lvl: 2, entry: 'hook', tool: 'mcp__a__x', decision: 'compressed', reason: null, bytes_in: 10000, bytes_out: 4000, pct: 60, stages: ['crush'], spill: '/tmp/fnd-mcp-slim-a.json' }),
    acc({ tool: 'Read', via: 'Read', spill: '/tmp/fnd-mcp-slim-a.json' }),
  ], { file: '/x.log' });
  check('m16-access-out-of-totals', /totals: 10000 → 4000 B \(60.0% saved\)/.test(mixed)
    && /decisions: compressed 1/.test(mixed) && !/cli runs:/.test(mixed)
    && /elc: 1 event, 6000 B saved/.test(mixed) && !/ {4}0 B over 1 call — Bash/.test(mixed),
    `an access line must not move totals, decisions, cli runs, projects or the tool ranking:\n${mixed}`);
  check('m16-access-recovers-a-stub', /spill reads \(access hook\): 1 {2}\(via: Read 1\)/.test(mixed),
    `the Read of a hook spill is still recorded:\n${mixed}`);

  // 4 — a log written before the hook existed reports exactly the numbers it always did; only the two
  // labels changed. Pinned against the same events with the access line removed.
  const legacy = J.buildReport([
    ov(),
    JSON.stringify({ ts: '2026-08-25T09:02:00.000Z', project: 'elc', lvl: 2, entry: 'cli', tool: '/p/tool-results/b1z10evqs.txt', decision: 'compressed', reason: null, bytes_in: 764124, bytes_out: 123048, pct: 83.9, stages: ['crush'], spill: null }),
    JSON.stringify({ ts: '2026-08-25T09:10:00.000Z', project: 'elc', lvl: 2, entry: 'hook', tool: 'mcp__a__y', decision: 'stubbed', reason: 'weak-gain', bytes_in: 260000, bytes_out: 910, pct: 99.6, stages: ['crush'], spill: '/tmp/fnd-mcp-slim-b.json' }),
  ], { file: '/x.log' });
  check('m16-legacy-log-unchanged', /missed whales \(platform-overflow never read by any tool\): 0 of 1/.test(legacy)
    && /stubbed \(spill-and-stub guard\): 1 \(weak-gain 1\), 1 never read/.test(legacy)
    && /cli runs: 1 · saved 641076 B \(83.9%\)/.test(legacy) && !/spill reads/.test(legacy)
    && /whale recoveries via: json-slim 1/.test(legacy),
    `a log with no access lines keeps every number and only renames the two labels:\n${legacy}`);

  // 5 — `via:"named"` is the hook's mark for a command that only touched the NAME (`rm`, `mv`, `ls`,
  // `echo`). Nothing was read into a context, so it may not clear the whale: a post-session `rm` of the
  // spill would otherwise report full recovery of everything the session missed.
  const named = J.buildReport([ov(), acc({ via: 'named', ts: '2026-08-25T09:40:00.000Z' })], { file: '/x.log' });
  check('m16-named-only-is-no-recovery', /missed whales \(platform-overflow never read by any tool\): 1 of 1/.test(named)
    && !/whale recoveries via/.test(named)
    && /spill reads \(access hook\): 1 {2}\(via: named 1\)/.test(named),
    `naming a spill (rm/ls/echo) is recorded but is not a read:\n${named}`);

  // 6 — a window can hold access lines and NO compression event (spills read, no MCP call). The body
  // below the header is all bytes and decisions, so it is skipped rather than rendered empty.
  const only = J.buildReport([acc()], { file: '/x.log' });
  check('m16-access-only-window', /no compression events in range\./.test(only)
    && /spill reads \(access hook\): 1/.test(only)
    && !/decisions:/.test(only) && !/projects:/.test(only) && !/totals:/.test(only),
    `an access-only window prints the access line, not an empty compression body:\n${only}`);

  // 7 — the header counts the whole window while every aggregate counts compression events; the split
  // is named on the line so the two populations reconcile.
  check('m16-header-names-the-split', /log: 2 events \(1 spill read\)/.test(J.buildReport([ov(), acc()], {})),
    'the header must say how many of its events are spill reads');
}

// ============================================== spill privacy: wx + 0600 tmp, 0700 spill dir ==
// The final spill name is a content HASH, so `<final>.tmp-<pid>` is predictable: a plain write there
// followed a planted symlink into a foreign file, and the payload (whole MCP results — tokens, PII)
// then sat 0644 for the whole TTL window.
{
  const base = mkdtempSync(path.join(tmpdir(), 'jslim-perm-'));
  const dir = path.join(base, 'created-by-writespill');
  const s = J.writeSpill(dir, 'fnd-crush-', 'shpat_secret payload');
  check('sec-spill-written', !!s && readFileSync(s.path, 'utf8') === 'shpat_secret payload', `spill written: ${JSON.stringify(s)}`);
  if (process.platform !== 'win32') {
    check('sec-spill-mode-0600', (statSync(s.path).mode & 0o777) === 0o600,
      `a spill must not be readable by anyone else: ${(statSync(s.path).mode & 0o777).toString(8)}`);
    check('sec-spill-dir-mode-0700', (statSync(dir).mode & 0o777) === 0o700,
      `a spill dir this call CREATED must be private: ${(statSync(dir).mode & 0o777).toString(8)}`);
  }
  rmSync(base, { recursive: true, force: true });
}
// A symlink pre-planted at the exact tmp name must not be written through, and the spill must still
// succeed (a retry name), or one planted link would null every spill of that payload.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-plant-'));
  const victim = path.join(dir, 'victim.txt');
  writeFileSync(victim, 'victim bytes');
  const text = 'payload aimed at a planted tmp name';
  const finalName = `fnd-crush-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}.json`;
  symlinkSync(victim, path.join(dir, `${finalName}.tmp-${process.pid}`));
  const s = J.writeSpill(dir, 'fnd-crush-', text);
  check('sec-symlink-victim-untouched', readFileSync(victim, 'utf8') === 'victim bytes',
    `a planted symlink must not be followed: ${JSON.stringify(readFileSync(victim, 'utf8').slice(0, 40))}`);
  check('sec-symlink-spill-still-written', !!s && readFileSync(s.path, 'utf8') === text && path.basename(s.path) === finalName,
    `the spill must still land under its content name: ${JSON.stringify(s)}`);
  rmSync(dir, { recursive: true, force: true });
}
// The same rail for a STALE regular file at the tmp name (a crashed run whose pid was recycled).
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-stale-'));
  const text = 'payload behind a stale tmp file';
  const finalName = `fnd-crush-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}.json`;
  const stale = path.join(dir, `${finalName}.tmp-${process.pid}`);
  writeFileSync(stale, 'stale leftover');
  const s = J.writeSpill(dir, 'fnd-crush-', text);
  check('sec-stale-tmp-untouched', readFileSync(stale, 'utf8') === 'stale leftover', 'a stale tmp file is never overwritten');
  check('sec-stale-spill-still-written', !!s && readFileSync(s.path, 'utf8') === text && path.basename(s.path) === finalName,
    `a stale tmp must not turn the spill into a null: ${JSON.stringify(s)}`);
  // …and a SECOND call still dedups on the content name (the retry name is only for the tmp).
  const s2 = J.writeSpill(dir, 'fnd-crush-', text);
  check('sec-stale-still-dedups', !!s2 && s2.path === s.path && s2.created === false,
    `the content-addressed dedup must survive a planted tmp: ${JSON.stringify(s2)}`);
  check('sec-no-tmp-leaked', readdirSync(dir).filter((f) => f.includes('.tmp-')).length === 1,
    `only the planted tmp may remain: ${JSON.stringify(readdirSync(dir))}`);
  rmSync(dir, { recursive: true, force: true });
}

// ==================================================== primitive sampling leaves a marker ==
// 400 strings sampled to 16 used to arrive with no count anywhere in the body: the model answered
// from the sample believing it held the list.
{
  const strs = Array.from({ length: 400 }, (_, i) => `item-${i}-${'x'.repeat(i % 7)}`);
  const nums = Array.from({ length: 400 }, (_, i) => i * 3 + (i % 5));
  const outS = JSON.parse(J.slim(JSON.stringify({ items: strs })).output).items;
  const outN = JSON.parse(J.slim(JSON.stringify({ items: nums })).output).items;
  const m = /^…(\d+) more of (\d+) omitted$/.exec(outS[outS.length - 1]);
  check('sample-marker-string', !!m && Number(m[2]) === 400 && Number(m[1]) === 400 - (outS.length - 1),
    `the last element must state the drop: ${JSON.stringify(outS.slice(-2))}`);
  const mn = /^…(\d+) more of (\d+) omitted$/.exec(outN[outN.length - 1]);
  check('sample-marker-number', !!mn && Number(mn[2]) === 400 && Number(mn[1]) === 400 - (outN.length - 1),
    `a sampled number array must say so too: ${JSON.stringify(outN.slice(-2))}`);
  // The switches: `ccr` is Headroom's byte-parity mode (marker-less by contract, the parity group
  // above depends on it) and the enableMarker:false library override opts out of every marker.
  check('sample-marker-not-in-ccr-mode', !T.crush(JSON.stringify({ items: strs }), { markerMode: 'ccr' }).compressed.includes('omitted'),
    'ccr mode must stay marker-less (smart-crusher parity)');
  check('sample-marker-off-with-enablemarker-false', !J.slim(JSON.stringify({ items: strs }), { enableMarker: false }).output.includes('omitted'),
    'enableMarker:false must drop the sampling marker with the rest');
  // A MIXED array already carries ONE {_ccr_dropped} sentinel over all groups — its string subgroup
  // must not add a second, unmappable one.
  const mixed = [...strs.slice(0, 60), ...Array.from({ length: 60 }, (_, i) => ({ id: i, msg: 'row' }))];
  const outM = J.slim(JSON.stringify({ items: mixed })).output;
  check('sample-marker-not-in-mixed-subgroup', outM.includes('_ccr_dropped') && !outM.includes('omitted'),
    `a mixed array keeps its single sentinel: ${outM.slice(0, 120)}`);
  // …and the strategy string still counts REAL rows, not the marker.
  check('sample-marker-not-counted-in-info', /string:adaptive\(400->(\d+)\)\(400->\1\)/.test(T.crush(JSON.stringify({ items: strs })).strategy),
    `the info line must report kept rows, not kept+marker: ${T.crush(JSON.stringify({ items: strs })).strategy}`);
  // The path the hook and the CLI share: the marker must survive to real stdout, not just to slim().
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-mark-'));
  const f = path.join(dir, 'strings.json');
  writeFileSync(f, JSON.stringify({ items: strs }));
  const cli = spawnSync('node', [SLIM, f], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir } });
  check('sample-marker-through-cli', /…\d+ more of 400 omitted/.test(cli.stdout),
    `the CLI body must carry the marker: ${cli.stdout.slice(0, 160)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ====================================== avatar-key drop no longer eats text content ==
// AVATAR_KEY is a SUBSTRING match, so `thumbnail_alt` / `image_thumbnail_text` — real copy — vanished
// with the image references.
eq('noise-thumbnail-alt-survives', T.noiseStage({ thumbnail_alt: 'A cat on a chair' }, T.DEFAULTS), { thumbnail_alt: 'A cat on a chair' });
eq('noise-thumbnail-text-survives', T.noiseStage({ image_thumbnail_text: 'Caption copy' }, T.DEFAULTS), { image_thumbnail_text: 'Caption copy' });
eq('noise-thumbnail-camel-alt-survives', T.noiseStage({ thumbnailAlt: 'alt copy', avatarDescription: 'who' }, T.DEFAULTS), { thumbnailAlt: 'alt copy', avatarDescription: 'who' });
eq('noise-thumbnail-url-dropped', T.noiseStage({ thumbnailUrl: 'http://t', thumbnail: 'http://t', thumbnails: ['http://t'], keep: 1 }, T.DEFAULTS), { keep: 1 });
eq('noise-avatar-icon-dropped', T.noiseStage({ avatarUrls: { '48x48': 'http://a' }, iconUrl: 'http://i', keep: 1 }, T.DEFAULTS), { keep: 1 });

// ============================================ a lossy FILE body names its original ==
// On STDERR for the JSON branch: this stdout is a document callers pipe into jq (scripts-sim parses
// it), so the pointer rides the same stream as the stdin run's "original spilled to" note.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-orig-'));
  const env = { ...process.env, FND_MCP_SLIM_DIR: dir };
  const lossy = path.join(dir, 'lossy.json');
  writeFileSync(lossy, JSON.stringify({ rows: Array.from({ length: 60 }, (_, i) => ({ id: i, msg: 'same row', n: null })) }));
  const r = spawnSync('node', [SLIM, lossy], { encoding: 'utf8', env });
  check('cli-original-line-on-compressed-file', r.stderr.includes(`json-slim: original: ${lossy}\n`),
    `a compressed file run must point back at the file on stderr: ${JSON.stringify(r.stderr.slice(-160))}`);
  check('cli-original-line-not-on-stdout', !r.stdout.includes('original:') && JSON.parse(r.stdout).rows.length > 0,
    `stdout must stay one parseable JSON document: ${JSON.stringify(r.stdout.slice(-120))}`);
  // A passthrough lost nothing → no pointer (and the decline notice already speaks).
  const flat = path.join(dir, 'flat.json');
  writeFileSync(flat, JSON.stringify({ a: 1 }));
  const rf = spawnSync('node', [SLIM, flat], { encoding: 'utf8', env });
  check('cli-no-original-line-on-passthrough', !rf.stdout.includes('original:') && !rf.stderr.includes('original:'),
    'a passthrough must not claim a lossy body');
  // stdin has no path to name — its stderr names the spilled copy instead.
  const viaStdin = spawnSync('node', [SLIM], { input: readFileSync(lossy, 'utf8'), encoding: 'utf8', env });
  check('cli-no-original-line-on-stdin', !viaStdin.stdout.includes('original:') && /spilled to /.test(viaStdin.stderr)
    && !/json-slim: original: /.test(viaStdin.stderr),
    `stdin keeps its spill line and adds no pointer: ${JSON.stringify(viaStdin.stderr.slice(-120))}`);
  rmSync(dir, { recursive: true, force: true });
}

// =============================== numbers JSON.parse cannot round-trip are not "compressed" ==
// JSON.parse turns 1e400 into null and 12345678901234567890 into …67000; re-serializing that and
// reporting a reduction rewrites the caller's data.
{
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, msg: 'same row' }));
  const withNum = (lit) => `{"v":${lit},"rows":${JSON.stringify(rows)}}`;
  for (const [name, lit] of [['exponent-overflow', '1e400'], ['19-digit-int', '12345678901234567890'], ['underflow', '1e-400']]) {
    const p = withNum(lit);
    const r = J.slim(p);
    check(`numgate-declines:${name}`, r.reason === 'number-precision' && r.wasModified === false && r.output === p,
      `${lit} must pass through byte-exact: reason=${r.reason} modified=${r.wasModified} same=${r.output === p}`);
  }
  const safe = `{"a":1.5,"b":1e5,"c":9007199254740991,"d":-0.25,"e":-0,"f":0.250,"g":1.0,"rows":${JSON.stringify(rows)}}`;
  const rs = J.slim(safe);
  check('numgate-passes-safe-numbers', rs.reason === undefined && rs.wasModified === true && rs.bytesOut < rs.bytesIn,
    `ordinary numbers must still compress: reason=${rs.reason} modified=${rs.wasModified}`);
  const tok = (t) => T.numberPrecisionLoss(`{"v":${t}}`);
  check('numgate-token-matrix', [1.5, '1e5', '9007199254740991', '-0.25', '0', '-0', '1.0', '0.1', '1e308', '-1e-5'].every((t) => tok(t) === false)
    && ['1e400', '-1e400', '12345678901234567890', '0.12345678901234567890', '1e-400'].every((t) => tok(t) === true),
    'the token matrix must split exactly on what the double round trip loses');
  // A number INSIDE a string is not a number token — the scanner skips literals, so an envelope's
  // escaped payload is judged by the recursive slim() that actually compresses it.
  check('numgate-string-digits-ignored', T.numberPrecisionLoss('{"v":"1e400 12345678901234567890"}') === false,
    'digits inside a string literal must not trip the gate');
  // LINEAR: a backtracking regex over a 1 MB body cost this repo 43 s once, so the scan is hand-written.
  const urls = [];
  while (JSON.stringify(urls).length < 1024 * 1024) {
    urls.push(`https://shop.example.com/products/handle-${urls.length}?v=1234567890123456789&utm=a-b-c-0987654321`);
  }
  const bigPayload = JSON.stringify({ urls });
  const t0 = Date.now();
  const hit = T.numberPrecisionLoss(bigPayload);
  const ms = Date.now() - t0;
  check('numgate-linear-on-1mb', hit === false && ms < 500, `1 MB of URL-dense strings: hit=${hit} in ${ms} ms (must be well under a second)`);
  // …and the CLI names the real cause instead of the generic "no reduction possible" decline.
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-numgate-'));
  const f = path.join(dir, 'wide-number.json');
  writeFileSync(f, withNum('1e400'));
  const r = spawnSync('node', [SLIM, f], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir } });
  check('numgate-cli-notice', r.stdout === `${withNum('1e400')}\n` && /cannot round-trip/.test(r.stderr) && !/deliberate decline/.test(r.stderr),
    `the CLI must print the file verbatim and name the cause: ${JSON.stringify(r.stderr)}`);
  check('numgate-cli-no-memo', readdirSync(dir).every((n) => !n.startsWith('.fnd-nogain-')),
    `a precision decline must not arm the "nothing to shrink" memo: ${JSON.stringify(readdirSync(dir))}`);
  rmSync(dir, { recursive: true, force: true });
}

// ================================== the sampling marker may never cost more than it saves ==
// A map of short primitive arrays (metafields, translations, block ids): the marker's ~30 bytes per
// array outweighed the sampling and json-slim printed a body LARGER than the file it read.
{
  const map = {};
  for (let k = 0; k < 200; k++) map[`group_${k}`] = Array.from({ length: 16 }, (_, i) => String(i));
  const flip = JSON.stringify(map);
  const f = J.slim(flip);
  check('sample-marker-never-inflates', f.bytesOut < f.bytesIn,
    `a 200×16 short-code map must still shrink: ${f.bytesIn} → ${f.bytesOut} (reason=${f.reason})`);
  const one = JSON.stringify({ k0: Array.from({ length: 16 }, (_, i) => String(i)) });
  const o = J.slim(one);
  check('sample-marker-never-inflates-single-array', o.bytesOut < o.bytesIn && !o.output.includes('omitted'),
    `78 B of short codes must not grow to fit a marker: ${o.bytesIn} → ${o.bytesOut} — ${o.output}`);
  // Dedup-only sampling hides NOTHING: the dropped elements were byte-identical to the kept ones, so a
  // marker would both overstate the loss and cost more than the dedup saved.
  const dup = J.slim(JSON.stringify({ items: Array.from({ length: 9 }, () => 'dup') }));
  check('sample-marker-not-on-dedup-only', !dup.output.includes('omitted') && dup.bytesOut < dup.bytesIn,
    `only duplicates were dropped — no marker, and the win survives: ${dup.output}`);
  // …and the global rail behind it: a body that GREW is a passthrough, not a "reduction". `1e5`
  // re-serializes as `100000`, so the pipeline's own output is bigger than the file.
  const grew = `{${Array.from({ length: 20 }, (_, i) => `"k${i}":1e5`).join(',')}}`;
  const g = J.slim(grew);
  check('slim-declines-a-body-that-grew', g.wasModified === false && g.reason === 'no-gain' && g.output === grew && g.bytesOut === g.bytesIn,
    `a grown body must come back as the original: modified=${g.wasModified} reason=${g.reason} ${g.bytesIn}→${g.bytesOut}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-grew-'));
  const gf = path.join(dir, 'grew.json');
  writeFileSync(gf, grew);
  const r = spawnSync('node', [SLIM, gf, '--stats'], { encoding: 'utf8', env: { ...process.env, FND_MCP_SLIM_DIR: dir, FND_NOGAIN_MEMO: '0' } });
  check('cli-prints-the-original-not-the-grown-body', r.stdout === `${grew}\n` && /no reduction possible/.test(r.stderr) && /0\.0% reduction/.test(r.stderr),
    `the CLI must print the file and say it declined: ${JSON.stringify(r.stdout)} / ${JSON.stringify(r.stderr)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ============================== the number gate also guards the --jq route ==
// `--jq` re-serializes the PARSED document, so slim()'s gate never sees the original token: the
// narrowed value came back silently rounded (1e400 → `null`, a 19-digit id → …67000) on the very path
// the whale stub advertises.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-jqnum-'));
  const env = { ...process.env, FND_MCP_SLIM_DIR: dir };
  let seq = 0;
  const run = (body, ...args) => {
    const f = path.join(dir, `p${seq++}.json`);
    writeFileSync(f, body);
    return { f, r: spawnSync('node', [SLIM, ...args, f], { encoding: 'utf8', env }) };
  };
  const over = '{"v":1e400,"a":1}';
  const a = run(over, '--jq', '.v');
  check('numgate-jq-does-not-narrow-an-overflow', a.r.stdout === `${over}\n` && /--jq was NOT applied/.test(a.r.stderr) && /cannot round-trip/.test(a.r.stderr),
    `--jq must refuse to hand back a rewritten value: ${JSON.stringify(a.r.stdout)} / ${JSON.stringify(a.r.stderr)}`);
  const wide = '{"v":12345678901234567890,"a":1}';
  const b = run(wide, '--jq', '.v');
  check('numgate-jq-does-not-narrow-a-19-digit-int', b.r.stdout === `${wide}\n` && !b.r.stdout.includes('12345678901234567000'),
    `the rounded id must never be the answer: ${JSON.stringify(b.r.stdout)}`);
  // …and an ordinary payload still narrows.
  const c = run('{"v":42,"a":[1,2,3]}', '--jq', '.v');
  check('numgate-jq-still-narrows-safe-numbers', c.r.stdout === '42\n' && c.r.stderr === '',
    `a safe payload must still answer the path: ${JSON.stringify(c.r.stdout)} / ${JSON.stringify(c.r.stderr)}`);
  // The M14 rail re-runs the WHOLE expression against the payload inside a text-block envelope, where
  // a scan of the file's own bytes sees one escaped string literal and walks past both numbers — so
  // `--jq .id` answered 12345678901234567000 and `--jq .over` answered `null`.
  const envBody = '[{"type":"text","text":"{\\"id\\":12345678901234567890,\\"over\\":1e400}"}]';
  const e1 = run(envBody, '--jq', '.id');
  check('numgate-jq-envelope-inner-id', e1.r.stdout === `${envBody}\n` && !e1.r.stdout.includes('12345678901234567000')
    && /--jq was NOT applied/.test(e1.r.stderr) && /cannot round-trip/.test(e1.r.stderr),
    `an envelope's inner id must not be narrowed: ${JSON.stringify(e1.r.stdout)} / ${JSON.stringify(e1.r.stderr)}`);
  const e2 = run(envBody, '--jq', '.over');
  check('numgate-jq-envelope-inner-overflow', e2.r.stdout === `${envBody}\n` && /--jq was NOT applied/.test(e2.r.stderr),
    `an envelope's inner overflow must not answer null: ${JSON.stringify(e2.r.stdout)}`);
  // …and on STDIN, which has no file argument for the sniff-and-divert paths above to lean on.
  const e3 = spawnSync('node', [SLIM, '--jq', '.id'], { input: envBody, encoding: 'utf8', env });
  check('numgate-jq-envelope-inner-on-stdin', e3.stdout === `${envBody}\n` && !e3.stdout.includes('12345678901234567000')
    && /--jq was NOT applied/.test(e3.stderr),
    `a piped envelope must decline the same way: ${JSON.stringify(e3.stdout)} / ${JSON.stringify(e3.stderr)}`);
  // The control: the same envelope shape with an ordinary inner number still narrows through the rail.
  const okEnv = '[{"type":"text","text":"{\\"id\\":42,\\"a\\":1}"}]';
  const e4 = run(okEnv, '--jq', '.id');
  check('numgate-jq-envelope-safe-still-narrows', e4.r.stdout === '42\n',
    `a safe envelope payload must still answer the path: ${JSON.stringify(e4.r.stdout)} / ${JSON.stringify(e4.r.stderr)}`);
  // An inner payload that is NOT a document (log text with a 19-digit trace id) is never re-parsed,
  // so its digits cannot be rewritten — the narrowing recovery a whale stub advertises must still work.
  const logEnv = JSON.stringify([{ type: 'text', text: 'ts=1725600000123456789 level=info msg=started\nts=1725600000123456790 level=warn msg=slow' }]);
  const e5 = run(logEnv, '--jq', '0.text');
  check('numgate-jq-envelope-log-text-still-narrows', /^"ts=1725600000123456789 /.test(e5.r.stdout) && !/NOT applied/.test(e5.r.stderr),
    `a non-document inner text must still narrow: ${JSON.stringify(e5.r.stdout)} / ${JSON.stringify(e5.r.stderr)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ================== a whale-sized precision decline hands the path back, never a duplicate spill ==
// Above the inline cap Gate A would otherwise write a full-size COPY of the file the caller just named
// and label it `slimmed output` at 0.0 % — for a body nothing was even attempted on.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-numcap-'));
  const env = { ...process.env, FND_MCP_SLIM_DIR: dir };
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, msg: 'a padded row of text', n: null }));
  const body = `{"v":1e400,"rows":${JSON.stringify(rows)}}`;
  const f = path.join(dir, 'whale.json');
  writeFileSync(f, body);
  check('numgate-whale-over-cap', Buffer.byteLength(body, 'utf8') > T.DEFAULTS.cliOutCap, 'the fixture must exceed the inline cap');
  const r = spawnSync('node', [SLIM, f], { encoding: 'utf8', env });
  check('numgate-cap-hands-the-path-back', r.stdout === `json-slim: nothing to compress (number precision); read the file directly: ${f}\n`,
    `an over-cap precision decline must hand the path back: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  check('numgate-cap-explains-itself', /cannot round-trip/.test(r.stderr) && !/deliberate decline/.test(r.stderr),
    `the cause still has to be named: ${JSON.stringify(r.stderr)}`);
  check('numgate-cap-writes-no-duplicate', readdirSync(dir).filter((n) => n.startsWith('fnd-')).length === 0,
    `no spill may be written for a body nothing was attempted on: ${JSON.stringify(readdirSync(dir))}`);
  rmSync(dir, { recursive: true, force: true });
}

// ================================================= gate + noise carve-out edge cases ==
// Subnormals defeat the "≤15 significant digits always round-trips" short-circuit: 2.5e-324 has two
// digits and still lands on 5e-324, a 2× rewrite.
check('numgate-subnormal-rewrite-declines', ['2.5e-324', '7.4e-324', '4.9e-324'].every((t) => T.numberPrecisionLoss(`{"v":${t}}`) === true),
  'a subnormal that shifts value must not pass the digit-count short-circuit');
check('numgate-subnormal-exact-passes', ['5e-324', '1e-323', '1.2e-320'].every((t) => T.numberPrecisionLoss(`{"v":${t}}`) === false),
  'a subnormal that DOES round-trip must not be declined');
// A token Number() cannot read at all (`1.2.3` in a fenced payload's prose) is not a number — the CLI
// runs this gate on the raw text before `--jq`, where prose can still be in front of the fence.
check('numgate-non-number-token-ignored', T.numberPrecisionLoss('see release 1.2.3.4 below') === false,
  'a malformed token must never be read as a precision loss');
// AVATAR_KEY is case-insensitive; its content carve-out must be too, or SHOUTING keys still lose copy.
eq('noise-thumbnail-uppercase-tail-survives',
  T.noiseStage({ THUMBNAIL_ALT: 'copy', thumbnail_ALT: 'copy', avatar_TITLE: 'copy', thumbnailALT: 'copy' }, T.DEFAULTS),
  { THUMBNAIL_ALT: 'copy', thumbnail_ALT: 'copy', avatar_TITLE: 'copy', thumbnailALT: 'copy' });
// …without widening into words that merely END in one of them.
eq('noise-thumbnail-context-still-dropped', T.noiseStage({ thumbnailContext: 'http://t', keep: 1 }, T.DEFAULTS), { keep: 1 });

// ============================ a symlink at the FINAL spill name is not handed back ==
// The tmp name is now O_EXCL, which leaves the content-addressed FINAL name as the predictable target:
// statSync followed the link and returned the victim's bytes behind a live `full=` handle.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jslim-symfinal-'));
  const text = 'XXXXXXXXXXXXXXXXX';
  const victim = path.join(dir, 'victim.txt');
  writeFileSync(victim, text);
  const link = path.join(dir, `fnd-crush-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}.json`);
  symlinkSync(victim, link);
  const s = J.writeSpill(dir, 'fnd-crush-', text);
  check('sec-final-symlink-not-deduped', !!s && s.path !== link && s.created === true && readFileSync(s.path, 'utf8') === text,
    `a symlinked final name must not be handed back: ${JSON.stringify(s)}`);
  check('sec-final-symlink-victim-untouched', readFileSync(victim, 'utf8') === text && lstatSync(link).isSymbolicLink(),
    'the planted link and its target are left exactly as they were');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`json-slim fixtures: ${pass} passed, ${fail} failed  (smart-crusher parity ${byteExact} byte + ${valueOnly} value of 17; log-compressor upstream parity ${logParityTotal}/20 = ${logByteExact} byte-exact + ${logDeviation1.length} deviation#1-trailer)`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
