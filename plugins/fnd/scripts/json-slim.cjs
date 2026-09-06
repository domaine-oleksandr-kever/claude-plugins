#!/usr/bin/env node
/*
 * json-slim.cjs — shape-driven compressor for large JSON (MCP tool results, saved dumps).
 *
 * Dual entry point (one home for the transform):
 *   - require()d as a module by the mcp-slim PostToolUse hook (M2) — { slim, crush, crushValue };
 *   - a standalone CLI to compress an already-saved dump on demand:
 *       node json-slim.cjs <file.json> [--jq <jq-path>] [--toon] [--no-spill] [--stats]
 *         --jq speaks a small jq subset: dot paths (`.a.b`, `.a[0]`), `[]` iteration, `,` multi-select
 *         (one array on stdout) and `| keys` / `| length`; anything else exits 2 naming the token.
 *       cat big.json | node json-slim.cjs
 *       node json-slim.cjs --report [logfile] [--since <ISO>]   (aggregate the FND_MCP_SLIM_DEBUG log)
 *     A JSONL file is PROFILED, never compressed (stats + sample rows + line-scripting
 *     guidance, streamed above 8 MB); log-shaped text is signal-compressed (log-slim.cjs) with
 *     an `original: <path>` recovery line; a Figma design-context JSX payload is compacted in place
 *     with that same `original: <path>` line (its node-id map spilled beside it); a compressed JSON
 *     file body gets the same pointer on STDERR, where it cannot break the document its stdout is
 *     (not on a `--jq` run, whose stdout is the selected value by contract);
 *     other non-JSONL JSON output is capped at 48 KB (spill + handback). A STDIN run names no input
 *     file, so a lossy body comes with a spilled copy of what the stages consumed (the whole stream,
 *     or the `--jq` subtree), reported on stderr — `--no-spill` opts out of that copy (and of the crush marker's),
 *     accepting an unrecoverable body.
 *
 * The pipeline is shape-driven (each stage independent, all generic — no per-tool registry),
 * applied by slim() in this order:
 *   1. ADF/rich-doc → markdown via adf-to-md.cjs (the single converter home);
 *   2. noise drop (nulls / empty containers / avatar-class decoration / self REST links);
 *   3. long-string truncation (base64 / data-URIs / long URLs);
 *   4. repetitive same-shape-array crush (a faithful port of Headroom's SmartCrusher).
 * The array-crush spills dropped rows to a file and leaves a `full=<path>` handle, so nothing
 * is lost — the detail is one `Read`/`jq` away.
 * Non-JSON input takes a sibling branch instead: a DOMINANT markdown fence (a tool's prose preamble
 * + ```json…``` wrapping the real payload) is unwrapped and its body re-run through this same
 * pipeline with the preamble kept on top; JSONL rows re-enter as one array; Figma design-context JSX
 * is compacted losslessly (className dictionary + node-id legend + ×N sibling fold); log-shaped text
 * goes to log-slim.cjs's signal selection; anything else passes through.
 *
 * Pure Node built-ins only (repo policy): fs, os, path, crypto + the local adf and log-slim
 * siblings.
 *
 * -----------------------------------------------------------------------------------------------
 * The array-crush (§ crushValue / analyseDictArray / sampleNumberArray / sampleStringArray) is a
 * port of the deterministic (empty-query) path of Headroom's SmartCrusher.
 *   Headroom — https://github.com/headroomlabs-ai/headroom — Copyright 2025 Headroom Contributors.
 *   Licensed under the Apache License, Version 2.0 (see tests/parity/NOTICE for attribution).
 * This is a modified re-implementation in JavaScript; behaviour is pinned against Headroom's own
 * parity fixtures (tests/json-slim-fixtures.mjs, "parity:*" cases).
 * -----------------------------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline'); // Gate B streams a whale file line-by-line — a Node built-in
const { adfToMarkdown } = require('./adf-to-md.cjs');
const { detectLog, compressLog } = require('./log-slim.cjs'); // M10: log/build-output text compressor

// ---------------------------------------------------------------------------- config --

// Defaults mirror Headroom's SmartCrusherConfig (the crush knobs) plus fnd pipeline knobs.
// Only the crush knobs affect parity; the pipeline knobs gate the fnd-specific stages.
const DEFAULTS = {
  // --- array crush (SmartCrusher parity) ---
  minItemsToAnalyze: 5, // arrays with < N items are recursed into, never crushed
  maxItemsAfterCrush: 15, // hard cap on kept real rows
  firstFraction: 0.3, // number/string paths: leading slice kept
  lastFraction: 0.15, // number/string paths: trailing slice kept
  varianceThreshold: 2, // the σ-multiplier for outliers / anomalies / change-points
  preserveChangePoints: true,
  dedupIdenticalItems: true,
  enableMarker: true, // append the {_ccr_dropped:…} sentinel when rows are offloaded
  markerMode: 'spill', // 'spill' → write dropped rows to a file, handle = full=<path>;
  //                       'ccr'   → reproduce Headroom's content hash (byte-parity tests only)
  spillDir: null, // override the spill directory (else FND_MCP_SLIM_DIR, else os.tmpdir())
  // spillSink / spillCreatedSink — CALLER-SUPPLIED ONLY, deliberately absent from these defaults: an
  // array here would be copied by REFERENCE through every `{...DEFAULTS}` spread and accumulate paths
  // for the process lifetime. Pass one in and every spill this call writes is pushed onto it (see
  // noteSpill); the second sink takes only the subset this call actually CREATED, which is the only
  // subset a caller discarding its result may unlink.
  deadline: null, // absolute ms timestamp (Date.now() scale) after which the pipeline stops and hands
  //                 the ORIGINAL back as `budget-exceeded`; null ⇒ no budget (CLI default)
  // --- fnd pipeline stages (slim only, not crush) ---
  adf: true, // stage 1: ADF doc nodes → markdown
  noise: true, // stage 3: drop nulls / empty containers / avatar-class keys
  dropRestLinks: true, // stage 3: drop `self` REST-navigation URLs (Jira/Confluence _links.self)
  truncate: true, // stage 4: clip base64 / data-URI / very long strings
  stringLimit: 200, // stage 4 threshold (chars)
  toon: false, // optional lossless tabular re-serialization of uniform arrays (behind a flag)
  jsonl: true, // detect a JSONL line stream (bulk-operation dump) → crush it as the same-shape array it is
  log: true, // M10: detect log/build-output TEXT → signal-select (errors/traces/summaries kept, spam deduped)
  jsx: true, // M13: detect Figma design-context JSX → className dictionary + node-id legend + ×N sibling fold
  fence: true, // M11: unwrap a DOMINANT markdown fence (tool prose + ```json…```) and re-run the pipeline on its body
  envelope: true, // M14: unwrap a PURE MCP text-block envelope ([{type:'text',text:'<json>'}]) and slim the inner payload
  fenceDominance: 0.8, // M11: the fenced body must be ≥ this fraction of total bytes (else a doc with a small code block → untouched)
  fencePreambleMax: 3, // M11: the opening fence must appear within this many leading lines (a short prose preamble)
  fenceTrailerMax: 3, // M11: at most this many lines may follow the closing fence
  // --- CLI whale gates (M9b; CLI-only — the hook never reaches these sizes, the platform truncates first) ---
  cliOutCap: 49152, // Gate A: a slimmed body larger than 48 KB is spilled + summarized, not printed inline
  streamGateBytes: 8 * 1024 * 1024, // Gate B: a file larger than 8 MB is stream-PROFILED, never readFileSync'd
  trace: false, // instrument `stages` (which stages changed bytes) for the FND_MCP_SLIM_DEBUG feed;
  //               off ⇒ a single final compact() (pre-M6 cost) — the hot path pays nothing when off
  // preserveFields { keyName: true } leaves the value/subtree under those keys uncrushed. Escape
  // hatch: name an ARRAY's own key to keep it whole — a field inside crushable rows does NOT shield
  // those rows from sampling (row-level preserve is a possible future enhancement).
  preserveFields: {},
};

// Substring-matched (lower-cased compact JSON) → the item is preserved as an "error" row.
const ERROR_KEYWORDS = [
  'error', 'exception', 'failed', 'failure', 'critical', 'fatal',
  'crash', 'panic', 'abort', 'timeout', 'denied', 'rejected',
];

// ---------------------------------------------------------------------------- helpers --

const trunc = Math.trunc;

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'list';
  const t = typeof v;
  if (t === 'boolean') return 'bool';
  if (t === 'number') return 'number';
  if (t === 'string') return 'str';
  if (t === 'object') return 'dict';
  return 'other'; // undefined / function — never appears in parsed JSON
}

// compactSerialize: no spaces, insertion-order keys, non-ASCII kept as UTF-8 — matches Python
// json.dumps(x, separators=(',',':'), ensure_ascii=False) for the payloads we handle.
const compact = (v) => JSON.stringify(v);

// JSON.parse is the ONE reader here that rejects a leading BOM (shapeHint, parseJsonl, unwrapFence and
// sniffFormat all strip one), so every JSON.parse of caller-supplied text goes through this.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// Banker's rounding (round-half-to-even) — the number/string split uses it.
function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Loop-based min/max — `Math.min(...arr)` throws RangeError past ~1e5 elements (stack overflow).
function minMax(nums) {
  let mn = Infinity, mx = -Infinity;
  for (const v of nums) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { min: mn, max: mx };
}

// Sample standard deviation (n-1 divisor) — the σ that feeds every 2σ gate.
function sampleStd(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const v = nums.reduce((a, b) => a + (b - m) * (b - m), 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Linear-interpolation percentile over a sorted array (0..100).
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

function sha256hex(str, n) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex').slice(0, n);
}
// 12 hex is Headroom's ccr-marker width — byte-parity fixtures depend on it, so it keeps its own name.
function sha256hex12(str) {
  return sha256hex(str, 12);
}

// Format a stat for the number-path strategy string: round to 2 decimals, strip trailing zeros.
function fmtStat(x) {
  if (Number.isInteger(x)) return String(x);
  let s = x.toFixed(2);
  s = s.replace(/\.?0+$/, '');
  return s;
}

// ------------------------------------------------------------------- array classification --

function classifyArray(arr) {
  if (arr.length === 0) return 'Empty';
  let bool = true, dict = true, str = true, num = true, list = true;
  for (const x of arr) {
    const t = jsonType(x);
    if (t !== 'bool') bool = false;
    if (t !== 'dict') dict = false;
    if (t !== 'str') str = false;
    if (t !== 'number') num = false;
    if (t !== 'list') list = false;
  }
  if (bool) return 'BoolArray';
  if (dict) return 'DictArray';
  if (str) return 'StringArray';
  if (num) return 'NumberArray';
  if (list) return 'NestedArray';
  return 'MixedArray'; // anything else, including any null element
}

// ---------------------------------------------------------------------- budget K (adaptive) --

// Faithful-in-spirit port of compute_optimal_k. Headroom uses SimHash(MD5 4-gram)+Kneedle+zlib to
// pick a per-array budget; we use distinct-count uniqueness + the knee-fallback formula. Both agree
// on every SmartCrusher parity fixture (diverse arrays → 15, all-identical → 3). CEILING: on a real
// payload with near-duplicate-but-not-identical rows the SimHash clustering could pick a tighter
// budget than distinct-count does; upgrade path = port SimHash/Kneedle if a payload ever needs it.
function computeOptimalK(itemStrings, bias, minK, maxK) {
  const n = itemStrings.length;
  if (n <= 8) return n;
  const uniq = new Set(itemStrings).size;
  const clamp = (x) => Math.max(minK, Math.min(x, maxK));
  if (uniq <= 3) return clamp(Math.max(3, uniq));
  const d = uniq / n;
  const knee = Math.max(3, trunc(n * (0.3 + 0.7 * d)));
  let k = Math.max(3, trunc(knee * bias));
  k = Math.min(k, maxK);
  return Math.max(3, Math.min(k, maxK));
}

// number/string split — round-half-to-even, clamped so first+last ≤ total.
function computeKSplit(kTotal, cfg) {
  let kFirst = Math.max(1, roundHalfEven(kTotal * cfg.firstFraction));
  let kLast = Math.max(1, roundHalfEven(kTotal * cfg.lastFraction));
  kFirst = Math.min(kFirst, kTotal);
  kLast = Math.min(kLast, kTotal - kFirst);
  return { kFirst, kLast };
}

// -------------------------------------------------------------- dict-array field statistics --

// Sorted (ASCII) union of keys across all items — the determinism contract; a missing key = null.
function unionKeys(items) {
  const set = new Set();
  for (const it of items) for (const k of Object.keys(it)) set.add(k);
  return [...set].sort();
}

function fieldValues(items, key) {
  return items.map((it) => (Object.prototype.hasOwnProperty.call(it, key) ? it[key] : null));
}

function uniqueRatio(values) {
  if (!values.length) return 0;
  const set = new Set(values.map((v) => compact(v)));
  return set.size / values.length;
}

function firstNonNullType(values) {
  for (const v of values) {
    if (v === null) continue;
    const t = typeof v;
    if (t === 'boolean') return 'bool';
    if (t === 'number') return 'number';
    if (t === 'string') return 'string';
    return 'other';
  }
  return 'null';
}

// A field is id-like when its values are (near-)unique and look like identifiers.
function idConfidence(values, key) {
  const present = values.filter((v) => v !== null);
  if (!present.length) return 0;
  const ur = uniqueRatio(values);
  if (ur < 0.9) return 0; // hard gate
  const type = firstNonNullType(values);
  if (type === 'string') {
    const sample = present.slice(0, 20);
    const uuidish = sample.filter((v) => /^[0-9a-fA-F-]{8,}$/.test(String(v))).length;
    if (uuidish > 0.8 * sample.length) return 0.95;
    if (ur > 0.95) return 0.8;
  } else if (type === 'number') {
    const nums = present.map(Number);
    let sequential = true;
    for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] !== 1) { sequential = false; break; }
    if (sequential && ur > 0.95) return 0.9;
    const mm = minMax(nums);
    const range = mm.max - mm.min;
    if (range > 0 && ur > 0.95) return 0.85;
  }
  if (ur > 0.98) return 0.7;
  return 0;
}

// Structural outliers: items owning a rare field, or holding a rare value in an otherwise-uniform
// common field. Returns a Set of indices. (§ detect_structural_outliers)
function structuralOutliers(items, keys) {
  const n = items.length;
  const out = new Set();
  if (n < 5) return out;
  const presence = {};
  for (const k of keys) presence[k] = items.filter((it) => Object.prototype.hasOwnProperty.call(it, k)).length;
  const rareFields = keys.filter((k) => presence[k] < n * 0.2);
  const commonFields = keys.filter((k) => presence[k] >= n * 0.8);
  // rare-field owners
  items.forEach((it, i) => {
    if (rareFields.some((k) => Object.prototype.hasOwnProperty.call(it, k))) out.add(i);
  });
  // rare-status values in common fields
  for (const k of commonFields) {
    const values = fieldValues(items, k);
    const distinct = new Set(values.filter((v) => v !== null).map((v) => compact(v)));
    const card = distinct.size;
    if (card < 2 || card > 50) continue;
    const counts = new Map();
    for (const v of values) {
      const key = v === null ? '__none__' : compact(v);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const total = values.length;
    const threshold = Math.ceil(total * 0.8);
    const ordered = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const topK = new Set();
    let cum = 0;
    for (const [val, c] of ordered) {
      topK.add(val);
      cum += c;
      if (cum >= threshold) break;
    }
    if (topK.size > 5) continue;
    values.forEach((v, i) => {
      const key = v === null ? '__none__' : compact(v);
      if (!topK.has(key)) out.add(i);
    });
  }
  return out;
}

function errorItems(items) {
  const out = new Set();
  items.forEach((it, i) => {
    const s = compact(it).toLowerCase();
    if (ERROR_KEYWORDS.some((kw) => s.includes(kw))) out.add(i);
  });
  return out;
}

// Per numeric field, indices where |v - mean| > 2σ (strict). (§ anomaly_count)
function numericAnomalies(items, keys, cfg) {
  const out = new Set();
  for (const k of keys) {
    const values = fieldValues(items, k);
    if (firstNonNullType(values) !== 'number') continue;
    const nums = [];
    const idx = [];
    values.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) { nums.push(v); idx.push(i); } });
    if (nums.length < 2) continue;
    const m = mean(nums);
    const sd = sampleStd(nums);
    if (sd <= 0) continue;
    nums.forEach((v, j) => { if (Math.abs(v - m) > cfg.varianceThreshold * sd) out.add(idx[j]); });
  }
  return out;
}

// Change points on a numeric series: window-5 running means, |R-L| > 2·(global σ), ≥ window apart.
function changePointsForSeries(nums, cfg) {
  const out = new Set();
  const n = nums.length;
  if (n < 10) return out;
  const sd = sampleStd(nums);
  if (sd <= 0) return out;
  const w = 5;
  const cps = [];
  for (let i = w; i < n - w; i++) {
    const L = mean(nums.slice(i - w, i));
    const R = mean(nums.slice(i, i + w));
    if (Math.abs(R - L) > cfg.varianceThreshold * sd) cps.push(i);
  }
  // greedy dedup: keep change-points more than `window` apart
  let last = -Infinity;
  for (const cp of cps) { if (cp - last > w) { out.add(cp); last = cp; } }
  return out;
}

function dictChangePoints(items, keys, cfg) {
  const out = new Set();
  for (const k of keys) {
    const values = fieldValues(items, k);
    if (firstNonNullType(values) !== 'number') continue;
    const nums = values.map((v) => (typeof v === 'number' ? v : NaN));
    if (nums.some((x) => Number.isNaN(x))) continue; // needs a full numeric column
    for (const cp of changePointsForSeries(nums, cfg)) out.add(cp);
  }
  return out;
}

// ------------------------------------------------------------------ dict-array analysis --

// Every per-key pass below walks all n rows, so the analysis costs rows × unionKeys. That union is
// bounded by a fixed schema in real traffic, but a shape with per-ROW key names (per-row-aliased
// GraphQL fields, metafield-keyed maps) makes it rows × keys and the whole analysis quadratic in
// bytes: measured 0.6 s at 151 KB, 10 s at 618 KB, 45 s at 1.28 MB.
// The UNION SIZE is that signal and the primary gate — an order above any real schema (a wide
// analytics row is ~200 keys) and far below the 80,000 the adversarial shape reaches at 2000 rows.
// The product is only the runtime backstop, and it has to sit well above the fixed-schema bulk dumps
// this compressor exists for: they cost rows × keys too, but that product is linear in bytes, and a 2e6
// cap declined an ordinary 300k-row × 7-key JSONL dump (2.1e6 ops) outright.
// Measured throughput is 1.3–2.9e6 row×key ops/s (the low end is the wide schemas this cap governs), so
// 4e6 bounds ONE call at ~2–3 s. That cost is uninterruptible and lands ON TOP of cfg.deadline, which
// can only stop the next unit of work — which is why the union cap, not this, is the primary gate.
const ANALYSE_KEYS_CAP = 2000;
const ANALYSE_OPS_CAP = 4e6;

// Decide whether a dict array is worth crushing and which generic strategy applies.
// Returns { crushable, strategy, reason, sig:{errors,structural,anomalies,changePoints,errorCount} }
// (the four are Sets of item indexes; errorCount is a count).
function analyseDictArray(items, cfg) {
  const n = items.length;
  const keys = unionKeys(items);
  if (keys.length > ANALYSE_KEYS_CAP || keys.length * n > ANALYSE_OPS_CAP) {
    // Declining keeps the array whole — the same outcome as any other skip, reached before the work
    // instead of after it.
    return { crushable: false, strategy: 'skip', reason: 'analysis_too_wide', sig: { errors: new Set(), structural: new Set(), anomalies: new Set(), changePoints: new Set(), errorCount: 0 } };
  }

  // id field = the max-confidence id-like field (first in sorted order wins ties)
  let idKey = null, bestConf = 0;
  for (const k of keys) {
    const conf = idConfidence(fieldValues(items, k), k);
    if (conf > bestConf) { bestConf = conf; idKey = k; }
  }
  const hasId = bestConf >= 0.7;
  const idUniqueness = idKey ? uniqueRatio(fieldValues(items, idKey)) : 0;

  // signals
  const errors = errorItems(items);
  const structural = structuralOutliers(items, keys);
  const anomalies = numericAnomalies(items, keys, cfg);
  const changePoints = dictChangePoints(items, keys, cfg);
  const errorCount = Math.max(structural.size, errors.size);
  const hasChangePoints = changePoints.size > 0;
  // error keywords only count as a signal when there are no structural outliers
  const errorKwSignal = structural.size === 0 && errors.size > 0;
  // score-field routing (TopN / search_results) is intentionally omitted — the parity corpus never
  // exercises it and every crushable case routes to SmartSample.
  const hasAnySignal = structural.size > 0 || errorKwSignal || anomalies.size > 0 || hasChangePoints;

  // uniqueness metrics (string / numeric fields, excluding the id field)
  const stringUniq = [];
  const numUniq = [];
  for (const k of keys) {
    if (hasId && k === idKey) continue;
    const values = fieldValues(items, k);
    const t = firstNonNullType(values);
    if (t === 'string') stringUniq.push(uniqueRatio(values));
    else if (t === 'number') numUniq.push(uniqueRatio(values));
  }
  const avgStringUniq = stringUniq.length ? mean(stringUniq) : 0;
  const avgNumUniq = numUniq.length ? mean(numUniq) : 0;
  const maxUniqueness = Math.max(avgStringUniq, hasId ? idUniqueness : 0, 0);
  const nonIdContentUniqueness = Math.max(avgStringUniq, avgNumUniq);

  const sig = { errors, structural, anomalies, changePoints, errorCount };

  // crushability decision tree — first match wins, strict comparisons
  let crushable, reason;
  if (nonIdContentUniqueness < 0.1 && hasId) { crushable = true; reason = 'repetitive_content_with_ids'; }
  else if (maxUniqueness < 0.3) { crushable = true; reason = 'low_uniqueness_safe_to_sample'; }
  else if (hasId && maxUniqueness > 0.8 && !hasAnySignal) { crushable = false; reason = 'unique_entities_no_signal'; }
  else if (maxUniqueness > 0.8 && hasAnySignal) { crushable = true; reason = 'unique_entities_with_signal'; }
  else if (!hasAnySignal) { crushable = false; reason = 'medium_uniqueness_no_signal'; }
  else { crushable = true; reason = 'medium_uniqueness_with_signal'; }

  if (n < cfg.minItemsToAnalyze) return { crushable: false, strategy: 'none', reason: '', sig };
  if (!crushable) return { crushable: false, strategy: 'skip', reason, sig };

  // strategy: the parity corpus only ever needs SmartSample once crushable (time_series is caught
  // by the Skip branch above). TopN/Cluster/TimeSeries routing would slot in here.
  return { crushable: true, strategy: 'smart_sample', reason, sig };
}

// -------------------------------------------------------------------- index selection --

// Position anchors — spread a small budget across front / middle / back regions. (§ select_anchors)
function selectAnchors(items, maxItems) {
  const n = items.length;
  const keep = new Set();
  if (n <= maxItems) { for (let i = 0; i < n; i++) keep.add(i); return keep; }
  let budget = Math.min(12, Math.max(3, trunc(maxItems * 0.25)));
  budget = Math.min(budget, n);
  const frontSlots = Math.max(1, trunc(budget * 0.5));
  const backSlots = Math.max(1, trunc(budget * 0.4));
  const middleSlots = budget - frontSlots - backSlots;
  const hash = (i) => compact(items[i]);

  const selectRegion = (start, end, slots, set) => {
    const size = end - start;
    if (size <= 0 || slots <= 0) return;
    if (slots >= size) { for (let i = start; i < end; i++) set.add(i); return; }
    const step = size / (slots + 1);
    const seen = new Set([...set].map(hash));
    for (let j = 0; j < slots; j++) {
      let idx = start + trunc((j + 1) * step);
      if (idx >= end) idx = end - 1;
      // skip content-dupes via +1,-1,+2,-2 nudges
      const nudges = [0, 1, -1, 2, -2];
      for (const d of nudges) {
        const cand = idx + d;
        if (cand < start || cand >= end) continue;
        if (!set.has(cand) && !seen.has(hash(cand))) { set.add(cand); seen.add(hash(cand)); break; }
      }
    }
  };

  const frontEnd = Math.min(frontSlots * 2, Math.floor(n / 3));
  selectRegion(0, frontEnd, frontSlots, keep);
  const backStart = Math.max(n - backSlots * 2, Math.floor((2 * n) / 3));
  selectRegion(backStart, n, backSlots, keep);
  if (middleSlots > 0) {
    // info-density middle: gather slots*3 stride candidates, score, take the top `middleSlots`
    const mStart = keep.size ? Math.min(...keep) + 1 : Math.floor(n / 3);
    const mEnd = keep.size ? Math.max(...keep) : Math.floor((2 * n) / 3);
    const lo = Math.max(frontEnd, 1);
    const hi = Math.min(backStart, n);
    const region = Math.max(0, hi - lo);
    if (region > 0) {
      const want = middleSlots * 3;
      const step = region / (want + 1);
      const cands = [];
      for (let j = 0; j < want; j++) {
        let idx = lo + trunc((j + 1) * step);
        if (idx >= hi) idx = hi - 1;
        if (idx >= lo && !cands.includes(idx)) cands.push(idx);
      }
      const scored = cands.map((i) => {
        const s = compact(items[i]);
        const rareness = 1 - (items.filter((x) => compact(x) === s).length / n);
        const lengthScore = Math.min(1, s.length / 200);
        const structural = new Set(Object.keys(items[i] || {})).size / Math.max(1, unionKeys(items).length);
        return { i, score: 0.4 * rareness + 0.3 * lengthScore + 0.3 * structural };
      });
      scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
      for (let j = 0; j < middleSlots && j < scored.length; j++) keep.add(scored[j].i);
    }
  }
  return keep;
}

// Collapse content-identical indices to the lowest, fill toward the budget, or trim if over. (§ prioritize_indices)
// signalSet = errors ∪ structural ∪ anomalies — force-kept (in full) when over budget.
function prioritizeIndices(keep, items, n, effectiveMax, signalSet) {
  const hash = (i) => compact(items[i]);
  // dedup by content → lowest index wins
  const byHash = new Map();
  for (const i of [...keep].sort((a, b) => a - b)) { const h = hash(i); if (!byHash.has(h)) byHash.set(h, i); }
  let current = new Set([...byHash.values()]);

  if (current.size < effectiveMax && current.size < n) {
    current = fillRemainingSlots(current, items, n, effectiveMax);
  }
  if (current.size <= effectiveMax) return current;

  // over-budget: keep ALL signals (may exceed budget), then first-3, last-2, then the rest ascending.
  const over = new Set();
  for (const i of [...(signalSet || new Set())].filter((i) => i >= 0 && i < n).sort((a, b) => a - b)) over.add(i);
  for (const i of [0, 1, 2]) if (i < n && over.size < effectiveMax) over.add(i);
  for (const i of [n - 2, n - 1]) if (i >= 0 && over.size < effectiveMax) over.add(i);
  for (const i of [...current].sort((a, b) => a - b)) { if (over.size >= effectiveMax) break; over.add(i); }
  return over;
}

function fillRemainingSlots(current, items, n, effectiveMax) {
  const hash = (i) => compact(items[i]);
  const remaining = effectiveMax - current.size;
  const candidates = [];
  for (let i = 0; i < n; i++) if (!current.has(i)) candidates.push(i);
  if (!candidates.length || remaining <= 0) return current;
  const step = Math.max(trunc(candidates.length / (remaining + 1)), 1);
  const seen = new Set([...current].map(hash));
  let added = 0;
  for (let startOffset = 0; startOffset < step && added < remaining; startOffset++) {
    for (let i = startOffset; i < candidates.length && added < remaining; i += step) {
      const idx = candidates[i];
      const h = hash(idx);
      if (!seen.has(h)) { current.add(idx); seen.add(h); added++; }
    }
  }
  return current;
}

// ------------------------------------------------------------------------- markers / spill --

// The one home for "where spills live" — shared by every writer (this module's crush spill, the
// mcp-slim hook's whole-original spill) AND the sweep, so the sweep scans the same DIR we write to.
function spillRoot(dir) {
  return dir || process.env.FND_MCP_SLIM_DIR || os.tmpdir();
}

// 64 bits of content address. Names are CONTENT-addressed so re-running the same tool call reuses one
// file instead of adding another (a live week: 23 distinct payloads → 1030 files / 307 MB per TTL
// window). Not 12 hex like the ccr marker: a collision here hands the WRONG payload back behind a live
// `full=` handle, so the margin is the whole point. A same-name/different-SIZE file is treated as a
// collision below; a same-size collision is accepted (~2⁻⁶⁴ per pair).
const SPILL_HASH_HEX = 16;

// The ONE spill writer for the four compressor prefixes (fnd-crush-, fnd-slim-out-, fnd-jsx-ids-,
// fnd-mcp-slim-), so dedup, the atomic write and the mtime discipline are decided once —
// fnd-prompt-json- deliberately stays outside it (see SPILL_PREFIXES). Returns { path, created } or
// null when nothing could be written (buildMarker, spillOriginal, the jsx id map and capOutput's
// Gate A all depend on that failure path).
function writeSpill(dir, prefix, text) {
  try {
    const root = spillRoot(dir);
    // 0700 on a dir this call CREATES: a spill carries whole MCP results (tokens, customer PII) and
    // lives for the TTL window, so a shared tmpdir must not expose the tree. An existing dir keeps its
    // own mode — os.tmpdir() is the usual root and is never re-chmod'ed here.
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const bytes = Buffer.byteLength(text, 'utf8');
    const hash = sha256hex(text, SPILL_HASH_HEX);
    // Two candidates, BOTH content-addressed. A base name holding foreign bytes — a hash collision or a
    // truncated leftover (this repo has seen a 0-byte truncation) — must never be overwritten and never
    // be handed back as ours, but a RANDOM retry name would then mint one file per call for as long as
    // that leftover sits in the dir: the 1030-files-for-23-payloads regression, silently restored for one
    // payload. The retry name hashes content+size instead, so every later call for the same payload lands
    // on the same second name and dedups there.
    const names = [`${prefix}${hash}.json`, `${prefix}${hash}-${sha256hex(`${hash}:${bytes}`, 8)}.json`];
    let p = null;
    for (const name of names) {
      const cand = path.join(root, name);
      let st;
      // lstat, not stat: a symlink planted at this predictable content name would otherwise be
      // measured through its target and that foreign file handed back behind a live `full=` handle.
      try { st = fs.lstatSync(cand); } catch (_) { p = cand; break; } // nothing there → write it
      if (st.isFile() && st.size === bytes && dedupSafe(cand, st)) {
        // Same bytes already on disk. Re-date it: the TTL sweep prunes by mtime, so a REUSED spill
        // would otherwise expire while the handle this call just handed out still names it.
        try { const now = new Date(); fs.utimesSync(cand, now, now); } catch (_) {}
        return { path: cand, created: false };
      }
    }
    // Both content names occupied by foreign bytes: a random name is the only safe write left. It does
    // not dedup, but nothing is overwritten and no foreign file is handed back behind a live handle.
    if (!p) p = path.join(root, `${prefix}${hash}-${crypto.randomUUID().slice(0, 8)}.json`);
    // tmp + rename, so two processes spilling identical content race safely and no reader can ever see
    // a half-written file behind a handle. The tmp keeps the fnd- prefix, so a leaked one is swept.
    // `wx` + 0600: the final name is a content hash, so the tmp name is predictable — a symlink planted
    // there would send the payload into a foreign file, and a plain write would leave the spill
    // world-readable for the whole TTL window. EEXIST (a planted link, or a crashed run's leftover from
    // a recycled pid) retries ONCE under a random name, or that one leftover would null every later
    // spill of this payload; any other error keeps the cleanup+throw path.
    let tmp = `${p}.tmp-${process.pid}`;
    try {
      try {
        fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
        tmp = `${p}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
        fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
      }
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
    return { path: p, created: true };
  } catch (_) {
    return null;
  }
}

// A same-name/same-size candidate may only be deduped when this user can actually READ it and OWNS
// it (statSync needs neither — in a shared tmpdir it happily returns a neighbour's 0600 spill, and
// utimesSync on a foreign file is a silent EPERM, so the sweep-protecting re-date would never happen).
// A failed gate falls through to the content-addressed retry name: never hand a foreign or unreadable
// file back behind a live handle.
function dedupSafe(cand, st) {
  try { fs.accessSync(cand, fs.constants.R_OK); } catch (_) { return false; }
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

// Report a written spill to the caller's `cfg.spillSink` (an array it supplied — see the config
// comment on spillDir). The channel the mcp-slim hook and the CLI use to name, on their one debug
// line, every file the invocation left on disk — the orphan question the log could not answer.
// `created` (writeSpill's second return field) additionally rides on `cfg.spillCreatedSink`: only a
// file THIS call brought into existence may be cleaned up when the handle naming it is discarded — a
// deduped one may still be the target of an earlier invocation's live handle. It BOUNDS orphans, it
// does not prove sole ownership: the names are content-addressed, so two processes spilling identical
// bytes at the same moment both mint one, and a caller's cleanup is best-effort against that race.
function noteSpill(cfg, p, created) {
  if (!p || !cfg) return;
  if (Array.isArray(cfg.spillSink)) cfg.spillSink.push(p);
  if (created && Array.isArray(cfg.spillCreatedSink)) cfg.spillCreatedSink.push(p);
}

// Build the {_ccr_dropped:…} sentinel. 'ccr' reproduces Headroom's content hash (byte-parity
// tests); 'spill' writes the dropped rows to a file and references them as full=<path>.
function buildMarker(originalItems, droppedItems, droppedCount, cfg) {
  if (cfg.markerMode === 'ccr') {
    const hash = sha256hex12(compact(originalItems));
    return `<<ccr:${hash} ${droppedCount}_rows_offloaded>>`;
  }
  // If the spill can't be written the dropped rows would be unrecoverable — signal failure so the
  // caller keeps the array uncrushed rather than emit a handle to a file that does not exist.
  const s = writeSpill(cfg.spillDir, 'fnd-crush-', compact(droppedItems));
  if (!s) return null;
  noteSpill(cfg, s.path, s.created);
  return `<<full=${s.path} ${droppedCount}_rows_offloaded>>`;
}

// ------------------------------------------------------------------------- spill hygiene --

// The only file prefixes the sweep will ever delete. Keep in sync with the writers' filenames: the crush
// marker here (fnd-crush-), `capOutput`'s Gate-A spill here (fnd-slim-out-), the jsx stage's node-id map
// here (fnd-jsx-ids-), `spillOriginal` in hooks/mcp-slim.cjs (fnd-mcp-slim-) — all four go through
// writeSpill, which appends a content hash — and `spillBlob` in hooks/prompt-json-guard.cjs
// (fnd-prompt-json-), the ONE exception: it still mints a `<uuid>` name with a plain writeFileSync, so it
// neither dedups nor appears in any `spills` telemetry, and it writes to the task workspace or a bare
// os.tmpdir() (this sweep reaches it only when that tmpdir IS the sweep dir). Prefix matching identifies
// all five either way. The literals are duplicated on purpose — importing this module into a per-prompt
// hook just for a string would drag the whole compressor into every UserPromptSubmit.
const SPILL_PREFIXES = ['fnd-crush-', 'fnd-slim-out-', 'fnd-jsx-ids-', 'fnd-mcp-slim-', 'fnd-prompt-json-'];
// One directory scan per throttle window, gated by this marker's mtime — the hook's hot path
// pays one stat, not a readdir of the whole tmpdir on every MCP call. A dotfile, so it matches
// no SPILL_PREFIX (it is excluded for good measure anyway).
const SWEEP_MARKER = '.fnd-mcp-slim-sweep';
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;
// R6: the whale-guidance one-shot state files (one per session × profiled file, see
// whaleGuideStatePath). Also dotfiles — same reason as SWEEP_MARKER: they must match no SPILL_PREFIX so
// they are never mistaken for a payload spill, and they must stay invisible to a plain `ls` because the
// suites assert a profile run adds NO listed file to the spill dir. The sweep prunes them by this prefix
// on age (they are pure hints — losing one only reprints the full guidance block once).
const WHALE_GUIDE_PREFIX = '.fnd-whale-guide-';
// B2: the per-file no-gain memo (one per session × DECLINED file, see nogainStatePath). A dotfile for
// exactly the WHALE_GUIDE_PREFIX reasons — it must match no SPILL_PREFIX, and it must stay invisible to
// a plain `ls` because the suites assert a run adds NO listed file to the spill dir. Swept by age below:
// losing one only costs one re-printed body.
const NOGAIN_PREFIX = '.fnd-nogain-';
// Fixed (not sliding) window, like WHALE_GUIDE_TTL_MS: the stamp is written at the decline, so a session
// that keeps re-running one declined file gets the body back once every 2 h instead of once per run.
const NOGAIN_TTL_MS = 2 * 60 * 60 * 1000;
// Below this a refusal saves less context than the state file is worth reasoning about — the same scale
// as the hook's sub-gate, where a result this small is not worth compressing either.
const NOGAIN_FLOOR_BYTES = 4096;
// The FND_MCP_SLIM_DEBUG log basename (its writer + rotation live in the debug-log section below);
// defined here so SWEEP_KEEP is the single source of truth — the sweep must never prune it.
const DEBUG_LOG = 'fnd-mcp-slim-debug.log';
// Files that share a spill prefix but must survive: the debug log + its one rotation, and the sweep
// marker. Excluded by EXACT name, so `fnd-mcp-slim-debug.log` is never mistaken for a spill and swept.
const SWEEP_KEEP = new Set([DEBUG_LOG, `${DEBUG_LOG}.1`, SWEEP_MARKER]);
// The bundled @playwright/mcp server's `--output-dir`, PROJECT-relative: the server resolves it against
// its own cwd, which every host launches in the project dir. The same literal is spelled in the manifest's
// args and in hooks/scratch-path-guard.cjs; a hooks-sim case pins the three together. Without it the
// server defaults to `<cwd>/.playwright-mcp`, where every no-`filename` screenshot, `.yml` snapshot dump
// and console log lands — 374 untracked files in one client checkout, gitignored by nobody. Pointing it
// under `.claude/` puts that traffic in a directory this sweep prunes and git never sees.
const PLAYWRIGHT_OUT_REL = '.claude/fnd-tmp/playwright';
// The `.git/info/exclude` pattern that keeps the whole scratch root out of `git status` (and out of a
// bulk `git add`). The written line is anchored (leading slash) and trailing-slashed: a directory,
// never a stray match — and anchoring is at the REPO root, so the line is built with the project's
// path prefix inside the repo rather than used as-is (see ensureFndTmpExcluded).
const EXCLUDE_SUFFIX = '.claude/fnd-tmp/';

// Parse FND_MCP_SLIM_TTL as hours. Default 24; exactly `0` disables the sweep. ANY invalid value —
// non-numeric, NaN, negative — falls back to 24: a negative TTL must NEVER become a past cutoff
// that mass-deletes fresh spills (the rule that keeps a typo safe). parseFloat, so `0.5` works.
function spillTtlHours(raw) {
  if (raw === undefined || raw === null || raw === '') return 24;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 24;
  return n;
}

// Age-based TTL sweep of the shared spill dir. Best-effort and fully self-contained: every error
// is swallowed so a sweep NEVER affects the hook's emitted result or the CLI's output/exit code.
// Deletes only our-prefixed files (payload spills + the WHALE_GUIDE_PREFIX / NOGAIN_PREFIX hint files)
// whose mtime is older than the TTL — files written by the current
// process are always fresh, so an in-flight `full=<path>` handle survives up to the TTL (a day
// covers same-day conversation resume; an older, expired handle is an already-tolerated re-fetch).
// Called by BOTH entry points (the mcp-slim hook after it writes stdout, the CLI at exit) so one
// implementation covers every writer. NB the prompt-json guard's WORKSPACE-placed spills ride with
// the task workspace, outside this dir; its tmpdir spills are swept only when the sweep dir is the
// default os.tmpdir() (FND_MCP_SLIM_DIR unset — the common case). Returns a small summary for tests.
// `projectDir` adds the second pass: the playwright output dir lives in the PROJECT, not in the
// shared spill dir, so it can only be reached from here with the project in hand. Omitting it keeps
// the old single-dir behaviour. The hook passes the EVENT's cwd, which names the project exactly;
// the CLI passes its own process.cwd(), which is the agent shell's working dir — the project only
// when the run started at the project root, and a harmless miss (an absent dir) otherwise.
function sweepSpills(dir, projectDir) {
  const summary = { disabled: false, throttled: false, swept: 0 };
  try {
    const ttl = spillTtlHours(process.env.FND_MCP_SLIM_TTL);
    if (ttl === 0) { summary.disabled = true; return summary; }
    const root = spillRoot(dir);
    const marker = path.join(root, SWEEP_MARKER);
    const now = Date.now();
    try {
      if (now - fs.statSync(marker).mtimeMs < SWEEP_THROTTLE_MS) { summary.throttled = true; return summary; }
    } catch (_) {} // no marker yet → first sweep in this dir
    // Touch BEFORE scanning so a sibling hook firing during the scan sees a fresh marker and skips
    // — one scan per window even under parallel MCP calls. The spill root is never CREATED here: a
    // typo'd FND_MCP_SLIM_DIR must not silently grow a tree.
    let claimed = false;
    try { fs.writeFileSync(marker, ''); claimed = true; } catch (_) {}
    const cutoff = now - ttl * 3600 * 1000;
    let names;
    // An unreadable spill root is not a reason to skip the PROJECT pass below — the two dirs are
    // independent, and the marker (written before the scan) still throttles the window.
    try { names = fs.readdirSync(root); } catch (_) { names = []; }
    for (const name of names) {
      if (SWEEP_KEEP.has(name)) continue;
      if (!SPILL_PREFIXES.some((p) => name.startsWith(p)) && !name.startsWith(WHALE_GUIDE_PREFIX) && !name.startsWith(NOGAIN_PREFIX)) continue;
      try {
        const p = path.join(root, name);
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); summary.swept++; }
      } catch (_) {} // gone / racing another sweep / unreadable → skip
    }
    // Only behind a CLAIMED marker: an unwritable spill root (a missing dir, a read-only one) means
    // the throttle window never closes, and an unthrottled project pass — a recursive walk plus two
    // git forks — would then run on every single hook invocation. It also stamps `.git/info/exclude`,
    // and only for a project playwright has actually written in.
    if (claimed && typeof projectDir === 'string' && projectDir) sweepPlaywrightOut(projectDir, cutoff, summary);
  } catch (_) {} // any failure → no-op
  return summary;
}

// Second sweep target: `<project>/.claude/fnd-tmp/playwright`, where the bundled server drops the
// artefacts no tool call names a path for (page-<ts>.png, the .yml snapshot dumps, console-<ts>.log,
// session/trace files). Same TTL and the same total silence as the spill pass — the browser session's
// own files are only ever re-read within the run that made them. Directories are left standing:
// playwright nests per-session dirs, and an empty one costs nothing while removing it could race a
// live session. Absent dir = playwright never ran in this project, the common case, so this is one
// stat on the throttled path.
function sweepPlaywrightOut(projectDir, cutoff, summary) {
  // Every component of the path has to be a REAL directory, checked with lstat: the walk below deletes
  // by mtime alone, with no name filter, so a single symlinked component would aim it at whatever the
  // link points at and prune that instead. Not hypothetical — this plugin's own worktree flow symlinks
  // `<wt>/.claude/tasks` at the main checkout, so a part-symlinked `.claude` subtree is a live shape.
  // (Nested entries are already lstat-based: readdir Dirents do not follow links.)
  let dir = projectDir;
  for (const seg of PLAYWRIGHT_OUT_REL.split('/')) {
    dir = path.join(dir, seg);
    try {
      if (!fs.lstatSync(dir).isDirectory()) return;
    } catch (_) { return; }
  }
  const walk = (d, depth) => {
    if (depth > 8) return; // a pathological nest is not worth unbounded recursion
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.isFile()) continue; // symlinks and sockets are not ours to delete
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); summary.swept++; }
      } catch (_) {} // gone / racing / unreadable → skip
    }
  };
  walk(dir, 0);
  ensureFndTmpExcluded(projectDir);
}

// Keep the scratch root invisible to git without editing anything the developer owns: `.gitignore` is
// a tracked file of the client's repo, `.git/info/exclude` is local-only. Best-effort and silent —
// this rides on a sweep, and a sweep may never influence a hook's output or exit code. Two callers:
// the sweep, at most once per throttle window and only in a project playwright has written in, and
// hooks/scratch-path-guard.cjs, whose allow of the bundled server's scratch dir is justified by this
// stamp — so the guard makes it true itself rather than waiting on a compressor switch.
function ensureFndTmpExcluded(projectDir) {
  try {
    const { spawnSync } = require('child_process'); // required here so the hot path never loads it
    const opts = { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    // 0 = git already ignores it (a repo-level rule, or a stamp from an earlier run); 1 = not ignored;
    // anything else (128, a spawn failure) = no repo / no git, where there is nothing to exclude from.
    const ci = spawnSync('git', ['check-ignore', '-q', '.claude/fnd-tmp'], opts);
    if (ci.status !== 1) return;
    // An anchored pattern is read from the REPO root, but the session's project dir may sit deeper in it
    // (`cd packages/theme && claude`) — there `/.claude/fnd-tmp/` would match nothing, and the "already
    // stamped" scan below would then block the correct line forever. The prefix git reports for this dir
    // is what puts the anchor in the right place; it already ends in `/` when non-empty.
    const sp = spawnSync('git', ['rev-parse', '--show-prefix'], opts);
    if (sp.status !== 0 || typeof sp.stdout !== 'string') return;
    const line = `/${sp.stdout.trim()}${EXCLUDE_SUFFIX}`;
    // --git-path answers with the COMMON dir's file, so one stamp serves every worktree of the repo —
    // the same rule scripts/worktree-setup.sh follows for `.claude/tasks`.
    const gp = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], opts);
    if (gp.status !== 0 || typeof gp.stdout !== 'string') return;
    const rel = gp.stdout.trim();
    if (!rel) return;
    const file = path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) {} // no exclude file yet → create it below
    const has = body.split('\n').some((l) => l.trim() === line);
    if (has) return;
    // An exclude file whose last byte is not a newline is legal and not rare; appending blind would glue
    // our pattern onto the developer's last one, breaking both.
    const bridge = body !== '' && !body.endsWith('\n') ? '\n' : '';
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
    fs.appendFileSync(file, `${bridge}${line}\n`);
  } catch (_) {} // any failure → the dir stays visible in git status, which is not worth a broken hook
}

// ---------------------------------------------------------------------------- debug log --

// Opt-in observability (FND_MCP_SLIM_DEBUG, off by default): one JSONL metadata line per hook/CLI
// invocation → <spill-dir>/<DEBUG_LOG>. Metadata ONLY (bytes/decision/reason/stages) — never any
// payload content. The M5 sweep excludes this file and its rotation by exact name (SWEEP_KEEP, where
// DEBUG_LOG is defined). Single home: the mcp-slim hook and this module's CLI both call debugLog().
const DEBUG_LOG_MAX = 5 * 1024 * 1024; // rotate one generation past ~5 MB (bounded, keeps the recent window)
// A payload with many crushable arrays writes one spill per array; cap how many a single line may name
// so a debug line can never grow toward DEBUG_LOG_MAX (the total still rides along as `spills_n`).
const SPILL_LOG_MAX = 8;

// Verbosity (B4.10c). 1/true/yes/on = KEY events; any integer ≥ 2 = everything, including the sub-gate
// lines that were 76 % of a live week's log. Anything else (unset / 0 / false / junk) → off, so the
// default really is zero side effects: debugLog opens nothing and creates no file.
function debugLevel() {
  const raw = process.env.FND_MCP_SLIM_DEBUG;
  if (!raw) return 0;
  const v = String(raw).trim();
  if (/^\d+$/.test(v) && Number(v) >= 2) return 2;
  return /^(1|true|yes|on)$/i.test(v) ? 1 : 0;
}
function debugEnabled() {
  return debugLevel() > 0;
}

// Passthrough reasons that carry no signal about compression — nothing was compressible either way, so
// level 1 omits them. Keyed on the FINAL `reason`, never on the emitting branch: the hook's
// platform-overflow (missed-whale) event comes out of the very same sub-gate branch, and it is the one
// number the MAX_MCP_OUTPUT_TOKENS decision rests on. A `compressed`/`stubbed` record can never carry
// one of these reasons, so no savings event is ever dropped.
const SUBGATE_REASONS = new Set(['size-gate']);

// The `project` tag's resolver: the nearest ancestor of the event's own cwd holding `.git` (existsSync
// matches the directory AND the worktree/submodule FILE form) → else CLAUDE_PROJECT_DIR → else the cwd
// itself. basename only, never a full path. Live logs attributed 154 of 476 events to `scratchpad`/`tmp`
// when this was basename(cwd) alone.
// The WALK comes first because it is the only rail BOTH entry points can run: Claude Code exports
// CLAUDE_PROJECT_DIR to hook commands but not to the Bash tool, so preferring it split one session in one
// monorepo into `web` (the hook, reading the launch subdir) and `myrepo` (the CLI, walking) — the log is
// per-user and shared, so the per-project grep the README documents then matched a subset. The env var
// stays as the fallback for a cwd with no repo above it. Known floor: a CLI run from a scratch dir OUTSIDE
// any repo still tags that dir's basename — no env var reaches it, so nothing local can recover the
// project name there. Memoized per env+cwd: a hook pays the walk once, and the key keeps repeated
// in-process calls (tests) honest.
const PROJECT_WALK_MAX = 64;
const projectMemo = new Map();
function projectName(cwd) {
  let name = null;
  try {
    const env = String(process.env.CLAUDE_PROJECT_DIR || '').trim();
    const from = cwd || process.cwd();
    const key = `${env}|${from}`;
    if (projectMemo.has(key)) return projectMemo.get(key);
    let root = '';
    let d = path.resolve(from);
    for (let i = 0; i < PROJECT_WALK_MAX; i++) {
      if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
      const up = path.dirname(d);
      if (up === d) break; // filesystem root — no repo above the cwd
      d = up;
    }
    if (!root) root = env || from;
    name = path.basename(path.resolve(root)) || null;
    projectMemo.set(key, name);
  } catch (_) {} // any failure → omit the field (--report buckets it as `(unknown)`)
  return name;
}

// Append one JSONL trace line (`ts` stamped here, insertion order preserved after it). Best-effort:
// disabled → no-op; every error swallowed so logging NEVER touches the hook's emitted result or the
// CLI's stdout / exit code. Rotates the log to `.log.1` (overwrite) once it passes DEBUG_LOG_MAX.
// `dir` shares the spill root so the log lives beside the spills it describes; `cwd` is the event's own
// working directory (the hook reads it off the PostToolUse payload), defaulting to this process's.
function debugLog(record, dir, cwd) {
  try {
    const level = debugLevel();
    if (!level) return;
    if (level < 2 && record && SUBGATE_REASONS.has(record.reason)) return;
    const root = spillRoot(dir);
    // 0700 for the same reason writeSpill gives: whichever writer CREATES the shared root decides the
    // mode for every spill that lands in it afterwards.
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch (_) {}
    const logPath = path.join(root, DEBUG_LOG);
    try {
      if (fs.statSync(logPath).size >= DEBUG_LOG_MAX) fs.renameSync(logPath, path.join(root, `${DEBUG_LOG}.1`));
    } catch (_) {} // no log yet, or rotate failed → just append below
    // `spills` (B4.10a) — every file the invocation wrote, deduped and capped here so no caller has to.
    // An empty list is dropped: "this run left nothing on disk" is the ABSENCE of the field.
    let rec = record;
    if (rec && Array.isArray(rec.spills)) {
      const uniq = [...new Set(rec.spills)];
      rec = { ...rec, spills: uniq.slice(0, SPILL_LOG_MAX) };
      if (uniq.length > SPILL_LOG_MAX) rec.spills_n = uniq.length;
      if (!uniq.length) delete rec.spills;
    }
    // `project` on EVERY line (M8): the spill dir — and so this log — is per-USER, so sessions from
    // different projects share one file. The tag makes it filterable per project; metadata only (a
    // basename, never the full path), and any failure just omits the field.
    const project = projectName(cwd);
    // `lvl` — the level this line was COLLECTED at. Level 1 drops the sub-gate lines above, i.e. the
    // in==out ballast, so a =1 window's totals % reads far higher than the same traffic at =2 (measured:
    // 93.6 % vs 43.4 %). The log is append-only and one file per user, and the documented workflow is to
    // flip to 2 and back, so one file straddles both. Stamping the level lets `--report` state which
    // events it is speaking about instead of inferring it from whether a `size-gate` reason happens to be
    // present — one foreign line silenced that guess, and a pre-B4.11 log (no `lvl`) recorded the sub-gate
    // events even at =1, so for those the totals ARE complete.
    // Append-only, and 0600 on the file this call may CREATE: the line carries tool names and spill
    // paths, and the log lives in a possibly shared tmpdir for as long as the user keeps debugging.
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...(project ? { project } : {}), lvl: level, ...rec })}\n`, { mode: 0o600 });
  } catch (_) {}
}

// ------------------------------------------------------------------------ per-type crush --

// DictArray: analyse → select indices → keep ascending → append sentinel for the dropped rows.
function crushDictArray(items, cfg) {
  const n = items.length;
  const itemStrings = items.map(compact);
  const adaptiveK = computeOptimalK(itemStrings, 1, 3, cfg.maxItemsAfterCrush);

  if (n <= adaptiveK) return { items, info: 'none:adaptive_at_limit', keptCount: n };

  const analysis = analyseDictArray(items, cfg);
  if (analysis.strategy === 'skip') return { items, info: `skip:${analysis.reason}`, keptCount: n };
  if (!analysis.crushable) return { items, info: '', keptCount: n };

  const { errors, structural, anomalies, changePoints } = analysis.sig;
  const keep = new Set();
  for (const i of selectAnchors(items, adaptiveK)) keep.add(i);
  const signalSet = new Set();
  for (const s of [errors, structural, anomalies]) for (const i of s) { keep.add(i); signalSet.add(i); }
  for (const cp of changePoints) for (const d of [-1, 0, 1]) { const i = cp + d; if (i >= 0 && i < n) keep.add(i); }

  const kept = prioritizeIndices(keep, items, n, adaptiveK, signalSet);
  const keptSorted = [...kept].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const outItems = keptSorted.map((i) => items[i]);
  const keptCount = outItems.length; // real rows, excluding the sentinel appended below
  const droppedCount = n - keptCount;
  if (droppedCount > 0 && cfg.enableMarker) {
    const dropped = items.filter((_, i) => !kept.has(i));
    const marker = buildMarker(items, dropped, droppedCount, cfg);
    if (marker === null) return { items, info: '', keptCount: n }; // spill failed → keep rows uncrushed
    outItems.push({ _ccr_dropped: marker });
  }
  return { items: outItems, info: 'smart_sample', keptCount };
}

// The primitive samplers keep K of N with no sentinel and no spill, so the drop used to be legible
// only in the internal `info` string — a reader answered from 16 values believing it held all 400.
// ONE trailing element says it where the data is. `ccr` mode stays marker-less: Headroom's byte-parity
// fixtures have no such element (the same carve-out sampleMixedArray's marker takes).
// Rough JSON width of a primitive array (brackets + commas + each element). String escapes are not
// counted — an undercount, which can only ever suppress a marker, never buy one.
function arrayWidth(a) {
  let w = a.length + 1;
  for (const v of a) w += typeof v === 'string' ? v.length + 2 : String(v).length;
  return w;
}
function withSampleMarker(value, arr, cfg) {
  const total = arr.length;
  if (!cfg.enableMarker || cfg.markerMode === 'ccr' || value.length >= total) return value;
  // Nothing DISTINCT was dropped ⇒ nothing is hidden: the string sampler dedups, so an array of 400
  // identical codes comes back as one of them and a marker would only claim a loss that did not happen
  // (and cost more bytes than the dedup saved).
  const shown = new Set(value);
  let hidden = 0;
  for (const v of arr) if (!shown.has(v)) hidden++;
  if (!hidden) return value;
  const marker = `…${total - value.length} more of ${total} omitted`;
  // The marker also has to pay for itself: on a map of short arrays of short values its ~30 bytes cost
  // MORE than the sampling saved, and the run then printed a body larger than the file it read.
  if (arrayWidth(arr) - arrayWidth(value) <= Buffer.byteLength(marker, 'utf8') + 3) return value;
  return [...value, marker];
}

// NumberArray: first/last slice ∪ outliers ∪ change-points, stride-fill to K. No dedup, no spill —
// `kept` is the real value count, which the marker element (if any) is not part of.
function sampleNumberArray(arr, cfg) {
  const n = arr.length;
  if (n <= 8) return { value: arr, info: 'number:passthrough', kept: n };
  const finiteIdx = [];
  arr.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) finiteIdx.push(i); });
  if (!finiteIdx.length) return { value: arr, info: 'number:no_finite', kept: n };
  const kTotal = computeOptimalK(arr.map(compact), 1, 3, cfg.maxItemsAfterCrush);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const nums = arr.map((v) => (typeof v === 'number' ? v : NaN));
  const finite = finiteIdx.map((i) => arr[i]);
  const m = mean(finite);
  const sd = sampleStd(finite);
  const keep = new Set();
  const outliers = new Set();
  if (sd > 0) arr.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - m) > cfg.varianceThreshold * sd) { outliers.add(i); keep.add(i); } });
  if (cfg.preserveChangePoints && n > 10 && sd > 0) {
    const w = 5;
    for (let i = w; i < n - w; i++) {
      const L = mean(nums.slice(i - w, i));
      const R = mean(nums.slice(i, i + w));
      if (Number.isFinite(L) && Number.isFinite(R) && Math.abs(R - L) > cfg.varianceThreshold * sd) keep.add(i);
    }
  }
  for (let i = 0; i < kFirst && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - kLast); i < n; i++) keep.add(i);
  let remaining = kTotal - keep.size;
  if (remaining > 0) {
    const stride = Math.max(trunc((n - 1) / (remaining + 1)), 1);
    const cap = kTotal + outliers.size;
    for (let i = 0; i < n; i += stride) { if (keep.size >= cap) break; keep.add(i); }
  }
  const idx = [...keep].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const value = idx.map((i) => arr[i]);
  const sorted = [...finite].sort((a, b) => a - b);
  const mm = minMax(finite);
  const stats = `min=${fmtStat(mm.min)},max=${fmtStat(mm.max)},mean=${fmtStat(m)},median=${fmtStat(median(sorted))},stddev=${fmtStat(sd)},p25=${fmtStat(percentile(sorted, 25))},p75=${fmtStat(percentile(sorted, 75))}`;
  return { value: withSampleMarker(value, arr, cfg), info: `number:adaptive(${n}->${value.length},${stats})`, kept: value.length };
}

// StringArray: first/last slice ∪ length-anomalies, stride-fill, dedup by raw string. No spill.
function sampleStringArray(arr, cfg) {
  const n = arr.length;
  if (n <= 8) return { value: arr, info: 'string:passthrough', kept: n };
  const kTotal = computeOptimalK(arr, 1, 3, cfg.maxItemsAfterCrush);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const lens = arr.map((s) => s.length);
  const m = mean(lens);
  const sd = sampleStd(lens);
  const keep = new Set();
  const anomalies = new Set();
  if (sd > 0) arr.forEach((s, i) => { if (Math.abs(s.length - m) > cfg.varianceThreshold * sd) { anomalies.add(i); keep.add(i); } });
  for (let i = 0; i < kFirst && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - kLast); i < n; i++) keep.add(i);
  let remaining = kTotal - keep.size;
  if (remaining > 0) {
    const stride = Math.max(trunc((n - 1) / (remaining + 1)), 1);
    const cap = kTotal + anomalies.size;
    const seen = new Set([...keep].map((i) => arr[i]));
    for (let i = 0; i < n; i += stride) {
      if (keep.size >= cap) break;
      if (!seen.has(arr[i])) { keep.add(i); seen.add(arr[i]); }
    }
  }
  const idx = [...keep].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const value = idx.map((i) => arr[i]);
  return { value: withSampleMarker(value, arr, cfg), info: `string:adaptive(${n}->${value.length})`, kept: value.length };
}

// Number sub-group inside a mixed array: first/last slice ∪ outliers only (no change-points, no
// stride-fill — unlike the standalone number sampler). (§3.6 "number→k-split+outliers")
function sampleMixedNumberGroup(nums, cfg) {
  const n = nums.length;
  if (n <= 8) return nums;
  const kTotal = computeOptimalK(nums.map(compact), 1, 3, cfg.maxItemsAfterCrush);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const m = mean(nums);
  const sd = sampleStd(nums);
  const keep = new Set();
  if (sd > 0) nums.forEach((v, i) => { if (Math.abs(v - m) > cfg.varianceThreshold * sd) keep.add(i); });
  for (let i = 0; i < kFirst && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - kLast); i < n; i++) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => nums[i]);
}

// MixedArray: group by JSON type (first-seen order), keep-all groups < 5, sub-sample the rest,
// reassemble in original index order. In `spill` mode (real operation) we append ONE {_ccr_dropped:…}
// sentinel over the whole array whenever rows are dropped, backed by a real spill file — the M9 CLI
// never spills the whole original the way the M2 hook does, so without this a `.jsonl` mixed dump
// would return a silently-incomplete array with no drop signal and no recovery handle. In `ccr` mode
// (byte-parity fixtures only, no spill file exists) we stay marker-less, exactly as Headroom's mixed
// path. The per-type sub-crushes keep enableMarker:false; this single top-level marker covers every
// dropped row across all subgroups.
function sampleMixedArray(arr, cfg) {
  const n = arr.length;
  if (n <= 8) return { value: arr, info: 'mixed:passthrough' };
  const groupsOrder = [];
  const groups = new Map();
  arr.forEach((v, i) => {
    const t = jsonType(v);
    const key = t === 'dict' ? 'dict' : t === 'str' ? 'str' : t === 'bool' ? 'bool' : t === 'number' ? 'num' : t === 'list' ? 'list' : 'none';
    if (!groups.has(key)) { groups.set(key, []); groupsOrder.push(key); }
    groups.get(key).push(i);
  });
  const kept = new Set();
  const parts = [];
  for (const key of groupsOrder) {
    const idxs = groups.get(key);
    const sub = idxs.map((i) => arr[i]);
    if (sub.length < 5) { idxs.forEach((i) => kept.add(i)); parts.push(`${key}:${sub.length}->${sub.length}`); continue; }
    let keptVals;
    if (key === 'dict') keptVals = crushDictArray(sub, { ...cfg, enableMarker: false }).items;
    // enableMarker:false for the dict subgroup's reason — this array gets ONE {_ccr_dropped} sentinel
    // over all groups below, and a per-group marker string has no index to map back to anyway.
    else if (key === 'str') keptVals = sampleStringArray(sub, { ...cfg, enableMarker: false }).value;
    else if (key === 'num') keptVals = sampleMixedNumberGroup(sub, cfg);
    else { idxs.forEach((i) => kept.add(i)); parts.push(`${key}:${sub.length}->${sub.length}`); continue; }
    // map kept sub-values back to original indices by greedy forward match
    let p = 0;
    for (let j = 0; j < idxs.length && p < keptVals.length; j++) {
      if (compact(arr[idxs[j]]) === compact(keptVals[p])) { kept.add(idxs[j]); p++; }
    }
    // Headroom labels the number group by size only (`num:20`); str/dict report `type:n->m`.
    parts.push(key === 'num' ? `num:${sub.length}` : `${key}:${sub.length}->${keptVals.length}`);
  }
  const idx = [...kept].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const value = idx.map((i) => arr[i]);
  const droppedCount = n - value.length;
  const info = `mixed:adaptive(${n}->${value.length},${parts.join(',')})`;
  if (droppedCount > 0 && cfg.enableMarker && cfg.markerMode === 'spill') {
    const dropped = arr.filter((_, i) => !kept.has(i));
    const marker = buildMarker(arr, dropped, droppedCount, cfg);
    // Spill failed → the dropped rows would be unrecoverable AND unsignalled; keep the array
    // uncrushed rather than hand back an incomplete result (mirrors crushDictArray).
    if (marker === null) return { value: arr, info: 'mixed:spill_failed' };
    value.push({ _ccr_dropped: marker });
  }
  return { value, info };
}

// ---------------------------------------------------------------- wall-clock budget --

// A single V8 regex or one analyseDictArray call is uninterruptible, so `cfg.deadline` cannot pre-empt
// work already running — it bounds ACCUMULATION: the walk and every stage boundary stop between units.
// Signalled by a throw so the deep recursion below needs no return-shape change; slim()'s own catch
// turns it into the `budget-exceeded` passthrough (the ORIGINAL, never a half-transformed value).
function budgetExpired(cfg) {
  return cfg.deadline != null && Date.now() > cfg.deadline;
}
function budgetStop() {
  const e = new Error('budget exceeded');
  e.fndBudget = true;
  return e;
}

// ---------------------------------------------------------------- recursive crush walk --

const MAX_DEPTH = 50;

// process_value: recurse the whole structure, crushing every qualifying array/object in place.
// Returns [value, info] where info is a comma-join of child strategy fragments.
function processValue(value, depth, cfg) {
  if (depth >= MAX_DEPTH) return [value, ''];
  if (budgetExpired(cfg)) throw budgetStop(); // between nodes: a 600-array object stops mid-walk
  const t = jsonType(value);
  if (t === 'list') {
    const arr = value;
    const n = arr.length;
    if (n >= cfg.minItemsToAnalyze) {
      const cls = classifyArray(arr);
      if (cls === 'DictArray') {
        const r = crushDictArray(arr, cfg);
        return [r.items, r.info ? `${r.info}(${n}->${r.keptCount})` : ''];
      }
      if (cls === 'StringArray') { const r = sampleStringArray(arr, cfg); return [r.value, `${r.info}(${n}->${r.kept})`]; }
      if (cls === 'NumberArray') { const r = sampleNumberArray(arr, cfg); return [r.value, `${r.info}(${n}->${r.kept})`]; }
      if (cls === 'MixedArray') { const r = sampleMixedArray(arr, cfg); return [r.value, `${r.info}(${n}->${r.value.length})`]; }
      // Empty / Bool / Nested → fall through to element recursion
    }
    const outArr = [];
    const infos = [];
    for (const el of arr) { const [v, inf] = processValue(el, depth + 1, cfg); outArr.push(v); if (inf) infos.push(inf); }
    return [outArr, infos.join(',')];
  }
  if (t === 'dict') {
    const out = {};
    const infos = [];
    for (const k of Object.keys(value)) {
      if (cfg.preserveFields && cfg.preserveFields[k]) { out[k] = value[k]; continue; }
      const [v, inf] = processValue(value[k], depth + 1, cfg);
      out[k] = v;
      if (inf) infos.push(inf);
    }
    return [out, infos.join(',')];
  }
  return [value, ''];
}

// ------------------------------------------------------------------------------- crush() --

// crush a JSON *string* → { compressed, wasModified, strategy }. Mirrors SmartCrusher::crush.
// Any transform failure → the original passes through untouched (safety rail).
function crush(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (typeof content !== 'string') return { compressed: content, wasModified: false, strategy: 'passthrough' };
  const original = content; // handed back on every non-modifying return, BOM included (see slim())
  content = stripBom(content);
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) {
    return { compressed: original, wasModified: false, strategy: 'passthrough' };
  }
  try {
    const [crushed, info] = processValue(parsed, 0, cfg);
    const compressed = compact(crushed);
    const wasModified = compressed !== content.trim();
    return { compressed: wasModified ? compressed : original, wasModified, strategy: info !== '' ? info : 'passthrough' };
  } catch (_) {
    return { compressed: original, wasModified: false, strategy: 'passthrough' };
  }
}

// crush a parsed VALUE (no re-parse) — used by the fnd pipeline after the ADF/noise/truncate stages.
// A transform failure returns the value unchanged (crash-safety parity with crush()).
function crushValue(value, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  try { return processValue(value, 0, cfg)[0]; } catch (e) {
    // The budget signal belongs to slim(): swallowing it here degrades an expiry into "skip the crush
    // stage", which reports a clean compression over a half-transformed body and strands every crush
    // spill the aborted walk wrote.
    if (e && e.fndBudget) throw e;
    return value;
  }
}

// ============================================================ fnd pipeline stages (slim) ==

// Stage 1 — replace every ADF doc node ({type:'doc',version,content}) with its markdown string.
function adfStage(value, cfg, depth) {
  depth = depth || 0;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => adfStage(v, cfg, depth + 1));
  if (value && typeof value === 'object') {
    if (value.type === 'doc' && Array.isArray(value.content)) {
      const md = adfToMarkdown(value);
      if (md != null) return md;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      if (cfg.preserveFields && cfg.preserveFields[k]) { out[k] = value[k]; continue; }
      out[k] = adfStage(value[k], cfg, depth + 1);
    }
    return out;
  }
  return value;
}

const AVATAR_KEY = /avatar|iconurl|24x24|16x16|32x32|48x48|thumbnail/i;
// …but a SUBSTRING match also swallowed real content: `thumbnail_alt`, `image_thumbnail_text` and
// `avatarDescription` hold prose, not an image reference. A key whose TAIL names text — after a
// `_`/`-` separator or at a camel-case boundary — is kept whatever AVATAR_KEY saw earlier in it.
const CONTENT_TAIL = /(?:[_-](?:alt|text|title|description|ALT|TEXT|TITLE|DESCRIPTION)|Alt|Text|Title|Description|ALT|TEXT|TITLE|DESCRIPTION)$/;

// A `self` value that is a REST-navigation URL — Jira/Confluence stamp one on every nested
// resource (`.../rest/api/2/status/3`, Confluence `_links.self`). The model never dereferences
// them (it acts through MCP tools, not raw REST), and the full result is spilled for recovery,
// so dropping them is safe. Matched only on Atlassian's `/rest/` (Jira, classic Confluence) or
// `/wiki/` (Confluence v2) path markers — NOT a bare `/api/`, which non-Atlassian servers use for
// real, actionable resource URLs. Precise key+value guard so a `self` holding real content survives.
const REST_LINK = /^https?:\/\/.*\/(rest|wiki)\//;

// Stage 3 — drop nulls, empty containers, avatar-class decoration keys, and `self` REST links.
function noiseStage(value, cfg, depth) {
  depth = depth || 0;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => noiseStage(v, cfg, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (cfg.preserveFields && cfg.preserveFields[k]) { out[k] = value[k]; continue; }
      if (AVATAR_KEY.test(k) && !CONTENT_TAIL.test(k)) continue;
      if (cfg.dropRestLinks && k === 'self' && typeof value[k] === 'string' && REST_LINK.test(value[k])) continue;
      const v = noiseStage(value[k], cfg, depth + 1);
      if (v === null) continue;
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }
  return value;
}

// Only OPAQUE long strings are truncated: data-URIs (anchored to a real `type/subtype;|,` shape so
// prose that merely starts "data: …" is NOT matched), pure base64 blobs, and single-token URLs.
// Prose / markdown (incl. ADF-derived descriptions) is NEVER clipped by length alone — clipping it
// would be unrecoverable data loss, and stage 1 has already converted ADF to compact markdown.
const LONG_STRING = /^data:[\w.+-]+\/[\w.+-]+[;,]|^[A-Za-z0-9+/]{200,}={0,2}$|^https?:\/\/\S{160,}$/;

// Stage 4 — clip data-URIs / base64 / very long URLs to head + a length note.
function truncateStage(value, cfg, depth) {
  depth = depth || 0;
  if (depth >= MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (value.length > cfg.stringLimit && LONG_STRING.test(value)) {
      return `${value.slice(0, 64)}…(len=${value.length})`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStage(v, cfg, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (cfg.preserveFields && cfg.preserveFields[k]) { out[k] = value[k]; continue; }
      out[k] = truncateStage(value[k], cfg, depth + 1);
    }
    return out;
  }
  return value;
}

// Optional stage — lossless tabular re-serialization of uniform arrays of flat objects (TOON-lite).
// Behind a flag; a basic variant kept as a benchmark option (CEILING: not the full TOON spec).
function toonStage(value, depth) {
  depth = depth || 0;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (value.length >= 3 && value.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = Object.keys(value[0]);
      const uniform = keys.length > 0 && value.every((o) => {
        const ks = Object.keys(o);
        return ks.length === keys.length && ks.every((k, i) => k === keys[i]) &&
          keys.every((k) => o[k] === null || typeof o[k] !== 'object');
      });
      if (uniform) {
        return { _toon: `${keys.join(',')}`, rows: value.map((o) => keys.map((k) => o[k])) };
      }
    }
    return value.map((v) => toonStage(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = toonStage(value[k], depth + 1);
    return out;
  }
  return value;
}

// Classify a NON-JSON payload by its leading bytes — a diagnostic tag for the FND_MCP_SLIM_DEBUG
// log (M8), attached ONLY on slim()'s `non-json` passthrough branch so it costs nothing on the
// compress path. The head is BOM-stripped and trimmed first so a leading BOM/whitespace can't hide
// the signature. Fixed lowercase vocabulary; `broken-json` (looks like JSON yet JSON.parse failed)
// is the diagnostic gem — it flags an upstream-truncated/malformed payload.
function sniffFormat(content) {
  const head = String(content).replace(/^\uFEFF/, '').trim().slice(0, 64).toLowerCase();
  if (/^<!doctype\s+html/.test(head) || head.startsWith('<html')) return 'html';
  if (head.startsWith('<?xml')) return 'xml';
  if (/^<[a-z]/.test(head)) return 'xml'; // tag-like and not html → xml
  if (head.startsWith('{') || head.startsWith('[')) return 'broken-json';
  return 'text';
}

// M12b — the one-line "what is in that file" hint the mcp-slim hook's spill-and-stub guard prints
// beside the spill path. Parseable JSON → `array of N` or its top-level keys; anything else → a
// whitespace-collapsed preview of the head. `format` rides along as the M8 tag ('json' when it
// parsed, else sniffFormat's html/xml/broken-json/text) so the stub names the payload honestly.
// Only the head is ever sliced, regexed and previewed — the first STUB_HINT_SCAN bytes. The one
// full-payload pass is JSON.parse, and only when the head actually opens an object/array (a linear
// scan, and the hint is worthless without it). Hard constraint: never run a REGEX over the full
// payload — its backtracking is quadratic on whale-sized strings, see OVERFLOW_WINDOW in
// hooks/mcp-slim.cjs.
const STUB_HINT_KEYS = 8;
const STUB_HINT_PREVIEW = 200;
const STUB_HINT_SCAN = 4096;
function shapeHint(text) {
  const head = (typeof text === 'string' ? text : '').slice(0, STUB_HINT_SCAN).replace(/^\uFEFF/, '').replace(/^\s+/, '');
  let parsed;
  // JSON.parse tolerates leading whitespace but NOT a BOM — strip that one char, nothing else.
  if (head[0] === '{' || head[0] === '[') { try { parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch (_) {} }
  if (Array.isArray(parsed)) return { format: 'json', hint: `array of ${parsed.length}` };
  if (parsed && typeof parsed === 'object') {
    const ks = Object.keys(parsed);
    if (!ks.length) return { format: 'json', hint: 'object with no keys' };
    return { format: 'json', hint: `keys: ${ks.slice(0, STUB_HINT_KEYS).join(', ')}${ks.length > STUB_HINT_KEYS ? ` …(+${ks.length - STUB_HINT_KEYS})` : ''}` };
  }
  const preview = head.replace(/\s+/g, ' ').trim().slice(0, STUB_HINT_PREVIEW);
  return { format: sniffFormat(head), hint: `starts with: ${preview}${preview.length >= STUB_HINT_PREVIEW ? '…' : ''}` };
}

// Parse a JSONL line stream (one JSON value per line — a Shopify bulk-operation dump, a saved
// log-of-objects) into an array of rows, so `slim()` can crush it as the same-shape array it is.
// Strict gate, because a whole-payload JSON.parse has ALREADY failed by the time we get here:
// BOM-stripped, split on \n, blank/whitespace-only lines skipped; EVERY remaining line must parse
// to an object or array (a bare scalar — a prose file of `42`/`true`/`null` lines — rejects the
// whole payload, never swallowed as data), and ≥2 rows are required (a lone line that failed the
// whole-payload parse is just broken JSON). Any failing line → null: the caller falls back to
// today's non-json handback, so a curl-truncated bulk file (last line cut mid-object) is NOT
// partially salvaged — the recorded M9 ceiling.
function parseJsonl(content) {
  const rows = [];
  for (const line of String(content).replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue; // structural blank line
    let v;
    try { v = JSON.parse(line); } catch (_) { return null; }
    if (v === null || typeof v !== 'object') return null; // bare scalar (typeof array/object is 'object')
    rows.push(v);
  }
  return rows.length >= 2 ? rows : null;
}

// M11 — unwrap a DOMINANT markdown fence. A tool wraps its payload in prose + a code fence
// ("Script ran on page and returned:\n```json\n<payload>\n```", chrome-devtools evaluate_script)
// which the whole JSON pipeline can't parse. Detect: an OPTIONAL short prose preamble (the opening
// fence must appear within cfg.fencePreambleMax leading lines), an opening ``` line (three-or-more
// backticks, an optional language tag), a body, a closing bare ``` line, at most cfg.fenceTrailerMax
// trailer lines. Return the body + preamble + trailer + offset (physical lines before the body, for the CLI's
// line-scripting guidance) ONLY when the body is the dominant content (≥ cfg.fenceDominance of bytes)
// — a real doc with a small code block stays below that bar → null → byte-identical passthrough. Non-
// goals: first fence only (no nesting), no tilde fences (a ~~~ block simply doesn't match → null, no
// crash), no preamble parsing.
const FENCE_OPEN = /^ {0,3}`{3,}[ \t]*[A-Za-z0-9._+-]*[ \t\r]*$/; // opening: optional info string (```json); trailing \r tolerated so CRLF-delimited fences match
const FENCE_CLOSE = /^ {0,3}`{3,}[ \t\r]*$/; // closing: bare backticks, no info string; trailing \r tolerated (CRLF)
// Index of the opening code-fence line within the first `maxPreamble` lines (0-based), or -1. A leading
// BOM is stripped from the first line so a BOM-prefixed fence (\uFEFF before ```json) is detected. Shared
// by unwrapFence and the >8 MB Gate B scan so both agree on fence presence \u2014 the \u22648 MB and >8 MB paths
// classify a BOM-prefixed fenced whale identically.
function findOpeningFence(lines, maxPreamble) {
  for (let i = 0; i < lines.length && i <= maxPreamble; i++) {
    const ln = i === 0 ? String(lines[i]).replace(/^\uFEFF/, '') : lines[i];
    if (FENCE_OPEN.test(ln)) return i;
  }
  return -1;
}
function unwrapFence(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const lines = String(content).replace(/^\uFEFF/, '').split('\n');
  const oi = findOpeningFence(lines, cfg.fencePreambleMax);
  if (oi === -1) return null;
  let ci = -1;
  for (let j = oi + 1; j < lines.length; j++) { if (FENCE_CLOSE.test(lines[j])) { ci = j; break; } }
  if (ci === -1) return null; // unterminated fence → old behavior
  if (lines.length - 1 - ci > cfg.fenceTrailerMax) return null; // a long trailer → not a dominant single fence
  const body = lines.slice(oi + 1, ci).join('\n');
  const total = Buffer.byteLength(content, 'utf8');
  if (!total || Buffer.byteLength(body, 'utf8') / total < cfg.fenceDominance) return null; // dominance guard
  // Carry the trailer forward so a substantive line after the closing fence (e.g. "NOTE: truncated at
  // N rows for safety.") is never silently dropped when the body compresses. A bare final newline from
  // the split is not substantive → pop the trailing empty element(s) so it isn't mistaken for a trailer.
  const trailerLines = lines.slice(ci + 1);
  while (trailerLines.length && trailerLines[trailerLines.length - 1] === '') trailerLines.pop();
  return { preamble: lines.slice(0, oi).join('\n'), body, trailer: trailerLines.join('\n'), offset: oi + 1 };
}

// ==================================================== M13 — jsx-slim (Figma design context) ==
//
// A lossless compactor for Figma dev-mode `get_design_context` payloads (generated React/Tailwind
// JSX). Measured on a real 211 KB desktop section: `className="…"` strings are 57 % of the payload
// with 98 unique values across 804 occurrences, `data-node-id` another 33 KB across 593 attrs, and
// whole sibling subtrees repeat verbatim. Three line-oriented transforms, no JSX parser:
//   1. className dictionary — repeated values move to a `C17: …` legend on top, occurrences become
//      `class=C17`; inside the legend a second pass shortens repeated `var(--…)` tokens to `$N`;
//   2. node-id legend — `data-node-id="I13920:240400;…"` becomes `#n17`, and the `n17 → full id`
//      map goes to a SPILL FILE so the ids stay usable for follow-up Figma calls;
//   3. ×N sibling fold — adjacent sibling subtrees that are identical apart from a small set of
//      value slots collapse to one exemplar plus a `{/* ×3 more … */}` line that LISTS what differed
//      per repeat, so nothing is dropped in band either.
// Scope is ONLY this machine-generated grammar (see detectJsx) — generic HTML/XML/Liquid is never
// touched, so a Liquid file that merely uses `var(--…)` passes through byte-identical.

const JSX_HEADER = '<<fnd-jsx-slim>>';
const JSX_MIN_HITS = 3; // each signature must appear at least this often before the stage engages

// Occurrence counter with an early exit at `cap`. indexOf, never a regex: a payload can be 200 KB on
// ONE physical line, where a counting regex backtracks quadratically.
function countUpTo(hay, needle, cap) {
  let n = 0, i = 0;
  while (n < cap) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n++; i = j + needle.length;
  }
  return n;
}

// Figma-generated JSX only: React `className=` AND Figma's `data-node-id=` AND design-token
// `var(--…)`, each at least JSX_MIN_HITS times. All three together are what no hand-written HTML,
// XML or Liquid template carries — the corruption rail behind this stage.
function detectJsx(content) {
  const s = typeof content === 'string' ? content : '';
  if (s.includes(JSX_HEADER)) return false; // already compacted — never compact twice
  return countUpTo(s, 'data-node-id="', JSX_MIN_HITS) >= JSX_MIN_HITS &&
    countUpTo(s, 'className="', JSX_MIN_HITS) >= JSX_MIN_HITS &&
    countUpTo(s, 'var(--', JSX_MIN_HITS) >= JSX_MIN_HITS;
}

// Every `<prefix>value"` occurrence as { start, end, value }. Attribute values in this grammar are
// double-quoted and never contain an escaped quote, so the next `"` closes the value.
function scanAttr(text, prefix) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = text.indexOf(prefix, i);
    if (a === -1) break;
    const vs = a + prefix.length;
    const ve = text.indexOf('"', vs);
    if (ve === -1) break; // unterminated → stop scanning, the tail stays verbatim
    out.push({ start: a, end: ve + 1, value: text.slice(vs, ve) });
    i = ve + 1;
  }
  return out;
}

