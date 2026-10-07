#!/usr/bin/env node
/*
 * log-slim.cjs — signal-selecting compressor for log / build-output TEXT (M10).
 *
 * A sibling of json-slim.cjs, required by it: when slim()'s non-JSON branch meets log-shaped text
 * (after parseJsonl declines it), detectLog() gates it and compressLog() keeps the SIGNAL lines
 * (errors, stack traces, summaries) while deduping INFO/WARN spam. This is the opposite trade-off
 * from the JSON array crush: logs are diagnostics, so errors/summaries are worth ~everything and
 * repeated spam ~nothing — we select, we do not sample.
 *
 * Pure Node built-ins only (repo policy): crypto (for the test-only CCR hash). No json-slim import —
 * the detector/compressor are self-contained so json-slim → log-slim is a one-way require (no cycle).
 *
 * -----------------------------------------------------------------------------------------------
 * This is a JavaScript re-implementation of Headroom's LogCompressor + the log branch of its regex
 * ContentDetector.
 *   Headroom — https://github.com/headroomlabs-ai/headroom — Copyright 2025 Headroom Contributors.
 *   Licensed under the Apache License, Version 2.0 (see tests/parity/NOTICE for attribution).
 * Ported from the Python shim (headroom/transforms/log_compressor.py — regexes/constants) with the
 * two Rust-only passes (flavor-aware stack-trace termination + runtime-frame collapse) taken from
 * crates/headroom-core/src/transforms/log_compressor.rs. Deliberate divergences from upstream:
 *   - the CCR/MD5 spill marker is NOT emitted at runtime (json-slim/mcp-slim spill the whole original
 *     as the recovery net); it is reproduced only under `ccrStore:true`;
 *   - deduped warnings are annotated ` ×N` (upstream drops silently) — an fnd readability enhancement;
 *   - the omitted-lines trailer reports per-level counts of lines ACTUALLY omitted (total − kept), so
 *     a kept error is never listed as omitted;
 *   - the log-branch DETECTOR gates on structural level FIELDS (uppercase/first, bracketed, or `:`/`[`
 *     delimited) rather than a case-insensitive `\bERROR\b`-anywhere substring scan, so prose that
 *     merely mentions error/warning words passes through byte-identical.
 * Behaviour is pinned BYTE-EXACT against the 20 VERBATIM upstream fixtures under
 * tests/parity/fixtures/log_compressor/ (copied from the Headroom repo, Apache-2.0) — 19/20 fully
 * identical and 1/20 (the compressing case) identical on every line but the omitted trailer, which is
 * exempted for the deviation above. Only the first three divergences can touch fixture bytes (the
 * detector one only widens passthrough, and no fixture is prose) — they are the ONLY sanctioned
 * relaxations; any other diff against an upstream fixture is a real port bug (fix the port, not the
 * fixture).
 * -----------------------------------------------------------------------------------------------
 */
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------- config --

// Defaults mirror Headroom's LogCompressorConfig (camelCase per repo convention). `ccrStore` is the
// only fnd-added knob: OFF at runtime (no CCR marker — we spill the original ourselves), ON in the
// golden-fixture harness so the `[N lines compressed…hash=…]` marker is exercised/pinned.
const LOG_DEFAULTS = {
  maxErrors: 10,
  errorContextLines: 3,
  keepFirstError: true,
  keepLastError: true,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  maxWarnings: 5,
  dedupeWarnings: true,
  keepSummaryLines: true,
  maxTotalLines: 100,
  enableCcr: true,
  minLinesForCcr: 50, // logs shorter than this are returned verbatim
  minCompressionRatioForCcr: 0.5,
  collapseRuntimeFrames: true,
  traceHeadFrames: 3,
  traceAppFrames: 5,
  bias: 1.0,
  ccrStore: false, // test-only: emit the CCR marker (the golden fixtures pin this path)
};

// ---------------------------------------------------------------- content detector (log branch) --

