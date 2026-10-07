/*
 * engines/sniff.cjs — content-based detection: which engine a payload belongs to, and why.
 *
 * Order (first match wins): binary (magic bytes / NUL) → none (empty) → JSON (`adf` for a bare ADF
 * doc) → figma (Figma design-context JSX markers) → the guards that keep text untouched (diff, test
 * output, template, shebang, XML → `text`) → a dominant markdown fence (the body's engine) → JSONL →
 * code by line openings (`text`) → HTML → log (detector confidence ≥ 0.5) → `text`. The guards run before HTML and log on purpose: a
 * test run must not be deduped as a log, a theme template must not be stripped as a page. Pure.
 */
'use strict';

const { stripBom } = require('./util.cjs');
const { detectLog } = require('./log.cjs');
const { detectJsx } = require('./figma.cjs');
const { parseJsonl, unwrapFence } = require('./json.cjs');

const SCAN = 65536;

const MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x1f, 0x8b], // gzip
  [0x00, 0x61, 0x73, 0x6d], // wasm
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
];
function binaryBuffer(b) {
  const starts = (sig) => sig.every((v, i) => b[i] === v);
  if (MAGIC.some(starts)) return true;
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return true;
  return b.subarray(0, 8192).includes(0);
}
function binaryString(s) {
  return s.slice(0, 8192).includes('\u0000') || s.startsWith('%PDF-') || s.startsWith('\u0089PNG');
}

const DIFF_LINE = /^(?:diff --git |--- a\/|\+\+\+ b\/|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/gm;
const TEST_OUTPUT = [
  /^(?:PASS|FAIL) \S/m,
  /^\s*Tests?:\s+\d+/m,
  /^(?:ok|not ok) \d+ /m,
  /\b\d+ (?:passing|failing|passed|failed)\b/,
  /^=+ .*\b(?:passed|failed|error)\b.* =+$/m,
  /^(?:---|===) (?:RUN|PASS|FAIL|SKIP)\b/m,
  /^(?:ok|FAIL|\?)\s+\S+\s+(?:[\d.]+s|\[no test files\])$/m,
  /\b\d+ examples?, \d+ failures?\b/,
];
const CHECKMARKS = /^\s*[✓✔✗✕×] /gm;
const TEMPLATE = /\{%|\{\{|<%|<\?php/;
const CODE_LINE = /^\s*(?:import|export|from|const|let|var|function|class|def|return|if|for|while|public|private|package|#include|use |fn |[{}]|\/\/|\/\*|\*)/;
const HTML_START = /^\s*(?:<!doctype html|<html[\s>])/i;
const HTML_HEAD = /<head[\s>]|<body[\s>]/i;

const isHtml = (s) => HTML_START.test(s) || HTML_HEAD.test(s.slice(0, 2048));
const count = (re, s) => { re.lastIndex = 0; let n = 0; while (re.exec(s)) n++; return n; };

// The guard that keeps this text away from every transforming engine, or null.
function guard(text) {
  const head = text.slice(0, SCAN);
  if (count(DIFF_LINE, head) >= 2) return 'diff';
  if (TEST_OUTPUT.some((re) => re.test(head)) || count(CHECKMARKS, head) >= 3) return 'test-output';
  if (TEMPLATE.test(head)) return 'template';
  const t = head.trimStart();
  if (t.startsWith('#!')) return 'code';
  if (t.startsWith('<?xml') || (/^<[a-z][\w:.-]*[\s>/]/i.test(t) && !isHtml(head))) return 'xml';
  return null;
}

// Source code by its line openings. Checked after the fence and JSONL rules: a JSON line opens with a
// brace too, and a fenced code body is guarded when its own body is sniffed.
function looksLikeCode(text) {
  const head = text.slice(0, SCAN);
  if (head.trimStart().startsWith('<')) return false;
  const lines = [];
  for (const l of head.split('\n')) { if (l.trim()) lines.push(l); if (lines.length === 200) break; }
  return lines.length > 0 && lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.3;
}

// Text-shaped detection after JSON: shared by the top-level call and a fence body.
function sniffText(text, fenced) {
  if (detectJsx(text)) return { engine: 'figma', confidence: 0.95, reason: 'figma-jsx' };
  const g = guard(text);
  if (g) return { engine: 'text', confidence: 0.9, reason: g };
  if (!fenced) {
    const f = unwrapFence(text);
    if (f) {
      const inner = sniffJson(f.body) || sniffText(f.body, true);
      return { engine: inner.engine, confidence: 0.8, reason: 'fence' };
    }
  }
  if (parseJsonl(text)) return { engine: 'jsonl', confidence: 0.9, reason: 'jsonl' };
  if (looksLikeCode(text)) return { engine: 'text', confidence: 0.9, reason: 'code' };
  if (isHtml(text)) return { engine: 'html', confidence: 0.9, reason: 'html' };
  const log = detectLog(text);
  if (log.confidence >= 0.5) return { engine: 'log', confidence: Math.round(log.confidence * 100) / 100, reason: 'log' };
  return { engine: 'text', confidence: 0.5, reason: 'prose' };
}

function sniffJson(text) {
  const s = stripBom(text);
  const c = s.trimStart()[0];
  if (c !== '{' && c !== '[') return null;
  let v;
  try { v = JSON.parse(s); } catch (_) { return null; }
  if (v && typeof v === 'object' && !Array.isArray(v) && v.type === 'doc' && Array.isArray(v.content)) {
    return { engine: 'adf', confidence: 1, reason: 'adf-doc' };
  }
  return { engine: 'json', confidence: 1, reason: 'json' };
}

// sniff({ data, hint? }) → { engine, confidence, reason }. Never throws.
function sniff(input) {
  try {
    const data = input && typeof input === 'object' && 'data' in input ? input.data : input;
    let text;
    if (Buffer.isBuffer(data)) {
      if (binaryBuffer(data)) return { engine: 'binary', confidence: 1, reason: 'magic-bytes' };
      text = data.toString('utf8');
    } else if (typeof data === 'string') {
      if (binaryString(data)) return { engine: 'binary', confidence: 1, reason: 'nul-or-magic' };
      text = data;
    } else if (data && typeof data === 'object') {
      return { engine: 'json', confidence: 1, reason: 'object' };
    } else {
      return { engine: 'none', confidence: 1, reason: 'no-data' };
    }
    if (!text.trim()) return { engine: 'none', confidence: 1, reason: 'empty' };
    return sniffJson(text) || sniffText(text, false);
  } catch (_) {
    return { engine: 'none', confidence: 0, reason: 'unreadable' };
  }
}

module.exports = { sniff, guard, binaryBuffer, binaryString };