// `var(--token,fallback)` spans, first `)` closing. A nested fallback (`var(--x, rgba(0,0,0,.5))`)
// simply tokenizes short; the leftover stays inline, so the legend still reconstructs byte-exactly.
function varTokens(s) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('var(--', i);
    if (a === -1) break;
    const b = s.indexOf(')', a);
    if (b === -1) break;
    out.push(s.slice(a, b + 1));
    i = b + 1;
  }
  return out;
}

// ---- transform 3: ×N sibling fold ----

const indentOf = (l) => { let i = 0; while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++; return i; };
const isDigit = (c) => c >= 48 && c <= 57;

// The value-carrying slots a repeated sibling may differ in. Everything else — tag names, class
// refs, structure, indentation — must match exactly, which is the conservative gate: an unequal
// class ref means a different appearance, so those siblings are kept in full.
const SLOT_ATTRS = [['data-node-id="', 'node-id'], ['data-name="', 'name'], ['alt="', 'alt'], ['src="', 'src']];

// Every slot leaves a MARK in the skeleton, so slot presence is part of the canon: `>text<` can
// never match `><`, and an own-line text node can never match a whitespace-only line at the same
// indent. That is what keeps a value-bearing line from folding into an empty one — two lines
// canonicalizing equal with different slot COUNTS would let the exemplar's list either hide the
// duplicates' extra values (silent loss under a "nothing dropped" header) or index past the end.
const SLOT_MARK = '\u0000';

