#!/usr/bin/env node
/*
 * json-slim.cjs — shape-driven compressor for large JSON (MCP tool results, saved dumps).
 *
 * Dual entry point (one home for the transform):
 *   - require()d as a module by the mcp-slim PostToolUse hook (M2) — { slim, crush, crushValue };
 *   - a standalone CLI to compress an already-saved dump on demand:
 *       node json-slim.cjs <file.json> [--jq <dot.path>] [--toon] [--no-spill] [--stats]
 *       cat big.json | node json-slim.cjs
 *       node json-slim.cjs --report [logfile] [--since <ISO>]   (aggregate the FND_MCP_SLIM_DEBUG log)
 *     A JSONL file is PROFILED, never compressed (stats + sample rows + line-scripting
 *     guidance, streamed above 8 MB); log-shaped text is signal-compressed (log-slim.cjs) with
 *     an `original: <path>` recovery line; other non-JSONL JSON output is capped at 48 KB
 *     (spill + handback).
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
 * pipeline with the preamble kept on top; JSONL rows re-enter as one array; log-shaped text goes to
 * log-slim.cjs's signal selection; anything else passes through.
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
  // --- fnd pipeline stages (slim only, not crush) ---
  adf: true, // stage 1: ADF doc nodes → markdown
  noise: true, // stage 3: drop nulls / empty containers / avatar-class keys
  dropRestLinks: true, // stage 3: drop `self` REST-navigation URLs (Jira/Confluence _links.self)
  truncate: true, // stage 4: clip base64 / data-URI / very long strings
  stringLimit: 200, // stage 4 threshold (chars)
  toon: false, // optional lossless tabular re-serialization of uniform arrays (behind a flag)
  jsonl: true, // detect a JSONL line stream (bulk-operation dump) → crush it as the same-shape array it is
  log: true, // M10: detect log/build-output TEXT → signal-select (errors/traces/summaries kept, spam deduped)
  fence: true, // M11: unwrap a DOMINANT markdown fence (tool prose + ```json…```) and re-run the pipeline on its body
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

function sha256hex12(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 12);
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

// Decide whether a dict array is worth crushing and which generic strategy applies.
// Returns { crushable, strategy, reason, signals:{errors,structural,anomalies,changePoints} }.
function analyseDictArray(items, cfg) {
  const n = items.length;
  const keys = unionKeys(items);

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

function spillPath(cfg) {
  const dir = spillRoot(cfg.spillDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return path.join(dir, `fnd-crush-${crypto.randomUUID()}.json`);
}

// Build the {_ccr_dropped:…} sentinel. 'ccr' reproduces Headroom's content hash (byte-parity
// tests); 'spill' writes the dropped rows to a file and references them as full=<path>.
function buildMarker(originalItems, droppedItems, droppedCount, cfg) {
  if (cfg.markerMode === 'ccr') {
    const hash = sha256hex12(compact(originalItems));
    return `<<ccr:${hash} ${droppedCount}_rows_offloaded>>`;
  }
  const p = spillPath(cfg);
  // If the spill can't be written the dropped rows would be unrecoverable — signal failure so the
  // caller keeps the array uncrushed rather than emit a handle to a file that does not exist.
  try { fs.writeFileSync(p, compact(droppedItems)); } catch (_) { return null; }
  return `<<full=${p} ${droppedCount}_rows_offloaded>>`;
}

// ------------------------------------------------------------------------- spill hygiene --

// The only file prefixes the sweep will ever delete. Keep in sync with the writers' filenames:
// `spillPath` here (fnd-crush-), `capOutput`'s Gate-A spill here (fnd-slim-out-), `spillOriginal`
// in hooks/mcp-slim.cjs (fnd-mcp-slim-), and `spillBlob` in hooks/prompt-json-guard.cjs
// (fnd-prompt-json-, swept only when it lands in the sweep dir). The literals are duplicated on
// purpose — importing this module into a per-prompt hook just for a string would drag the whole
// compressor into every UserPromptSubmit.
const SPILL_PREFIXES = ['fnd-crush-', 'fnd-slim-out-', 'fnd-mcp-slim-', 'fnd-prompt-json-'];
// One directory scan per throttle window, gated by this marker's mtime — the hook's hot path
// pays one stat, not a readdir of the whole tmpdir on every MCP call. A dotfile, so it matches
// no SPILL_PREFIX (it is excluded for good measure anyway).
const SWEEP_MARKER = '.fnd-mcp-slim-sweep';
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;
// The FND_MCP_SLIM_DEBUG log basename (its writer + rotation live in the debug-log section below);
// defined here so SWEEP_KEEP is the single source of truth — the sweep must never prune it.
const DEBUG_LOG = 'fnd-mcp-slim-debug.log';
// Files that share a spill prefix but must survive: the debug log + its one rotation, and the sweep
// marker. Excluded by EXACT name, so `fnd-mcp-slim-debug.log` is never mistaken for a spill and swept.
const SWEEP_KEEP = new Set([DEBUG_LOG, `${DEBUG_LOG}.1`, SWEEP_MARKER]);

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
// Deletes only our-prefixed files whose mtime is older than the TTL — files written by the current
// process are always fresh, so an in-flight `full=<path>` handle survives up to the TTL (a day
// covers same-day conversation resume; an older, expired handle is an already-tolerated re-fetch).
// Called by BOTH entry points (the mcp-slim hook after it writes stdout, the CLI at exit) so one
// implementation covers every writer. NB the prompt-json guard's WORKSPACE-placed spills ride with
// the task workspace, outside this dir; its tmpdir spills are swept only when the sweep dir is the
// default os.tmpdir() (FND_MCP_SLIM_DIR unset — the common case). Returns a small summary for tests.
function sweepSpills(dir) {
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
    // — one scan per window even under parallel MCP calls.
    try { fs.writeFileSync(marker, ''); } catch (_) {}
    const cutoff = now - ttl * 3600 * 1000;
    let names;
    try { names = fs.readdirSync(root); } catch (_) { return summary; }
    for (const name of names) {
      if (SWEEP_KEEP.has(name)) continue;
      if (!SPILL_PREFIXES.some((p) => name.startsWith(p))) continue;
      try {
        const p = path.join(root, name);
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); summary.swept++; }
      } catch (_) {} // gone / racing another sweep / unreadable → skip
    }
  } catch (_) {} // any failure → no-op
  return summary;
}

// ---------------------------------------------------------------------------- debug log --

// Opt-in observability (FND_MCP_SLIM_DEBUG, off by default): one JSONL metadata line per hook/CLI
// invocation → <spill-dir>/<DEBUG_LOG>. Metadata ONLY (bytes/decision/reason/stages) — never any
// payload content. The M5 sweep excludes this file and its rotation by exact name (SWEEP_KEEP, where
// DEBUG_LOG is defined). Single home: the mcp-slim hook and this module's CLI both call debugLog().
const DEBUG_LOG_MAX = 5 * 1024 * 1024; // rotate one generation past ~5 MB (bounded, keeps the recent window)

// On only when FND_MCP_SLIM_DEBUG is explicitly enabled (1/true/yes/on). Unset / 0 / false → off,
// so the default really is zero side effects: debugLog opens nothing and creates no file.
function debugEnabled() {
  const raw = process.env.FND_MCP_SLIM_DEBUG;
  return !!raw && /^(1|true|yes|on)$/i.test(raw.trim());
}

// Append one JSONL trace line (`ts` stamped here, insertion order preserved after it). Best-effort:
// disabled → no-op; every error swallowed so logging NEVER touches the hook's emitted result or the
// CLI's stdout / exit code. Rotates the log to `.log.1` (overwrite) once it passes DEBUG_LOG_MAX.
// `dir` shares the spill root so the log lives beside the spills it describes.
function debugLog(record, dir) {
  try {
    if (!debugEnabled()) return;
    const root = spillRoot(dir);
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
    const logPath = path.join(root, DEBUG_LOG);
    try {
      if (fs.statSync(logPath).size >= DEBUG_LOG_MAX) fs.renameSync(logPath, path.join(root, `${DEBUG_LOG}.1`));
    } catch (_) {} // no log yet, or rotate failed → just append below
    // `project` on EVERY line (M8): the spill dir — and so this log — is per-USER, so sessions from
    // different projects share one file. basename(cwd) makes it filterable per project. Metadata only
    // (basename, never the full path); best-effort — a cwd failure just omits the field.
    let project;
    try { project = path.basename(process.cwd()); } catch (_) {}
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...(project ? { project } : {}), ...record })}\n`);
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

// NumberArray: first/last slice ∪ outliers ∪ change-points, stride-fill to K. No dedup, no marker.
function sampleNumberArray(arr, cfg) {
  const n = arr.length;
  if (n <= 8) return { value: arr, info: 'number:passthrough' };
  const finiteIdx = [];
  arr.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) finiteIdx.push(i); });
  if (!finiteIdx.length) return { value: arr, info: 'number:no_finite' };
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
  return { value, info: `number:adaptive(${n}->${value.length},${stats})` };
}

// StringArray: first/last slice ∪ length-anomalies, stride-fill, dedup by raw string. No marker.
function sampleStringArray(arr, cfg) {
  const n = arr.length;
  if (n <= 8) return { value: arr, info: 'string:passthrough' };
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
  return { value, info: `string:adaptive(${n}->${value.length})` };
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
    else if (key === 'str') keptVals = sampleStringArray(sub, cfg).value;
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

// ---------------------------------------------------------------- recursive crush walk --

const MAX_DEPTH = 50;

// process_value: recurse the whole structure, crushing every qualifying array/object in place.
// Returns [value, info] where info is a comma-join of child strategy fragments.
function processValue(value, depth, cfg) {
  if (depth >= MAX_DEPTH) return [value, ''];
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
      if (cls === 'StringArray') { const r = sampleStringArray(arr, cfg); return [r.value, `${r.info}(${n}->${r.value.length})`]; }
      if (cls === 'NumberArray') { const r = sampleNumberArray(arr, cfg); return [r.value, `${r.info}(${n}->${r.value.length})`]; }
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
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) {
    return { compressed: content, wasModified: false, strategy: 'passthrough' };
  }
  try {
    const [crushed, info] = processValue(parsed, 0, cfg);
    const compressed = compact(crushed);
    const wasModified = compressed !== content.trim();
    return { compressed, wasModified, strategy: info !== '' ? info : 'passthrough' };
  } catch (_) {
    return { compressed: content, wasModified: false, strategy: 'passthrough' };
  }
}

// crush a parsed VALUE (no re-parse) — used by the fnd pipeline after the ADF/noise/truncate stages.
// A transform failure returns the value unchanged (crash-safety parity with crush()).
function crushValue(value, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  try { return processValue(value, 0, cfg)[0]; } catch (_) { return value; }
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
      if (AVATAR_KEY.test(k)) continue;
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

// slim a JSON *string* through the full pipeline →
//   { output, wasModified, bytesIn, bytesOut, ratio, stages, reason?, format? }.
// `stages` names the pipeline stages that actually changed the serialized bytes (adf / noise /
// truncate / crush / toon) — the FND_MCP_SLIM_DEBUG instrumentation; populated ONLY when
// `cfg.trace` (off by default), so the compression hot path stays single-serialization. `reason`
// marks a non-compressing outcome the debug log reports verbatim (`non-json` / `error-shape` /
// `transform-error`). Any stage failure → the original passes through untouched (safety rail).
function slim(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (typeof content !== 'string') return { output: content, wasModified: false, bytesIn: 0, bytesOut: 0, ratio: 0, stages: [] };
  const bytesIn = Buffer.byteLength(content, 'utf8');
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
            return { output, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['fence', ...inner.stages] : [], preamble: f.preamble, fenceBody: inner.output, fenceTrailer: f.trailer, ...(inner.logCompressed ? { logCompressed: true } : {}) };
          }
        }
      }
    }
    // A JSONL line stream (bulk-operation dump) is a same-shape array — route it through the
    // normal pipeline instead of the non-json handback (M9). parseJsonl returns null unless every
    // non-blank line is an object/array with ≥2 rows, so a truncated/prose file still falls to the
    // `non-json` branch below, byte-identical — `broken-json` then means truly malformed.
    const rows = cfg.jsonl ? parseJsonl(content) : null;
    if (rows) { parsed = rows; fromJsonl = true; }
    else {
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
      return { output: content, wasModified: false, bytesIn, bytesOut: bytesIn, ratio: 0, reason: 'non-json', format: sniffFormat(content), stages: [] };
    }
  }
  // Never touch error envelopes — write-gating elsewhere depends on seeing them verbatim. (An
  // array — including a JSONL row stream — is object-only-false here, so bulk data flows through.)
  if (isErrorShape(parsed)) {
    return { output: content, wasModified: false, bytesIn, bytesOut: bytesIn, ratio: 0, error: true, reason: 'error-shape', stages: [] };
  }
  let value = parsed;
  const stages = [];
  if (fromJsonl && cfg.trace) stages.push('jsonl'); // trace-only bookkeeping, like the other stages
  try {
    // The pipeline always runs; the compact()-per-stage byte-delta bookkeeping is opt-in (cfg.trace,
    // set by the FND_MCP_SLIM_DEBUG feed). Off ⇒ the hot path serializes exactly ONCE (the final
    // compact below) — no per-stage cost for a disabled feature, and `stages` stays empty.
    let prev = cfg.trace ? compact(value) : '';
    const runStage = (name, next) => {
      value = next;
      if (cfg.trace) { const cur = compact(value); if (cur !== prev) { stages.push(name); prev = cur; } }
    };
    if (cfg.adf) runStage('adf', adfStage(value, cfg));
    if (cfg.noise) runStage('noise', noiseStage(value, cfg));
    if (cfg.truncate) runStage('truncate', truncateStage(value, cfg));
    runStage('crush', crushValue(value, cfg));
    if (cfg.toon) runStage('toon', toonStage(value));
    const output = compact(value);
    const bytesOut = Buffer.byteLength(output, 'utf8');
    return {
      output,
      wasModified: output !== content.trim(),
      bytesIn,
      bytesOut,
      ratio: bytesIn ? 1 - bytesOut / bytesIn : 0,
      stages,
    };
  } catch (_) {
    return { output: content, wasModified: false, bytesIn, bytesOut: bytesIn, ratio: 0, reason: 'transform-error', stages: [] };
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
  const dir = spillRoot(cfg.spillDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  // M11: a fenced result's output is "preamble\n<json>\ntrailer"; spill ONLY the pure JSON body so the
  // fnd-slim-out-* spill is valid JSON — the advertised `--jq <spill>` recovery parses, and the shape
  // sampler below sees a real row instead of choking on the prose preamble. The preamble/trailer prose
  // rides on the handback text so the tool's message is preserved on top. A non-fenced result has no
  // `fenceBody` → the spilled body IS res.output, byte-for-byte as before this fix.
  const jsonBody = typeof res.fenceBody === 'string' ? res.fenceBody : res.output;
  const outPath = path.join(dir, `fnd-slim-out-${crypto.randomUUID()}.json`);
  try { fs.writeFileSync(outPath, jsonBody); } catch (_) { return null; }
  // Shape sample: the first REAL row (skipping the crush sentinel) if the body is an array, else the
  // object itself. Truncated so one fat row can't blow the handback back past the very cap we enforce.
  let rowsKept = null, sample = null, isArr = false;
  try {
    const parsed = JSON.parse(jsonBody);
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
  // no example (the ternary below drops the parenthetical); the `<dot.path>` syntax hint still shows.
  const jqExample = isArr ? '0' : (firstKey && /^[\w$-]+$/.test(firstKey) ? firstKey : null);
  let sampleStr = sample === null ? '(none)' : compact(sample);
  if (sampleStr.length > 200) sampleStr = `${sampleStr.slice(0, 200)}…`;
  const pct = ((res.ratio || 0) * 100).toFixed(1);
  const spilledBytes = Buffer.byteLength(jsonBody, 'utf8'); // the JSON body actually written to the spill
  const pre = res.preamble ? res.preamble + '\n' : ''; // fenced tool prose, kept on top of the handback
  const post = res.fenceTrailer ? '\n' + res.fenceTrailer : ''; // fenced trailer (e.g. a truncation note)
  const handback = pre +
    `json-slim: slimmed output ${res.bytesOut} B exceeds the ${cfg.cliOutCap} B inline cap — spilled, not printed.\n` +
    `  ${res.bytesIn} → ${res.bytesOut} bytes (${pct}% reduction)${rowsKept != null ? `, ${rowsKept} rows kept` : ''}\n` +
    `  ${isArr ? 'first row' : 'shape'}: ${sampleStr}\n` +
    `  slimmed output: ${outPath} (${spilledBytes} B)\n` +
    `  original file:  ${fileArg}\n` +
    `  narrow with: node json-slim.cjs --jq <dot.path> ${outPath}${jqExample ? `  (e.g. --jq ${jqExample})` : ''}` + post;
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
const PROFILE_BYTE_CAP = 8000; // the emitted profile stays ≤ ~8 KB (exit target: stdout ≤ 10 KB)

function makeProfileAccumulator(config) {
  return {
    cfg: { ...DEFAULTS, ...(config || {}) },
    lines: 0, parsed: 0, parseFailures: 0,
    keys: new Map(), // key → { present, null, type, distinct:Set, capped }
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
    if (!s) { s = { present: 0, null: 0, type: null, distinct: new Set(), capped: false }; st.keys.set(k, s); }
    s.present++;
    const val = v[k];
    if (val === null) s.null++;
    else if (s.type === null) s.type = jsonType(val);
    if (!s.capped) { s.distinct.add(compact(val)); if (s.distinct.size >= PROFILE_DISTINCT_CAP) s.capped = true; }
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
const PROFILE_KEY_CAP = 200; // cheap pre-limit before the byte ladder (a 300k-key doc never builds them all)
function profileFinalize(st, meta) {
  const keyEntries = [];
  for (const [k, s] of st.keys) {
    if (keyEntries.length >= PROFILE_KEY_CAP) break;
    keyEntries.push([k, { present: s.present, null: s.null, type: s.type || 'null', distinct: s.capped ? PROFILE_DISTINCT_CAP : s.distinct.size, ...(s.capped ? { distinctCapped: true } : {}) }]);
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
  // Emit `limit` keys and record how many were dropped (from either the pre-limit or the byte ladder).
  const setKeys = (limit) => {
    profile.keys = {};
    const shown = Math.min(limit, keyEntries.length);
    for (let i = 0; i < shown; i++) profile.keys[keyEntries[i][0]] = keyEntries[i][1];
    const dropped = totalKeys - shown;
    if (dropped > 0) profile.keysTruncated = dropped; else delete profile.keysTruncated;
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
// don't pull the data into context.
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
function emitProfile(profile, file, bytes, t0, cfg, offset) {
  // Gate B fires on SIZE alone, before any JSONL detection, so a >8 MB NON-JSONL document (a single
  // minified JSON array/object, a pretty-printed doc whose lines are fragments) reaches here too and
  // profiles as rows:0/1 with all-parseFailures — a row profile + row guidance is misleading for it.
  // A genuine JSONL row stream always has ≥2 parsed rows (parseJsonl's own threshold); below that we
  // hand the file back with non-JSONL guidance instead. (The ≤8 MB JSONL path guarantees rows≥2.)
  if (profile.rows < 2) {
    const notice = bigDocNotice(file, bytes);
    process.stdout.write(notice + '\n');
    debugLog({ entry: 'cli', tool: file, decision: 'passthrough', reason: 'big-nonjsonl', bytes_in: bytes, bytes_out: Buffer.byteLength(notice, 'utf8'), pct: 0, stages: [], spill: null, spill_out: null, ms: Date.now() - t0 }, cfg.spillDir);
    sweepSpills(cfg.spillDir);
    return;
  }
  const body = compact(profile);
  process.stdout.write(body + '\n');
  process.stdout.write(whaleGuidance(file, profile.rows, offset) + '\n');
  debugLog({ entry: 'cli', tool: file, decision: 'passthrough', reason: 'stream-profile', bytes_in: bytes, bytes_out: Buffer.byteLength(body, 'utf8'), pct: 0, stages: [], spill: null, spill_out: null, profile: true, ms: Date.now() - t0 }, cfg.spillDir);
  sweepSpills(cfg.spillDir);
}

// ==================================================================== --jq ergonomics (M12) ==

// Normalize a --jq path to the plain dot-walk this CLI understands: a leading `.` is stripped and
// `[N]` numeric indices are rewritten to `.N`, so `.products[0].title` ≡ `products.0.title`. Full jq
// stays out of scope on purpose — quoted keys (`["a.b"]`), slices, pipes and filters are NOT parsed
// (a `["a.b"]` spelling survives verbatim and then splits on its dot, so a key literally
// containing a dot stays unreachable). `.` / `..` still normalize to the empty identity selector.
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

// ================================================================ debug-log report (M12) ==

// Aggregate the FND_MCP_SLIM_DEBUG JSONL log (M6/M8) into a ≤ ~40-line plain-text summary: totals,
// counts per decision / reason / stage, the top HOOK tools by bytes saved (CLI runs are keyed by
// file path, not tool name — they get one aggregate line), per-project subtotals, and the
// MISSED-WHALE list — `platform-overflow` events (the hook's tag for a result the platform spilled to
// a tool-results file before the hook could see it) with NO later `entry:"cli"` run over that spill
// path, i.e. the whale nobody ever compressed. Pure over an array of raw lines (`opts.file`/`bytes`
// only decorate the header), so tests feed a synthetic log and the CLI feeds a real one.
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
  const out = [`json-slim: debug-log report — ${o.file || '(stdin)'}`];
  const stamps = events.map((e) => e.ts).filter(Boolean).sort();
  out.push(`  log: ${o.bytes != null ? `${o.bytes} B, ` : ''}${events.length} events` +
    `${skipped ? ` (+${skipped} unparseable)` : ''}` +
    `${stamps.length ? `, ${stamps[0]} → ${stamps[stamps.length - 1]}` : ''}` +
    `${o.since ? `  [since ${o.since}]` : ''}`);
  if (!events.length) { out.push('  no events in range.'); return out.join('\n'); }

  const decisions = new Map(), reasons = new Map(), stages = new Map(), tools = new Map(), projects = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let bytesIn = 0, bytesOut = 0;
  const cli = { n: 0, in: 0, saved: 0 };
  for (const e of events) {
    const bi = Number(e.bytes_in) || 0;
    const bo = Number(e.bytes_out) || 0;
    // A `stubbed` event (M12b) shrank the payload as surely as a compressed one — the model got a
    // ~1 KB stub instead of the whale — so it counts toward the savings, and its `reason` names the
    // branch it replaced, not a passthrough (it is listed on its own line below).
    const shrunk = e.decision === 'compressed' || e.decision === 'stubbed';
    bytesIn += bi;
    bytesOut += shrunk ? bo : bi; // a passthrough saved nothing, whatever it logged as bytes_out
    bump(decisions, e.decision || 'unknown');
    if (!shrunk) bump(reasons, e.reason || 'unknown');
    for (const s of Array.isArray(e.stages) ? e.stages : []) bump(stages, s);
    const saved = shrunk ? Math.max(0, bi - bo) : 0;
    // A CLI event's `tool` is the FILE it ran on, not an MCP tool name — ranking those together
    // would let a handful of whale files crowd every MCP tool out of the top-5 and would double-count
    // the notice and the CLI run of the same whale. CLI work is aggregated on its own line instead.
    if (e.entry === 'cli') { cli.n++; cli.in += bi; cli.saved += saved; } else {
      const tk = e.tool || '(stdin)';
      const t = tools.get(tk) || { saved: 0, n: 0 };
      t.saved += saved; t.n++; tools.set(tk, t);
    }
    const p = projects.get(e.project || '(unknown)') || { saved: 0, n: 0 };
    p.saved += saved; p.n++; projects.set(e.project || '(unknown)', p);
  }
  const pct = bytesIn ? (100 * (1 - bytesOut / bytesIn)).toFixed(1) : '0.0';
  // Totals and the per-project subtotals deliberately span BOTH entries — they answer "what did the
  // plugin save", hook and CLI alike. Only the RANKING is hook-only, because a cli `tool` is a path.
  out.push(`  totals: ${bytesIn} → ${bytesOut} B (${pct}% saved)`);
  out.push(`  decisions: ${fmtCounts(decisions)}`);
  if (reasons.size) out.push(`  passthrough reasons: ${fmtCounts(reasons)}`);
  if (stages.size) out.push(`  stages: ${fmtCounts(stages)}`);

  const topTools = [...tools.entries()].filter(([, t]) => t.saved > 0).sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_TOOLS);
  out.push('  top tools by bytes saved (hook):');
  if (!topTools.length) out.push('    (no hook compressions)');
  for (const [name, t] of topTools) out.push(`    ${t.saved} B over ${t.n} call${t.n === 1 ? '' : 's'} — ${name}`);
  if (cli.n) out.push(`  cli runs: ${cli.n} · saved ${cli.saved} B (${cli.in ? (100 * cli.saved / cli.in).toFixed(1) : '0.0'}%)`);
  const topProjects = [...projects.entries()].sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_PROJECTS);
  out.push('  projects:');
  for (const [name, p] of topProjects) out.push(`    ${name}: ${p.n} event${p.n === 1 ? '' : 's'}, ${p.saved} B saved`);

  // Missed whales: pair each platform-overflow event with a LATER cli run over the same spill path
  // (the M7 instruction being followed). Basenames are compared too, so an equivalent path spelling
  // still pairs. Unpaired = the compressor never ran on that whale — the two-lever evidence number.
  const cliRuns = events.filter((e) => e.entry === 'cli' && e.tool).map((e) => ({ at: Date.parse(e.ts) || 0, tool: String(e.tool) }));
  const unpaired = (e) => {
    const spill = e.spill ? String(e.spill) : null;
    if (!spill) return true; // an event whose path we could not extract is not provably handled
    const at = Date.parse(e.ts) || 0;
    return !cliRuns.some((c) => c.at >= at && (c.tool === spill || path.basename(c.tool) === path.basename(spill)));
  };
  const overflows = events.filter((e) => e.reason === 'platform-overflow');
  const missed = overflows.filter(unpaired);
  out.push(`  missed whales (platform-overflow with no later json-slim run): ${missed.length} of ${overflows.length}`);
  for (const e of missed.slice(0, REPORT_MISSED)) out.push(`    ${e.ts || '(no ts)'}  ${e.tool || '(unknown tool)'}  →  ${e.spill || '(no path)'}`);
  if (missed.length > REPORT_MISSED) out.push(`    …(+${missed.length - REPORT_MISSED} more)`);
  // M12b: stubbed results are NOT missed whales — the hook already replaced the payload with a stub
  // carrying the spill path and the CLI command, so an unused stub is a model choice (shown for
  // curiosity), not a gap in the pipeline.
  const stubbed = events.filter((e) => e.decision === 'stubbed');
  if (stubbed.length) {
    const stubReasons = new Map();
    for (const e of stubbed) bump(stubReasons, e.reason || 'unknown');
    out.push(`  stubbed (spill-and-stub guard): ${stubbed.length} (${fmtCounts(stubReasons)}), ${stubbed.filter(unpaired).length} with no later json-slim run`);
  }
  return out.join('\n');
}

module.exports = {
  slim, crush, crushValue, parseJsonl, unwrapFence, findOpeningFence,
  normalizeJqPath, jqAvailable, buildReport, shapeHint,
  classifyArray, computeOptimalK, analyseDictArray, isErrorShape,
  adfStage, noiseStage, truncateStage, toonStage,
  sweepSpills, spillTtlHours, spillRoot,
  debugLog, debugEnabled,
  capOutput, streamProfile, profileLines,
  detectLog, compressLog, // M10: re-exported from log-slim.cjs for callers/tests
  DEFAULTS,
};

// -------------------------------------------------------------------------------- CLI --

if (require.main === module) {
  const t0 = Date.now();
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const opt = (f) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const fileArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--jq' && args[i - 1] !== '--report' && args[i - 1] !== '--since');
  const jq = opt('--jq');
  // Segments of the --jq path (simple dot-walk, jq-ish spellings normalized — M12). An empty result —
  // `.` / `..` / leading/trailing dots — is the IDENTITY selector: it addresses the WHOLE value, not a
  // single row/field. On a JSONL file that means "the whole file", which must PROFILE like a no-jq run,
  // never crush the reshaped array.
  const jqSegs = jq != null ? normalizeJqPath(jq).split('.').filter(Boolean) : null;
  const jqIdentity = jq != null && jqSegs.length === 0;

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

  const cfg = {};
  if (has('--toon')) cfg.toon = true;
  if (has('--no-spill')) cfg.enableMarker = false;

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
        sweepSpills(cfg.spillDir);
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

  // A JSONL FILE (≤ the stream gate, no --jq) is NEVER compressed — it PROFILES, exactly like Gate B.
  // parseJsonl is the strict detector (≥2 lines, each a JSON object/array): a regular JSON document
  // fails it on line 1 and slims below; a truncated/prose file also declines and falls to the non-json
  // handback. Detecting BEFORE slim keeps crush from ever running on a JSONL file — so no fnd-crush-*
  // and no fnd-slim-out spill is ever written for it. STDIN never profiles (no on-disk original to
  // point the guidance at) — it keeps flowing through the pipeline below. `--jq .` (identity) selects
  // the WHOLE file, so it counts as "no narrowing" here and profiles too — otherwise the identity walk
  // leaves the whole reshaped array and slim() would crush + spill it (a JSONL body, contract-forbidden).
  if (fileArg && (!jq || jqIdentity)) {
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
  }

  // --jq <dot.path>: narrow to a sub-path before slimming (simple key/index walk, no jq dependency).
  if (jq) {
    let v;
    try { v = JSON.parse(raw); } catch (e) {
      // A JSONL file is a same-shape array — let `--jq 0.handle` address a row directly (M9).
      const rows = parseJsonl(raw);
      if (rows) v = rows;
      else {
        // M11: a fenced JSON/JSONL payload (tool prose + ```json…```) — unwrap the dominant fence and
        // narrow into its body so `--jq <dot.path>` works on the ORIGINAL wrapper file too, not only the
        // Gate-A spill. Without this, `--jq` on a fenced whale errored on the prose line.
        const f = DEFAULTS.fence ? unwrapFence(raw, cfg) : null;
        let fv;
        if (f) { try { fv = JSON.parse(f.body); } catch (_) { const fr = parseJsonl(f.body); if (fr) fv = fr; } }
        if (fv !== undefined) v = fv;
        else { process.stderr.write('json-slim: input is not valid JSON: ' + e.message + '\n'); process.exit(1); }
      }
    }
    // Walk the normalized segments. stdout stays `null` for a path that doesn't resolve (machine-
    // friendly, unchanged), but a MISSING segment now says so on stderr — the deepest location that
    // did resolve plus what is addressable there, so a typo is distinguishable from a real null (M12).
    // A value that genuinely IS null prints nothing.
    const walked = [];
    for (const seg of jqSegs) {
      const next = v == null ? undefined : (Array.isArray(v) && /^\d+$/.test(seg) ? v[Number(seg)] : v[seg]);
      if (next === undefined) {
        const where = walked.length ? `at '${walked.join('.')}'` : 'at top level';
        process.stderr.write(`json-slim: --jq: '${seg}' not found ${where}; ${jqAvailable(v)}\n`);
        v = undefined;
        break;
      }
      walked.push(seg);
      v = next;
    }
    raw = JSON.stringify(v === undefined ? null : v); // a missed path yields null, never a crash
  }

  const res = slim(raw, { ...cfg, trace: debugEnabled() }); // trace only when the debug log will consume `stages`
  const compressed = res.wasModified && res.bytesOut < res.bytesIn;
  // Hand the file path back — instead of re-dumping the whole (possibly whale-sized) file — for a
  // non-JSON file: never compressible, and a truncated/broken JSONL lands here too (parseJsonl already
  // declined it above, so it was not profiled). A non-JSON STDIN stream has no path to return, so it
  // still passes through below.
  const handback = fileArg && res.reason === 'non-json';
  // M10 — a compressed LOG file: print the selected body (its own `[N lines omitted…]` trailer
  // included) + one line naming the on-disk original, which IS the recovery (profile-philosophy
  // consistent). Skips capOutput below — that gate is JSON-document-shaped, not log text.
  const logOut = res.logCompressed && fileArg;
  // Gate A (M9b) — a slimmed body over the inline cap is spilled + summarized, not dumped: one huge JSON
  // document (JSONL files never reach here — they profiled upstream).
  const capped = (handback || logOut) ? null : capOutput(res, fileArg, cfg);
  if (handback) {
    process.stdout.write(`json-slim: nothing to compress; read the file directly: ${fileArg}\n`);
  } else if (logOut) {
    process.stdout.write(`${res.output}\noriginal: ${fileArg}\n`);
  } else if (capped) {
    process.stdout.write(capped.handback + '\n');
  } else {
    process.stdout.write(res.output + '\n');
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
    bytes_in: res.bytesIn,
    bytes_out: res.bytesOut,
    pct: Math.round((res.ratio || 0) * 1000) / 10,
    stages: res.stages || [],
    spill: null,
    spill_out: capped ? capped.spillOut : null, // M9b Gate A: the fnd-slim-out-* spill (non-JSONL huge doc)
    ms: Date.now() - t0,
  }, cfg.spillDir);
  // Spill hygiene at exit — prune stale spills (best-effort; never affects output or exit code).
  sweepSpills(cfg.spillDir);
}
