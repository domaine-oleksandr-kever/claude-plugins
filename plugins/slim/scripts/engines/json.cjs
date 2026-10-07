/*
 * engines/json.cjs — shape-driven compressor for large JSON (and the JSON-adjacent shapes that arrive
 * as text: JSONL streams, a dominant markdown fence around a payload, an MCP text-block envelope).
 *
 * The JSON pipeline is shape-driven (each stage generic, no per-tool registry), run in this order:
 * 1 ADF/rich-doc → markdown (engines/adf.cjs); 2 noise drop (nulls / empty containers / avatar
 * decoration / self REST links); 3 long-string truncation (base64 / data-URIs / long URLs); 4
 * repetitive same-shape-array crush (a port of Headroom's SmartCrusher), whose dropped rows leave as a
 * `rows` part cited by a `full=<path>` handle so nothing is lost; 5–6 only under a caller's
 * targetBytes: trim long prose in the dominant rows, then fit by offloading rows. Non-JSON input takes a sibling
 * branch: a DOMINANT markdown fence is unwrapped and its body re-run; a JSONL stream is crushed as the
 * row array it is; Figma design-context JSX goes to engines/figma.cjs; log-shaped text to
 * engines/log.cjs. A pure text-block envelope is unwrapped and its payload slimmed.
 *
 * Pure: no I/O. Requires `crypto` and sibling engines only.
 *
 * The array-crush (crushValue / analyseDictArray / sampleNumberArray / sampleStringArray) is a
 * port of the deterministic (empty-query) path of Headroom's SmartCrusher.
 *   Headroom — https://github.com/headroomlabs-ai/headroom — Copyright 2025 Headroom Contributors.
 *   Licensed under the Apache License, Version 2.0 (see tests/parity/NOTICE for attribution).
 * This is a modified re-implementation in JavaScript; behaviour is pinned against Headroom's own
 * parity fixtures (tests/slim-engines.mjs, EP rows).
 */
'use strict';

const crypto = require('crypto');
const { adfToMarkdown } = require('./adf.cjs');
const { detectLog, compressLog } = require('./log.cjs');
const { detectJsx, compressJsx } = require('./figma.cjs');

// Every key is a knob a caller overrides — the engine entry, a parity fixture or a unit row. Numbers
// the code merely reads live in the constants below.
const DEFAULTS = {
  minItemsToAnalyze: 5, // arrays with < N items are recursed into, never crushed
  enableMarker: true, // append the {_ccr_dropped:…} sentinel when rows are offloaded
  markerMode: 'spill', // 'spill' → dropped rows leave as a `rows` part, cited full=<path>;
  //                       'ccr'   → reproduce Headroom's content hash (byte-parity tests only)
  part: null, // (kind, payload) → the path the text cites; set by the engine entry
  deadline: null, // absolute ms (Date.now() scale) after which the pipeline stops and hands the
  //                 ORIGINAL back as `budget-exceeded`; null ⇒ no budget
  dropRestLinks: true, // stage 2: drop `self` REST-navigation URLs (Jira/Confluence _links.self)
  jsonl: true, // a JSONL line stream → crushed as the same-shape array it is
  log: true, // log/build-output TEXT → signal-selected by engines/log.cjs
  jsx: true, // Figma design-context JSX → engines/figma.cjs
  fence: true, // unwrap a DOMINANT markdown fence (tool prose + ```json…```) and re-run on its body
  envelope: true, // unwrap a PURE MCP text-block envelope ([{type:'text',text:'<json>'}]) and slim the inner payload
  trace: false, // record `stages` (which stages changed bytes); off ⇒ a single final serialization
  targetBytes: null, // a body still above this after the crush runs the trim and fit stages; null ⇒ never
  // preserveFields { keyName: true } leaves the value/subtree under those keys uncrushed. Name an
  // ARRAY's own key to keep it whole — a field inside crushable rows does NOT shield those rows.
  preserveFields: {},
};