// Split one line into a canonical skeleton (slot values replaced by their mark) + the slot values in
// document order. Two subtrees fold only when their skeletons are byte-equal.
function lineSlots(line, canon, slots) {
  // A Figma text node sits on its own line, so a whole prose-only line is one text slot — that is
  // what lets siblings differing ONLY in their copy fold with the copy listed. Anything carrying
  // markup or code punctuation stays structural. The slot value keeps the TRAILING whitespace too
  // (only the indent is canon), so repeats differing there are listed rather than silently equal.
  const t = line.trim();
  if (t && !/[<>{}=]/.test(t)) {
    const lead = line.length - line.trimStart().length;
    slots.push({ kind: 'text', value: line.slice(lead) });
    canon.push(line.slice(0, lead), SLOT_MARK, 'text', '\n');
    return;
  }
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    if (c === '#' && line[i + 1] === 'n' && isDigit(line.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && isDigit(line.charCodeAt(j))) j++;
      slots.push({ kind: 'node-id', value: line.slice(i, j) });
      canon.push(SLOT_MARK, 'node-id'); i = j; continue;
    }
    let matched = false;
    for (const [pre, kind] of SLOT_ATTRS) {
      if (!line.startsWith(pre, i)) continue;
      const ve = line.indexOf('"', i + pre.length);
      if (ve !== -1) { slots.push({ kind, value: line.slice(i + pre.length, ve) }); canon.push(pre, SLOT_MARK, kind, '"'); i = ve + 1; matched = true; }
      break;
    }
    if (matched) continue;
    // element text content (`>Finish<`) — the one slot that is not an attribute
    if (c === '>' && line[i + 1] !== '<') {
      const lt = line.indexOf('<', i + 1);
      if (lt > i + 1) {
        const txt = line.slice(i + 1, lt);
        if (txt.trim()) { slots.push({ kind: 'text', value: txt }); canon.push('>', SLOT_MARK, 'text'); i = lt; continue; }
      }
    }
    canon.push(c); i++;
  }
  canon.push('\n');
}

