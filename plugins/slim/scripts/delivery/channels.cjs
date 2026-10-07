// The channel table: per built-in tool, how big a result must be before slim looks at it, which
// engines may touch it, how its text is taken out of the tool's result record and how the compressed
// text is put back in the same record shape (the host validates a hook's result against the tool's
// output schema, so Bash stays {stdout, stderr, …}, Read keeps its file record, and so on).
'use strict';

const path = require('path');

// Pre-filter sizes, held equal to the hooks module's GATES literal (tests/slim-fixtures.mjs S24).
// 0 = the plain-text threshold (SLIM_PLAIN_BYTES).
const GATES = { mcp: 4096, bash: 4096, read: 32768, webfetch: 16384, websearch: 0, grep: 16384, glob: 16384, agent: 0 };
const LOG_GATE = 16384;
// A json/jsonl output still over this is stubbed; any other output over it passes through.
const EGRESS = { bash: 32768, webfetch: 32768, websearch: 32768, agent: 32768, grep: 16384, glob: 16384, read: 65536 };
const WINDOW = { bashPersisted: 4096, grep: 8192, glob: 8192, other: 12288 };
const CHANNELS = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'glob', 'agent'];

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
// reads a log, everything a channel does not admit is treated as plain text.
function admit(channel, engine, command) {
  switch (channel) {
    case 'bash':
      if (engine === 'html') return FETCH_CMD.test(command) ? 'html' : 'text';
      if (engine === 'log') return LOG_CMD.test(command) ? 'log' : 'text';
      return engine;
    case 'read':
      return engine === 'json' || engine === 'jsonl' || engine === 'log' ? engine : null;
    case 'webfetch':
      return engine === 'json' || engine === 'jsonl' || engine === 'html' ? engine : 'text';
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
const plainGate = (channel, plainBytes) => (channel === 'grep' || channel === 'glob' ? GATES[channel] : plainBytes);

// The Bash host's own stdout notice, as the model would have seen it (`bytes_seen`).
function bashSeen(persistedPath, size) {
  const kb = `${(size / 1024).toFixed(1)}KB`;
  return utf8(`Output too large (${kb}). Full output saved to: ${persistedPath}\n\nPreview (first 2KB):\n`) + Math.min(2048, size) + 40;
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
    case 'webfetch':
      if (typeof rec.result !== 'string') return { pass: 'unrecognized-shape' };
      return { texts: [rec.result], single: { text: rec.result, rebuild: (out) => ({ ...rec, result: out }) } };
    case 'grep':
    case 'glob': {
      if (channel === 'grep' && typeof rec.content === 'string') {
        return { texts: [rec.content], single: { text: rec.content, rebuild: (out) => ({ ...rec, content: out }) } };
      }
      if (!Array.isArray(rec.filenames)) return { pass: 'unrecognized-shape' };
      const text = rec.filenames.map(String).join('\n');
      return { texts: [text], single: { text, rebuild: (out) => ({ ...rec, filenames: out.split('\n') }) } };
    }
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
  GATES, LOG_GATE, EGRESS, WINDOW, CHANNELS, FETCH_CMD, LOG_CMD, OWN_CLI, READ_LOG_EXT,
  isSourceJson, commandWords, admit, structuredGate, plainGate, bashSeen, extract,
};