const MAX_ITEMS_AFTER_CRUSH = 15; // hard cap on kept real rows
const FIRST_FRACTION = 0.3; // number/string paths: leading slice kept
const LAST_FRACTION = 0.15; // number/string paths: trailing slice kept
const VARIANCE_THRESHOLD = 2; // the σ-multiplier for outliers / anomalies / change-points
const PRESERVE_CHANGE_POINTS = true;
const STRING_LIMIT = 200; // stage 3 threshold (chars)
const FENCE_DOMINANCE = 0.8; // the fenced body must be ≥ this fraction of total bytes (else a doc with a small code block → untouched)
const FENCE_PREAMBLE_MAX = 3; // the opening fence must appear within this many leading lines (a short prose preamble)
const FENCE_TRAILER_MAX = 3; // at most this many lines may follow the closing fence

// Substring-matched (lower-cased compact JSON) → the item is preserved as an "error" row.
const ERROR_KEYWORDS = [
  'error', 'exception', 'failed', 'failure', 'critical', 'fatal',
  'crash', 'panic', 'abort', 'timeout', 'denied', 'rejected',
];

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
  let kFirst = Math.max(1, roundHalfEven(kTotal * FIRST_FRACTION));
  let kLast = Math.max(1, roundHalfEven(kTotal * LAST_FRACTION));
  kFirst = Math.min(kFirst, kTotal);
  kLast = Math.min(kLast, kTotal - kFirst);
  return { kFirst, kLast };
}

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
    nums.forEach((v, j) => { if (Math.abs(v - m) > VARIANCE_THRESHOLD * sd) out.add(idx[j]); });
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
    if (Math.abs(R - L) > VARIANCE_THRESHOLD * sd) cps.push(i);
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

// Build the {_ccr_dropped:…} sentinel. 'ccr' reproduces Headroom's content hash (byte-parity
// tests); 'spill' hands the dropped rows to cfg.part and cites the path it returns. No part
// function → null, so the caller keeps the array uncrushed rather than drop rows it cannot cite.
function buildMarker(originalItems, droppedItems, droppedCount, cfg) {
  if (cfg.markerMode === 'ccr') {
    const hash = sha256hex12(compact(originalItems));
    return `<<ccr:${hash} ${droppedCount}_rows_offloaded>>`;
  }
  if (typeof cfg.part !== 'function') return null;
  return `<<full=${cfg.part('rows', compact(droppedItems))} ${droppedCount}_rows_offloaded>>`;
}

// DictArray: analyse → select indices → keep ascending → append sentinel for the dropped rows.
function crushDictArray(items, cfg) {
  const n = items.length;
  const itemStrings = items.map(compact);
  const adaptiveK = computeOptimalK(itemStrings, 1, 3, MAX_ITEMS_AFTER_CRUSH);

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
    if (marker === null) return { items, info: '', keptCount: n }; // no part to cite → keep rows uncrushed
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
  const kTotal = computeOptimalK(arr.map(compact), 1, 3, MAX_ITEMS_AFTER_CRUSH);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const nums = arr.map((v) => (typeof v === 'number' ? v : NaN));
  const finite = finiteIdx.map((i) => arr[i]);
  const m = mean(finite);
  const sd = sampleStd(finite);
  const keep = new Set();
  const outliers = new Set();
  if (sd > 0) arr.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - m) > VARIANCE_THRESHOLD * sd) { outliers.add(i); keep.add(i); } });
  if (PRESERVE_CHANGE_POINTS && n > 10 && sd > 0) {
    const w = 5;
    for (let i = w; i < n - w; i++) {
      const L = mean(nums.slice(i - w, i));
      const R = mean(nums.slice(i, i + w));
      if (Number.isFinite(L) && Number.isFinite(R) && Math.abs(R - L) > VARIANCE_THRESHOLD * sd) keep.add(i);
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
  const kTotal = computeOptimalK(arr, 1, 3, MAX_ITEMS_AFTER_CRUSH);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const lens = arr.map((s) => s.length);
  const m = mean(lens);
  const sd = sampleStd(lens);
  const keep = new Set();
  const anomalies = new Set();
  if (sd > 0) arr.forEach((s, i) => { if (Math.abs(s.length - m) > VARIANCE_THRESHOLD * sd) { anomalies.add(i); keep.add(i); } });
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
  const kTotal = computeOptimalK(nums.map(compact), 1, 3, MAX_ITEMS_AFTER_CRUSH);
  const { kFirst, kLast } = computeKSplit(kTotal, cfg);
  const m = mean(nums);
  const sd = sampleStd(nums);
  const keep = new Set();
  if (sd > 0) nums.forEach((v, i) => { if (Math.abs(v - m) > VARIANCE_THRESHOLD * sd) keep.add(i); });
  for (let i = 0; i < kFirst && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - kLast); i < n; i++) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => nums[i]);
}