// Node-id refs are handed out in first-appearance order, so a folded subtree's ids are contiguous —
// collapse those runs to `#n120–#n158` instead of listing 39 refs. A slot carrying a `label` (a kind
// the subtree holds more than once) prints qualified, so `name#2:"B"` cannot be read as the outer
// `data-name`; node-id refs need no ordinal — each resolves to exactly one id in the map.
function fmtSlots(g) {
  const out = [];
  const num = (v) => (v.kind === 'node-id' && v.value[0] === '#' ? Number(v.value.slice(2)) : NaN);
  for (let i = 0; i < g.length; i++) {
    let j = i;
    while (j + 1 < g.length && Number.isFinite(num(g[j + 1])) && num(g[j + 1]) === num(g[j]) + 1) j++;
    if (j > i && Number.isFinite(num(g[i]))) { out.push(`${g[i].value}–${g[j].value}`); i = j; continue; }
    const v = g[i].kind === 'node-id' ? g[i].value : JSON.stringify(g[i].value);
    out.push(g[i].label ? `${g[i].label}:${v}` : v);
  }
  return out.join(', ');
}

// Fold adjacent same-shape siblings into the first one. Indentation is the tree: a node owns every
// following line indented deeper, plus its own closing tag. Only real elements fold (a line opening
// with `<`), only when the fold line is genuinely smaller than the lines it replaces, and the
// recursion never descends into a subtree that was folded away.
function foldSiblings(code) {
  const lines = code.split('\n');
  const drop = new Uint8Array(lines.length);
  const inject = new Map();
  let folded = 0;

  // Per-line skeleton and slots are built ONCE, and a line's skeleton is interned to an integer so a
  // subtree comparison is an id-array compare. Rebuilding a subtree's skeleton character by character
  // at every nesting level would instead cost bytes × depth — a deep tree stalls the hook.
  const canonId = new Int32Array(lines.length);
  const indent = new Int32Array(lines.length);
  const kind = new Uint8Array(lines.length); // 0 blank, 1 opening `<`, 2 closing `</`, 3 other
  const lineSlotList = new Array(lines.length);
  const intern = new Map();
  for (let i = 0; i < lines.length; i++) {
    const canon = [], slots = [];
    lineSlots(lines[i], canon, slots);
    const key = canon.join('');
    let id = intern.get(key);
    if (id === undefined) { id = intern.size + 1; intern.set(key, id); }
    canonId[i] = id;
    lineSlotList[i] = slots;
    indent[i] = indentOf(lines[i]);
    const t = lines[i].trim();
    kind[i] = !t ? 0 : (t.startsWith('</') ? 2 : (t[0] === '<' ? 1 : 3));
  }
  const sameShape = (a, b) => {
    const len = a[1] - a[0];
    if (len !== b[1] - b[0]) return false;
    for (let k = 0; k < len; k++) if (canonId[a[0] + k] !== canonId[b[0] + k]) return false;
    return true;
  };
  const nodeSlots = (r) => { const out = []; for (let i = r[0]; i < r[1]; i++) for (const s of lineSlotList[i]) out.push(s); return out; };

  const walk = (from, to) => {
    let d = -1;
    for (let i = from; i < to; i++) if (kind[i]) { d = indent[i]; break; }
    if (d === -1) return;
    const nodes = [];
    let i = from;
    while (i < to) {
      if (!kind[i] || indent[i] !== d) { i++; continue; }
      let j = i + 1;
      while (j < to && (!kind[j] || indent[j] > d)) j++;
      if (j < to && indent[j] === d && kind[j] === 2) j++;
      nodes.push([i, j]);
      i = j;
    }
    for (let g = 0; g < nodes.length;) {
      let h = g + 1;
      while (h < nodes.length && sameShape(nodes[g], nodes[h])) h++;
      if (h > g + 1 && kind[nodes[g][0]] === 1) {
        const base = nodeSlots(nodes[g]);
        const dups = [];
        for (let x = g + 1; x < h; x++) dups.push({ range: nodes[x], slots: nodeSlots(nodes[x]) });
        // Belt and braces on top of the slot marks: any residual skeleton ambiguity degrades to
        // "keep both siblings", never to a value that is neither listed nor emitted.
        if (dups.every((dd) => dd.slots.length === base.length)) {
          // A kind the subtree carries more than once is ambiguous unqualified — label those slots
          // with their ordinal so a listed value names the slot it came from.
          const seen = new Map();
          const ord = base.map((s) => { const k = (seen.get(s.kind) || 0) + 1; seen.set(s.kind, k); return k; });
          const varying = [];
          const kinds = [];
          for (let k = 0; k < base.length; k++) {
            if (!dups.some((dd) => dd.slots[k].value !== base[k].value)) continue;
            varying.push(k);
            if (!kinds.includes(base[k].kind)) kinds.push(base[k].kind);
          }
          const label = (k) => (base[k].kind !== 'node-id' && seen.get(base[k].kind) > 1 ? `${base[k].kind}#${ord[k]}` : null);
          const per = dups.map((dd) => `[${fmtSlots(varying.map((k) => ({ ...dd.slots[k], label: label(k) })))}]`).join(' ');
          const fold = `${' '.repeat(d)}{/* ×${dups.length} more, identical${kinds.length ? ` except (${kinds.join(', ')}): ${per}` : ''} */}`;
          let dropped = 0;
          for (const dd of dups) for (let x = dd.range[0]; x < dd.range[1]; x++) dropped += Buffer.byteLength(lines[x], 'utf8') + 1;
          if (Buffer.byteLength(fold, 'utf8') + 1 < dropped) {
            for (const dd of dups) for (let x = dd.range[0]; x < dd.range[1]; x++) drop[x] = 1;
            const at = nodes[g][1] - 1;
            inject.set(at, [...(inject.get(at) || []), fold]);
            folded += dups.length;
          }
        }
      }
      g = h;
    }
    for (const [s, e] of nodes) {
      if (drop[s]) continue; // a folded-away subtree has no surviving interior to fold
      const inner = (e - 1 > s && indent[e - 1] === d && kind[e - 1] === 2) ? e - 1 : e;
      if (inner > s + 1) walk(s + 1, inner);
    }
  };
  walk(0, lines.length);
  if (!folded) return { code, folded: 0 };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i]) out.push(lines[i]);
    if (inject.has(i)) for (const f of inject.get(i)) out.push(f);
  }
  return { code: out.join('\n'), folded };
}

// ---- the stage ----

// Compact a Figma design-context payload. Returns `{ compressed, idFile, classes, nodeIds, folded }`
// — `compressed` is the original and `idFile` null unless the transforms produced a REAL byte win
// (same contract as the log/crush stages; the whole original lives in the caller's spill).
function compressJsx(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const text = String(content);
  let idFile = null;
  let idCreated = false;
  try {
    const win = compactJsx(text, cfg, (p, c) => { idFile = p; idCreated = c; });
    if (win) { noteSpill(cfg, idFile, idCreated); return win; }
  } catch (_) {
    // A shape the transforms cannot handle degrades to passthrough — never a thrown stage. The CLI's
    // whale-recovery command and the hook both run this on payloads nothing else has validated.
  }
  // A throw or a declined compaction never unlinks the map HERE: its name is content-addressed, so an
  // identical map may be behind another process's live `ids=` handle. Reported in the sink either way
  // (the file IS on disk), with `created` deciding whether the CALLER may drop it once it knows nothing
  // it emitted names the file — the hook does exactly that; everyone else leaves it to the TTL sweep.
  noteSpill(cfg, idFile, idCreated);
  return { compressed: text, idFile: null, classes: 0, nodeIds: 0, folded: 0 };
}

// The compaction itself: the win object, or null when there is nothing to reference or the compacted
// body is not smaller. The caller owns the passthrough result; a written map is never unlinked.
function compactJsx(text, cfg, keepIdFile) {
  const cls = scanAttr(text, 'className="');
  const ids = scanAttr(text, 'data-node-id="');

  // Only values used more than once pay for themselves: a singleton would cost a legend line plus a
  // reference where the inline attribute was already shorter.
  const counts = new Map();
  for (const o of cls) counts.set(o.value, (counts.get(o.value) || 0) + 1);
  const dict = new Map();
  for (const o of cls) if (counts.get(o.value) >= 2 && !dict.has(o.value)) dict.set(o.value, `C${dict.size + 1}`);

  // The node-id map is only worth taking out of the tree if it can be handed back: write the spill
  // FIRST, and keep the ids inline when that write fails (never an unresolvable `#n17`).
  const idMap = new Map();
  let idFile = null;
  if (ids.length) {
    for (const o of ids) if (!idMap.has(o.value)) idMap.set(o.value, `n${idMap.size + 1}`);
    const map = {};
    for (const [full, ref] of idMap) map[ref] = full;
    const s = writeSpill(cfg.spillDir, 'fnd-jsx-ids-', compact(map));
    if (s) { idFile = s.path; keepIdFile(s.path, s.created); } // on a throw or a decline the wrapper leaves it to the TTL sweep
    else idMap.clear();
  }
  if (!dict.size && !idMap.size) return null;

  // One left-to-right rewrite over both occurrence lists (they cannot overlap in this grammar, but
  // an occurrence starting inside a previous one is skipped rather than trusted).
  const occ = [];
  for (const o of cls) if (dict.has(o.value)) occ.push({ start: o.start, end: o.end, rep: `class=${dict.get(o.value)}` });
  if (idMap.size) for (const o of ids) occ.push({ start: o.start, end: o.end, rep: `#${idMap.get(o.value)}` });
  occ.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const o of occ) {
    if (o.start < cursor) continue;
    parts.push(text.slice(cursor, o.start), o.rep);
    cursor = o.end;
  }
  parts.push(text.slice(cursor));

  const fold = foldSiblings(parts.join(''));

  // Legend pass 2: `var(--…)` tokens repeated ACROSS legend entries become `$N`. Skipped whole when
  // any entry already contains a `$`, so a `$N` reference can never be ambiguous.
  let entries = [...dict.keys()];
  const varLines = [];
  if (entries.length && !entries.some((e) => e.includes('$'))) {
    const tokCount = new Map();
    for (const e of entries) for (const t of varTokens(e)) tokCount.set(t, (tokCount.get(t) || 0) + 1);
    const chosen = new Map();
    for (const e of entries) for (const t of varTokens(e)) {
      if (chosen.has(t)) continue;
      const ref = `$${chosen.size + 1}`;
      // uses × saved-per-use must beat the legend line the token costs
      if (tokCount.get(t) * (t.length - ref.length) > t.length + ref.length + 3) chosen.set(t, ref);
    }
    if (chosen.size) {
      entries = entries.map((e) => {
        let out = '', i = 0;
        for (;;) {
          const a = e.indexOf('var(--', i);
          const b = a === -1 ? -1 : e.indexOf(')', a);
          if (b === -1) { out += e.slice(i); break; }
          const tok = e.slice(a, b + 1);
          out += e.slice(i, a) + (chosen.get(tok) || tok);
          i = b + 1;
        }
        return out;
      });
      for (const [t, ref] of chosen) varLines.push(`${ref}: ${t}`);
    }
  }

  // `ids=` and not `full=`: `full=<path>` is the plugin's established handle for the ORIGINAL result
  // (the hook's marker, the crush marker, the README), and a body carrying two `full=` paths would
  // let a loose scan hand back the id map instead of the payload. The original is named by whoever
  // emits this body — the hook's `<<full=… original_result>>`, the CLI's `original:` line.
  const legend = entries.map((e, i) => `C${i + 1}: ${e}`);
  const clauses = [];
  if (dict.size) clauses.push(`class=CN → the CN: legend line below${varLines.length ? ' ($N → the $N: line)' : ''}`);
  if (fold.folded) clauses.push('{/* ×N more … */} folds identical repeated siblings and lists what differed per repeat');
  // The map's path ends the header, ALWAYS — and then takes no closing period. A naive read of the
  // `ids=` token stops at whitespace (the way a model or a shell one-liner reads it), so any clause
  // AFTER it glues the joining '; ' onto the filename and a period would glue itself on: both ENOENT
  // on the documented node-id recovery. Same rail as the hook's overflowSpill, which strips exactly
  // that punctuation off a spill path.
  if (idMap.size) clauses.push(`#nN → a data-node-id, the full ids are in ids=${idFile}`);
  const tail = clauses.length ? ` ${clauses.join('; ')}` : '';
  const header = `${JSX_HEADER} Figma design context, compacted losslessly — nothing dropped.` +
    tail + (tail && !(idFile && tail.endsWith(idFile)) ? '.' : '');
  const compressed = [header, ...varLines, ...legend, '', fold.code].join('\n');
  if (Buffer.byteLength(compressed, 'utf8') >= Buffer.byteLength(text, 'utf8')) return null;
  return { compressed, idFile, classes: dict.size, nodeIds: idMap.size, folded: fold.folded };
}

// A PLAIN text block — `type:'text'` plus `text`, nothing else. Unwrapping keeps only the text, so a
// block carrying `annotations` or a per-block `_meta` cursor would lose it while the compacted body
// claims nothing was dropped. Same rail, same reason as the hook's STUB_BLOCK_KEYS.
const JSX_BLOCK_KEYS = new Set(['type', 'text']);
const isPlainBlock = (b) => !!b && typeof b === 'object' && !Array.isArray(b) && b.type === 'text' &&
  typeof b.text === 'string' && Object.keys(b).every((k) => JSX_BLOCK_KEYS.has(k));

// The block LIST of a PURE text-block envelope (`[{type:'text',text}]`, `{content:[…]}`, or a lone
// `{type:'text',text}`) — the shape an MCP result keeps when it is spilled to disk whole. null unless
// the envelope carries NOTHING but those blocks: an envelope sibling (`structuredContent`, `_meta`
// with its `nextCursor`, `isError`) survives only if the whole value stays with the JSON pipeline,
// which compresses it without discarding fields.
function blockList(v) {
  if (isPlainBlock(v)) return [v];
  const arr = Array.isArray(v) ? v
    : (v && typeof v === 'object' && Array.isArray(v.content) && Object.keys(v).every((k) => k === 'content') ? v.content : null);
  if (!arr || !arr.length) return null;
  for (const b of arr) if (!isPlainBlock(b)) return null;
  return arr;
}

// The blocks joined with '\n' — a JOIN, not a document; see soleBlockText for why that matters.
function blockText(v) {
  const blocks = blockList(v);
  return blocks ? blocks.map((b) => b.text).join('\n') : null;
}

// The text of a SOLE plain text block — the M14 rail's stricter gate. blockText JOINS a multi-block
// envelope, and a join is not a document: two blocks each holding one compact JSON object read as two
// JSONL ROWS, and a prose block followed by a fenced one reads as one dominant fence. An envelope's
// blocks are independent results, not lines of a stream, so answering either shape with a row profile
// (or with one unwrapped payload) describes something the caller never sent. Multi-block envelopes
// are therefore handed back whole — the named ceiling of this rail. The jsx stage keeps blockText on
// purpose: detectJsx accepts the joined text only when
// every signature of ONE Figma payload is present in it.
function soleBlockText(v) {
  const blocks = blockList(v);
  return blocks && blocks.length === 1 ? blocks[0].text : null;
}

// The one wording every M14 unwrap notice opens with — the CLI states the unwrap on stderr (stdout
// stays the body a caller pipes), and a reader who greps for it finds the plain run, the --jq run and
// the JSONL profile alike.
const ENVELOPE_NOTE = 'json-slim: unwrapped MCP text envelope ([0].text)';

// Can these bytes OPEN a content-block envelope? A cheap gate in front of a full JSON.parse whose
// only purpose is envelope detection — `[{`, a lone block or a `{content:[…]}` wrapper, first key
// one of the block's own. Whitespace-tolerant (a spill may be pretty-printed); key ORDER is not
// guaranteed, hence `text` next to `type`.
const ENVELOPE_HEAD_SNIFF = /^\s*\[?\s*\{\s*"(type|text|content)"\s*:/;

// M14 — the PARSED payload hiding inside a pure text-block envelope, or null. The spill of an MCP
// result keeps the payload as a JSON-encoded STRING in `[0].text`, so every dot-walk and every
// pipeline stage sees a 1-element array of one long string and finds nothing to do. Two acceptance
// rails, both deliberate: purity is soleBlockText's (an envelope carrying `_meta` /
// `structuredContent` / `annotations` is NOT an envelope for this purpose — unwrapping would drop
// those fields — and neither is a MULTI-block one, see soleBlockText), and the inner must be ONE JSON
// document (bare, or inside a dominant M11 fence). A JSONL inner is excluded HERE on purpose: its rows
// must profile, not slim, and the profile's `sed -n '<N>p'` recipes cannot address lines that only
// exist inside an escaped string — the CLI diverts that case to a spill of the unwrapped body before
// slim() ever runs.
function envelopeInner(v, config) {
  const text = soleBlockText(v);
  if (text === null) return null;
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const s = stripBom(text);
  try { return { text, value: JSON.parse(s) }; } catch (_) {}
  if (cfg.fence) {
    const f = unwrapFence(s, cfg);
    if (f) { try { return { text, value: JSON.parse(stripBom(f.body)) }; } catch (_) {} }
  }
  return null;
}

// ------------------------------------------------------------- number round-trip gate --

// Every stage below re-serializes what JSON.parse gave it, and JSON.parse is lossy on two number
// shapes: an exponent past ±1.8e308 becomes Infinity (JSON.stringify then writes `null`), and more
// than 15 significant digits round to the nearest double (12345678901234567890 →
// …67000). Re-emitting that as a "reduction" silently rewrites the caller's data, so a payload
// holding one is declined instead — the whole body passes through as `number-precision`.
//
// A decimal token with ≤ 15 significant digits always survives the double round trip, which is the
// cheap gate; beyond that the token is compared with String(Number(tok)) in a normalized form, so the
// legal spellings (1.0, 1e5, 0.250, -0) are not mistaken for loss.
function normalizeNumberToken(tok) {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(tok);
  if (!m) return null;
  const frac = m[3] || '';
  let digits = `${m[2] || ''}${frac}`;
  let exp = (m[4] ? parseInt(m[4], 10) : 0) - frac.length; // value = digits × 10^exp
  digits = digits.replace(/^0+/, '');
  const trimmed = digits.replace(/0+$/, '');
  exp += digits.length - trimmed.length;
  if (!trimmed) return '0'; // every spelling of zero, sign included
  return `${m[1]}${trimmed}e${exp}`;
}
function numberTokenSurvives(tok) {
  const v = Number(tok);
  if (Number.isNaN(v)) return true; // not a number at all (`1.2.3` in a fenced payload's prose) — never decline on a guess
  if (!Number.isFinite(v)) return false; // 1e400 → Infinity → JSON.parse hands back null
  const a = normalizeNumberToken(tok);
  if (a === null) return true; // not a shape this gate can judge — never decline on a guess
  if (v === 0) return a === '0'; // 1e-400 underflows to 0 — a loss the digit count below cannot see
  // The ≤15-digit short-circuit is exact for NORMAL doubles only: under ~2.2e-308 a double loses
  // mantissa bits, so a 2-digit 2.5e-324 still lands on 5e-324. Subnormals take the exact comparison.
  if (Math.abs(v) >= 2.2250738585072014e-308 && a.replace(/^-/, '').split('e')[0].length <= 15) return true;
  return a === normalizeNumberToken(String(v));
}
// A LINEAR hand-scan, deliberately not a regex over the whole body: a backtracking pattern on a 1 MB
// payload cost this repo 43 s once. String literals are skipped wholesale, so a URL full of digits is
// walked, not parsed, and only real number tokens reach the check above. Callers run it on text
// JSON.parse has already accepted, where a digit outside a string can only start a number.
function numberPrecisionLoss(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // '"' — skip the whole literal, escapes included
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) { i += 2; continue; } // '\'
        i++;
        if (d === 34) break;
      }
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) { // '-' or a digit
      const start = i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if ((d >= 48 && d <= 57) || d === 46 || d === 43 || d === 45 || d === 101 || d === 69) i++;
        else break;
      }
      if (!numberTokenSurvives(text.slice(start, i))) return true;
      continue;
    }
    i++;
  }
  return false;
}

// Run the jsx stage over `text` and shape the slim() result, or null when the payload is not Figma
// JSX / the transforms produced no byte win against the ORIGINAL input (`content` — the text itself
// unless it arrived wrapped in a block envelope, which is what the win has to beat).
function jsxResult(text, cfg, content = text) {
  if (!detectJsx(text)) return null;
  const bytesIn = Buffer.byteLength(content, 'utf8');
  const j = compressJsx(text, cfg);
  const bytesOut = Buffer.byteLength(j.compressed, 'utf8');
  if (j.compressed === text || bytesOut >= bytesIn) return null;
  return { output: j.compressed, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['jsx'] : [], jsxCompressed: true, jsxIdFile: j.idFile };
}

