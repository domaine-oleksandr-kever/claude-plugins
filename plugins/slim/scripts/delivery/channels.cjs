// The channel table: per built-in tool, how big a result must be before slim looks at it, which
// engines may touch it, how its text is taken out of the tool's result record and how the compressed
// text is put back in the same record shape (the host validates a hook's result against the tool's
// output schema, so Bash stays {stdout, stderr, …}, Read keeps its file record, and so on).
'use strict';

const path = require('path');

// Pre-filter sizes, held equal to the hooks module's GATES literal (tests/slim-fixtures.mjs S24).
// 0 = the plain-text threshold (SLIM_PLAIN_BYTES).
const GATES = { mcp: 4096, bash: 4096, read: 32768, webfetch: 16384, websearch: 0, grep: 16384, agent: 0, attachment: 32768 };
const LOG_GATE = 16384;
// A json/jsonl output still over this is stubbed; any other output over it passes through.
const EGRESS = { bash: 32768, webfetch: 32768, websearch: 32768, agent: 32768, grep: 16384, read: 65536, attachment: 65536 };
// Room under the host's Bash inline limit for what follows the body: the figure, the handle, the hint.
const BASH_TAIL = 2048;
const bashEgress = (inline) => Math.max(1, Math.min(EGRESS.bash, inline - BASH_TAIL));
const WINDOW = { bashPersisted: 4096, grep: 8192, other: 12288 };
const CHANNELS = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'agent', 'attachment'];