// MixedArray: group by JSON type (first-seen order), keep-all groups < 5, sub-sample the rest,
// reassemble in original index order. In `spill` mode ONE {_ccr_dropped:…} sentinel over the whole
// array names the dropped rows' part, so a mixed dump never comes back silently incomplete. `ccr`
// mode (byte-parity fixtures only) stays marker-less, exactly as Headroom's mixed path. The per-type
// sub-crushes keep enableMarker:false; the one top-level marker covers every subgroup.
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
    // No part to cite → the dropped rows would be unrecoverable AND unsignalled; keep the array
    // uncrushed rather than hand back an incomplete result (mirrors crushDictArray).
    if (marker === null) return { value: arr, info: 'mixed:spill_failed' };
    value.push({ _ccr_dropped: marker });
  }
  return { value, info };
}

// A single V8 regex or one analyseDictArray call is uninterruptible, so `cfg.deadline` cannot pre-empt
// work already running — it bounds ACCUMULATION: the walk and every stage boundary stop between units.
// Signalled by a throw so the deep recursion below needs no return-shape change; slim()'s own catch
// turns it into the `budget-exceeded` passthrough (the ORIGINAL, never a half-transformed value).
function budgetExpired(cfg) {
  return cfg.deadline != null && Date.now() > cfg.deadline;
}
function budgetStop() {
  const e = new Error('budget exceeded');
  e.slimBudget = true;
  return e;
}

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

// crush a parsed VALUE (no re-parse) — used by slim() after the ADF/noise/truncate stages.
// A transform failure returns the value unchanged (crash-safety parity with crush()).
function crushValue(value, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  try { return processValue(value, 0, cfg)[0]; } catch (e) {
    // The budget signal belongs to slim(): swallowing it here degrades an expiry into "skip the crush
    // stage", which reports a clean compression over a half-transformed body.
    if (e && e.slimBudget) throw e;
    return value;
  }
}

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
// Prose / markdown (incl. ADF-derived descriptions) is not clipped here: only the trim stage cuts it,
// and only when the caller's targetBytes would otherwise turn the whole result into a stub.
const LONG_STRING = /^data:[\w.+-]+\/[\w.+-]+[;,]|^[A-Za-z0-9+/]{200,}={0,2}$|^https?:\/\/\S{160,}$/;