// slim a JSON *string* through the full pipeline →
//   { output, wasModified, bytesIn, bytesOut, ratio, stages, reason?, format? }.
// `stages` names the pipeline stages that actually changed the serialized bytes (adf / noise /
// truncate / crush / toon) — the FND_MCP_SLIM_DEBUG instrumentation; populated ONLY when
// `cfg.trace` (off by default), so the compression hot path stays single-serialization. `reason`
// marks a non-compressing outcome the debug log reports verbatim (`non-json` / `error-shape` /
// `transform-error` / `number-precision`). Any stage failure → the original passes through untouched
// (safety rail).
function slim(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (typeof content !== 'string') return { output: content, wasModified: false, bytesIn: 0, bytesOut: 0, ratio: 0, stages: [] };
  // A BOM-prefixed JSON payload used to misroute to `non-json` — and, over the hook's stub threshold,
  // leave context for a file. Stripped ONCE here, so every stage below sees the same string.
  // `original` keeps the exact argument: a `wasModified:false` result hands THAT back, never the
  // stripped string — the CLI prints a passthrough verbatim, so it must be byte-identical to what
  // arrived. bytesIn/bytesOut speak about the argument too.
  const original = content;
  content = stripBom(content);
  const bytesIn = Buffer.byteLength(original, 'utf8');
  const pass = (reason, extra) => ({ output: original, wasModified: false, bytesIn, bytesOut: bytesIn, ratio: 0, reason, stages: [], ...extra });
  let parsed;
  let fromJsonl = false;
  try { parsed = JSON.parse(content); } catch (_) {
    // M11: a DOMINANT markdown fence (a tool's prose preamble + ```json…``` wrapping the payload,
    // e.g. chrome-devtools evaluate_script) hides an otherwise-compressible body from the whole
    // pipeline. Unwrap the body and re-run slim on it (fence:false → never re-unwrap), keeping the
    // preamble on top so the result still reads as the tool's message. Only a WIN is emitted — an
    // incompressible body leaves the WHOLE original untouched (never a bare unwrapped body). Runs
    // BEFORE parseJsonl so a fenced JSONL body reaches the same jsonl branch as an unfenced one.
    if (cfg.fence) {
      const f = unwrapFence(content, cfg);
      if (f) {
        const inner = slim(f.body, { ...cfg, fence: false });
        if (inner.wasModified && inner.bytesOut < inner.bytesIn) {
          // Re-emit the tool's prose preamble on top and any trailer (e.g. "NOTE: truncated at N rows")
          // below the slimmed body so neither is silently dropped. `preamble` + `fenceBody` (the PURE
          // JSON body) ride on the result so the CLI's Gate-A spill can be valid JSON (see capOutput).
          const output = [f.preamble, inner.output, f.trailer].filter((s) => s !== '').join('\n');
          const bytesOut = Buffer.byteLength(output, 'utf8');
          if (bytesOut < bytesIn) {
            return { output, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['fence', ...inner.stages] : [], preamble: f.preamble, fenceBody: inner.output, fenceTrailer: f.trailer, ...(inner.logCompressed ? { logCompressed: true } : {}), ...(inner.jsxCompressed ? { jsxCompressed: true } : {}) };
          }
        }
        // A fenced ERROR envelope (a tool wraps its failures the way it wraps its payloads) declines
        // every stage, so without this it reached the generic `non-json` return below — where the hook's
        // stub guard, seeing no error, replaced the failure with a stub. `inner.error` IS isErrorShape
        // over the unwrapped body; the WHOLE original is handed back, fence and preamble included.
        if (inner.error) return pass('error-shape', { error: true });
      }
    }
    // The FIRST place the budget may speak on this route, and deliberately not before the fence
    // branch above: `inner.error` is how a fenced error envelope is recognized, and an envelope is
    // verbatim by contract — a bail that skipped that probe would report a failure as an ordinary
    // passthrough the hook's stub guard is then allowed to replace. The fence branch needs no gate of
    // its own: its cost is the recursive slim(), which carries the same deadline. Everything below is
    // a non-JSON, non-fenced payload, which isErrorShape can never match.
    if (budgetExpired(cfg)) return pass('budget-exceeded');
    // A JSONL line stream (bulk-operation dump) is a same-shape array — route it through the
    // normal pipeline instead of the non-json handback (M9). parseJsonl returns null unless every
    // non-blank line is an object/array with ≥2 rows, so a truncated/prose file still falls to the
    // `non-json` branch below, byte-identical — `broken-json` then means truly malformed.
    const rows = cfg.jsonl ? parseJsonl(content) : null;
    if (rows) { parsed = rows; fromJsonl = true; }
    else {
      // M13: a Figma design-context payload (generated React/Tailwind JSX) is compacted losslessly —
      // className dictionary + node-id legend + ×N sibling fold. Before the log detector because its
      // own detector is the far narrower one (all three Figma-JSX signatures, see detectJsx), and it
      // only emits on a real byte win. Recovery is the same net as the log stage — the hook spills
      // the whole original, the CLI names the on-disk file — plus the node-id map's own spill.
      if (cfg.jsx) {
        const j = jsxResult(content, cfg);
        if (j) return j;
      }
      // M10: log-shaped TEXT (build/test output, console spam) is signal-selected, not sampled —
      // errors/traces/summaries kept, INFO/WARN spam deduped ×N. Order: parseJsonl (above) →
      // log-detect (here) → passthrough. The detector must clear conf ≥ 0.5, so prose / markdown /
      // docs-chunks / XML fall through byte-identical; a short or already-minimal log yields no byte
      // gain and also falls through. Trace-only 'log' stage tag. Recovery: the hook spills the whole
      // original; the CLI names the on-disk file (both lossless nets, so no CCR marker here).
      if (cfg.log && detectLog(content).isLog) {
        const r = compressLog(content, cfg);
        const bytesOut = Buffer.byteLength(r.compressed, 'utf8');
        if (r.compressed !== content && bytesOut < bytesIn) {
          return { output: r.compressed, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['log'] : [], logCompressed: true };
        }
      }
      // `format` sniffs the head so the debug log can tell WHAT the non-JSON payload was (M8) — a
      // pure diagnostic tag; it never changes the passthrough. Set on this branch only.
      return pass('non-json', { format: sniffFormat(content) });
    }
  }
  // Never touch error envelopes — write-gating elsewhere depends on seeing them verbatim. (An
  // array — including a JSONL row stream — is object-only-false here, so bulk data flows through.)
  if (isErrorShape(parsed)) return pass('error-shape', { error: true });
  // Budget gate for the JSON route. An envelope-wrapped ERROR must still leave as `error-shape`, for
  // the reason the fence branch states: an error envelope is verbatim by contract, and
  // `budget-exceeded` is a reason the hook's stub guard is allowed to replace. Probed only once the
  // budget HAS expired, so the hot path pays nothing for it.
  if (budgetExpired(cfg)) {
    if (cfg.envelope) {
      const env = envelopeInner(parsed, cfg);
      if (env && isErrorShape(env.value)) return pass('error-shape', { error: true });
    }
    return pass('budget-exceeded');
  }
  // A number JSON.parse could not round-trip is already WRONG in `parsed`; every stage would then
  // re-serialize the rounded value and the run would report it as a reduction. Decline the whole body
  // instead. Runs on the JSON route only — an envelope's escaped inner text is inside a string literal
  // here and is judged by the recursive slim() that actually compresses it.
  // BEHIND the budget gate, not in front of it: this is a full linear walk of the body, and an expired
  // deadline must bound every scan that follows it (`budget-exceeded` is stubbable, which is the safer
  // outcome of the two anyway).
  if (numberPrecisionLoss(content)) return pass('number-precision');
  // M13: a Figma design-context result also reaches the CLI still inside its MCP block envelope
  // (`[{"type":"text","text":"<the JSX>"}]` — the platform overflow spill), which parses as JSON and
  // would otherwise never meet the jsx stage in the non-JSON branch above. Unwrap a pure text-block
  // envelope and compact the text; detectJsx is narrow enough that no other JSON shape gets here,
  // and a non-win falls straight through to the normal pipeline.
  if (cfg.jsx) {
    const inner = blockText(parsed);
    if (inner !== null) {
      const j = jsxResult(inner, cfg, content);
      if (j) return j;
    }
  }
  // M14 — the same envelope, but around a JSON payload: the shape the mcp-slim hook spills a whale
  // ORIGINAL in, and therefore the shape the CLI recovery path is pointed at. A 1-element array whose
  // single string no stage and no dot-walk can descend into yields no win on its own, so the INNER
  // payload is slimmed and THAT body handed back: rewrapping it would re-escape the win away, and the
  // reader wants the payload, not the transport. The RATIO is measured against the ENVELOPE's bytes —
  // that is what the caller would otherwise have paid; a win against the inner implies one against
  // the envelope, whose escaping and wrapper only ever add bytes.
  // A non-winning inner falls through to the normal pipeline, so an incompressible envelope still
  // leaves with the WHOLE original untouched (the decline rule above); an inner ERROR envelope is
  // handed back verbatim for the reason the fence branch states (on an expired budget too — the
  // probe inside the gate above).
  if (cfg.envelope) {
    const env = envelopeInner(parsed, cfg);
    if (env) {
      const inner = slim(env.text, { ...cfg, envelope: false });
      if (inner.error) return pass('error-shape', { error: true });
      if (inner.wasModified && inner.bytesOut < inner.bytesIn) {
        return {
          output: inner.output,
          wasModified: true,
          bytesIn,
          bytesOut: inner.bytesOut,
          ratio: bytesIn ? 1 - inner.bytesOut / bytesIn : 0,
          stages: cfg.trace ? ['envelope', ...inner.stages] : [],
          envelopeUnwrapped: true,
          // The fenced-body handles ride along so Gate A still spills PURE JSON (capOutput's rule) and
          // the tool's prose still frames the handback, exactly as on an unwrapped fenced payload.
          ...(typeof inner.fenceBody === 'string' ? { preamble: inner.preamble, fenceBody: inner.fenceBody, fenceTrailer: inner.fenceTrailer } : {}),
          // No `logCompressed` twin: the inner parsed as JSON by construction, so the log stage — a
          // NON-JSON text detector — cannot have run on it. A nested envelope of Figma JSX can.
          ...(inner.jsxCompressed ? { jsxCompressed: true } : {}),
        };
      }
    }
  }
  let value = parsed;
  const stages = [];
  if (fromJsonl && cfg.trace) stages.push('jsonl'); // trace-only bookkeeping, like the other stages
  try {
    // The pipeline always runs; the compact()-per-stage byte-delta bookkeeping is opt-in (cfg.trace,
    // set by the FND_MCP_SLIM_DEBUG feed). Off ⇒ the hot path serializes exactly ONCE (the final
    // compact below) — no per-stage cost for a disabled feature, and `stages` stays empty.
    let prev = cfg.trace ? compact(value) : '';
    const runStage = (name, nextFn) => {
      if (budgetExpired(cfg)) throw budgetStop(); // stages accumulate; a bail here discards the whole run
      value = nextFn();
      if (cfg.trace) { const cur = compact(value); if (cur !== prev) { stages.push(name); prev = cur; } }
    };
    if (cfg.adf) runStage('adf', () => adfStage(value, cfg));
    if (cfg.noise) runStage('noise', () => noiseStage(value, cfg));
    if (cfg.truncate) runStage('truncate', () => truncateStage(value, cfg));
    runStage('crush', () => crushValue(value, cfg));
    if (cfg.toon) runStage('toon', () => toonStage(value));
    const output = compact(value);
    const wasModified = output !== content.trim();
    // Not modified ⇒ the argument itself is the result (same rail as the passthrough returns above):
    // re-serializing would otherwise report a phantom gain for stripped surrounding whitespace / a BOM.
    const bytesOut = wasModified ? Buffer.byteLength(output, 'utf8') : bytesIn;
    // A body that GREW is not a compression — a sampling marker or a toon table can cost more than the
    // stage that ran saved. Both callers already refuse to call this compressed, so without the rail the
    // CLI still printed the larger body (and `--stats` reported a negative reduction as a win).
    if (wasModified && bytesOut >= bytesIn) return pass('no-gain');
    return {
      output: wasModified ? output : original,
      wasModified,
      bytesIn,
      bytesOut,
      ratio: bytesIn ? 1 - bytesOut / bytesIn : 0,
      stages,
    };
  } catch (e) {
    return pass(e && e.fndBudget ? 'budget-exceeded' : 'transform-error');
  }
}

// An MCP/tool error envelope — never compress these (write-gating elsewhere reads them verbatim).
function isErrorShape(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.isError === true) return true; // MCP CallToolResult error result
  const e = v.errors; // GraphQL: an empty errors:[] is a SUCCESS, not an envelope
  if (Array.isArray(e) ? e.length > 0 : !!e) return true;
  if (Array.isArray(v.userErrors) && v.userErrors.length) return true;
  if (v.error) return true;
  return false;
}

// ================================================================ CLI whale gates (M9b) ==

// Gate A — a slimmed body over the inline cap is bounded before it reaches context. A crush that keeps
// a wide signal set, or a null-heavy dump that noise-drops without sampling, can leave an output far
// past what belongs inline. This is the one-huge-JSON-document case (a giant saved API read); a JSONL
// file never reaches here — it always profiles upstream and is never slimmed. Spill the slimmed output
// and hand back a compact summary + recovery paths. STDIN has no path to point at → the caller keeps
// the body (fileArg gate). A spill-write failure returns null → the caller prints the body (never lose
// the result).
function capOutput(res, fileArg, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!fileArg || typeof res.output !== 'string' || res.bytesOut <= cfg.cliOutCap) return null;
  // M11: a fenced result's output is "preamble\n<json>\ntrailer"; spill ONLY the pure JSON body so the
  // fnd-slim-out-* spill is valid JSON — the advertised `--jq <spill>` recovery parses, and the shape
  // sampler below sees a real row instead of choking on the prose preamble. The preamble/trailer prose
  // rides on the handback text so the tool's message is preserved on top. A non-fenced result has no
  // `fenceBody` → the spilled body IS res.output, byte-for-byte as before this fix.
  const jsonBody = typeof res.fenceBody === 'string' ? res.fenceBody : res.output;
  const spilled = writeSpill(cfg.spillDir, 'fnd-slim-out-', jsonBody);
  if (!spilled) return null;
  const outPath = spilled.path;
  noteSpill(cfg, outPath, spilled.created);
  // Shape sample: the first REAL row (skipping the crush sentinel) if the body is an array, else the
  // object itself. Truncated so one fat row can't blow the handback back past the very cap we enforce.
  let rowsKept = null, sample = null, isArr = false, isJson = false;
  try {
    const parsed = JSON.parse(stripBom(jsonBody));
    isJson = true;
    if (Array.isArray(parsed)) {
      isArr = true;
      const real = parsed.filter((r) => !(r && typeof r === 'object' && !Array.isArray(r) && r._ccr_dropped));
      rowsKept = real.length;
      sample = real.length ? real[0] : null;
    } else { sample = parsed; }
  } catch (_) {}
  // A one-token example built from the data itself — `<path>` alone reads like a FILE path, so the
  // hint spells the syntax AND shows a segment that really resolves.
  const firstKey = sample && typeof sample === 'object' && !Array.isArray(sample) ? Object.keys(sample)[0] : null;
  // …but ONLY when that segment survives the round trip: a key holding a dot, a bracket or a space is
  // unreachable by this dot-walk (`weird.key` splits, `a[0]` normalizes to `a.0`) and a space would
  // even split the pasted command line, silently retargeting the file argument. Unaddressable key →
  // no example (the ternary below drops the parenthetical); the `<jq-path>` syntax hint still shows.
  const jqExample = isArr ? '0' : (firstKey && /^[\w$-]+$/.test(firstKey) ? firstKey : null);
  let sampleStr = sample === null ? '(none)' : compact(sample);
  if (sampleStr.length > 200) sampleStr = `${sampleStr.slice(0, 200)}…`;
  const pct = ((res.ratio || 0) * 100).toFixed(1);
  const spilledBytes = Buffer.byteLength(jsonBody, 'utf8'); // the JSON body actually written to the spill
  const pre = res.preamble ? res.preamble + '\n' : ''; // fenced tool prose, kept on top of the handback
  const post = res.fenceTrailer ? '\n' + res.fenceTrailer : ''; // fenced trailer (e.g. a truncation note)
  // A slimmed body is not always JSON since M13 — a compacted Figma design-context payload is JSX.
  // Sampling a "first row" and advertising `--jq` would then be nonsense, so the non-JSON case names
  // the shape honestly and points at line-windowed reading instead.
  const handback = pre +
    `json-slim: slimmed output ${res.bytesOut} B exceeds the ${cfg.cliOutCap} B inline cap — spilled, not printed.\n` +
    `  ${res.bytesIn} → ${res.bytesOut} bytes (${pct}% reduction)${rowsKept != null ? `, ${rowsKept} rows kept` : ''}\n` +
    (isJson ? `  ${isArr ? 'first row' : 'shape'}: ${sampleStr}\n` : '') +
    `  slimmed output: ${outPath} (${spilledBytes} B)\n` +
    `  original file:  ${fileArg}\n` +
    (isJson
      ? `  narrow with: node json-slim.cjs --jq <jq-path> ${outPath}${jqExample ? `  (e.g. --jq ${jqExample})` : ''}\n`
        + `  <jq-path>: ${JQ_GRAMMAR_HINT}`
      : `  not JSON — read the slimmed body windowed: sed -n '1,80p' ${shq(outPath)}  (--jq does not apply)`) + post;
  return { handback, spillOut: outPath };
}

// Gate B — a file past the stream gate is PROFILED line-by-line, never loaded whole. readFileSync +
// per-row JSON.parse of a multi-GB JSONL would OOM (a 30 MB / 200k-row file peaked ~509 MB RSS, ~17×);
// JSONL is a line stream by design. The accumulator is O(samples): running counts + per-key stats +
// bounded head/tail/reservoir samples. Parse failures are TOLERATED here (a whale is worth profiling
// even with a few bad lines) — counted, not rejecting. Split from the stream so tests feed line
// strings directly (profileLines) without a real whale.
const PROFILE_HEAD = 5;
const PROFILE_TAIL = 5;
const PROFILE_RESERVOIR = 10;
const PROFILE_DISTINCT_CAP = 1000;
// A count cap alone does not bound the distinct set: 1000 × 100 KB values is 100 MB of retained
// strings, and a GB-scale whale is exactly where those live. Cap the retained BYTES per key too.
const PROFILE_DISTINCT_BYTES = 65536;
const PROFILE_BYTE_CAP = 8000; // the emitted profile stays ≤ ~8 KB (exit target: stdout ≤ 10 KB)

function makeProfileAccumulator(config) {
  return {
    cfg: { ...DEFAULTS, ...(config || {}) },
    lines: 0, parsed: 0, parseFailures: 0,
    keys: new Map(), // key → { present, null, type, distinct:Set, distinctBytes, capped }
    keyCapHit: false,
    head: [], tail: [], reservoir: [], seen: 0,
  };
}

// Feed one raw line into the accumulator. Blank lines are structural; a parse failure or a non-object
// row is tolerated (parseFailures++), object rows drive the per-key stats and the samples.
function profileFeed(st, rawLine) {
  const line = String(rawLine).replace(/^\uFEFF/, ''); // strip a leading BOM on the first line
  if (!line.trim()) return;
  st.lines++;
  let v;
  try { v = JSON.parse(line); } catch (_) { st.parseFailures++; return; }
  // Accept object AND array rows — the SAME acceptance parseJsonl uses (a bare scalar is the only
  // reject). A JSONL file of tuple rows (`[1,2,3]` per line) is legitimate bulk data; profiling it
  // by index-key mirrors the object case (Object.keys of an array yields "0","1",… → per-position
  // stats). Rejecting arrays here made a valid array-row JSONL profile as rows:0/all-parseFailures.
  if (!v || typeof v !== 'object') { st.parseFailures++; return; }
  st.parsed++;
  for (const k of Object.keys(v)) {
    let s = st.keys.get(k);
    if (!s) {
      // An id-keyed map dumped one row per line carries a FRESH key name every row — one distinct-Set
      // per name, held for the whole stream (2.2M keys ≈ 1.1 GB, an OOM on a file Gate B exists to make
      // tractable). Past the build cap the key is dropped: stats for a key the emit cap can never show
      // are dead weight, and profileFinalize flags the count as a floor.
      if (st.keys.size >= PROFILE_KEY_BUILD_CAP) { st.keyCapHit = true; continue; }
      s = { present: 0, null: 0, type: null, distinct: new Set(), distinctBytes: 0, capped: false };
      st.keys.set(k, s);
    }
    s.present++;
    const val = v[k];
    if (val === null) s.null++;
    else if (s.type === null) s.type = jsonType(val);
    if (!s.capped) {
      const c = compact(val);
      const before = s.distinct.size;
      s.distinct.add(c);
      if (s.distinct.size !== before) s.distinctBytes += c.length;
      if (s.distinct.size >= PROFILE_DISTINCT_CAP || s.distinctBytes >= PROFILE_DISTINCT_BYTES) s.capped = true;
    }
  }
  if (st.head.length < PROFILE_HEAD) st.head.push(v);
  st.tail.push(v); if (st.tail.length > PROFILE_TAIL) st.tail.shift();
  st.seen++;
  if (st.reservoir.length < PROFILE_RESERVOIR) st.reservoir.push(v);
  else { const j = Math.floor(Math.random() * st.seen); if (j < PROFILE_RESERVOIR) st.reservoir[j] = v; } // Algorithm R
}

// Truncate one sample row whose serialization would eat the byte budget — keep a shape hint, not bytes.
function capSampleRow(v) {
  const s = compact(v);
  return s.length > 600 ? { _sample_truncated: s.length, _head: s.slice(0, 200) } : v;
}

// Collapse the accumulator into ONE compact profile object, then trim samples AND keys until it fits
// the cap. A count cap alone does NOT bound bytes — 200 keys with long names (a wide row) serialize
// far past PROFILE_BYTE_CAP — so after the samples ladder we shrink the emitted key set by bytes too.
const PROFILE_KEY_CAP = 200; // cheap pre-limit before the byte ladder
// What the ACCUMULATOR will build, headroom over the emit cap so the byte ladder still has candidates
// to trim: an emit cap bounds the output, only this bounds memory.
const PROFILE_KEY_BUILD_CAP = 2 * PROFILE_KEY_CAP;
function profileFinalize(st, meta) {
  const keyEntries = [];
  for (const [k, s] of st.keys) {
    if (keyEntries.length >= PROFILE_KEY_CAP) break;
    keyEntries.push([k, { present: s.present, null: s.null, type: s.type || 'null', distinct: s.distinct.size, ...(s.capped ? { distinctCapped: true } : {}) }]);
  }
  const totalKeys = st.keys.size;
  const profile = {
    profile: true,
    file: (meta && meta.file) || null,
    bytes: meta && meta.bytes != null ? meta.bytes : null,
    lines: st.lines,
    rows: st.parsed,
    parseFailures: st.parseFailures,
    keys: {},
    samples: {
      head: st.head.map(capSampleRow),
      tail: st.tail.map(capSampleRow),
      reservoir: st.reservoir.map(capSampleRow),
    },
  };
  // Set before the byte ladder runs so its size() sees this field. Past the build cap the accumulator
  // stopped tracking key names, so the dropped count saturates and the exact number of distinct keys
  // the file holds is not knowable from here.
  if (st.keyCapHit) profile.keysCapped = true;
  // Emit `limit` keys and record how many were dropped (from either the pre-limit or the byte ladder).
  // The count is named for what it is: an exact total, or — once the build cap capped the key set — a
  // FLOOR. The profile is the only artifact a JSONL whale ever puts in context, so a saturated 266 must
  // not read as "this file has 400 fields".
  const setKeys = (limit) => {
    profile.keys = {};
    const shown = Math.min(limit, keyEntries.length);
    for (let i = 0; i < shown; i++) profile.keys[keyEntries[i][0]] = keyEntries[i][1];
    const dropped = totalKeys - shown;
    const field = st.keyCapHit ? 'keysTruncatedAtLeast' : 'keysTruncated';
    delete profile.keysTruncated;
    delete profile.keysTruncatedAtLeast;
    if (dropped > 0) profile[field] = dropped;
  };
  setKeys(keyEntries.length);
  const size = () => Buffer.byteLength(compact(profile), 'utf8');
  if (size() > PROFILE_BYTE_CAP) { profile.samples.reservoir = []; }
  if (size() > PROFILE_BYTE_CAP) { profile.samples.tail = []; }
  if (size() > PROFILE_BYTE_CAP) { profile.samples.head = profile.samples.head.slice(0, 2); }
  if (size() > PROFILE_BYTE_CAP) { profile.samples = { note: 'omitted (over size budget)' }; }
  // Keys can still dominate (wide rows / a misidentified minified single object) — binary-search the
  // largest key count that fits. setKeys(0) empties keys and the base profile is tiny, so this always
  // converges (a single key name > the cap collapses to keys:{}, keysTruncated:<total>).
  if (size() > PROFILE_BYTE_CAP) {
    let lo = 0, hi = Object.keys(profile.keys).length, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      setKeys(mid);
      if (size() <= PROFILE_BYTE_CAP) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    setKeys(best);
  }
  return profile;
}

// Synchronous profile over an iterable of raw line strings — the test seam; streamProfile shares the
// same accumulator over a file stream.
function profileLines(lines, meta, cfg) {
  const st = makeProfileAccumulator(cfg);
  for (const line of lines) profileFeed(st, line);
  return profileFinalize(st, meta || {});
}

// Read up to `maxLines` lines from the HEAD of a file without loading it whole — a single bounded read
// (≤ maxBytes). A >8 MB fenced whale can have a one-line 700 KB body, so we must NOT slurp the file to
// find the fence; the opening fence is always among the first few short lines, well inside one 64 KB
// read. String.split(sep, limit) caps the returned array, so a body line cut mid-read is never mistaken
// for a complete fence line (it can't match the anchored fence regex). Used by Gate B (M11).
function peekHeadLines(file, maxLines, maxBytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, read).split('\n', maxLines);
  } catch (_) { return []; }
}

// Single-pass readline over a read stream — O(samples) memory, so it works at GB scale. `opts.skipLeading`
// skips the first N physical lines and `opts.fenceAware` skips any closing-fence line, so a >8 MB fenced
// JSONL whale profiles only its real rows (matching the ≤8 MB unwrap path) — the wrapper never inflates
// parseFailures and the offset drives the guidance's tolerant loader / sed hint (M11).
function streamProfile(file, cfg, opts) {
  const skip = (opts && opts.skipLeading) || 0;
  const fenceAware = !!(opts && opts.fenceAware);
  return new Promise((resolve, reject) => {
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch (_) {}
    const st = makeProfileAccumulator(cfg);
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let idx = 0;
    rl.on('line', (line) => {
      if (idx++ < skip) return; // wrapper preamble + opening fence
      if (fenceAware && FENCE_CLOSE.test(line)) return; // closing fence (and a would-be trailer fence)
      profileFeed(st, line);
    });
    rl.on('close', () => resolve(profileFinalize(st, { file, bytes })));
    rl.on('error', reject);
  });
}