// A fetching command word at the start of a pipeline segment; `cat src/http/page.html` is not one.
const FETCH_CMD = /(?:^|[;&|(`]|\$\()\s*(?:curl|wget|https?|xh|lynx)(?=\s|$)/;
const LOG_CMD = /\.log\b|\.jsonl\b|\b(?:journalctl|logs?)\b/;
const OWN_CLI = /\b(?:json-slim|log-slim|slim|figma-node-slim|adf-to-md|mcp-slim)\.cjs\b/;
const SOURCE_JSON_DIR = /(?:^|\/)(?:config|templates|locales|sections|blocks|snippets|layout)\/[^/]+\.json$/i;
const SOURCE_JSON_BASE = /^(?:package(?:-lock)?|tsconfig[\w.-]*|composer|jsconfig|\.?[\w-]*rc)\.json$|\.schema\.json$/i;
const isSourceJson = (p) => SOURCE_JSON_DIR.test(p) || SOURCE_JSON_BASE.test(path.basename(p));
const READ_LOG_EXT = new Set(['.log', '.jsonl', '.ndjson']);

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The words of a shell command that look like paths.
const commandWords = (cmd) => String(cmd || '').split(/[\s'"|;&<>()=]+/).filter(Boolean);

// The engine a channel lets run on a sniffed payload: html and log need a command that fetches or
// reads a log, everything a channel does not admit is treated as plain text. A Figma REST nodes
// response goes wherever JSON goes.
function admit(channel, engine, command) {
  switch (channel) {
    case 'bash':
      if (engine === 'html') return FETCH_CMD.test(command) ? 'html' : 'text';
      if (engine === 'log') return LOG_CMD.test(command) ? 'log' : 'text';
      return engine;
    case 'read':
      return ['json', 'jsonl', 'figma-nodes', 'log'].includes(engine) ? engine : null;
    case 'attachment':
      return ['json', 'jsonl', 'log'].includes(engine) ? engine : null;
    case 'webfetch':
      return ['json', 'jsonl', 'figma-nodes', 'html'].includes(engine) ? engine : 'text';
    default:
      return 'text';
  }
}

// The size a non-text engine needs before it runs, or null when the payload goes as plain text.
function structuredGate(channel, engine, plainBytes) {
  if (engine === 'text') return null;
  if (channel === 'bash' && engine === 'log') return LOG_GATE;
  return GATES[channel] || plainBytes;
}
const plainGate = (channel, plainBytes) => (channel === 'grep' ? GATES.grep : plainBytes);

// The Bash host's own stdout notice, as the model would have seen it (`bytes_seen`).
function bashSeen(persistedPath, size) {
  const kb = `${(size / 1024).toFixed(1)}KB`;
  return utf8(`Output too large (${kb}). Full output saved to: ${persistedPath}\n\nPreview (first 2KB):\n`) + Math.min(2048, size) + 40;
}

// An @-mentioned file as the host frames it: `Called the Read tool with the following input: {…}`, then
// `Result of calling the Read tool: ` and the file as numbered lines (`     1→…`), maybe a note after.
// → { before, body, after } with the numbers stripped from body, or null when no numbered run of at
// least three consecutive lines is there.
const NUMBERED = /^(Result of calling the \w+ tool: )?\s*(\d+)(?:→|\t)/;
function numberedBody(text) {
  const lines = text.split('\n');
  let i = 0;
  let m = null;
  for (; i < lines.length; i++) if ((m = NUMBERED.exec(lines[i]))) break;
  if (!m) return null;
  const first = Number(m[2]);
  const body = [lines[i].slice(m[0].length)];
  let k = i + 1;
  for (; k < lines.length; k++) {
    const n = /^\s*(\d+)(?:→|\t)/.exec(lines[k]);
    if (!n || Number(n[1]) !== first + (k - i)) break;
    body.push(lines[k].slice(n[0].length));
  }
  if (body.length < 3) return null;
  const before = lines.slice(0, i).map((l) => `${l}\n`).join('') + (m[1] || '');
  const after = k < lines.length ? `\n${lines.slice(k).join('\n')}` : '';
  return { before, body: body.join('\n'), after };
}

// The file path the framing's Read input names, or null.
function attachmentPath(text) {
  const m = /^Called the Read tool with the following input: (\{.*\})$/m.exec(text.slice(0, 8192));
  if (!m) return null;
  try { const v = JSON.parse(m[1]); return typeof v.file_path === 'string' ? v.file_path : null; } catch (_) { return null; }
}

// One channel's record → { pass } or { texts, items }, where every item is
// { text, put(out) } and `rebuild(outs)` restores the record. `texts` are the visible texts.
function extract(channel, rec, input) {
  if (!isObj(rec)) return { pass: 'unrecognized-shape' };
  switch (channel) {
    case 'bash': {
      if (rec.isImage || (Array.isArray(rec.structuredContent) && rec.structuredContent.length) || rec.backgroundTaskId) return { pass: 'not-text' };
      if (typeof rec.stdout !== 'string') return { pass: 'unrecognized-shape' };
      const rebuild = (out) => {
        const r = { ...rec, stdout: out };
        delete r.persistedOutputPath;
        delete r.persistedOutputSize;
        return r;
      };
      return { texts: [rec.stdout], single: { text: rec.stdout, rebuild }, persisted: typeof rec.persistedOutputPath === 'string' ? rec.persistedOutputPath : null };
    }
    case 'read': {
      if (rec.type !== 'text' || !isObj(rec.file) || typeof rec.file.content !== 'string') return { pass: 'not-text' };
      const rebuild = (out) => {
        const file = { ...rec.file, content: out, numLines: out.split('\n').length, startLine: 1 };
        delete file.truncatedByTokenCap;
        return { ...rec, file };
      };
      return { texts: [rec.file.content], single: { text: rec.file.content, rebuild } };
    }
    case 'attachment': {
      if (typeof rec.text !== 'string') return { pass: 'unrecognized-shape' };
      const b = numberedBody(rec.text);
      if (!b) return { texts: [rec.text], pass: 'read-guard' };
      return { texts: [rec.text], single: { text: b.body, rebuild: (out) => ({ text: `${b.before}${out}${b.after}` }) } };
    }
    case 'webfetch':
      if (typeof rec.result !== 'string') return { pass: 'unrecognized-shape' };
      return { texts: [rec.result], single: { text: rec.result, rebuild: (out) => ({ ...rec, result: out }) } };
    case 'grep':
      // A file listing has no text field to window: only the content mode is read.
      if (typeof rec.content !== 'string') return { pass: 'unrecognized-shape' };
      return { texts: [rec.content], single: { text: rec.content, rebuild: (out) => ({ ...rec, content: out }) } };
    case 'websearch': {
      if (!Array.isArray(rec.results)) return { pass: 'unrecognized-shape' };
      const at = [];
      rec.results.forEach((r, i) => { if (typeof r === 'string') at.push(i); });
      return {
        texts: at.map((i) => rec.results[i]),
        items: at.map((i) => ({ text: rec.results[i], index: i })),
        rebuildItems: (outs) => {
          const results = rec.results.slice();
          for (const [i, out] of outs) results[i] = out;
          return { ...rec, results };
        },
      };
    }
    case 'agent': {
      if (rec.status !== 'completed') return { pass: 'not-text' };
      if (!Array.isArray(rec.content)) return { pass: 'unrecognized-shape' };
      const at = [];
      rec.content.forEach((b, i) => { if (isObj(b) && b.type === 'text' && typeof b.text === 'string') at.push(i); });
      return {
        texts: at.map((i) => rec.content[i].text),
        items: at.map((i) => ({ text: rec.content[i].text, index: i })),
        rebuildItems: (outs) => {
          const content = rec.content.slice();
          for (const [i, out] of outs) content[i] = { ...content[i], text: out };
          return { ...rec, content };
        },
      };
    }
    default:
      return { pass: 'unrecognized-shape' };
  }
}

module.exports = {
  GATES, LOG_GATE, EGRESS, bashEgress, WINDOW, CHANNELS, FETCH_CMD, LOG_CMD, OWN_CLI, READ_LOG_EXT,
  isSourceJson, commandWords, admit, structuredGate, plainGate, bashSeen, extract, numberedBody, attachmentPath,
};
