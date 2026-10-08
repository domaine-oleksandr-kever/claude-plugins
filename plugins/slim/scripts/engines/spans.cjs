/*
 * engines/spans.cjs — the data-shaped spans inside a mixed text (a prompt with a paste in it): where
 * each one starts and ends and what it is, so a caller can compress the spans and keep the prose
 * around them byte for byte. Pure: offsets in, offsets out; nothing is compressed here.
 *
 * Kinds: `json` (a balanced object or array that JSON.parse accepts), `jsonl` (two or more JSON lines
 * in a row), `html` (a `<!doctype html>` / `<html>` line through its `</html>` tag), `log` (a run of
 * timestamp- or level-led lines and their stack frames, confirmed by the log detector), and a fenced
 * block whose body sniffs as one of those (the span is the body; the fence lines stay). Prose is never
 * a span, and neither is a span that already carries a slim or fnd handle or stats line.
 */
'use strict';

const { utf8 } = require('./util.cjs');
const { sniff } = require('./sniff.cjs');
const { detectLog } = require('./log.cjs');

const MIN = 8192;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HTML_OPEN = /^\s*(?:<!doctype html|<html[\s>])/i;
const HTML_CLOSE = /<\/html\s*>/i;
const LOG_START = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}[.,\]\s]|\[?(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} )/;
// A stack frame or traceback line: it may close a run. A tab- or `...`-led line only joins one, so an
// indented question typed after the paste stays prose.
const LOG_STACK = /^(?:\s+at\s+(?:async\s+|new\s+)?\S+(?:\s+\(.*\))?\s*$|\s+File "[^"]+", line \d+|\s*Caused by\b|\s*\.\.\. \d+ more)/;
const LOG_MORE = /^(?:\t|\s+\.\.\.)/;
// A handle, a stub mark or a stats line inside the span, or a stats line / handle right after it.
const MARK_INSIDE = /<<full=|<<slim stub>>|<<fnd-mcp-slim stub>>|fnd-prompt-json-|^(?:slim|fnd-mcp-slim|fnd-prompt-slim): (?:compressed|stub) /m;
const MARK_AFTER = /^\s*(?:(?:slim|fnd-mcp-slim|fnd-prompt-slim): (?:compressed|stub) |<<full=)/;

/**
 * Every JSON object or array in `text` of at least `min` UTF-8 bytes that JSON.parse accepts, in order
 * and non-overlapping. Each `{` / `[` is matched to its closer with string state tracked from it, so
 * prose before a paste (a stray quote, an unclosed brace) cannot decide the outcome. The scan budget
 * is linear in the text: an adversarial run of openers bails (`bailed: true`, no blobs). `openAt` is
 * the first opener of at least `min` bytes of remainder that never closes (a truncated paste), else -1.
 */
function jsonBlobs(text, min = MIN) {
  const blobs = [];
  let openAt = -1;
  let budget = text.length * 8 + 65536;
  const matchEnd = (from) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      if (--budget < 0) return -1;
      const c = text[i];
      if (inString) {
        // No JSON string spans a raw line break: such a quote opened prose, not a value.
        if (c === '\n' || c === '\r') { inString = false; escaped = false; continue; }
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    const end = matchEnd(i);
    if (budget < 0) return { blobs: [], openAt: -1, bailed: true };
    if (end < 0) {
      if (openAt < 0 && utf8(text.slice(i)) >= min) openAt = i;
      continue;
    }
    const span = text.slice(i, end);
    const start = i;
    i = end - 1;
    if (utf8(span) < min) continue;
    try { JSON.parse(span); blobs.push({ start, end }); } catch (_) {}
  }
  return { blobs, openAt, bailed: false };
}

function isJsonLine(s) {
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return false;
  try { const v = JSON.parse(t); return v !== null && typeof v === 'object'; } catch (_) { return false; }
}