// The shared "what to do with this whale" block — printed after a PROFILE by BOTH the streaming Gate B
// and the JSONL Gate A case, so both paths speak identically (one home for the guidance text). Points
// at the ORIGINAL file: its path, the row count, a ready-to-adapt readline template the model fills
// from the profile's sample rows, and sed/grep for single-row extraction. --jq is deliberately NOT
// offered — it re-reads the whole file and defeats the streaming/profiling that made the whale
// tractable. The samples in the profile exist precisely so the model can write the filter correctly
// (they reveal gotchas like a `children.value` sub-field being a JSON-encoded STRING, not an array).
// This is the intended interface for analytical questions over data files: query the original by line,
// don't pull the data into context. Emitted in FULL on the first profile of a given file per session and
// replaced by whaleReminder() afterwards — see the one-shot state below.
// Wrap a path as a single POSIX shell token (single-quoted, embedded ' → '\'') so the copy-paste
// recovery commands survive spaces, quotes, `$`, etc. in the path.
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function whaleGuidance(file, rows, offset) {
  const qf = shq(file);
  // The node -e script: JSON.stringify escapes the path for the inner JS string literal (handles " and
  // \); shq then single-quotes the WHOLE script for the shell (handles ' in the path). Both layers
  // needed — a bare "${file}" broke on a " in the path AND on a space splitting the shell token.
  // M11: when the JSONL rows sit inside a fence (offset physical lines precede them), the loader must
  // SKIP the wrapper lines (prose/fence/close) — a tolerant try/parse does that; the plain path keeps
  // the strict `JSON.parse(l)` byte-for-byte, and a fence note states the offset for the sed hint.
  const parse = offset ? 'let o;try{o=JSON.parse(l)}catch(_){return}' : 'const o=JSON.parse(l)';
  const script = `const rl=require("readline").createInterface({input:require("fs").createReadStream(${JSON.stringify(file)})});rl.on("line",l=>{${parse};/* filter, e.g. JSON.parse(o.children?.value||"[]").length>50 */&&console.log(o.handle)})`;
  const fenceNote = offset ? `  the rows are inside a \`\`\` fence — they begin at line ${offset + 1}; the loader below skips the ${offset} wrapper lines, and a sed line number is the row number + ${offset}.\n` : '';
  return `json-slim: query the ORIGINAL by line, don't pull it into context — ${file}${rows != null ? ` (${rows} rows)` : ''}.\n` +
    fenceNote +
    `  filter rows (adapt the /* … */ predicate from the sample rows above):\n` +
    `    node -e ${shq(script)}\n` +
    `  single rows: sed -n '<N>p' ${qf}  ·  grep <pattern> ${qf}  (--jq would re-read the whole file)`;
}
// R6 — the full block above is ~530-900 B (the path is interpolated 4×) and is IDENTICAL every time the
// same file is profiled again in one session, so repeats are pure context tax. After the first emission
// per session × file the profile carries this one-liner instead: it still names the file and the row
// count (the profile is worthless without knowing which file it describes) and it stays SELF-SUFFICIENT
// — the single-row `sed`/`grep` forms and the fence offset are per-file FACTS, not prose, and the reader
// of a repeat profile may not hold the first block at all (a spawned subagent shares the session id, a
// `/compact` drops the earlier transcript, concurrent runs race the state file). Only the long
// readline-filter template is dropped, and the switch that brings it back is named. NEVER changes WHAT
// is profiled — only how much guidance prose rides along.
function whaleReminder(file, rows, offset) {
  const qf = shq(file);
  const fenceNote = offset ? ` rows are inside a \`\`\` fence and start at line ${offset + 1}, so a sed line number is the row number + ${offset};` : '';
  return `json-slim: profile only — ${file}${rows != null ? ` (${rows} rows)` : ''} — query the ORIGINAL by line, never pull the file into context;${fenceNote} single rows: sed -n '<N>p' ${qf} · grep <pattern> ${qf} (--jq would re-read the whole file); the readline-filter template was printed for this file earlier this session — FND_WHALE_GUIDE=0 re-prints the full block.`;
}
// Suppression is opt-out: anything falsey-looking in FND_WHALE_GUIDE (0/false/no/off) means "always
// print the full block", which is also the escape hatch a model is told about in the reminder itself.
function whaleGuideEnabled() {
  const raw = process.env.FND_WHALE_GUIDE;
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}
// One state file per (session, profiled file) — keyed on the FILE PATH so a different whale always gets
// its own full block (the commands differ per path, and the suites profile several files through one
// spill dir), and on the session so a fresh conversation starts over. The path is RESOLVED first: two
// different files invoked under the same relative spelling from different cwds (`./data.jsonl`) would
// otherwise share one entry — and the `st.p` collision guard would pass on the identical string, so the
// second file would be suppressed without ever having printed its own commands or fence offset.
// CLAUDE_CODE_SESSION_ID is what the harness exports to tool subprocesses; when it is absent (a bare
// shell) the key degrades to path-only and the TTL alone bounds the suppression. Lives in spillRoot(),
// so FND_MCP_SLIM_DIR isolates it exactly like every other file this module writes.
function whaleGuideKey(file) { return path.resolve(String(file)); }
function whaleGuideStatePath(dir, file) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const sid = String(process.env.CLAUDE_CODE_SESSION_ID || '');
  const key = crypto.createHash('sha256').update(`${sid}\n${whaleGuideKey(file)}`).digest('hex').slice(0, 16);
  return path.join(spillRoot(dir), `${WHALE_GUIDE_PREFIX}${uid}-${key}`);
}
// Fixed (not sliding) window: the stamp is written only when the FULL block is printed, so the full block
// comes back every WHALE_GUIDE_TTL_MS even in a session that keeps re-profiling the same whale.
const WHALE_GUIDE_TTL_MS = 2 * 60 * 60 * 1000;
// True when the caller should print the full block. Every fs error and every unexpected file content
// (truncated, corrupt, another path behind a hash collision, an expired stamp, a stamp from the FUTURE —
// a clock stepped backwards by an NTP correction or a VM resume, which an unbounded `now - t < TTL`
// would let suppress forever) falls back to the full block: over-explaining costs tokens,
// under-explaining strands the model without recovery commands. DECISION ONLY — the stamp is written
// by whaleGuideStamp() after the block actually reached stdout (see emitProfile), so a run cut off
// mid-pipe (`| head -1` → EPIPE, now a quiet exit 0) never records a block it did not deliver.
function whaleGuideFullBlock(dir, file) {
  if (!whaleGuideEnabled()) return true;
  const abs = whaleGuideKey(file);
  const state = whaleGuideStatePath(dir, file);
  let fd;
  try {
    // O_NOFOLLOW + a size cap: with CLAUDE_CODE_SESSION_ID absent the state name is fully
    // predictable and the spill root may be a shared tmpdir — never follow a planted symlink,
    // never slurp a planted large file; both fall through to the full block.
    fd = fs.openSync(state, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const meta = fs.fstatSync(fd);
    if (meta.isFile() && meta.size <= 4096) {
      const buf = Buffer.alloc(Number(meta.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const st = JSON.parse(buf.toString('utf8'));
      const age = st && Number.isFinite(st.t) ? Date.now() - st.t : NaN;
      if (st && st.p === abs && age >= 0 && age < WHALE_GUIDE_TTL_MS) return false;
    }
  } catch (_) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return true;
}
// The stamp, written only AFTER the full block reached stdout. tmp + rename replaces a planted
// symlink itself (never its target) and `wx` refuses a pre-existing tmp; the .tmp name keeps
// WHALE_GUIDE_PREFIX so an orphan is swept with the hints. A profile run never CREATES the spill
// tree — at HEAD it created nothing there, and a typo'd FND_MCP_SLIM_DIR must not silently
// materialize directories: no root → no stamp → full block every run, the safe direction.
function whaleGuideStamp(dir, file) {
  const abs = whaleGuideKey(file);
  const state = whaleGuideStatePath(dir, file);
  try {
    if (!fs.existsSync(spillRoot(dir))) return;
    const tmp = `${state}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ p: abs, t: Date.now() }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, state);
  } catch (_) {} // unwritable dir → every run prints the full block, which is the safe direction
}

// B2 — the per-file no-gain memo. A live week showed 22 CLI runs that re-slimmed files which could not
// shrink, each re-printing the whole file for 0 gain, and the dominant pattern was "decline → immediate
// re-run": a 0 % result reads like a failed attempt unless something says otherwise. So a FILE run that
// printed its body back unchanged records that fact, and the next run of the same file answers in one
// line. The machinery mirrors the whale guide above (state under spillRoot, session × RESOLVED path key,
// fixed TTL, O_NOFOLLOW read, stamp only after delivery) but is a SEPARATE implementation on purpose:
// that one suppresses guidance PROSE while this one suppresses the whole run, and folding them together
// would put a "print less text" edit one line away from a "print nothing at all" decision.
// Opt-out with the same falsey semantics as FND_WHALE_GUIDE (0/false/no/off) — the escape hatch the
// refusal itself names, so the model that hits it is never stranded.
function nogainMemoEnabled() {
  const raw = process.env.FND_NOGAIN_MEMO;
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}
// One state file per (session, declined file). The path is RESOLVED first for whaleGuideStatePath's
// reason: two different files spelled `./data.json` from different cwds would otherwise share one entry,
// and the `st.p` collision guard passes on the identical string — the second file would be refused
// without ever having been printed. CLAUDE_CODE_SESSION_ID scopes it to the conversation (absent → the
// key degrades to path-only and the TTL alone bounds it); the uid is in the name because with the
// session id absent the name is fully predictable in a shared tmpdir. Lives in spillRoot(), so
// FND_MCP_SLIM_DIR isolates it exactly like every other file this module writes.
function nogainStatePath(dir, file) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const sid = String(process.env.CLAUDE_CODE_SESSION_ID || '');
  const key = crypto.createHash('sha256').update(`${sid}\n${path.resolve(String(file))}`).digest('hex').slice(0, 16);
  return path.join(spillRoot(dir), `${NOGAIN_PREFIX}${uid}-${key}`);
}
// The current size when a refusal is warranted, else null. Every fs error, unusable content, a foreign
// path behind a hash collision, an expired stamp, a stamp from the FUTURE (a clock stepped back by an
// NTP correction or a VM resume, which an unbounded `now - t < TTL` would let refuse forever) and every
// size/mtime mismatch answers null: a wrong refusal HIDES the file from the model, while doing the work
// again only costs what it cost the first time — refusing is the risky direction. The size+mtime pin is
// what makes the memo safe on a file that is REWRITTEN between runs (a re-fetched spill, a regenerated
// dump): different bytes may well compress, so the memo must not speak for them.
// Caveat by design: overlapping runs that all start before the first stamp lands are NOT guarded — the
// stamp is post-delivery, and the tax this removes is the rerun-after-decline tail, not the burst.
function nogainMemoHit(dir, file) {
  if (!nogainMemoEnabled()) return null;
  const abs = path.resolve(String(file));
  const state = nogainStatePath(dir, file);
  let fd;
  try {
    // O_NOFOLLOW + a size cap, for whaleGuideFullBlock's reason: the name is predictable when the
    // session id is absent and the spill root may be a shared tmpdir — never follow a planted symlink,
    // never slurp a planted large file; both fall through to doing the work.
    fd = fs.openSync(state, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const meta = fs.fstatSync(fd);
    if (meta.isFile() && meta.size <= 4096) {
      const buf = Buffer.alloc(Number(meta.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const st = JSON.parse(buf.toString('utf8'));
      const age = st && Number.isFinite(st.t) ? Date.now() - st.t : NaN;
      // NB the 4096 read cap above is the STATE-FILE size limit (never slurp a planted large file) —
      // the same number as NOGAIN_FLOOR_BYTES by coincidence of scale, not by meaning; that one decides
      // which declines are worth remembering. They move independently.
      if (st && st.p === abs && age >= 0 && age < NOGAIN_TTL_MS) {
        const now = fs.statSync(file);
        if (now.size === st.size && now.mtimeMs === st.mtimeMs) return now.size;
      }
    }
  } catch (_) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return null;
}
// The stamp, written only AFTER the unchanged body reached stdout (the whaleGuideStamp rule: a run cut
// off mid-pipe never records a delivery it did not make). tmp + rename replaces a planted symlink itself
// (never its target) and `wx` refuses a pre-existing tmp; the .tmp name keeps NOGAIN_PREFIX so an orphan
// is swept with the hints. Never CREATES the spill tree — a typo'd FND_MCP_SLIM_DIR must not silently
// materialize directories: no root → no stamp → the body every run, the safe direction.
function nogainStamp(dir, file) {
  const abs = path.resolve(String(file));
  const state = nogainStatePath(dir, file);
  try {
    if (!fs.existsSync(spillRoot(dir))) return;
    const s = fs.statSync(file); // the identity the next run re-checks: same bytes, or no refusal
    const tmp = `${state}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ p: abs, t: Date.now(), size: s.size, mtimeMs: s.mtimeMs }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, state);
  } catch (_) {} // unwritable dir → every run prints the body, which is the safe direction
}
// The one-line answer a memo hit gives instead of the body. Self-sufficient like whaleReminder(): the
// reader of the refusal may not hold the first decline at all (a subagent shares the session id, a
// /compact drops the earlier transcript), so it carries the size, both recoveries and the off switch.
function nogainRefusal(file, bytes) {
  return `json-slim: ${file} already passed through uncompressed this session (${bytes} B — nothing to shrink). ` +
    `Do NOT re-run json-slim on it: read it directly (Read/head/sed -n '<K>p') or extract a sub-path: --jq <jq-path>. ` +
    `FND_NOGAIN_MEMO=0 disables this memo.`;
}
// B2 Layer 1 — json-slim's OWN Gate-A output spill (capOutput writes it as fnd-slim-out-*) holds an
// ALREADY SLIMMED body: re-slimming re-prints up to the 48 KB inline cap for ~0 gain. ONLY this prefix
// is refused. `fnd-mcp-slim-` and `fnd-prompt-json-` are spilled ORIGINALS — precisely the input the CLI
// exists to run on; `fnd-crush-` holds the rows a crush dropped (a legitimate analysis target); and
// `fnd-jsx-ids-` is a small id map. Refusing any of those would break a documented recovery.
const SLIM_OUT_PREFIX = 'fnd-slim-out-';
function slimOutRefusal(file, bytes) {
  return `json-slim: ${file} IS json-slim's own slimmed output (already compressed, ${bytes} B) — re-slimming cannot shrink it. ` +
    `Read it directly (Read/head/sed) or extract a sub-path: --jq <jq-path>. FND_NOGAIN_MEMO=0 forces the run.`;
}
function streamJqRefusal(file, bytes) {
  const qf = shq(file);
  return `json-slim: --jq re-reads the whole file, but ${file} is ${bytes} B (> ${DEFAULTS.streamGateBytes} B) — refusing to load it. ` +
    `Extract rows with \`sed -n '<N>p' ${qf}\` or \`grep <pat> ${qf}\`.`;
}
// A file over the stream gate that is NOT a JSONL row stream (a single large JSON document, or an
// unparseable file) — profiling it as rows is misleading. Hand the path back with honest guidance:
// json-slim won't load a file this size whole, so inspect it with external tools.
function bigDocNotice(file, bytes) {
  const qf = shq(file);
  return `json-slim: ${file} is ${bytes} B (> ${DEFAULTS.streamGateBytes} B) and is NOT a JSONL row stream — a single large JSON document. ` +
    `json-slim won't load a file this size whole; inspect it with \`head -c <N> ${qf}\`, \`jq\`, or \`grep\`, or split it into JSONL rows first.`;
}

// The ONE profile emitter, shared by BOTH profile feeds — Gate B's readline stream (>8 MB) and the
// ≤8 MB JSONL file case: the compact profile JSON, the guidance block over the original, one debug line
// (passthrough-family + `profile:true`, reusing the existing `stream-profile` reason — no new value),
// then the exit sweep. `bytes` is the original file size so the debug line's bytes_in matches the file
// regardless of how the profile was fed.
// `extra` re-points the parts of that line this emitter cannot know, for the ONE caller whose profile
// is not about the file it was handed (M14's envelope-JSONL case profiles a spill of the unwrapped
// body): `tool` keeps naming the ARGUMENT — `--report` pairs a platform-overflow spill with the cli
// run that recovered it BY PATH — while `stages`/`spills`/`spill` carry the rail that fired and the
// file this invocation left on disk, without which the B4.10a inventory under-reports exactly the
// spills a new writer creates. Every other call site passes nothing and logs the line it always did.
function emitProfile(profile, file, bytes, t0, cfg, offset, extra) {
  const x = extra || {};
  const logTool = x.tool || file;
  const logStages = x.stages || [];
  const logSpill = x.spill || null;
  const logSpills = Array.isArray(x.spills) ? x.spills : undefined;
  // Gate B fires on SIZE alone, before any JSONL detection, so a >8 MB NON-JSONL document (a single
  // minified JSON array/object, a pretty-printed doc whose lines are fragments) reaches here too and
  // profiles as rows:0/1 with all-parseFailures — a row profile + row guidance is misleading for it.
  // A genuine JSONL row stream always has ≥2 parsed rows (parseJsonl's own threshold); below that we
  // hand the file back with non-JSONL guidance instead. (The ≤8 MB JSONL path guarantees rows≥2.)
  if (profile.rows < 2) {
    const notice = bigDocNotice(file, bytes);
    process.stdout.write(notice + '\n');
    debugLog({ entry: 'cli', tool: logTool, decision: 'passthrough', reason: 'big-nonjsonl', bytes_in: bytes, bytes_out: Buffer.byteLength(notice, 'utf8'), pct: 0, stages: logStages, spill: logSpill, spill_out: null, ...(logSpills ? { spills: logSpills } : {}), ms: Date.now() - t0 }, cfg.spillDir);
    sweepSpills(cfg.spillDir, process.cwd());
    return;
  }
  const body = compact(profile);
  process.stdout.write(body + '\n');
  // `guide` rides on the debug line so --report can measure how often the one-shot rule fires (the
  // TTL/N tuning evidence) and an always-suppress regression is visible in the field, not only in tests.
  const full = whaleGuideFullBlock(cfg.spillDir, file);
  // Stamp only once stdout CONFIRMS the flush: with a piped stdout the write is async and an
  // EPIPE surfaces on a later tick, so stamping synchronously after write() would still record
  // a block that `| head -1` never delivered. The callback gets err on a broken pipe → no stamp.
  process.stdout.write((full
    ? whaleGuidance(file, profile.rows, offset)
    : whaleReminder(file, profile.rows, offset)) + '\n',
  (err) => { if (!err && full) whaleGuideStamp(cfg.spillDir, file); });
  debugLog({ entry: 'cli', tool: logTool, decision: 'passthrough', reason: 'stream-profile', bytes_in: bytes, bytes_out: Buffer.byteLength(body, 'utf8'), pct: 0, stages: logStages, spill: logSpill, spill_out: null, ...(logSpills ? { spills: logSpills } : {}), profile: true, guide: full ? 'full' : 'reminder', ms: Date.now() - t0 }, cfg.spillDir);
  sweepSpills(cfg.spillDir, process.cwd());
}

// ==================================================================== --jq ergonomics (M12) ==

// Normalize ONE --jq path to the plain dot-walk underneath it: a leading `.` is stripped and `[N]`
// numeric indices are rewritten to `.N`, so `.products[0].title` ≡ `products.0.title`. Spelling only —
// pipes, commas and `[]` belong to the grammar layer below, and a quoted key (`["a.b"]`) survives
// verbatim (it is refused there, so a key literally containing a dot stays unreachable). `.` / `..`
// still normalize to the empty identity selector.
function normalizeJqPath(p) {
  return String(p).replace(/\[(\d+)\]/g, '.$1').replace(/^\.+/, '');
}

// What a --jq walk could have addressed at the point it died — the second half of the stderr
// diagnostic (`keys: products` / `length: 250` / `value is string`). Keys are capped so a wide
// object can't turn one diagnostic line into a dump.
const JQ_KEYS_SHOWN = 8;
function jqAvailable(v) {
  if (Array.isArray(v)) return `length: ${v.length}`;
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return 'no keys (empty object)';
    return `keys: ${ks.slice(0, JQ_KEYS_SHOWN).join(', ')}${ks.length > JQ_KEYS_SHOWN ? `, …(+${ks.length - JQ_KEYS_SHOWN})` : ''}`;
  }
  return `value is ${v === null ? 'null' : typeof v}`;
}

// ------------------------------------------------------------ the supported --jq grammar (M15) --
// Readers write REAL jq (`.fields | keys`, `.a[].b`, `.x, .y`), and a plain dot-walk answered those
// with `null` plus a diagnostic about a segment called `fields | keys` — so the path looked wrong and
// the same file was re-run three to seven times with guessed spellings. The CLI now evaluates the
// small subset those expressions actually use and REFUSES the rest by name (no jq dependency, still):
//   expr   := term (',' term)*     — one stdout doc here where jq emits N, so terms come back as ONE array
//   term   := path ('|' filter)*
//   path   := dot path (as before) with `[]` fan-out allowed at any segment
//   filter := 'keys' | 'length' | a leading-dot path (`.a | .b` ≡ `.a.b`)
// A step is a key string; `null` is the `[]` fan-out (a key is always a string, so the marker needs no
// wrapper). Anything else is a USAGE error, named before the walk runs — see the CLI's refusal.
// The ONE spelling of that grammar, interpolated by the refusal, the Gate-A handback and the hook's
// stub: hand-copying this sentence into three strings is how they drift apart. Examples are quoted
// because an unquoted `,` multi-select is split by the shell into two arguments.
const JQ_GRAMMAR_HINT = "dot paths (.a.b, .a[0]), '[]' iteration, ',' multi-select, '| keys' / '| length'";

// The constructs this evaluator cannot run, matched on the stage AS TYPED (before normalizeJqPath
// rewrites `[N]`): recursive descent, the alternative operator, optionals, function calls, literals,
// comparisons, and any bracket that is not `[]` or `[N]`. Judged FIRST, so whatever is left over may be
// a plain key — the dot-walk this replaced addressed `@type`, `a:b`, `x/y` and `2fa`, and refusing them
// now would send the reader back to reading the whole file for want of one value.
const JQ_UNSUPPORTED = /\.\.|\/\/|\?|[()"']|[=<>!]=?|\[(?!\]|\d+\])[^\]]*\]?/;
// One step: the separating dot — absent only on the first, which normalizeJqPath already stripped —
// then the key. The dot is REQUIRED, or a digit-leading key splits in two (`2fa` → `2`, `fa`) and
// answers with a sibling numeric key's value instead of the one the reader addressed.
const JQ_STEP = /^(\.?)([^.[\]]+)/;

// The first slice of a stage that is NOT supported syntax — the token the refusal names, so the
// reader sees WHICH part of their filter is out of scope instead of the whole expression back. The
// constructs with a spelling of their own come first; the trailing run-of-characters is the catch-all.
function jqBadToken(s) {
  const t = String(s).trim();
  const m = /^(?:\.\.|\/\/|[A-Za-z_$][\w$-]*\s*\(|"[^"]*"?|'[^']*'?|\[[^\]]*\]?|[^\s,|]+)/.exec(t);
  if (!m) return t.slice(0, 40);
  // A bare word with something after it is refused for what FOLLOWS it, not for the word: naming
  // `length` in `length > 2` would point at the one part of that filter this CLI does support.
  const bare = m[0] !== t && /^[A-Za-z_$][\w$-]*$/.test(m[0]);
  return (bare ? t : m[0]).slice(0, 40);
}

// One path stage → steps, or `{ bad }` for the first unsupported slice. normalizeJqPath still owns the
// `[N]` → `.N` and leading-dot rewrites, so only `[]` brackets survive into the tokenizer.
function parseJqPath(src) {
  // `.a.[0]` is jq's own spelling of `.a[0]`; collapsing the pair keeps the scan below from reading it
  // as the recursive descent the reader never typed.
  const s = String(src).trim().replace(/\.\[/g, '[');
  if (/^\.?$/.test(s)) return { segs: [] }; // '.' — identity: the whole value, not a field
  const out = JQ_UNSUPPORTED.exec(s);
  if (out) return { bad: out[0].slice(0, 40) };
  const segs = [];
  let rest = normalizeJqPath(s);
  for (let first = true; rest; first = false) {
    if (rest.startsWith('[]')) { segs.push(null); rest = rest.slice(2); continue; }
    const m = JQ_STEP.exec(rest);
    if (!m || (m[1] === '.') === first) return { bad: jqBadToken(rest) }; // a missing or doubled separator
    segs.push(m[2]);
    rest = rest.slice(m[0].length);
  }
  return { segs };
}

// The whole expression, parsed ONCE: the CLI needs the identity answer (and the refusal) before it
// reads any body. `identity` is the old empty-segment rule — `.` / `..` select the whole value.
function parseJqExpr(src) {
  // `..` is identity only as the WHOLE expression (the spelling the CLI has always accepted for
  // "re-dump everything"); inside a pipeline it is jq's recursive descent, which this evaluator
  // refuses like any other construct it cannot run.
  if (/^\s*\.+\s*$/.test(String(src))) return { terms: [{ segs: [], ops: [] }], identity: true };
  const terms = [];
  for (const term of String(src).split(',')) {
    // An EMPTY slot (`.a,`, `,.a`, `.a,,.b` — what an unquoted multi-select leaves behind after the
    // shell splits it) is a syntax error in jq and must be one here: parsed as a path it is the
    // identity selector, which would answer a stray comma with the WHOLE document.
    if (!term.trim()) return { bad: ',' };
    const stages = term.split('|');
    const head = parseJqPath(stages[0]);
    if (head.bad) return { bad: head.bad };
    const ops = [];
    for (const stage of stages.slice(1)) {
      const f = stage.trim();
      if (f === 'keys' || f === 'length') { ops.push(f); continue; }
      // A path filter must be spelled with its dot: a BARE word after a pipe is a jq function
      // (`keys_unsorted`, `not`, `add`), and reading it as a key would answer a filter this CLI
      // cannot run with a plausible-looking null — the exact failure the refusal exists to end.
      if (!f.startsWith('.')) return { bad: jqBadToken(f || '|') };
      const p = parseJqPath(f);
      if (p.bad) return { bad: p.bad };
      ops.push(p.segs);
    }
    terms.push({ segs: head.segs, ops });
  }
  return { terms, identity: terms.length === 1 && !terms[0].ops.length && !terms[0].segs.length };
}

// Does this expression select the WHOLE document? Answered by SHAPE, not by spelling: a path-filter
// stage continues the walk (`.a | .b` ≡ `.a.b`, so `. | .[]` ≡ `.[]`), so flatten each term's path with
// its path-filters and ask whether nothing is left but the bare root or a bare root `[]` — and every
// term must be whole, since a multi-select of two whole terms answers with TWO copies of the document.
// The syntactic test this replaced recognized only the literal `.` and `.[]`, so `. | .`, `.[] | .`,
// `., .` … counted as narrowings and re-dumped the file the JSONL gate and the B2 guards exist to spare.
function jqExprWhole(expr) {
  if (!expr || expr.bad) return false;
  if (expr.identity) return true;
  return expr.terms.every((t) => {
    if (t.ops.some((o) => typeof o === 'string')) return false; // `| keys` / `| length` answer something else
    const flat = [].concat(t.segs, ...t.ops); // a `| .` stage contributes no segment at all
    return flat.length === 0 || (flat.length === 1 && flat[0] === null);
  });
}

// Where a walk died, in the spelling the reader typed (`a[].b`), plus what was addressable there.
function jqMiss(what, where, cur) {
  const at = where.length ? `at '${where.join('.')}'` : 'at top level';
  return { ok: false, depth: where.length, diag: `json-slim: --jq: ${what} ${at}; ${jqAvailable(cur)}\n` };
}

// One `[]` iteration, shared by the path walk and by the per-element filter loop (`.a[] | .b` is the
// same fan as `.a[].b`). `depth` is how many segments had already RESOLVED when the fan opened: 0 means
// the iteration was over the whole document, which is the only shape M14's envelope rail may re-try
// against another one. A HARD failure is the term's answer and stops the loop; jq's per-element `null`
// rides on `miss` instead.
function fanResult(items, where, depth, apply) {
  const out = [];
  let n = 0, dead = 0, note = null;
  for (const item of items) {
    const r = apply(item);
    if (!r.ok) return r;
    n++;
    if (r.miss) { dead++; note = note || r.miss; }
    // Concatenated, never spread: `push(...rows)` passes one argument per element and dies with a
    // RangeError above ~125k of them — a size a spilled whale reaches by design.
    if (r.fan && Array.isArray(r.value)) { for (const x of r.value) out.push(x); } else out.push(r.value);
  }
  const fan = { ok: true, value: out, where, depth, fan: true };
  // NOTHING in the iteration resolved: the value is still jq's column of nulls, but the reader hears
  // once which key was wrong instead of reading an empty stderr as "the field is genuinely null".
  if (n && dead === n) { fan.allMissed = true; fan.miss = note; }
  return fan;
}

function jqWalkPath(root, segs, where0, lenient) {
  let cur = root;
  const where = where0.slice();
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === null) {
      // `[]` FANS OUT: the rest of the path runs per element and the results come back as one array,
      // concatenated when a later `[]` already produced arrays — jq's flat stream, not nesting. An
      // object iterates to its values, as in jq.
      if (!cur || typeof cur !== 'object') return jqMiss("'[]' needs an array or object", where, cur);
      const rest = segs.slice(i + 1);
      const inner = where.length ? where.slice(0, -1).concat(`${where[where.length - 1]}[]`) : ['[]'];
      return fanResult(Array.isArray(cur) ? cur : Object.values(cur), inner, where.length,
        (item) => jqWalkPath(item, rest, inner, true));
    }
    const next = cur == null ? undefined : (Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg]);
    // Inside a fan-out a missing key is jq's `null`, not a hard miss — but the diagnostic is CARRIED, so
    // the caller can report it once for the whole iteration instead of once per row.
    if (next === undefined) {
      if (!lenient) return jqMiss(`'${seg}' not found`, where, cur);
      return { ok: true, value: null, where: where.concat(seg), miss: jqMiss(`'${seg}' not found`, where, cur).diag };
    }
    where.push(seg);
    cur = next;
  }
  return { ok: true, value: cur, where };
}