// A log-line LEVEL FIELD, not a prose mention of a level word. DELIBERATE DEVIATION from Headroom's
// case-insensitive `\bERROR\b`-anywhere substring scan: the spec requires markdown / docs / prose to
// pass through byte-identical, but ordinary prose that merely MENTIONS "error" / "failed" / "warning"
// (even in caps, mid-sentence) is NOT a log line and must not clear the detector gate — the bare
// substring scan false-positived a 50+ line troubleshooting doc into being compressed. A
// real log level appears as a discrete FIELD: uppercase and first (after an optional timestamp or a
// `[field]`), bracketed `[error]`/`[WARN]` (any case), or immediately delimited by `:`/`!`/`[` (any
// case, e.g. `error:`, `warning:`, `error[E0308]`). That distinction is what these matchers encode.
// Only the level layer changed; the compressor's own classifyLevel stays case-insensitive because it
// runs AFTER this gate has already confirmed the text is a log.
const LEVEL_PREFIX_RE = /^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.,+Zz-]*\s+|\[?\d{2}:\d{2}:\d{2}[.,\d]*\]?\s+|\[[^\]\n]{1,48}\]\s+)*/;
function compileLevel(words) {
  return {
    bare: new RegExp('^(?:' + words + ')\\b'), // UPPERCASE level as the first token (case-sensitive)
    bracket: new RegExp('[\\[(<]\\s*(?:' + words + ')\\s*[\\])>]', 'i'), // [error] / (WARN) — any case
    delim: new RegExp('^(?:' + words + ')[:!\\[]', 'i'), // error: / WARN! / error[E0308] — any case
  };
}
const ERROR_LEVEL = compileLevel('ERROR|FATAL|CRITICAL|FAILED|FAIL|ERR');
const WARN_LEVEL = compileLevel('WARN|WARNING');
const INFO_LEVEL = compileLevel('INFO|DEBUG|TRACE');
function matchesLevel(line, lv) {
  if (lv.bracket.test(line)) return true; // bracketed anywhere (before prefix-stripping)
  const body = line.replace(LEVEL_PREFIX_RE, ''); // drop a leading timestamp / [field] so a level after it still counts
  return lv.bare.test(body) || lv.delim.test(body);
}

// The rest of the log branch of Headroom's regex ContentDetector (content_detector.py _LOG_PATTERNS),
// the non-level shapes ported as-is. NON-global regexes — `.test()` on a /g regex is stateful and
// would silently skip every other line.
const LOG_TAIL_PATTERNS = [
  /^\s*\d{4}-\d{2}-\d{2}/, // ISO date timestamp
  /^\s*\[\d{2}:\d{2}:\d{2}\]/, // [HH:MM:SS]
  /^={3,}|^-{3,}/, // rule separators
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/, // test results
  /^npm ERR!|^yarn error|^cargo error/, // build tools
  /Traceback \(most recent call last\)/, // Python traceback
  /^\w*(Error|Exception):/, // Python exception final line
  /^\s*at\s+[\w.$/]+\(/, // JS/Java stack frame
  /^\s*at async \S/, // Node async frame
  /^(panic|fatal error): /, // Go panic
  /^goroutine \d+ \[/, // Go goroutine header
  /^\t\S+\.go:\d+ \+0x/, // Go frame file line
  /^thread '[^']*' panicked at/, // Rust panic
  /^stack backtrace:/, // Rust backtrace header
  /^\s+\d+: \S/, // Rust numbered frame
  /^\s+at \S+:\d+:\d+$/, // bare path frame sub-line
  /^Unhandled exception\./, // .NET
  // .NET frame with PDB info. The first quantifier is PINNED to `[^)]+`: with `.+` there, a long line
  // dense in `) in ` that never reaches `:line <n>` backtracks catastrophically (37.7 s on 998 KB,
  // exactly 4× per doubling). The tail stays `.+` so a Windows PDB path containing spaces still
  // matches; the cost is that an argument list with NESTED parens no longer does (.NET does not nest).
  /^\s*at [^)]+\) in .+:line \d+/,
  /^Caused by: /, // Java chain head
  /^\s*\.\.\. \d+ more$/, // Java elided-frames summary
];