/**
 * spans(text, { min = 8192 }) → [{ start, end, kind }], ordered and non-overlapping; `kind` is
 * 'json' | 'jsonl' | 'log' | 'html'. Deterministic; an adversarial text that exhausts the JSON scan
 * budget gives [] (nothing is mined from a text that could not be read whole).
 */
function spans(text, opts) {
  const min = opts && Number.isFinite(opts.min) && opts.min > 0 ? opts.min : MIN;
  if (typeof text !== 'string' || utf8(text) < min) return [];
  const j = jsonBlobs(text, min);
  if (j.bailed) return [];
  let json = j.blobs;
  // A truncated paste left open: nothing after its opener is mined as JSON.
  if (j.openAt >= 0) {
    const rest = utf8(text.slice(j.openAt)) - json.reduce((n, b) => (b.start > j.openAt ? n + utf8(text.slice(b.start, b.end)) : n), 0);
    if (rest >= min) json = json.filter((b) => b.start < j.openAt);
  }
  const found = json.map((b) => ({ ...b, kind: 'json' }));

  const lines = [];
  for (let at = 0; at <= text.length;) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl;
    lines.push({ s: at, e: end });
    if (nl === -1) break;
    at = nl + 1;
  }
  const covered = (s, e) => json.some((b) => b.start < e && s < b.end);
  const line = (k) => text.slice(lines[k].s, lines[k].e);
  const free = (k) => !covered(lines[k].s, lines[k].e + 1);
  const take = (from, to, kind, end) => {
    const s = lines[from].s;
    const e = end === undefined ? lines[to].e : end;
    if (utf8(text.slice(s, e)) >= min) found.push({ start: s, end: e, kind });
  };

  for (let i = 0; i < lines.length;) {
    if (!free(i)) { i++; continue; }
    const l = line(i);
    const f = FENCE.exec(l);
    if (f) {
      let close = -1;
      for (let k = i + 1; k < lines.length; k++) {
        const t = line(k).trim();
        if (t.length >= f[1].length && t === f[1][0].repeat(t.length)) { close = k; break; }
      }
      if (close === -1) { i++; continue; }
      if (close > i + 1 && !covered(lines[i + 1].s, lines[close - 1].e)) {
        const body = text.slice(lines[i + 1].s, lines[close - 1].e);
        const kind = utf8(body) >= min ? sniff({ data: body }).engine : null;
        if (kind === 'json' || kind === 'jsonl' || kind === 'log' || kind === 'html') take(i + 1, close - 1, kind);
      }
      i = close + 1;
      continue;
    }
    if (HTML_OPEN.test(l)) {
      let k = i;
      while (k < lines.length && free(k) && !HTML_CLOSE.test(line(k))) k++;
      if (k < lines.length && free(k)) {
        const m = HTML_CLOSE.exec(line(k));
        take(i, k, 'html', lines[k].s + m.index + m[0].length);
        i = k + 1;
        continue;
      }
      i++;
      continue;
    }
    if (isJsonLine(l)) {
      let k = i;
      while (k + 1 < lines.length && free(k + 1) && isJsonLine(line(k + 1))) k++;
      if (k > i) take(i, k, 'jsonl');
      i = k + 1;
      continue;
    }
    if (LOG_START.test(l)) {
      let k = i;
      let last = i;
      while (k + 1 < lines.length && free(k + 1)) {
        const next = line(k + 1);
        if (LOG_START.test(next) || LOG_STACK.test(next)) last = k + 1;
        else if (!LOG_MORE.test(next)) break;
        k++;
      }
      const body = text.slice(lines[i].s, lines[last].e);
      if (utf8(body) >= min && detectLog(body).confidence >= 0.5) take(i, last, 'log');
      i = last + 1;
      continue;
    }
    i++;
  }

  return found
    .filter((s) => !MARK_INSIDE.test(text.slice(s.start, s.end)) && !MARK_AFTER.test(text.slice(s.end, s.end + 400)))
    .sort((a, b) => a.start - b.start);
}

module.exports = { spans, jsonBlobs, MIN };