// jq's own definitions: `keys` sorts an object's names and yields an array's indices; `length` is the
// element/key/codepoint count, a number's magnitude, and 0 for null (a boolean has none).
function jqFilter(name, v, where) {
  if (name === 'keys') {
    if (Array.isArray(v)) return { ok: true, value: v.map((_, i) => i), where };
    if (v && typeof v === 'object') return { ok: true, value: Object.keys(v).sort(), where };
    return jqMiss("'keys' needs an array or object", where, v);
  }
  const n = Array.isArray(v) ? v.length
    : v === null ? 0
      : typeof v === 'object' ? Object.keys(v).length
        : typeof v === 'string' ? [...v].length
          : typeof v === 'number' ? Math.abs(v) : null;
  if (n === null) return jqMiss("'length' is not defined", where, v);
  return { ok: true, value: n, where };
}

// One expression against one document. A filter after a fan-out is applied PER ELEMENT (`.a[] | length`
// is N lengths in jq, not the length of the collection), which also makes `.a[] | .b` ≡ `.a[].b`.
function evalJqTerm(root, term) {
  let r = jqWalkPath(root, term.segs, [], false);
  for (const op of term.ops) {
    if (!r.ok) return r;
    const apply = (v, lenient) => (typeof op === 'string' ? jqFilter(op, v, r.where) : jqWalkPath(v, op, r.where, lenient));
    if (!r.fan) { r = apply(r.value, false); continue; }
    r = fanResult(r.value, r.where, r.depth, (item) => apply(item, true));
  }
  return r;
}

// Multi-select answers with ONE array (this CLI has a single stdout where jq emits a document per
// term), a missed term contributing `null` in its slot and its own diagnostic. A term whose iteration
// resolved NOTHING counts as missed too — it answered `[null, …]`, which is not an answer. `retryInner`
// is M14's envelope question asked of the WHOLE expression: nothing resolved here, and every term died
// at DEPTH 0 — on its first segment, or iterating the document itself ⇒ it was never about this one. A
// term whose prefix DID resolve here (`.content[].foo`) stays: its real miss is `foo`, in this document.
function evalJqExpr(root, expr) {
  const rs = expr.terms.map((t) => evalJqTerm(root, t));
  const one = rs.length === 1;
  const dead = (r) => !r.ok || r.allMissed === true;
  return {
    ok: rs.some((r) => !dead(r)),
    value: one ? (rs[0].ok && rs[0].value !== undefined ? rs[0].value : null) : rs.map((r) => (r.ok && r.value !== undefined ? r.value : null)),
    diags: rs.filter(dead).map((r) => r.diag || r.miss).filter(Boolean),
    retryInner: rs.every((r) => dead(r) && r.depth === 0),
  };
}

// ================================================================ debug-log report (M12) ==

// Aggregate the FND_MCP_SLIM_DEBUG JSONL log (M6/M8) into a ≤ 40-line plain-text summary (34 lines with
// every optional section populated): totals — labelled with the collection level, which decides what they
// can be compared to — counts per decision / reason / stage, the top HOOK tools by bytes saved (CLI runs
// are keyed by file path, not tool name — they get one aggregate line), per-project subtotals, the count
// of DISTINCT spill files left on disk, and the MISSED-WHALE list — `platform-overflow` events (the hook's
// tag for a result the platform spilled to a tool-results file before the hook could see it) that no later
// `entry:"cli"` run AND no `entry:"access"` read (hooks/spill-access.sh) ever touched, i.e. the whale
// nobody ever opened at all. Pure over an array of raw lines (`opts.file`/`bytes` only decorate the
// header), so tests feed a synthetic log and the CLI feeds a real one.
const REPORT_TOP_TOOLS = 5;
const REPORT_TOP_PROJECTS = 5;
const REPORT_MISSED = 8;

function fmtCounts(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(' · ');
}

function buildReport(lines, opts) {
  const o = opts || {};
  const since = o.since ? Date.parse(o.since) : null;
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    if (!String(line).trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { skipped++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { skipped++; continue; }
    if (since != null && !(Date.parse(r.ts) >= since)) continue;
    events.push(r);
  }
  // An `entry:"access"` line (hooks/spill-access.sh) is not a compression event: it measures that a
  // tool READ a spill. It carries no bytes, no decision and no stages, so every aggregate below runs
  // over `comp` and the access lines are only counted on their own line and paired as recoveries —
  // a log written before the hook existed therefore reports exactly the numbers it always did.
  const access = events.filter((e) => e.entry === 'access');
  const comp = events.filter((e) => e.entry !== 'access');
  const out = [`json-slim: debug-log report — ${o.file || '(stdin)'}`];
  const stamps = events.map((e) => e.ts).filter(Boolean).sort();
  // The header counts the whole window; every aggregate below counts `comp`. Naming the split on the
  // line is what keeps the two populations reconcilable (`140 events` vs `100 events here came from…`).
  out.push(`  log: ${o.bytes != null ? `${o.bytes} B, ` : ''}${events.length} events` +
    `${access.length ? ` (${access.length} spill read${access.length === 1 ? '' : 's'})` : ''}` +
    `${skipped ? ` (+${skipped} unparseable)` : ''}` +
    `${stamps.length ? `, ${stamps[0]} → ${stamps[stamps.length - 1]}` : ''}` +
    `${o.since ? `  [since ${o.since}]` : ''}`);
  if (!events.length) { out.push('  no events in range.'); return out.join('\n'); }

  const decisions = new Map(), reasons = new Map(), stages = new Map(), tools = new Map(), projects = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // Access lines are the only population that can survive a window with no compression in it (a session
  // that read spills and made no MCP call), and the body below is all bytes and decisions — rendering it
  // over an empty `comp` printed a bare `decisions:` line and a headerless `projects:` block.
  let spillReads = '';
  if (access.length) {
    const vias = new Map();
    for (const e of access) bump(vias, e.via || 'other');
    spillReads = `  spill reads (access hook): ${access.length}  (via: ${fmtCounts(vias)})`;
  }
  if (!comp.length) { out.push('  no compression events in range.', spillReads); return out.join('\n'); }
  // What an event actually saved — only a `compressed`/`stubbed` decision shrank anything, whatever a
  // passthrough happened to log as bytes_out. One `shrunkOf` predicate, shared by the totals and
  // `savedOf`; `savedOf` feeds the per-tool/project/cli aggregates and the recovery pairing below.
  const shrunkOf = (e) => e.decision === 'compressed' || e.decision === 'stubbed';
  const savedOf = (e) => (shrunkOf(e)
    ? Math.max(0, (Number(e.bytes_in) || 0) - (Number(e.bytes_out) || 0)) : 0);
  // A whole-file re-dump: the run printed the file back into context with no reduction. The designed
  // low-context recoveries are excluded by the marks their lines carry — a `--jq` narrowing, a JSONL
  // profile (`profile`), a Gate-A capped summary (`spill_out`), the path handbacks and the stream
  // refusals (by `reason`) — none of which put the payload back, whatever bytes_out they logged (a
  // handback line records bytes_out == bytes_in although it printed a ~120 B path line).
  // B2: the two re-run guards answer with ONE line and never print the body, so they are not dumps
  // either — and they are counted on the cli line, because "how often did the guard fire" is the measure
  // of the re-run tax it exists to remove.
  const REFUSED_RERUN = new Set(['already-slim-out', 'no-gain-memo']);
  // `jq-unsupported` joins them: that run never read a body at all — it refused an out-of-grammar
  // filter on the argument line — so counting it as a re-dump would report context cost nobody paid.
  const NOT_A_DUMP = new Set(['non-json', 'transform-error', 'error-shape', 'big-nonjsonl', 'stream-jq-refused', 'jq-unsupported', ...REFUSED_RERUN]);
  const flatOf = (e) => !savedOf(e) && !e.narrowed && !e.profile && !e.spill_out && !NOT_A_DUMP.has(e.reason);
  let bytesIn = 0, bytesOut = 0;
  const cli = { n: 0, in: 0, saved: 0, flat: 0, memo: 0 };
  const spills = { paths: new Set(), events: 0, capped: 0 };
  // Collection level (B4.11), read off the line rather than guessed: 1 = sub-gate events were dropped,
  // so this event's siblings are missing from the totals; ≥2 or absent (a pre-B4.11 line, which recorded
  // them even at 1) = the window is complete.
  let lvl1 = 0, lvlFull = 0;
  for (const e of comp) {
    const bi = Number(e.bytes_in) || 0;
    const bo = Number(e.bytes_out) || 0;
    // A `stubbed` event (M12b) shrank the payload as surely as a compressed one — the model got a
    // ~1 KB stub instead of the whale — so it counts toward the savings, and its `reason` names the
    // branch it replaced, not a passthrough (it is listed on its own line below).
    const shrunk = shrunkOf(e);
    bytesIn += bi;
    bytesOut += shrunk ? bo : bi; // a passthrough saved nothing, whatever it logged as bytes_out
    if (Number(e.lvl) === 1) lvl1++; else lvlFull++;
    bump(decisions, e.decision || 'unknown');
    if (!shrunk) bump(reasons, e.reason || 'unknown');
    for (const s of Array.isArray(e.stages) ? e.stages : []) bump(stages, s);
    const saved = savedOf(e);
    // A CLI event's `tool` is the FILE it ran on, not an MCP tool name — ranking those together
    // would let a handful of whale files crowd every MCP tool out of the top-5 and would double-count
    // the notice and the CLI run of the same whale. CLI work is aggregated on its own line instead.
    // `flat` (flatOf above) — counted so a followed-but-useless recovery is visible instead of reading
    // as savings-neutral work.
    if (e.entry === 'cli') { cli.n++; cli.in += bi; cli.saved += saved; if (flatOf(e)) cli.flat++; if (REFUSED_RERUN.has(e.reason)) cli.memo++; } else {
      const tk = e.tool || '(stdin)';
      const t = tools.get(tk) || { saved: 0, n: 0 };
      t.saved += saved; t.n++; tools.set(tk, t);
    }
    const p = projects.get(e.project || '(unknown)') || { saved: 0, n: 0 };
    p.saved += saved; p.n++; projects.set(e.project || '(unknown)', p);
    // B4.10a: which files the run left on disk — the anchor for the orphan question, since a
    // stubbed/passed-through event's crush spills are exactly the files nobody will ever read. Paths are
    // DEDUPED across events: names are content-addressed, so repeat traffic names the same file from many
    // events, and summing the per-event lists would report the dedup factor as a file count (the live
    // week that motivated the change: 1030 names for 23 payloads). A capped line contributes the paths it
    // still names plus an upper bound (`spills_n`) for the ones it dropped.
    const listed = Array.isArray(e.spills) ? e.spills.filter((s) => typeof s === 'string' && s) : [];
    if (listed.length) {
      spills.events++;
      for (const s of listed) spills.paths.add(s);
      const total = Number(e.spills_n) || 0;
      if (total > listed.length) spills.capped += total - listed.length;
    }
  }
  const pct = bytesIn ? (100 * (1 - bytesOut / bytesIn)).toFixed(1) : '0.0';
  // The totals % changes MEANING with the collection level — level 1 omits the sub-gate lines, which are
  // the in==out ballast — so the level it came from is stated on the line itself, and a log that straddles
  // the switch is called out rather than averaged into one number nobody can compare.
  const levelTag = lvl1 && lvlFull
    ? `  [MIXED levels: ${lvl1} at =1 (sub-gate omitted) + ${lvlFull} complete — this % is not comparable]`
    : lvl1 ? '  [level 1 — sub-gate results not logged, so this % covers logged events only]' : '';
  // Totals and the per-project subtotals deliberately span BOTH entries — they answer "what did the
  // plugin save", hook and CLI alike. Only the RANKING is hook-only, because a cli `tool` is a path.
  out.push(`  totals: ${bytesIn} → ${bytesOut} B (${pct}% saved)${levelTag}`);
  out.push(`  decisions: ${fmtCounts(decisions)}`);
  if (reasons.size) out.push(`  passthrough reasons: ${fmtCounts(reasons)}`);
  if (stages.size) out.push(`  stages: ${fmtCounts(stages)}`);

  const topTools = [...tools.entries()].filter(([, t]) => t.saved > 0).sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_TOOLS);
  out.push('  top tools by bytes saved (hook):');
  if (!topTools.length) out.push('    (no hook compressions)');
  for (const [name, t] of topTools) out.push(`    ${t.saved} B over ${t.n} call${t.n === 1 ? '' : 's'} — ${name}`);
  if (cli.n) out.push(`  cli runs: ${cli.n} · saved ${cli.saved} B (${cli.in ? (100 * cli.saved / cli.in).toFixed(1) : '0.0'}%)` +
    `${cli.flat ? ` · ${cli.flat} gained nothing (the file went into context for no reduction)` : ''}` +
    `${cli.memo ? ` · ${cli.memo} refused by the no-gain/slim-out guard (no body printed)` : ''}`);
  const topProjects = [...projects.entries()].sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_PROJECTS);
  out.push('  projects:');
  for (const [name, p] of topProjects) out.push(`    ${name}: ${p.n} event${p.n === 1 ? '' : 's'}, ${p.saved} B saved`);

  if (spillReads) out.push(spillReads);

  // Missed whales: pair each platform-overflow event with a LATER cli run over the same spill path
  // (the M7 instruction being followed). Basenames are compared too, so an equivalent path spelling
  // still pairs. Unpaired = the compressor never ran on that whale — the two-lever evidence number.
  // Content addressing does NOT reach this count: a platform-overflow `spill` is the PLATFORM's own
  // tool-results file, not one of our hash names, so no two of these events share a path.
  // A `jq-unsupported` refusal is not a recovery either: it read no body and printed nothing, so
  // pairing it with a whale would drop that whale out of the count this number exists to give.
  const cliRuns = comp.filter((e) => e.entry === 'cli' && e.tool && e.reason !== 'jq-unsupported')
    .map((e) => ({ at: Date.parse(e.ts) || 0, tool: String(e.tool), via: 'json-slim', flat: flatOf(e) }));
  // …and a spill READ recovers the whale just as well: three targeted `jq` queries over a
  // tool-results file is the right move, and counting it as a miss is what this line was reporting
  // before the access hook existed. `via` names which tool got there, never a byte count.
  // …with one exception: `via:"named"` is the hook's mark for a command that only touched the NAME
  // (`rm`/`mv`/`ls`/`echo` …). Those bytes never entered a context, so pairing one would clear a whale
  // from the very count this line exists to give — a post-session `rm <spill>` would report full recovery.
  const accessRuns = access.filter((e) => e.spill && e.via !== 'named')
    .map((e) => ({ at: Date.parse(e.ts) || 0, tool: String(e.spill), via: String(e.via || 'other'), flat: false }));
  const runs = cliRuns.concat(accessRuns);
  // Indexed by basename once, and memoized per (event ts × path): access lines are the most frequent
  // line the log holds and `recoveries` is called ~3× per overflow/stub, so the linear scan this used to
  // be turned a 5 MB log into a 12 s `--report`. A path equal to `spill` shares its basename, so the
  // bucket subsumes the exact-path test.
  const runsByBase = new Map();
  for (const c of runs) {
    const b = path.basename(c.tool);
    const bucket = runsByBase.get(b);
    if (bucket) bucket.push(c); else runsByBase.set(b, [c]);
  }
  const recCache = new Map();
  // The runs that could be the recovery for this event: same spill path, not earlier. Empty = nobody
  // read it (an event whose path we could not extract is not provably handled either).
  const recoveries = (e) => {
    const spill = e.spill ? String(e.spill) : null;
    if (!spill) return [];
    const at = Date.parse(e.ts) || 0;
    const key = `${at}|${spill}`;
    const hit = recCache.get(key);
    if (hit) return hit;
    const found = (runsByBase.get(path.basename(spill)) || []).filter((c) => c.at >= at);
    recCache.set(key, found);
    return found;
  };
  const unpaired = (e) => recoveries(e).length === 0;
  const overflows = comp.filter((e) => e.reason === 'platform-overflow');
  const missed = overflows.filter(unpaired);
  out.push(`  missed whales (platform-overflow never read by any tool): ${missed.length} of ${overflows.length}`);
  for (const e of missed.slice(0, REPORT_MISSED)) out.push(`    ${e.ts || '(no ts)'}  ${e.tool || '(unknown tool)'}  →  ${e.spill || '(no path)'}`);
  if (missed.length > REPORT_MISSED) out.push(`    …(+${missed.length - REPORT_MISSED} more)`);
  // M12b: stubbed results are NOT missed whales — the hook already replaced the payload with a stub
  // carrying the spill path and the CLI command, so an unused stub is a model choice (shown for
  // curiosity), not a gap in the pipeline. A FOLLOWED stub is not automatically a win either: a stub's
  // `spill` IS one of our content-addressed names, so two identical stubbed payloads name the same file
  // and one CLI run pairs both (that much optimism is real here), and a run that reduced nothing put the
  // payload into context anyway — reported separately, or "0 unfollowed" would read as full compliance.
  const stubbed = comp.filter((e) => e.decision === 'stubbed');
  if (stubbed.length) {
    const stubReasons = new Map();
    for (const e of stubbed) bump(stubReasons, e.reason || 'unknown');
    const flatFollowUp = stubbed.filter((e) => recoveries(e).some((c) => c.flat)).length;
    out.push(`  stubbed (spill-and-stub guard): ${stubbed.length} (${fmtCounts(stubReasons)}), ${stubbed.filter(unpaired).length} never read` +
      `${flatFollowUp ? `, ${flatFollowUp} whose run gained nothing` : ''}`);
  }
  // Which tool actually got to each whale — the follow-up question the missed count raises, and the
  // one the access hook exists to answer. Each whale counts once per DISTINCT via among its
  // recoveries, so two jq reads of one spill are one jq recovery, not two.
  const recoveryVias = new Map();
  for (const e of overflows.concat(stubbed)) {
    for (const v of new Set(recoveries(e).map((c) => c.via))) bump(recoveryVias, v);
  }
  if (recoveryVias.size) out.push(`  whale recoveries via: ${fmtCounts(recoveryVias)}`);
  if (spills.events) {
    out.push(`  spill files: ${spills.paths.size} named by ${spills.events} event${spills.events === 1 ? '' : 's'}` +
      `${spills.capped ? ` (+ up to ${spills.capped} more the capped lines did not name)` : ''}`);
  }
  // Honesty, not a fix: at level 1 the sub-gate lines are never recorded, so `totals` and the call
  // counts speak about LOGGED events. Missed whales, stubbed and the per-stage counts are unaffected —
  // those events are logged at every level. Read off `lvl`, so a =2 log gets no caveat and a level-1 log
  // keeps it even when a foreign `size-gate` line from another project shares the file.
  if (lvl1) {
    out.push('  note: sub-gate results (≤4 KB, reason size-gate) are logged only at FND_MCP_SLIM_DEBUG=2 — ' +
      `${lvl1} of ${comp.length} events here came from level 1, so totals and call counts cover logged events.`);
  }
  return out.join('\n');
}

module.exports = {
  slim, crush, crushValue, parseJsonl, unwrapFence, findOpeningFence,
  blockText, soleBlockText, envelopeInner, // M14: the pure text-block envelope rail (purity gate + inner payload)
  detectJsx, compressJsx, foldSiblings, // M13: the Figma design-context (jsx) stage
  normalizeJqPath, jqAvailable, parseJqExpr, jqExprWhole, evalJqExpr, JQ_GRAMMAR_HINT, // M15: the supported --jq grammar + its evaluator
  buildReport, shapeHint,
  classifyArray, computeOptimalK, analyseDictArray, isErrorShape, numberPrecisionLoss,
  adfStage, noiseStage, truncateStage, toonStage,
  sweepSpills, sweepPlaywrightOut, ensureFndTmpExcluded, PLAYWRIGHT_OUT_REL, spillTtlHours, spillRoot, writeSpill,
  whaleGuidance, whaleReminder, whaleGuideEnabled, whaleGuideFullBlock, whaleGuideStamp, whaleGuideStatePath,
  nogainMemoEnabled, nogainMemoHit, nogainStamp, nogainStatePath, nogainRefusal, // B2: the re-run guards' state
  debugLog, debugEnabled, debugLevel,
  capOutput, streamProfile, profileLines,
  detectLog, compressLog, // M10: re-exported from log-slim.cjs for callers/tests
  DEFAULTS,
};

// -------------------------------------------------------------------------------- CLI --