// Detect log/build output. Returns { isLog, confidence, ratio, patternMatches, errorMatches }.
// isLog is the compress gate: confidence ≥ 0.5 (Headroom's threshold). Prose/markdown/docs/XML have
// too few pattern hits to clear it → the caller passes them through byte-identical.
function detectLog(content) {
  const lines = String(content).split('\n').slice(0, 200); // first 200 lines
  let patternMatches = 0;
  let errorMatches = 0;
  for (const line of lines) {
    // Structural level fields first — ERROR/WARN also boost the confidence "error hits" term.
    if (matchesLevel(line, ERROR_LEVEL) || matchesLevel(line, WARN_LEVEL)) { patternMatches++; errorMatches++; continue; }
    if (matchesLevel(line, INFO_LEVEL)) { patternMatches++; continue; }
    for (let i = 0; i < LOG_TAIL_PATTERNS.length; i++) {
      if (LOG_TAIL_PATTERNS[i].test(line)) { patternMatches++; break; } // one pattern per line is enough
    }
  }
  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (patternMatches === 0 || nonEmpty === 0) {
    return { isLog: false, confidence: 0, ratio: 0, patternMatches, errorMatches };
  }
  const ratio = patternMatches / nonEmpty;
  if (ratio < 0.1) {
    return { isLog: false, confidence: 0, ratio, patternMatches, errorMatches };
  }
  const confidence = Math.min(1.0, 0.3 + ratio * 0.5 + errorMatches * 0.05);
  return { isLog: confidence >= 0.5, confidence, ratio, patternMatches, errorMatches };
}

// ---------------------------------------------------------------- format detector --

// Static-table format detector — walks the first 100 lines and picks the format with the most marker
// hits (≤ one hit per line per format). Ties resolve to the earlier table entry (Headroom parity:
// a later format only wins on a STRICTLY greater count). Only tunes summary/trace expectations.
const FORMAT_TABLE = [
  ['pytest', ['=== FAILURES', '=== ERRORS', '=== test session', '=== short test summary', 'PASSED [', 'FAILED [', 'ERROR [', 'SKIPPED [', 'collected ']],
  ['npm', ['npm ERR!', 'npm WARN', 'npm info', 'npm http']],
  ['cargo', ['Compiling ', 'Finished ', 'Running ', 'warning: ', 'error[E']],
  ['jest', ['PASS ', 'FAIL ', 'Test Suites:']],
  ['make', ['make[', 'make:', 'gcc ', 'g++ ', 'clang ']],
];

function detectLogFormat(lines) {
  const sample = lines.slice(0, 100);
  let bestFmt = null;
  let bestScore = 0;
  for (const [fmt, markers] of FORMAT_TABLE) {
    let score = 0;
    for (const line of sample) {
      if (markers.some((m) => line.includes(m))) score++; // ≤ one hit per line
    }
    if (score > 0 && (bestFmt === null || score > bestScore)) {
      bestFmt = fmt;
      bestScore = score;
    }
  }
  return bestFmt || 'generic';
}

// ---------------------------------------------------------------- level classifier --

// Word-boundary keyword classifier, first level (in priority order) whose pattern matches anywhere
// wins — the Python shim's _LEVEL_PATTERNS verbatim (the primary porting reference). NON-global so
// `.test()` stays stateless.
const LEVEL_PATTERNS = [
  ['error', /\b(?:ERROR|error|Error|FATAL|fatal|Fatal|CRITICAL|critical)\b/],
  ['fail', /\b(?:FAIL|FAILED|fail|failed|Fail|Failed)\b/],
  ['warn', /\b(?:WARN|WARNING|warn|warning|Warn|Warning)\b/],
  ['info', /\b(?:INFO|info|Info)\b/],
  ['debug', /\b(?:DEBUG|debug|Debug)\b/],
  ['trace', /\b(?:TRACE|trace|Trace)\b/],
];

function classifyLevel(line) {
  for (const [level, pattern] of LEVEL_PATTERNS) {
    if (pattern.test(line)) return level;
  }
  return 'unknown';
}

// ---------------------------------------------------------------- summary detector --

// Anchored summary patterns (Python shim _SUMMARY_PATTERNS, verbatim).
const SUMMARY_PATTERNS = [
  /^={3,}/,
  /^-{3,}/,
  /^\d+ (passed|failed|skipped|error|warning)/,
  /^(?:Tests?|Suites?):?\s+\d+/,
  /^(?:TOTAL|Total|Summary)/,
  /^(?:Build|Compile|Test).*(?:succeeded|failed|complete)/,
];

function isSummaryLine(line) {
  return SUMMARY_PATTERNS.some((p) => p.test(line));
}

// ---------------------------------------------------------------- stack-trace state machine --
// Flavor-aware termination (Rust truth: crates/headroom-core/…/log_compressor.rs). Each language
// flavor recognises its own opener, then keeps marking lines until a flavor-specific rule fires —
// crucially, blank lines only terminate flavors that never legitimately embed them (the
// chained-exception fix).

