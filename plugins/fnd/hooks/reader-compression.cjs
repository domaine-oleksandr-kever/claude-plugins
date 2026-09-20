#!/usr/bin/env node
// PostToolUse hook on the subagent-spawn tool (`Agent`, `Task` on older builds): relay a reader
// agent's `compression` field into the PARENT session. The readers (agents/jira-reader.md,
// figma-reader.md, doc-reader.md) measure the compression in their OWN context and return it as one
// line; until this hook only the SKILL that spawned them said it out loud, so an ad-hoc reader spawn
// — a pasted ticket, no skill — never surfaced the figure. SubagentStop cannot do this: its
// additionalContext goes back to the subagent, not to the parent. A BACKGROUND spawn answers this
// tool with launch metadata only; its return arrives as a task notification, which is the
// UserPromptSubmit half's job (hooks/reader-notification.cjs).
//
// Contract:
//   in  — PostToolUse event JSON on stdin. `tool_input` is the spawn brief (`subagent_type` names
//         the reader); `tool_response` MIRRORS the tool_result content — a string, a
//         {type:'text',text} block, an array of those, or {content:[…]} — and a host that hands it
//         over JSON-encoded is read one level deeper.
//   out — hooks/compression-notice.cjs's surface-chosen field (systemMessage on the CLI,
//         hookSpecificOutput.additionalContext everywhere else), or nothing at all.
//   arg — none. Claude Code only, by wiring: no other host spawns subagents through a tool whose
//         PostToolUse this plugin sees, so the host gate mcp-slim.cjs needs would be dead code here.
//
// A subagent's return is DATA, and a ticket body it echoes is data quoted inside data, so TWO gates
// stand between it and a channel the model is told to obey — the agent must be one of the three
// readers, and the value must parse END TO END as a compressor's printed line — both shared with
// the background half (hooks/reader-notification.cjs) through hooks/compression-notice.cjs.
// Everything else — an unparseable event, a `none`/empty/absent field, any other agent — exits 0
// in silence: a relay must never be able to delay or block a tool.
//
// Env: FND_READER_COMPRESSION (`0` disables; gated in the wiring, so node never spawns).
'use strict';

let shared = null;
try { shared = require('./compression-notice.cjs'); } catch (_) {} // partial install → silent
let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
try { hostTrace = require('./host-trace.cjs'); } catch (_) {} // stubbed on a partial install
let eventTool = null; // carried out to the trace call, which fires on every exit path

// Every string a tool_result shape can carry the return in. Depth is bounded by the shapes
// themselves — a content array of text blocks, one level deep.
function textOf(r) {
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(textOf).filter(Boolean).join('\n');
  if (r && typeof r === 'object') {
    if (typeof r.text === 'string') return r.text;
    if (r.content !== undefined) return textOf(r.content);
  }
  return '';
}

function responseText(r) {
  const t = textOf(r);
  const s = t.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    // A host that hands the result over JSON-encoded. One re-read, never a loop.
    try { const inner = textOf(JSON.parse(s)); if (inner) return inner; } catch (_) {}
  }
  return t;
}

// → the relayable line, or null. Every `; `-joined part must be a whole printed figure: one part
// that is anything else disqualifies the value rather than being trimmed off it, because a value
// half-composed by an agent is still composed by an agent.
function run(raw) {
  if (!shared) return 'skip';
  const input = JSON.parse(raw);
  eventTool = typeof input.tool_name === 'string' ? input.tool_name : null;
  const ti = input.tool_input;
  const who = ti && typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
  if (!shared.isReader(who)) return 'skip';
  const value = shared.readerFigure(responseText(input.tool_response !== undefined ? input.tool_response : input.tool_output));
  if (!value) return 'skip';
  const out = shared.notice(`${who} → ${value}`, input.transcript_path);
  if (!out) return 'skip';
  process.stdout.write(JSON.stringify({
    ...(out.additionalContext
      ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: out.additionalContext } }
      : {}),
    ...(out.systemMessage ? { systemMessage: out.systemMessage } : {}),
  }));
  return 'inject';
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const ht0 = hostTrace.start();
  let decision = 'error';
  try { decision = run(Buffer.concat(chunks).toString('utf8')); } catch (_) {} // fail-open, always exit 0
  hostTrace.trace({ event: 'PostToolUse', hook: 'reader-compression', decision, tool: eventTool, startedAt: ht0 });
});