if (require.main === module) {
  // CLI runs only — as a module the caller (mcp-slim) has already loaded the env files, and a
  // library require must not mutate process.env as a side effect.
  try { require('./env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps (env > project > global)

  // A downstream `| head` closes stdout mid-write; the EPIPE (Windows: `code: 'EOF'`)
  // surfaces async and would crash the process AFTER the consumer got its bytes.
  // Reader-side truncation is success — exit quietly; other stream errors still throw.
  // The pending stamp callback keeps the loop alive long enough for the error to be
  // delivered at all — hence this guard; the stamp itself is safe (see emitProfile).
  const quietOnEpipe = (s) => s.on('error', (e) => { if (e && (e.code === 'EPIPE' || e.code === 'EOF')) process.exit(0); throw e; });
  quietOnEpipe(process.stdout);
  quietOnEpipe(process.stderr);
  const t0 = Date.now();
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const opt = (f) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const isStdinPath = (p) => p === '/dev/stdin' || p === '/dev/fd/0' || p === '/proc/self/fd/0';
  const fileArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--jq' && args[i - 1] !== '--report' && args[i - 1] !== '--since');
  let jq = opt('--jq');
  // The --jq expression, parsed once (see the grammar above). An empty segment list — `.` / `..` —
  // is the IDENTITY selector: it addresses the WHOLE value, not a single row/field. On a JSONL file
  // that means "the whole file", which must PROFILE like a no-jq run, never crush the reshaped array.
  // An unsupported expression is neither, and is refused below before any body is read.
  const jqExpr = jq ? parseJqExpr(jq) : null;
  const jqIdentity = jqExpr !== null && jqExpr.identity === true;
  // The OTHER spellings of "the whole file" — `.[]`, `. | .`, `., .` … (see jqExprWhole for the rule).
  const jqWhole = jqExpr !== null && jqExprWhole(jqExpr);
  // A real NARROWING (`--jq <jq-path>`, not a whole-document selector, which re-dumps the value it was
  // given): the run answers a sub-path instead of the file. Hoisted above the guards below because
  // narrowing is the documented recovery AFTER a decline — the one thing they must never refuse. Read
  // further down by the handback gates and the debug line, so a whole-document re-dump is counted as the
  // re-dump it is instead of hiding behind `narrowed:true`.
  let narrowed = jqExpr !== null && !jqWhole;

  // --report [logfile] [--since <ISO>] (M12): aggregate the FND_MCP_SLIM_DEBUG log instead of
  // compressing anything. Runs before every input path — it reads the log, not a payload — and logs
  // nothing itself, so reading the report never becomes an event in the report.
  if (has('--report')) {
    const logPath = opt('--report') || path.join(spillRoot(null), DEBUG_LOG);
    const since = opt('--since');
    if (since && Number.isNaN(Date.parse(since))) {
      process.stderr.write(`json-slim: --since: not a parseable date: ${since}\n`);
      process.exit(1);
    }
    let text, bytes = null;
    try { text = fs.readFileSync(logPath, 'utf8'); bytes = fs.statSync(logPath).size; } catch (e) {
      process.stderr.write(`json-slim: no debug log at ${logPath} (set FND_MCP_SLIM_DEBUG=1 to record one): ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(buildReport(text.split('\n'), { file: logPath, bytes, since }) + '\n');
    return;
  }

  // An expression outside the supported grammar is a USAGE error, not a miss: answering it with the
  // M12 `null` told the reader their jq had RUN and found nothing, so they re-ran with guessed plain
  // paths (3–7 CLI runs per question in the field). Empty stdout, one named diagnostic, exit 2 —
  // before any body is read, so no pipeline runs and nothing is spilled. Its own debug reason keeps
  // `--report` from counting a refusal that printed no body as a run that "gained nothing".
  if (jqExpr && jqExpr.bad) {
    process.stderr.write(`json-slim: --jq: unsupported jq syntax near '${jqExpr.bad}' — supported: ${JQ_GRAMMAR_HINT}, ` +
      `quoted as one argument ('.a, .b'). For full jq run:\n` +
      `  node json-slim.cjs <file> --jq '<supported-path>' | jq '<rest of your expression>'\n`);
    debugLog({ entry: 'cli', tool: fileArg || null, decision: 'passthrough', reason: 'jq-unsupported', bytes_in: 0, bytes_out: 0, pct: 0, stages: [], spill: null, spill_out: null, ms: Date.now() - t0 }, null);
    process.exit(2);
  }

  const cfg = {};
  if (has('--toon')) cfg.toon = true;
  if (has('--no-spill')) cfg.enableMarker = false;
  // M14 — the envelope rail's CLI switch, decided ONCE for the three places it acts (slim()'s unwrap,
  // the `--jq` fallback, the JSONL diversion): the pipeline default, minus the IDENTITY selector.
  // `--jq .` is the "re-dump everything" spelling, so it keeps dumping the document it was given,
  // envelope and all — answering it with the payload instead would make identity mean two different
  // things depending on the file's shape. Mirrored into cfg so slim() reads the same decision; a
  // NARROWING `--jq` keeps the rail for its own fallback walk and then clears cfg (see the walk below),
  // because a value the caller addressed by path must not be unwrapped a second time underneath them.
  const envelopeRail = DEFAULTS.envelope && !jqIdentity;
  if (!envelopeRail) cfg.envelope = false;

  // Flags that change what the pipeline can PRODUCE: `--toon` is the squeeze-harder re-serialization,
  // `--no-spill` takes the crush's row offload away. A decline under one pipeline says nothing about
  // another, in either direction — so no B2 refusal may speak for such a run, and such a run may not
  // record a memo for the plain one. Derived from cfg, so a new pipeline flag is caught by adding it
  // above rather than by remembering a second list.
  const pipelineFlags = cfg.toon === true || cfg.enableMarker === false;
  // Every spill this run writes lands here (crush markers, the jsx id map, Gate A's body) and rides on
  // the exit line. Passed IN rather than returned: the catch around slim() below builds a synthetic
  // result and would otherwise lose the paths of files already written before the throw.
  const spills = [];
  cfg.spillSink = spills;

  // B2 — the two re-run guards, before ANY body is read (a refusal that first slurps the file has
  // already paid the cost it exists to avoid). FILE runs only: a stdin stream has no identity to
  // recognize or remember, so those paths are untouched. A NARROWING `--jq` bypasses both — it is the
  // documented recovery after a decline and answers a sub-path, not the file. So does `--stats`: that
  // is a MEASUREMENT run, and mcp-whale.md promises it reports the 0.0 % — a refusal would answer it
  // with no measurement at all. So do the pipeline flags (see pipelineFlags). FND_NOGAIN_MEMO=0 turns
  // BOTH refusals off, which is the escape hatch each of them names. Both print ONE line and exit 0:
  // a refusal is not an error, and a non-zero exit would read as "json-slim broke".
  if (fileArg && !narrowed && nogainMemoEnabled() && !pipelineFlags && !has('--stats')) {
    let sz = -1;
    try { sz = fs.statSync(fileArg).size; } catch (_) {} // unreadable → no guard; the normal read below reports it
    // Layer 1 — our own Gate-A output spill (see SLIM_OUT_PREFIX for why no other prefix qualifies).
    // Bounded by the stream gate: past it the file belongs to Gate B, whose big-doc/profile guidance
    // (`head -c`, split into rows) is the only usable advice for a file json-slim will not load whole —
    // this refusal's `--jq` hint would send the reader straight into streamJqRefusal.
    if (sz >= 0 && sz <= DEFAULTS.streamGateBytes && path.basename(fileArg).startsWith(SLIM_OUT_PREFIX)) {
      const notice = slimOutRefusal(fileArg, sz) + '\n';
      process.stdout.write(notice);
      debugLog({ entry: 'cli', tool: fileArg, decision: 'passthrough', reason: 'already-slim-out', bytes_in: sz, bytes_out: Buffer.byteLength(notice, 'utf8'), pct: 0, stages: [], spill: null, spill_out: null, ms: Date.now() - t0 }, cfg.spillDir);
      sweepSpills(cfg.spillDir, process.cwd());
      return;
    }
    // Layer 2 — this session already printed THIS file back unchanged and it has not changed since.
    const memoBytes = sz >= 0 ? nogainMemoHit(cfg.spillDir, fileArg) : null;
    if (memoBytes !== null) {
      const notice = nogainRefusal(fileArg, memoBytes) + '\n';
      process.stdout.write(notice);
      debugLog({ entry: 'cli', tool: fileArg, decision: 'passthrough', reason: 'no-gain-memo', bytes_in: memoBytes, bytes_out: Buffer.byteLength(notice, 'utf8'), pct: 0, stages: [], spill: null, spill_out: null, ms: Date.now() - t0 }, cfg.spillDir);
      sweepSpills(cfg.spillDir, process.cwd());
      return;
    }
  }

  // Gate B (M9b) — a file past the stream gate is PROFILED line-by-line, never loaded whole; a
  // readFileSync + per-row JSON.parse of a multi-GB JSONL would OOM. CLI-only: MCP results never
  // reach this size (the platform truncates far earlier), so the mcp-slim hook is untouched.
  if (fileArg) {
    let sz = -1;
    try { sz = fs.statSync(fileArg).size; } catch (_) {}
    if (sz > DEFAULTS.streamGateBytes) {
      if (jq) {
        // --jq would re-read the whole gigabyte to walk one path — refuse and point at line tools.
        process.stdout.write(streamJqRefusal(fileArg, sz) + '\n');
        debugLog({ entry: 'cli', tool: fileArg, decision: 'passthrough', reason: 'stream-jq-refused', bytes_in: sz, bytes_out: 0, pct: 0, stages: [], spill: null, spill_out: null, ms: Date.now() - t0 }, cfg.spillDir);
        sweepSpills(cfg.spillDir, process.cwd());
      } else {
        // M11: a >8 MB file may be a fenced JSONL whale (tool prose + ```jsonl…``` around the rows).
        // Peek the head (bounded — never loads the file whole) for an opening fence in the first
        // fencePreambleMax lines; if found, stream-profile the BODY only (skip the wrapper) and thread
        // the line offset so the guidance's readline loader tolerates the wrapper lines and the sed hint
        // states the offset — the SAME offset-correctness the ≤8 MB unwrap path already has.
        let skipLeading = 0;
        if (DEFAULTS.fence) {
          const head = peekHeadLines(fileArg, DEFAULTS.fencePreambleMax + 1, 65536);
          const oi = findOpeningFence(head, DEFAULTS.fencePreambleMax);
          if (oi !== -1) skipLeading = oi + 1;
        }
        streamProfile(fileArg, cfg, { skipLeading, fenceAware: skipLeading > 0 })
          .then((profile) => emitProfile(profile, fileArg, sz, t0, cfg, skipLeading))
          .catch((e) => { process.stderr.write('json-slim: profile failed: ' + e.message + '\n'); process.exit(1); });
      }
      return; // scheduled (async) or done (sync) — never fall through to the load-whole-file path
    }
  }

  let raw;
  try { raw = fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8'); } catch (e) {
    process.stderr.write('json-slim: cannot read input: ' + e.message + '\n');
    process.exit(1);
  }
  // What arrived, kept because the `--jq` walk below REPLACES `raw` with a re-serialization of the
  // selected value. For a real narrowing that re-serialization IS what the stages consume, so it is the
  // right recovery copy — but a WHOLE-document selector narrows nothing while still re-serializing, and a
  // piped JSONL stream then collapses into one array line: the copy the run calls "the original" would
  // hold none of the line boundaries its own guidance tells the reader to address.
  const stdinBytes = raw;

  // M14 §M1.5's emit, shared by the plain run and the `--jq` divert below — ONE spelling of the
  // spill + stderr note + profile, so the two entry points cannot drift. Returns false on a failed
  // spill write, and the caller falls through to its normal path (recipes that cannot run are worse
  // than a decline). `envBytes` is the ENVELOPE's size — the debug line speaks about the argument.
  const envelopeJsonlProfile = (innerText, envBytes) => {
    const s = writeSpill(cfg.spillDir, 'fnd-mcp-slim-', innerText);
    if (!s) return false;
    noteSpill(cfg, s.path, s.created);
    const innerBytes = Buffer.byteLength(innerText, 'utf8');
    process.stderr.write(`${ENVELOPE_NOTE} — the rows profiled below are the inner payload, spilled to ${s.path} (${innerBytes} B); ${fileArg} is the envelope.\n`);
    emitProfile(profileLines(innerText.split('\n'), { file: s.path, bytes: innerBytes }, cfg), s.path, envBytes, t0, cfg, 0,
      { tool: fileArg, stages: ['envelope'], spills, spill: s.path });
    return true;
  };

  // A JSONL FILE (≤ the stream gate, no --jq) is NEVER compressed — it PROFILES, exactly like Gate B.
  // parseJsonl is the strict detector (≥2 lines, each a JSON object/array): a regular JSON document
  // fails it on line 1 and slims below; a truncated/prose file also declines and falls to the non-json
  // handback. Detecting BEFORE slim keeps crush from ever running on a JSONL file — so no fnd-crush-*
  // and no fnd-slim-out spill is ever written for it. STDIN never profiles (no on-disk original to
  // point the guidance at) — it keeps flowing through the pipeline below. EVERY spelling that selects the
  // whole document (`jqWhole`: `.`, `.[]`, `. | .`, `., .` …) counts as "no narrowing" here and profiles
  // too — otherwise the walk leaves the whole reshaped array and slim() would crush + spill it (a JSONL
  // body, contract-forbidden), or hand a multi-select's N copies of it straight back.
  if (fileArg && (!jq || jqWhole)) {
    const bytes = Buffer.byteLength(raw, 'utf8');
    let feed = null, offset = 0;
    if (parseJsonl(raw)) { feed = raw.split('\n'); }
    else if (DEFAULTS.fence) {
      // M11: a JSONL body wrapped in a dominant fence still PROFILES (never crushed, like any JSONL
      // file) — unwrap it and profile the body, threading the wrapper's line offset so the guidance's
      // sed/readline hints point at the right physical lines. slim()'s fence branch would instead
      // CRUSH it (correct for the hook), so the diversion must happen here, before slim() runs.
      const f = unwrapFence(raw, cfg);
      if (f && parseJsonl(f.body)) { feed = f.body.split('\n'); offset = f.offset; }
    }
    if (feed) {
      emitProfile(profileLines(feed, { file: fileArg, bytes }, cfg), fileArg, bytes, t0, cfg, offset);
      return;
    }
    // M14 §M1.5 — the spill of an MCP text-block envelope whose payload is a JSONL row stream. It
    // still PROFILES (JSONL is never crushed), but the envelope file cannot be the file the recipes
    // address: its "lines" are one escaped string, so `sed -n '<N>p'` on it returns the whole payload
    // or nothing. Spill the unwrapped body and point the profile at THAT (the Gate-A precedent) — the
    // debug line keeps naming the argument, so `--report`'s whale pairing is unaffected, and carries
    // both the `envelope` stage tag and the file just written — the spill inventory (B4.10a) is what
    // makes a stray recovery spill visible, and this branch is a writer. Gated on a SOLE text block:
    // the "rows" of a joined multi-block envelope are its blocks, not a stream (see soleBlockText). A
    // failed spill write falls through to the normal path rather than printing recipes that cannot run.
    // Unconditional on `--no-spill` for capOutput's reason: without the file there is nothing the
    // sed/grep recipes could address, so the flag would buy silence at the price of the answer.
    // The head sniff keeps the second full JSON.parse off every ordinary document: only a payload
    // whose first bytes can open a content-block envelope pays for the probe, and slim() parses the
    // rest ~30 lines later anyway. Permissive on purpose — a false positive costs one parse, while a
    // false negative would cost the divert itself.
    if (envelopeRail && ENVELOPE_HEAD_SNIFF.test(stripBom(raw).slice(0, 64))) {
      let doc = null;
      try { doc = JSON.parse(stripBom(raw)); } catch (_) {}
      const innerText = doc === null ? null : soleBlockText(doc);
      if (innerText !== null && parseJsonl(innerText) && envelopeJsonlProfile(innerText, bytes)) return;
    }
  }

  // The round-trip gate belongs on the ORIGINAL text here, not on slim()'s input: the walk below
  // re-serializes the PARSED document, so a number JSON.parse could not carry is already rewritten by
  // the time slim() sees it and the narrowed value would be handed back silently wrong — on the very
  // path the whale stub tells the model to use. Drop the narrowing; the plain route below then declines
  // the whole body with the same notice a file run gives.
  // The scan has to run on the text the EVALUATOR consumes, which for an MCP text envelope is the
  // payload inside `[0].text`: there the outer scan sees one escaped string literal and walks straight
  // past a 19-digit id, and the rail below then re-runs the whole expression against that inner
  // document and hands the rounded value back. Same sniff-then-parse gate the JSONL divert above uses,
  // so an ordinary document pays nothing for it.
  let jqNumberDeclined = !!jq && numberPrecisionLoss(stripBom(raw));
  if (jq && !jqNumberDeclined && envelopeRail && ENVELOPE_HEAD_SNIFF.test(stripBom(raw).slice(0, 64))) {
    let doc = null;
    try { doc = JSON.parse(stripBom(raw)); } catch (_) {}
    const innerText = doc === null ? null : soleBlockText(doc);
    // Only an inner DOCUMENT is re-parsed by the rail — log or prose text keeps its digits verbatim.
    const innerIsDoc = innerText !== null && (() => { try { JSON.parse(stripBom(innerText)); return true; } catch (_) { return !!parseJsonl(innerText); } })();
    if (innerIsDoc && numberPrecisionLoss(innerText)) jqNumberDeclined = true;
  }
  if (jqNumberDeclined) { jq = null; narrowed = false; }
  // --jq <jq-path>: narrow before slimming — the supported-grammar evaluator above, no jq dependency.
  if (jq) {
    let v;
    try { v = JSON.parse(stripBom(raw)); } catch (e) {
      // A JSONL file is a same-shape array — let `--jq 0.handle` address a row directly (M9).
      const rows = parseJsonl(raw);
      if (rows) v = rows;
      else {
        // M11: a fenced JSON/JSONL payload (tool prose + ```json…```) — unwrap the dominant fence and
        // narrow into its body so `--jq <jq-path>` works on the ORIGINAL wrapper file too, not only the
        // Gate-A spill. Without this, `--jq` on a fenced whale errored on the prose line.
        const f = DEFAULTS.fence ? unwrapFence(raw, cfg) : null;
        let fv;
        if (f) { try { fv = JSON.parse(f.body); } catch (_) { const fr = parseJsonl(f.body); if (fr) fv = fr; } }
        if (fv !== undefined) v = fv;
        else { process.stderr.write('json-slim: input is not valid JSON: ' + e.message + '\n'); process.exit(1); }
      }
    }
    // Evaluate the expression (parsed with the args above). stdout stays `null` for a path that
    // doesn't resolve (machine-friendly, unchanged), but a MISSING segment says so on stderr — the
    // deepest location that did resolve plus what is addressable there, so a typo is distinguishable
    // from a real null (M12). A value that genuinely IS null prints nothing. The diagnostics are BUILT
    // by the evaluator and written by the caller: which of the two documents (envelope or inner
    // payload) the reader needs to hear about is only known after the fallback below has had its turn.
    // M14 — the ENVELOPE is walked first, always: `--jq 0.text` addresses the transport on purpose and
    // must keep working. Only a miss on the FIRST segment says the path was never about this document
    // (a deeper miss IS about it — the prefix resolved here), and only then is the pure text-block
    // envelope reopened and the WHOLE EXPRESSION re-run against the payload inside it. A double miss
    // reports the INNER location: `length: 1` describes the wrapper the reader did not ask about,
    // while the payload's key list is what tells them which spelling to try next.
    let r = evalJqExpr(v, jqExpr);
    if (!r.ok && r.retryInner && envelopeRail) {
      const env = envelopeInner(v, cfg);
      if (env && numberPrecisionLoss(env.text)) {
        // The gate above scanned the file's own bytes and, for a BARE envelope, the text inside it. A
        // FENCED one only becomes `v` through the unwrap above, so this is the first place its payload
        // exists as text — and the walk about to run on it would answer with a rounded number.
        jqNumberDeclined = true;
      } else if (env) {
        const innerWalk = evalJqExpr(env.value, jqExpr);
        process.stderr.write(`${ENVELOPE_NOTE} — the path ${innerWalk.ok ? 'resolved inside' : 'was re-tried against'} the inner payload.\n`);
        r = innerWalk;
      } else if (fileArg) {
        // envelopeInner refuses a JSONL inner BY DESIGN (rows must profile, never slim), and a
        // dot-walk cannot answer for a row stream either — the contract forbids `--jq` on JSONL. So
        // the plain run's divert is the answer here too: line-addressable recipes against a spill of
        // the unwrapped body, instead of a `null` that describes the wrapper. Stdin keeps the miss
        // diagnostic below — a profile needs an on-disk argument for its recipes to name.
        const innerText = soleBlockText(v);
        if (innerText !== null && parseJsonl(innerText) && envelopeJsonlProfile(innerText, Buffer.byteLength(raw, 'utf8'))) return;
      }
    }
    // A decline discovered on the inner document lands here, after the walk was already set up: drop the
    // narrowing exactly as the pre-gate does and leave `raw` alone — the file's own bytes are the answer.
    if (jqNumberDeclined) { jq = null; narrowed = false; }
    else {
      for (const d of r.diags) process.stderr.write(d); // one per missed term — a multi-select misses per slot
      raw = JSON.stringify(r.value === undefined ? null : r.value); // a missed path yields null, never a crash
      // The rail has had its ONE turn on this run — slim() must not take a second. A narrowed value is
      // the answer to a path the caller wrote, and the two spellings that address the TRANSPORT resolve
      // on the envelope itself: without this, `--jq 0` (the block) came back as the unwrapped, noise-
      // stripped payload while `--jq 0.text` (the same block, one field deeper) came back verbatim — one
      // selector meaning two things depending on the shape underneath. A path that resolved through the
      // fallback above is already INSIDE the payload, so there is nothing left for the rail to unwrap.
      cfg.envelope = false;
      // An ENUMERATION — `| keys`, or a fan-out that answered with SCALARS — must come back whole: the
      // crush's string-array sampling would hand back a subset as if it were the list (a 21-key Jira
      // `fields` came back as 14 names, 40 comment dates as 15, no marker). Enumerations are cheap — a
      // list of names is a few KB — so they opt out of row sampling. Decided on the RESULT, not on the
      // spelling: `[]` anywhere in the expression also describes `.comments[]`, an array of OBJECTS and
      // the whale query the stub itself advertises, which exempted itself from the crush and degraded
      // an 832 KB answer to 0.0 % and a path handback. Arrays of objects crush like any other rows.
      const enumerated = jqExpr.terms.some((t) => t.ops[t.ops.length - 1] === 'keys')
        || (Array.isArray(r.value) && r.value.every((x) => x === null || typeof x !== 'object'));
      if (enumerated) cfg.minItemsToAnalyze = Infinity;
    }
  }

  // The same rail slimText gives the hook: a stage fault degrades to the path handback below instead
  // of killing the process — this IS the whale-recovery command the stub hands the model.
  let res;
  if (jqNumberDeclined) {
    // The gate has already read the whole body, envelope payload included. slim() would only re-find
    // that number when it sits at the TOP level: inside an envelope it is one escaped string literal, so
    // the run would compress AROUND it and report a reduction on a body that answers neither the path
    // the caller wrote nor the file. Hand the original back under the reason the notice below reads.
    const b = Buffer.byteLength(raw, 'utf8');
    res = { output: raw, wasModified: false, bytesIn: b, bytesOut: b, ratio: 0, reason: 'number-precision', stages: [] };
  } else {
    try { res = slim(raw, { ...cfg, trace: debugEnabled() }); } // trace only when the debug log will consume `stages`
    catch (_) {
      const b = Buffer.byteLength(raw, 'utf8');
      res = { output: raw, wasModified: false, bytesIn: b, bytesOut: b, ratio: 0, reason: 'transform-error', stages: [] };
    }
  }
  // The recovery net for STDIN. Every lossy branch below names the on-disk original, which a FILE
  // run already has; a stdin run had none, so `noise` (dropped fields) and `truncate` (clipped strings)
  // handed back the ONLY remaining copy of the input — the crush spill holds the dropped ROWS, not the
  // original. Spill it here, before anything is printed: content-addressed, so a re-run of the same
  // payload reuses one file. Under a NARROWING `--jq` the "original" is the narrowed value the stages
  // consumed — that is the complete undo for the body being printed, and a far smaller one than the whole
  // stream; a whole-document selector narrowed nothing, so the piped bytes are the copy (see stdinBytes)
  // — the same `jqWhole` the stderr label below reads, or the copy and its name would disagree.
  // A passthrough loses nothing and must never spill. `--no-spill` is the explicit opt-out.
  let stdinOriginal = null;
  if (!fileArg && res.wasModified && res.bytesOut < res.bytesIn && cfg.enableMarker !== false) {
    const s = writeSpill(cfg.spillDir, 'fnd-mcp-slim-', jqWhole ? stdinBytes : raw);
    if (s) { noteSpill(cfg, s.path, s.created); stdinOriginal = s.path; }
    else {
      // No recovery copy → hand the original back verbatim rather than a lossy body nothing can undo
      // (the rail hooks/mcp-slim.cjs takes on the same failure). Shaped like the transform-error
      // degrade above, so every branch below reports what was actually printed.
      const b = Buffer.byteLength(raw, 'utf8');
      res = { output: raw, wasModified: false, bytesIn: b, bytesOut: b, ratio: 0, reason: 'spill-write-failure', stages: res.stages || [] };
    }
  }
  const compressed = res.wasModified && res.bytesOut < res.bytesIn;
  // Hand the file path back — instead of re-dumping the whole (possibly whale-sized) file — for a
  // non-JSON file: never compressible, and a truncated/broken JSONL lands here too (parseJsonl already
  // declined it above, so it was not profiled). A non-JSON STDIN stream has no path to return, so it
  // still passes through below.
  // `transform-error` joins it: a stage that faulted compressed nothing, so the file is the answer.
  // `error-shape` too, but ONLY above the inline cap: an error envelope is a verbatim passthrough by
  // contract, so a whale-sized one pours the whole file back into context and Gate A would write a
  // full-size DUPLICATE of the file the caller already named, labelled `slimmed output`. Under the cap
  // the envelope IS the answer the caller came for — a 133 B "PERMISSION DENIED" hidden behind a path
  // costs a second Read to learn the run failed. Both carve out a narrowing `--jq` (`narrowed`, decided
  // with the args at the top of the CLI): that selects a sub-value the file path does not answer (same
  // test as the JSONL profile gate above).
  // `number-precision` follows the error-shape rule for the error-shape reason: nothing was attempted on
  // that body, so above the cap Gate A would spill a full-size DUPLICATE of the file the caller just
  // named and label it `slimmed output` at 0.0 %. Under the cap the payload is still the answer, printed
  // with its own notice. (`narrowed` is always false here — the decline drops the narrowing — so it is
  // not re-tested.)
  const handback = fileArg && (res.reason === 'non-json'
    || (res.reason === 'transform-error' && !narrowed)
    || (res.reason === 'number-precision' && res.bytesIn > DEFAULTS.cliOutCap)
    || (res.reason === 'error-shape' && res.bytesIn > DEFAULTS.cliOutCap && !narrowed));
  // M10 — a compressed LOG file: print the selected body (its own `[N lines omitted…]` trailer
  // included) + one line naming the on-disk original, which IS the recovery (profile-philosophy
  // consistent). Skips capOutput below — that gate is JSON-document-shaped, not log text.
  const logOut = res.logCompressed && fileArg;
  // Gate A (M9b) — a slimmed body over the inline cap is spilled + summarized, not dumped: one huge JSON
  // document (JSONL files never reach here — they profiled upstream).
  const capped = (handback || logOut) ? null : capOutput(res, fileArg, cfg);
  // M13 — a compacted Figma body printed INLINE has no spill of the ORIGINAL (only its node-id map),
  // so name the on-disk original the way the log stage does. Over the cap, Gate A already names it.
  const jsxOut = res.jsxCompressed && fileArg && !capped;
  if (handback) {
    const why = { 'error-shape': 'error envelope', 'non-json': 'not JSON', 'transform-error': 'transform error', 'number-precision': 'number precision' }[res.reason];
    // A stdin device is not a path anyone can open again — the stream is spent, so "read the file
    // directly: /dev/stdin" is advice that cannot be followed. Name the shape of the recovery instead.
    const lead = `json-slim: nothing to compress (${why}); `;
    process.stdout.write(lead + (isStdinPath(fileArg)
      ? 'the payload came in on stdin — re-run json-slim on the file itself, or narrow it with --jq <jq-path>.\n'
      : `read the file directly: ${fileArg}\n`));
  } else if (logOut || jsxOut) {
    process.stdout.write(`${res.output}\noriginal: ${fileArg}\n`);
  } else if (capped) {
    process.stdout.write(capped.handback + '\n');
  } else {
    // A LOSSY body (noise-dropped fields, clipped strings, sampled rows) printed inline names the file
    // it came from — the same recovery pointer the log and jsx branches give. Only here: a passthrough
    // lost nothing, Gate A and the handback already name the file, and a stdin run has no path at all
    // (its stderr names the spilled copy instead). A `--jq` run is excluded too: its stdout is the
    // selected VALUE by contract (callers parse it), and the file does not hold that value anyway.
    // On STDERR, unlike the log and jsx branches: this branch's stdout is a JSON document a caller pipes
    // into jq (two suites parse it), and a trailing prose line would break every one of them. The log and
    // jsx bodies are not JSON, so their pointer can ride along on stdout.
    const nameOriginal = compressed && fileArg && jq == null && !isStdinPath(fileArg);
    process.stdout.write(`${res.output}\n`);
    if (nameOriginal && !res.envelopeUnwrapped) process.stderr.write(`json-slim: original: ${fileArg}\n`); // the M14 note below names it
    // B2 Layer 3 — this FILE run printed the file's own bytes back UNCHANGED, which is a deliberate
    // decline; in the field it read as a failed attempt and was immediately re-run on the same file. Say
    // it out loud, on stderr only: stdout stays the parseable body a caller can pipe, and both streams
    // reach the model. The predicate is literal, not merely "gained nothing": ANY `--jq` (including the
    // IDENTITY selector) prints a RE-SERIALIZED value — a pretty-printed file re-serializes smaller, so
    // `--jq .` can decline on bytes that a plain run would have shrunk by 20 % — and `wasModified` with
    // bytesOut ≥ bytesIn is a CHANGED body, not the file. Neither may claim "printed unchanged", and
    // neither may arm the memo for a run whose pipeline it never describes.
    // An `error-shape` envelope under the inline cap does stamp, deliberately: it is a verbatim
    // passthrough by contract, so a re-run has nothing to shrink either.
    // `number-precision` is carved out: nothing was ATTEMPTED on that body, so "no reduction possible"
    // would misreport it — and a memo saying "nothing to shrink" would outlive an edit of the payload.
    // Its own notice below names the real cause.
    if (fileArg && !compressed && jq == null && !res.wasModified && res.reason !== 'number-precision') {
      process.stderr.write(`json-slim: no reduction possible — ${res.bytesIn} B printed unchanged; this is a deliberate decline, not an error. ` +
        `Do NOT re-run json-slim on this file; read it directly or narrow with --jq <jq-path>.\n`);
      // …and remember it, so the NEXT run answers in one line instead of re-printing this body. Stamped
      // here, after the delivery (the whaleGuideStamp rule), never at the decision. Under the floor a
      // refusal would save too little to be worth remembering; under a pipeline flag the decline belongs
      // to that pipeline, not to the plain run the memo would refuse. (`--stats` DOES stamp — it is the
      // same pipeline, measured.)
      if (nogainMemoEnabled() && !pipelineFlags && res.bytesIn >= NOGAIN_FLOOR_BYTES) nogainStamp(cfg.spillDir, fileArg);
    }
  }
  // M14 — the body just printed is NOT this file's shape: the envelope and its escaping are gone, so a
  // reader diffing the two, or writing a `--jq` path from what they see, has to be told once. stderr,
  // like every other CLI notice; the ORIGINAL is named because the unwrapped body is not on disk.
  if (res.envelopeUnwrapped) {
    process.stderr.write(`${ENVELOPE_NOTE} — the slimmed body is the INNER payload, not the envelope` +
      `${fileArg ? `; the original stays at ${fileArg}` : ''}.\n`);
  }
  // On stderr, not appended to stdout: a stdin run's stdout is the machine-readable body a caller can
  // pipe (a fixture parses it), while both streams reach the model that invoked the CLI.
  // Under `--jq` that copy holds the NARROWED subtree the stages consumed — the complete undo for the
  // body being printed, but not the stream that was piped in; a caller told "the original" would read
  // it looking for one.
  if (stdinOriginal) process.stderr.write(`json-slim: ${narrowed ? 'narrowed input' : 'original'} spilled to ${stdinOriginal}\n`);
  else if (res.reason === 'spill-write-failure') process.stderr.write('json-slim: cannot write a recovery copy — passing the original through uncompressed\n');
  // "nothing was compressed", not "passed through": above the inline cap this run handed the path back
  // and printed no body at all, and the notice has to be true of both branches.
  if (res.reason === 'number-precision') {
    process.stderr.write(`json-slim: nothing was compressed${jqNumberDeclined ? ' and --jq was NOT applied' : ''} — this payload holds a number JSON.parse cannot round-trip ` +
      '(an exponent past ±1.8e308, or more than 15 significant digits); re-serializing it would silently change the value.\n');
  }
  if (has('--stats')) {
    process.stderr.write(`json-slim: ${res.bytesIn} → ${res.bytesOut} bytes (${(res.ratio * 100).toFixed(1)}% reduction)${res.error ? ' [error-shape passthrough]' : ''}\n`);
  }
  // Debug trace (opt-in FND_MCP_SLIM_DEBUG) — one JSONL line for this run; never touches stdout.
  debugLog({
    entry: 'cli',
    tool: fileArg || null,
    decision: compressed ? 'compressed' : 'passthrough',
    reason: compressed ? null : (res.reason || 'no-gain'),
    ...(res.format ? { format: res.format } : {}), // M8: set only on the non-json branch
    // B4.11: this run answered a SUB-PATH, so "reduced nothing" says nothing about context cost — it
    // printed one field, not the file. Without the flag `--report` counts a followed narrowing recovery
    // as the re-dump it exists to discourage.
    ...(narrowed ? { narrowed: true } : {}),
    bytes_in: res.bytesIn,
    bytes_out: res.bytesOut,
    pct: Math.round((res.ratio || 0) * 1000) / 10,
    stages: res.stages || [],
    spill: stdinOriginal, // the stdin recovery copy IS the handback this run gave the model (null for a file run, which hands back its own path)
    spill_out: capped ? capped.spillOut : null, // M9b Gate A: the fnd-slim-out-* spill (non-JSONL huge doc)
    spills, // B4.10a: every file this run wrote — deduped/capped in debugLog
    ms: Date.now() - t0,
  }, cfg.spillDir);
  // Spill hygiene at exit — prune stale spills (best-effort; never affects output or exit code).
  sweepSpills(cfg.spillDir, process.cwd());
}