// Stage 4 — clip data-URIs / base64 / very long URLs to head + a length note.
function truncateStage(value, cfg, depth) {
  depth = depth || 0;
  if (depth >= MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (value.length > STRING_LIMIT && LONG_STRING.test(value)) {
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

// Stages 5–6 run only when the caller sets `targetBytes` and the crushed body is still above it, so
// the crush and its parity fixtures never see them. Trim works on every row array, fit on the largest.
const TRIM_HEAD = 300; // chars a cut string keeps
const TRIM_MIN = TRIM_HEAD + 40; // below this the ` [+N chars]` note eats most of the saving
const ID_KEY = /(?:^|[_-])(?:id|key|uuid|gid)$|[a-z](?:Id|Key|Uuid|Gid)$/;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isSentinel = (v) => isPlain(v) && Object.prototype.hasOwnProperty.call(v, '_ccr_dropped');
const bytesOf = (v) => Buffer.byteLength(compact(v), 'utf8');

// Paths to the row arrays: arrays whose elements are all objects, at least two of them real rows. An
// array of rows is not searched further, so no path lies inside another.
function rowArrays(value) {
  const found = [];
  const walk = (v, p, depth) => {
    if (depth >= MAX_DEPTH) return;
    if (Array.isArray(v)) {
      if (v.length >= 2 && v.every(isPlain) && v.filter((r) => !isSentinel(r)).length >= 2) { found.push(p); return; }
      v.forEach((x, i) => walk(x, [...p, i], depth + 1));
    } else if (isPlain(v)) {
      for (const k of Object.keys(v)) walk(v[k], [...p, k], depth + 1);
    }
  };
  walk(value, [], 0);
  return found;
}
// The largest row array's path (the first on a tie), or null.
function dominantRows(value) {
  let best = null;
  let bestBytes = -1;
  for (const p of rowArrays(value)) {
    const b = bytesOf(getAt(value, p));
    if (b > bestBytes) { best = p; bestBytes = b; }
  }
  return best;
}
const getAt = (v, p) => p.reduce((o, k) => o[k], v);
function setAt(v, p, x) {
  if (!p.length) return x;
  const [k, ...rest] = p;
  const copy = Array.isArray(v) ? v.slice() : { ...v };
  copy[k] = setAt(v[k], rest, x);
  return copy;
}

// Stage 5 — cut long prose strings inside the rows of every row array to TRIM_HEAD chars, longest
// first, until the body fits targetBytes. Keys, numbers, id-named fields and strings without
// whitespace (tokens, URLs, base64) are never touched. `orig` maps each rewritten row to its source.
function trimStage(value, cfg, state) {
  let total = bytesOf(value);
  if (total <= cfg.targetBytes) return value;
  const arrays = rowArrays(value).map((p) => ({ p, rows: getAt(value, p).map((r) => (isSentinel(r) ? r : JSON.parse(compact(r)))), touched: new Set() }));
  const cands = [];
  const collect = (holder, k, a, row, depth) => {
    const v = holder[k];
    if (typeof v === 'string') {
      if (v.length > TRIM_MIN && /\s/.test(v) && !(typeof k === 'string' && ID_KEY.test(k))) cands.push({ holder, k, a, row, len: v.length, at: cands.length });
    } else if (depth < MAX_DEPTH && v && typeof v === 'object') {
      for (const kk of Object.keys(v)) collect(v, Array.isArray(v) ? Number(kk) : kk, a, row, depth + 1);
    }
  };
  for (const a of arrays) a.rows.forEach((r, i) => { if (!isSentinel(r)) for (const k of Object.keys(r)) collect(r, k, a, i, 1); });
  cands.sort((a, b) => (b.len - a.len) || (a.at - b.at));
  let cut = 0;
  for (const c of cands) {
    if (total <= cfg.targetBytes) break;
    if (budgetExpired(cfg)) throw budgetStop();
    const s = c.holder[c.k];
    const end = /[\uD800-\uDBFF]/.test(s[TRIM_HEAD - 1]) ? TRIM_HEAD - 1 : TRIM_HEAD;
    const next = `${s.slice(0, end)}… [+${s.length - end} chars]`;
    total -= bytesOf(s) - bytesOf(next);
    c.holder[c.k] = next;
    c.a.touched.add(c.row);
    cut++;
  }
  if (!cut) return value;
  let out = value;
  for (const a of arrays) {
    if (!a.touched.size) continue;
    const src = getAt(value, a.p);
    for (const i of a.touched) state.orig.set(a.rows[i], src[i]);
    out = setAt(out, a.p, a.rows);
  }
  state.warnings.push(`trim: ${cut} long strings cut to ${TRIM_HEAD} chars`);
  return out;
}

// Stage 6 — still above targetBytes: keep an evenly spaced subset of the largest row array's rows (the
// first and last always) and move the rest, as their untrimmed originals, to a `rows` part cited by a
// sentinel like the crush's. Without a part function the rows stay. Only the chosen subset registers a
// part: the others are sized with a stand-in marker of the same length.
function fitStage(value, cfg, state) {
  const p = dominantRows(value);
  if (!p || typeof cfg.part !== 'function' || bytesOf(value) <= cfg.targetBytes) return value;
  const arr = getAt(value, p);
  const rows = arr.filter((r) => !isSentinel(r));
  const tail = arr.filter(isSentinel);
  const m = rows.length;
  const rowBytes = rows.reduce((s, r) => s + bytesOf(r) + 1, 0);
  const fixed = bytesOf(value) - rowBytes;
  let k = Math.min(m - 1, Math.max(2, Math.floor(m * (cfg.targetBytes - fixed - 160) / rowBytes)));
  const pick = (n) => {
    const keep = new Set(Array.from({ length: n }, (_, j) => Math.round((j * (m - 1)) / (n - 1))));
    return { kept: rows.filter((_, i) => keep.has(i)), dropped: rows.filter((_, i) => !keep.has(i)).map((r) => state.orig.get(r) || r) };
  };
  const withMarker = (kept, marker) => setAt(value, p, [...kept, ...tail, { _ccr_dropped: marker }]);
  let first = null;
  for (; k >= 2; k--) {
    if (budgetExpired(cfg)) throw budgetStop();
    const { kept, dropped } = pick(k);
    let marker;
    if (!first) {
      marker = buildMarker(arr, dropped, dropped.length, cfg);
      if (marker === null) return value;
      first = { k, marker };
    } else {
      marker = first.marker.replace(/ \d+_rows_offloaded>>$/, ` ${dropped.length}_rows_offloaded>>`);
    }
    const next = withMarker(kept, marker);
    if (bytesOf(next) <= cfg.targetBytes || k === 2) {
      state.warnings.push(`fit: ${dropped.length} of ${m} rows offloaded to meet targetBytes`);
      return k === first.k ? next : withMarker(kept, buildMarker(arr, dropped, dropped.length, cfg));
    }
  }
  return value;
}

// Classify a NON-JSON payload by its leading bytes — the `format` tag of a `non-json` passthrough.
// `broken-json` (looks like JSON yet JSON.parse failed) flags an upstream-truncated payload.
function sniffFormat(content) {
  const head = String(content).replace(/^\uFEFF/, '').trim().slice(0, 64).toLowerCase();
  if (/^<!doctype\s+html/.test(head) || head.startsWith('<html')) return 'html';
  if (head.startsWith('<?xml')) return 'xml';
  if (/^<[a-z]/.test(head)) return 'xml'; // tag-like and not html → xml
  if (head.startsWith('{') || head.startsWith('[')) return 'broken-json';
  return 'text';
}

// The one-line "what is in this payload" hint (exported as peek): parseable JSON → `array of N` or
// its top-level keys; anything else → a whitespace-collapsed preview of the head. Only the first
// STUB_HINT_SCAN bytes are ever regexed — a regex over a whale-sized string backtracks quadratically.
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
// whole-payload parse is just broken JSON). Any failing line → null, so a truncated bulk file
// (last line cut mid-object) is not partially salvaged.
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

// Unwrap a DOMINANT markdown fence. A tool wraps its payload in prose + a code fence
// ("Script ran on page and returned:\n```json\n<payload>\n```", chrome-devtools evaluate_script)
// which the whole JSON pipeline can't parse. Detect: an OPTIONAL short prose preamble (the opening
// fence must appear within FENCE_PREAMBLE_MAX leading lines), an opening ``` line (three-or-more
// backticks, an optional language tag), a body, a closing bare ``` line, at most FENCE_TRAILER_MAX
// trailer lines. Return the body + preamble + trailer ONLY when the body is the dominant content (≥ FENCE_DOMINANCE of bytes)
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
function unwrapFence(content) {
  const lines = String(content).replace(/^\uFEFF/, '').split('\n');
  const oi = findOpeningFence(lines, FENCE_PREAMBLE_MAX);
  if (oi === -1) return null;
  let ci = -1;
  for (let j = oi + 1; j < lines.length; j++) { if (FENCE_CLOSE.test(lines[j])) { ci = j; break; } }
  if (ci === -1) return null; // unterminated fence → old behavior
  if (lines.length - 1 - ci > FENCE_TRAILER_MAX) return null; // a long trailer → not a dominant single fence
  const body = lines.slice(oi + 1, ci).join('\n');
  const total = Buffer.byteLength(content, 'utf8');
  if (!total || Buffer.byteLength(body, 'utf8') / total < FENCE_DOMINANCE) return null; // dominance guard
  // Carry the trailer forward so a substantive line after the closing fence (e.g. "NOTE: truncated at
  // N rows for safety.") is never silently dropped when the body compresses. A bare final newline from
  // the split is not substantive → pop the trailing empty element(s) so it isn't mistaken for a trailer.
  const trailerLines = lines.slice(ci + 1);
  while (trailerLines.length && trailerLines[trailerLines.length - 1] === '') trailerLines.pop();
  return { preamble: lines.slice(0, oi).join('\n'), body, trailer: trailerLines.join('\n') };
}

// A PLAIN text block — `type:'text'` plus `text`, nothing else. Unwrapping keeps only the text, so a
// block carrying `annotations` or a per-block `_meta` cursor would lose it while the compacted body
// claims nothing was dropped.
const JSX_BLOCK_KEYS = new Set(['type', 'text']);
const isPlainBlock = (b) => !!b && typeof b === 'object' && !Array.isArray(b) && b.type === 'text' &&
  typeof b.text === 'string' && Object.keys(b).every((k) => JSX_BLOCK_KEYS.has(k));

// The block LIST of a PURE text-block envelope (`[{type:'text',text}]`, `{content:[…]}`, or a lone
// `{type:'text',text}`) — the shape an MCP result keeps when it is stored whole. null unless
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

// The text of a SOLE plain text block — the envelope unwrap's stricter gate. blockText JOINS a multi-block
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

// The PARSED payload hiding inside a pure text-block envelope, or null. A stored MCP result keeps
// the payload as a JSON-encoded STRING in `[0].text`, so every stage sees a 1-element array of one
// long string and finds nothing to do. Two acceptance
// rails, both deliberate: purity is soleBlockText's (an envelope carrying `_meta` /
// `structuredContent` / `annotations` is NOT an envelope for this purpose — unwrapping would drop
// those fields — and neither is a MULTI-block one, see soleBlockText), and the inner must be ONE JSON
// document (bare, or inside a dominant fence).
function envelopeInner(v, config) {
  const text = soleBlockText(v);
  if (text === null) return null;
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const s = stripBom(text);
  try { return { text, value: JSON.parse(s) }; } catch (_) {}
  if (cfg.fence) {
    const f = unwrapFence(s);
    if (f) { try { return { text, value: JSON.parse(stripBom(f.body)) }; } catch (_) {} }
  }
  return null;
}

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
  const j = compressJsx(text, cfg.part);
  const bytesOut = Buffer.byteLength(j.compressed, 'utf8');
  if (j.compressed === text || bytesOut >= bytesIn) return null;
  return { output: j.compressed, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['jsx'] : [], jsxCompressed: true, jsxIdFile: j.idFile };
}

// slim a JSON *string* through the full pipeline →
//   { output, wasModified, bytesIn, bytesOut, ratio, stages, reason?, format? }.
// `stages` names the pipeline stages that actually changed the serialized bytes (adf / noise /
// truncate / crush); populated ONLY when
// `cfg.trace` (off by default), so the compression hot path stays single-serialization. `reason`
// marks a non-compressing outcome the debug log reports verbatim (`non-json` / `error-shape` /
// `transform-error` / `number-precision`). Any stage failure → the original passes through untouched
// (safety rail).
function slim(content, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (typeof content !== 'string') return { output: content, wasModified: false, bytesIn: 0, bytesOut: 0, ratio: 0, stages: [] };
  // A BOM is stripped ONCE here, so every stage below sees the same string. `original` keeps the
  // exact argument: a `wasModified:false` result hands THAT back, byte-identical to what arrived.
  const original = content;
  content = stripBom(content);
  const bytesIn = Buffer.byteLength(original, 'utf8');
  const pass = (reason, extra) => ({ output: original, wasModified: false, bytesIn, bytesOut: bytesIn, ratio: 0, reason, stages: [], ...extra });
  let parsed;
  let fromJsonl = false;
  try { parsed = JSON.parse(content); } catch (_) {
    // A DOMINANT markdown fence (a tool's prose preamble + ```json…``` wrapping the payload,
    // e.g. chrome-devtools evaluate_script) hides an otherwise-compressible body from the whole
    // pipeline. Unwrap the body and re-run slim on it (fence:false → never re-unwrap), keeping the
    // preamble on top so the result still reads as the tool's message. Only a WIN is emitted — an
    // incompressible body leaves the WHOLE original untouched (never a bare unwrapped body). Runs
    // BEFORE parseJsonl so a fenced JSONL body reaches the same jsonl branch as an unfenced one.
    if (cfg.fence) {
      const f = unwrapFence(content);
      if (f) {
        // The prose around the fence counts against the target too.
        const wrap = [f.preamble, f.trailer].filter((s) => s !== '').reduce((n, s) => n + Buffer.byteLength(s, 'utf8') + 1, 0);
        const inner = slim(f.body, { ...cfg, fence: false, targetBytes: cfg.targetBytes ? Math.max(1, cfg.targetBytes - wrap) : cfg.targetBytes });
        if (inner.wasModified && inner.bytesOut < inner.bytesIn) {
          // Re-emit the tool's prose preamble on top and any trailer (e.g. "NOTE: truncated at N rows")
          // below the slimmed body so neither is silently dropped.
          const output = [f.preamble, inner.output, f.trailer].filter((s) => s !== '').join('\n');
          const bytesOut = Buffer.byteLength(output, 'utf8');
          if (bytesOut < bytesIn) {
            return { output, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['fence', ...inner.stages] : [], warnings: inner.warnings || [], ...(inner.logCompressed ? { logCompressed: true } : {}), ...(inner.jsxCompressed ? { jsxCompressed: true } : {}), ...(inner.jsonl ? { jsonl: true } : {}) };
          }
        }
        // A fenced ERROR envelope (a tool wraps its failures the way it wraps its payloads) declines
        // every stage, so without this it reached the generic `non-json` return below — where a caller's
        // stub guard, seeing no error, would replace the failure with a stub. `inner.error` IS isErrorShape
        // over the unwrapped body; the WHOLE original is handed back, fence and preamble included.
        if (inner.error) return pass('error-shape', { error: true });
      }
    }
    // The FIRST place the budget may speak on this route, and deliberately not before the fence
    // branch above: `inner.error` is how a fenced error envelope is recognized, and an envelope is
    // verbatim by contract — a bail that skipped that probe would report a failure as an ordinary
    // passthrough a caller's stub guard is then allowed to replace. The fence branch needs no gate of
    // its own: its cost is the recursive slim(), which carries the same deadline. Everything below is
    // a non-JSON, non-fenced payload, which isErrorShape can never match.
    if (budgetExpired(cfg)) return pass('budget-exceeded');
    // A JSONL line stream (bulk-operation dump) is a same-shape array — route it through the
    // normal pipeline instead of the non-json handback. parseJsonl returns null unless every
    // non-blank line is an object/array with ≥2 rows, so a truncated/prose file still falls to the
    // `non-json` branch below, byte-identical — `broken-json` then means truly malformed.
    const rows = cfg.jsonl ? parseJsonl(content) : null;
    if (rows) { parsed = rows; fromJsonl = true; }
    else {
      // Figma design-context JSX, before the log detector: its own detector is the far narrower one
      // (all three Figma-JSX signatures), and it only emits on a real byte win.
      if (cfg.jsx) {
        const j = jsxResult(content, cfg);
        if (j) return j;
      }
      // Log-shaped TEXT is signal-selected, not sampled. The detector must clear conf ≥ 0.5, so prose /
      // markdown / XML fall through byte-identical; a log yielding no byte gain falls through too.
      if (cfg.log && detectLog(content).isLog) {
        const r = compressLog(content, cfg);
        if (r.budgetExceeded) return pass('budget-exceeded');
        const bytesOut = Buffer.byteLength(r.compressed, 'utf8');
        if (r.compressed !== content && bytesOut < bytesIn) {
          return { output: r.compressed, wasModified: true, bytesIn, bytesOut, ratio: bytesIn ? 1 - bytesOut / bytesIn : 0, stages: cfg.trace ? ['log'] : [], logCompressed: true };
        }
      }
      // `format` is a diagnostic tag only; it never changes the passthrough.
      return pass('non-json', { format: sniffFormat(content) });
    }
  }
  // Never touch error envelopes — write-gating elsewhere depends on seeing them verbatim. (An
  // array — including a JSONL row stream — is object-only-false here, so bulk data flows through.)
  if (isErrorShape(parsed)) return pass('error-shape', { error: true });
  // Budget gate for the JSON route. An envelope-wrapped ERROR must still leave as `error-shape`, for
  // the reason the fence branch states: an error envelope is verbatim by contract, and
  // `budget-exceeded` is a reason a caller's stub guard is allowed to replace. Probed only once the
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
  // A Figma design-context result may arrive still inside its MCP block envelope
  // (`[{"type":"text","text":"<the JSX>"}]` — a host overflow file), which parses as JSON and
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
  // The same envelope, but around a JSON payload (the shape a stored MCP result keeps). A 1-element array whose
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
          warnings: inner.warnings || [],
          envelopeUnwrapped: true,
          // No `logCompressed` twin: the inner parsed as JSON by construction, so the log stage — a
          // NON-JSON text detector — cannot have run on it. A nested envelope of Figma JSX can.
          ...(inner.jsxCompressed ? { jsxCompressed: true } : {}),
        };
      }
    }
  }
  let value = parsed;
  const stages = [];
  const warnings = [];
  if (fromJsonl && cfg.trace) stages.push('jsonl'); // trace-only bookkeeping, like the other stages
  try {
    // The pipeline always runs; the compact()-per-stage byte-delta bookkeeping is opt-in (cfg.trace).
    // Off ⇒ the hot path serializes exactly ONCE (the final
    // compact below) — no per-stage cost for a disabled feature, and `stages` stays empty.
    let prev = cfg.trace ? compact(value) : '';
    const runStage = (name, nextFn) => {
      if (budgetExpired(cfg)) throw budgetStop(); // stages accumulate; a bail here discards the whole run
      value = nextFn();
      if (cfg.trace) { const cur = compact(value); if (cur !== prev) { stages.push(name); prev = cur; } }
    };
    runStage('adf', () => adfStage(value, cfg));
    runStage('noise', () => noiseStage(value, cfg));
    runStage('truncate', () => truncateStage(value, cfg));
    runStage('crush', () => crushValue(value, cfg));
    if (cfg.targetBytes) {
      const state = { orig: new Map(), warnings };
      runStage('trim', () => trimStage(value, cfg, state));
      runStage('fit', () => fitStage(value, cfg, state));
    }
    const output = compact(value);
    const wasModified = output !== content.trim();
    // Not modified ⇒ the argument itself is the result (same rail as the passthrough returns above):
    // re-serializing would otherwise report a phantom gain for stripped surrounding whitespace / a BOM.
    const bytesOut = wasModified ? Buffer.byteLength(output, 'utf8') : bytesIn;
    // A body that GREW is not a compression — a sampling marker can cost more than the stage saved.
    if (wasModified && bytesOut >= bytesIn) return pass('no-gain');
    return {
      output: wasModified ? output : original,
      wasModified,
      bytesIn,
      bytesOut,
      ratio: bytesIn ? 1 - bytesOut / bytesIn : 0,
      stages,
      warnings,
      ...(fromJsonl ? { jsonl: true } : {}),
    };
  } catch (e) {
    return pass(e && e.slimBudget ? 'budget-exceeded' : 'transform-error');
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

// The engine entry. A win is reported with the engine that produced it: a JSONL stream as `jsonl`,
// Figma JSX as `figma`, log text as `log`.
function run(text, opts, ctx) {
  const cfg = {
    ...DEFAULTS,
    trace: !!opts.trace,
    deadline: ctx.deadline,
    markerMode: opts.marker === 'ccr' ? 'ccr' : 'spill',
    part: ctx.part,
    targetBytes: opts.targetBytes,
  };
  const r = slim(text, cfg);
  if (r.error) return { decision: 'passthrough', reason: 'error-shape', text };
  if (!r.wasModified || r.bytesOut >= r.bytesIn) {
    return { decision: 'passthrough', reason: r.reason || 'no-gain', text, ...(r.format ? { format: r.format } : {}) };
  }
  const engine = r.jsxCompressed ? 'figma' : r.logCompressed ? 'log' : r.jsonl ? 'jsonl' : 'json';
  const warnings = r.warnings || [];
  if (opts.targetBytes && (engine === 'json' || engine === 'jsonl') && r.bytesOut > opts.targetBytes) warnings.push(`targetBytes ${opts.targetBytes} not met: ${r.bytesOut} B`);
  return { decision: 'compressed', text: r.output, stages: r.stages || [], engine, warnings };
}

module.exports = {
  id: 'json',
  run,
  shapeHint,
  isErrorShape,
  parseJsonl,
  unwrapFence,
  // Seams for tests/slim-engines.mjs: the parity rows run the crush alone.
  __test: { crush, crushValue, DEFAULTS, MAX_ITEMS_AFTER_CRUSH, FIRST_FRACTION, LAST_FRACTION, VARIANCE_THRESHOLD, PRESERVE_CHANGE_POINTS },
};