const isUpperFirst = (s) => {
  const c = s.charAt(0);
  return !!c && c !== c.toLowerCase() && c === c.toUpperCase();
};
const hasLineColSuffix = (s) => /:\d+:\d+/.test(s);
const isPythonFileFrame = (s) => s.startsWith('File "') && s.includes('", line ') && /\d$/.test(s);
const isJsAtFrame = (s) => s.startsWith('at ') && s.includes('(') && s.includes(')') && hasLineColSuffix(s);
function isJavaAtFrame(s) {
  if (!s.startsWith('at ') || !s.includes('(')) return false;
  const body = s.slice(3, s.indexOf('('));
  return body.length > 0 && /^[\w.$/]+$/.test(body); // \w covers [A-Za-z0-9_]; plus . $ /
}
const isRustPanicOpener = (s) => s.startsWith("thread '") && s.includes('panicked at');
const isRustBacktraceFrame = (line) => /^\d+: *0x[0-9a-fA-F]/.test(line.trimStart());
function isGoroutineHeader(line) {
  if (!line.startsWith('goroutine ')) return false;
  const rest = line.slice('goroutine '.length);
  const m = rest.match(/^\d+/);
  return !!m && rest.slice(m[0].length).startsWith(' [');
}
const isGoFileFrame = (line) => line.startsWith('\t') && line.slice(1).includes('.go:') && line.slice(1).includes(' +0x');
function isGoCallFrame(line) {
  if (line.startsWith('created by ')) return true;
  if (/^[ \t]/.test(line) || !line.endsWith(')')) return false;
  const open = line.indexOf('(');
  if (open < 0) return false;
  const symbol = line.slice(0, open);
  return symbol.length > 0 && symbol.includes('.') && /^[\w./*]+$/.test(symbol);
}
const isGoPanicOpener = (line) => line.startsWith('panic: ') || line.startsWith('fatal error: ') || isGoroutineHeader(line);
const isDotnetFrame = (s) => s.startsWith('at ') && s.includes(') in ') && s.includes(':line ');
const isDotnetOpener = (s) => s.startsWith('Unhandled exception.') || isDotnetFrame(s);
function isDotnetExceptionHead(t) {
  const c = t.indexOf(':');
  if (c < 0) return false;
  const head = t.slice(0, c);
  return head.endsWith('Exception') && head.includes('.') && /^[\w.`+]+$/.test(head);
}
function isJavaMoreSummary(t) {
  const m = t.match(/^\.\.\. (\d+)(.*)$/);
  return !!m && m[2].trim() === 'more';
}

// The opening-marker recogniser: which flavor (if any) does `line` start? Order matters (.NET before
// JS/Java — a .NET frame also satisfies the Java `at <dotted>(` shape).
function flavorFor(line) {
  const t = line.trimStart();
  if (t.startsWith('Traceback (most recent call last)') || isPythonFileFrame(t)) return 'PythonTraceback';
  if (isDotnetOpener(t)) return 'DotNet';
  if (isJsAtFrame(t)) return 'Js';
  if (isJavaAtFrame(t)) return 'Java';
  if (t.startsWith('--> ') && hasLineColSuffix(t)) return 'RustError';
  if (isRustPanicOpener(t) || t.startsWith('stack backtrace:') || isRustBacktraceFrame(line)) return 'RustBacktrace';
  if (isGoPanicOpener(line)) return 'GoPanic';
  return null;
}

// True if `line` ends the current flavor's run. `linesSoFar` = how many lines the active trace has
// claimed (1 = only the opener) — RustBacktrace uses it to keep the free-text panic-message line.
function terminates(flavor, line, linesSoFar) {
  const t = line.trimStart();
  switch (flavor) {
    case 'PythonTraceback': {
      const indentedOrBlank = /^[ \t]/.test(line) || line === '';
      const continuation = t.startsWith('Traceback') || t.startsWith('File ') || t.startsWith('During handling') || t.startsWith('The above exception');
      if (indentedOrBlank || continuation) return false;
      return !isUpperFirst(t); // keep the `ExceptionType: message` terminator, end after it
    }
    case 'Js':
      return !t.startsWith('at ') && line !== '';
    case 'Java': {
      const chain = t.startsWith('Caused by:') || t.startsWith('Suppressed:') || isJavaMoreSummary(t);
      return !t.startsWith('at ') && !chain && line !== '';
    }
    case 'DotNet': {
      if (line === '') return false;
      const continues = t.startsWith('at ') || t.startsWith('--->') || t.startsWith('--- End of') || isDotnetExceptionHead(t);
      return !continues;
    }
    case 'RustError':
      return !t.startsWith('--> ') && line !== '';
    case 'RustBacktrace': {
      if (line === '' || linesSoFar === 1) return false;
      const isFrame = /^\d/.test(t);
      const continuation = /^[ \t]/.test(line) || t.startsWith('stack backtrace:') || t.startsWith('note: run with');
      return !isFrame && !continuation;
    }
    case 'GoPanic': {
      if (line === '') return false;
      const continues = line.startsWith('\t') || isGoroutineHeader(line) || isGoCallFrame(line) || line.startsWith('panic: ') || line.startsWith('fatal error: ') || line.startsWith('[signal ');
      return !continues;
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------- scoring --

const LEVEL_SCORES = { error: 1.0, fail: 1.0, warn: 0.5, info: 0.1, debug: 0.05, trace: 0.02, unknown: 0.1 };

function scoreLogLine(line) {
  let score = LEVEL_SCORES[line.level] != null ? LEVEL_SCORES[line.level] : 0.1;
  if (line.isStackTrace) score += 0.3;
  if (line.isSummary) score += 0.4;
  return Math.min(1.0, score);
}

// ---------------------------------------------------------------- parse + classify --

// Parse every line into { lineNumber, content, level, isStackTrace, isSummary, score }. The
// stack-trace dispatcher opens on a flavor match and keeps marking until the flavor terminates or the
// per-trace line cap is hit; on a cap-hit mid-trace it re-checks whether the line still continues the
// flavor so the collapse pass (not arbitrary cap alignment) decides what survives.
function parseLogLines(lines, config) {
  const cfg = { ...LOG_DEFAULTS, ...(config || {}) };
  const out = [];
  let active = null;
  let traceLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entry = { lineNumber: i, content: line, level: classifyLevel(line), isStackTrace: false, isSummary: isSummaryLine(line), score: 0 };
    if (active !== null) {
      if (traceLines >= cfg.stackTraceMaxLines || terminates(active, line, traceLines)) {
        const capHit = traceLines >= cfg.stackTraceMaxLines;
        const prevFlavor = active;
        active = null;
        traceLines = 0;
        const newFlavor = flavorFor(line);
        if (newFlavor !== null) {
          active = newFlavor;
          traceLines = 1;
          entry.isStackTrace = true;
        } else if (capHit && !terminates(prevFlavor, line, 2)) {
          active = prevFlavor;
          traceLines = 1;
          entry.isStackTrace = true;
        }
      } else {
        entry.isStackTrace = true;
        traceLines += 1;
      }
    } else {
      const flavor = flavorFor(line);
      if (flavor !== null) {
        active = flavor;
        traceLines = 1;
        entry.isStackTrace = true;
      }
    }
    entry.score = scoreLogLine(entry);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- dedupe --

// Conservative normalizer: preserve the message prefix (before the first `:`/`=`) verbatim; normalize
// ONLY the trailing variable region (digits→N, 0x…→ADDR, paths→/PATH/). Order matches upstream
// (digits first). Two distinct messages sharing a trailing shape stay distinct.
function normalizeForDedupe(content) {
  let idx = content.length;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === ':' || ch === '=') { idx = i; break; }
  }
  const prefix = content.slice(0, idx);
  let suffix = content.slice(idx);
  suffix = suffix.replace(/\d+/g, 'N').replace(/0x[0-9a-fA-F]+/g, 'ADDR').replace(/\/[\w/]+\//g, '/PATH/');
  return prefix + suffix;
}

// Keep the first line of each normalized group; annotate the survivor ` ×N` when it stands for N > 1
// lines (fnd enhancement — upstream drops silently). Order preserved.
function dedupeSimilar(lines) {
  const counts = new Map();
  const order = [];
  for (const line of lines) {
    const key = normalizeForDedupe(line.content);
    if (!counts.has(key)) {
      counts.set(key, 1);
      order.push({ line, key });
    } else {
      counts.set(key, counts.get(key) + 1);
    }
  }
  return order.map(({ line, key }) => {
    const n = counts.get(key);
    return n > 1 ? { ...line, content: `${line.content} ×${n}` } : line;
  });
}

// ---------------------------------------------------------------- frame collapse --

const RUNTIME_FRAME_PREFIXES = ['at java.', 'at jdk.', 'at sun.', 'at javax.', 'at scala.', 'at System.', 'at Microsoft.', 'runtime.', 'created by runtime.'];
const RUNTIME_FRAME_MARKERS = ['site-packages/', '/usr/lib/python', 'lib/python3.', 'node:internal/', 'node_modules/', '(internal/', 'core::', 'std::', 'alloc::', 'rust_begin_unwind', '__rust_', '/rustc/', '/usr/local/go/src/', '/libexec/src/runtime/'];

function isFrameLine(line) {
  const t = line.trimStart();
  return t.startsWith('at ') || (t.startsWith('File "') && t.includes('", line ')) || isRustBacktraceFrame(line) || isGoFileFrame(line) || isGoCallFrame(line);
}
function isChainHeadLine(line) {
  const t = line.trimStart();
  return t.startsWith('Caused by:') || t.startsWith('Suppressed:') || t.startsWith('... ') || t.startsWith('--->') || t.startsWith('--- End of') || t.startsWith('During handling') || t.startsWith('The above exception');
}
function isRuntimeFrame(line) {
  const t = line.trimStart();
  return RUNTIME_FRAME_PREFIXES.some((p) => t.startsWith(p)) || RUNTIME_FRAME_MARKERS.some((m) => line.includes(m));
}

// Collapse runtime/stdlib frames in an oversized trace: keep every message/chain-head line, the first
// `headFrames` frames, and up to `appFrames` app-code frames; each contiguous dropped run becomes one
// `[... N frames collapsed]` marker. Returns { kept: LogLine[], droppedIndices: number[] } — the
// dropped indices are excluded from the later context pass so they don't ride back in.
function collapseTraceFrames(stack, headFrames, appFrames) {
  const kept = [];
  const droppedIndices = [];
  let framesSeen = 0;
  let appKept = 0;
  let runStart = null;
  let runLen = 0;
  let prevDropped = false;

  const flushRun = () => {
    if (runStart !== null) {
      kept.push({ lineNumber: runStart, content: `      [... ${runLen} frames collapsed]`, level: 'unknown', isStackTrace: true, isSummary: false, score: 0.8 });
      runStart = null;
      runLen = 0;
    }
  };

  for (const line of stack) {
    if (isFrameLine(line.content) && !isChainHeadLine(line.content)) {
      framesSeen += 1;
      const runtime = isRuntimeFrame(line.content);
      const keep = framesSeen <= headFrames || (!runtime && appKept < appFrames);
      if (keep) {
        if (!runtime) appKept += 1;
        flushRun();
        kept.push(line);
        prevDropped = false;
      } else {
        if (runStart === null) runStart = line.lineNumber;
        runLen += 1;
        droppedIndices.push(line.lineNumber);
        prevDropped = true;
      }
    } else if (prevDropped && /^[ \t]/.test(line.content) && !isChainHeadLine(line.content)) {
      // Indented continuation of a dropped frame (source echo) drops with it.
      runLen += 1;
      droppedIndices.push(line.lineNumber);
    } else {
      flushRun();
      kept.push(line);
      prevDropped = false;
    }
  }
  flushRun();
  return { kept, droppedIndices };
}

// ---------------------------------------------------------------- adaptive budget --

// Adaptive total-lines budget: distinct-count uniqueness → knee fraction, clamped to [minK, maxK].
// A faithful-in-spirit port of Headroom's compute_optimal_k (SimHash + Kneedle + zlib) — the same
// distinct-count stand-in json-slim's array crush uses. Only bounds the FINAL cap; the fixtures never
// exercise the cap boundary (their sole compressing case selects 8 < minK=10), so this cannot affect
// parity, only how hard a real over-budget log compresses.
function computeOptimalKLog(strings, bias, minK, maxK) {
  const n = strings.length;
  if (n <= 8) return Math.min(Math.max(n, minK), maxK);
  const uniq = new Set(strings).size;
  if (uniq <= 3) return Math.max(minK, Math.min(uniq, maxK));
  const d = uniq / n;
  const knee = Math.max(minK, Math.trunc(n * (0.3 + 0.7 * d)));
  const k = Math.max(minK, Math.trunc(knee * bias));
  return Math.max(minK, Math.min(k, maxK));
}

// ---------------------------------------------------------------- selection --

// Category selection: errors (first/last/top), fails (same), deduped warnings, first N stack traces
// (with frame collapse), ALL summaries; a ±context window around each pick; then a final adaptive cap
// that keeps the highest-scoring lines when the selection overflows.
function selectWithFirstLast(lines, maxCount, cfg) {
  if (lines.length <= maxCount) return lines.slice();
  const out = [];
  const seen = new Set();
  const push = (line) => { if (!seen.has(line.lineNumber)) { seen.add(line.lineNumber); out.push(line); } };
  if (cfg.keepFirstError) push(lines[0]);
  if (cfg.keepLastError) push(lines[lines.length - 1]);
  const remaining = maxCount - out.length;
  if (remaining > 0) {
    const byScore = lines.slice().sort((a, b) => (b.score - a.score) || (a.lineNumber - b.lineNumber));
    for (const line of byScore) {
      if (!seen.has(line.lineNumber)) {
        push(line);
        if (out.length >= maxCount) break;
      }
    }
  }
  return out;
}

function selectLogLines(logLines, bias, config) {
  const cfg = { ...LOG_DEFAULTS, ...(config || {}) };
  const adaptiveMax = computeOptimalKLog(logLines.map((l) => l.content), bias, 10, cfg.maxTotalLines);

  const errors = [];
  const fails = [];
  let warnings = [];
  const summaries = [];
  const stackTraces = [];
  let currentStack = [];
  for (const line of logLines) {
    if (line.level === 'error') errors.push(line);
    else if (line.level === 'fail') fails.push(line);
    else if (line.level === 'warn') warnings.push(line);
    if (line.isStackTrace) currentStack.push(line);
    else if (currentStack.length) { stackTraces.push(currentStack); currentStack = []; }
    if (line.isSummary) summaries.push(line);
  }
  if (currentStack.length) stackTraces.push(currentStack);

  // BTreeSet<LogLine> ordered/deduped by lineNumber → a Map keyed by lineNumber, first insert wins.
  const selected = new Map();
  const insert = (line) => { if (!selected.has(line.lineNumber)) selected.set(line.lineNumber, line); };

  for (const line of selectWithFirstLast(errors, cfg.maxErrors, cfg)) insert(line);
  for (const line of selectWithFirstLast(fails, cfg.maxErrors, cfg)) insert(line);

  if (cfg.dedupeWarnings) warnings = dedupeSimilar(warnings);
  for (const line of warnings.slice(0, cfg.maxWarnings)) insert(line);

  const collapsedFrameIndices = new Set();
  for (const stack of stackTraces.slice(0, cfg.maxStackTraces)) {
    if (cfg.collapseRuntimeFrames && stack.length > cfg.stackTraceMaxLines) {
      const collapsed = collapseTraceFrames(stack, cfg.traceHeadFrames, cfg.traceAppFrames);
      for (const idx of collapsed.droppedIndices) collapsedFrameIndices.add(idx);
      for (const line of collapsed.kept.slice(0, cfg.stackTraceMaxLines)) insert(line);
    } else {
      for (const line of stack.slice(0, cfg.stackTraceMaxLines)) insert(line);
    }
  }

  if (cfg.keepSummaryLines) for (const line of summaries) insert(line);

  // Context window around every selected line (skip deliberately-collapsed runtime frames).
  const selectedIndices = new Set(selected.keys());
  const contextIndices = new Set();
  for (const idx of selectedIndices) {
    const lo = Math.max(0, idx - cfg.errorContextLines);
    const hi = Math.min(logLines.length, idx + cfg.errorContextLines + 1);
    for (let i = lo; i < hi; i++) if (i !== idx) contextIndices.add(i);
  }
  for (const idx of contextIndices) {
    if (!selectedIndices.has(idx) && idx < logLines.length && !collapsedFrameIndices.has(idx)) insert(logLines[idx]);
  }

  let ordered = [...selected.values()].sort((a, b) => a.lineNumber - b.lineNumber);
  if (ordered.length > adaptiveMax) {
    // The keepFirst/keepLast contract (first + last ERROR/FAIL) must survive this final cap. A plain
    // score-sort keeps the LOWEST line numbers on a score tie, so when error/fail lines (all score
    // 1.0) overflow adaptiveMax it would evict the guaranteed LAST error — the one distinct final
    // failure a reader actually needs. Pin those anchors, then fill the rest by score.
    const pinned = new Set();
    for (const arr of [errors, fails]) {
      if (!arr.length) continue;
      if (cfg.keepFirstError) pinned.add(arr[0].lineNumber);
      if (cfg.keepLastError) pinned.add(arr[arr.length - 1].lineNumber);
    }
    const keepPinned = ordered.filter((l) => pinned.has(l.lineNumber));
    const rest = ordered.filter((l) => !pinned.has(l.lineNumber));
    const budget = Math.max(0, adaptiveMax - keepPinned.length);
    const keepRest = rest.slice().sort((a, b) => (b.score - a.score) || (a.lineNumber - b.lineNumber)).slice(0, budget);
    ordered = keepPinned.concat(keepRest).sort((a, b) => a.lineNumber - b.lineNumber);
  }
  return ordered;
}

// ---------------------------------------------------------------- output --

function countLevel(lines, level) {
  let n = 0;
  for (const l of lines) if (l.level === level) n++;
  return n;
}

// Kept lines in original order + a `[N lines omitted: X ERROR, Y WARN, …]` trailer. Returns
// { body, stats } — stats keys alphabetical to match Headroom's BTreeMap serialization.
function formatLogOutput(selected, allLines) {
  const errors = countLevel(allLines, 'error');
  const fails = countLevel(allLines, 'fail');
  const warnings = countLevel(allLines, 'warn');
  const info = countLevel(allLines, 'info');
  const stats = { errors, fails, info, selected: selected.length, total: allLines.length, warnings };

  const output = selected.map((l) => l.content);
  const omitted = allLines.length - selected.length;
  if (omitted > 0) {
    // Per-level counts of the lines ACTUALLY omitted (total − kept), NOT the log's total level
    // composition — a KEPT error must never be reported as omitted, and the breakdown must not exceed
    // the omitted total. `selected` may carry ×N-annotated survivors (level
    // preserved) and 'unknown' collapse markers, so counting kept lines by level is exact.
    const parts = [];
    for (const [label, level, total] of [['ERROR', 'error', errors], ['FAIL', 'fail', fails], ['WARN', 'warn', warnings], ['INFO', 'info', info]]) {
      const dropped = total - countLevel(selected, level);
      if (dropped > 0) parts.push(`${dropped} ${label}`);
    }
    if (parts.length) output.push(`[${omitted} lines omitted: ${parts.join(', ')}]`);
  }
  return { body: output.join('\n'), stats };
}

// ---------------------------------------------------------------- compress --

const md5hex24 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').slice(0, 24);

// Compress log/build TEXT. Returns the Headroom LogCompressionResult surface:
//   { compressed, original, original_line_count, compressed_line_count, format_detected,
//     compression_ratio, cache_key, stats }.
// Short logs (< minLinesForCcr) return verbatim. The CCR/MD5 marker is emitted only under
// `ccrStore:true` (parity fixtures) — at runtime the caller spills the whole original instead.
function compressLog(content, config) {
  const cfg = { ...LOG_DEFAULTS, ...(config || {}) };
  const lines = String(content).split('\n');
  const originalLineCount = lines.length;

  if (originalLineCount < cfg.minLinesForCcr) {
    return {
      compressed: content,
      original: content,
      original_line_count: originalLineCount,
      compressed_line_count: originalLineCount,
      format_detected: 'generic',
      compression_ratio: 1.0,
      cache_key: null,
      stats: {},
    };
  }

  const format = detectLogFormat(lines);
  const logLines = parseLogLines(lines, cfg);
  const selected = selectLogLines(logLines, cfg.bias != null ? cfg.bias : 1.0, cfg);
  const { body, stats } = formatLogOutput(selected, logLines);

  let compressed = body;
  const ratio = Buffer.byteLength(compressed, 'utf8') / Math.max(1, Buffer.byteLength(content, 'utf8'));
  let cacheKey = null;
  if (cfg.enableCcr && ratio < cfg.minCompressionRatioForCcr && cfg.ccrStore) {
    cacheKey = md5hex24(content);
    compressed += `\n[${originalLineCount} lines compressed to ${selected.length}. Retrieve more: hash=${cacheKey}]`;
  }

  return {
    compressed,
    original: content,
    original_line_count: originalLineCount,
    compressed_line_count: selected.length,
    format_detected: format,
    compression_ratio: ratio,
    cache_key: cacheKey,
    stats,
  };
}

module.exports = {
  LOG_DEFAULTS,
  detectLog,
  compressLog,
  // unit-test seams (the rest of the internals are covered via compressLog + the parity fixtures):
  classifyLevel,
  scoreLogLine,
  parseLogLines,
  normalizeForDedupe,
  dedupeSimilar,
  collapseTraceFrames,
};
