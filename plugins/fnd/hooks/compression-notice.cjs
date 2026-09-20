#!/usr/bin/env node
// The one out-of-band channel that carries an fnd compression figure to the DEVELOPER, shared by
// the two hooks that produce one — hooks/mcp-slim.cjs (an MCP result it rewrote) and
// hooks/reader-compression.cjs (a reader subagent's `compression` field) — so the channel and the
// wording cannot drift apart between them.
//
// One surface, every host: `systemMessage`. The terminal CLI prints it inline and the desktop app
// renders it under its collapsible hook notice, so the developer reads the figure either way and
// the model is told nothing at all — asking a model to repeat a line teaches it to obey "repeat
// this verbatim", which is the exact shape an injected tool result wears.
'use strict';

// A reader's field is `; `-joined and arrives from a subagent, i.e. as data: bounded here so one
// relayed line can never become a payload of its own.
const LINE_CAP = 300;
// A PostToolUse inside a SUBAGENT gets no channel to the developer: a subagent's systemMessage
// reaches nobody, and the only thing that leaves an agent is its contract-bound return. Claude
// Code keeps a subagent's transcript beside the session's own
// (`<session>/subagents/agent-<id>.jsonl`), which is the one thing the hook input tells us apart by
// — an unrecognised path is read as the main session, so a future layout fails toward speaking.
const SUBAGENT_TRANSCRIPT = /[\\/]subagents[\\/]agent-[^\\/]*$/;

// The reader relay's two gates, shared by its PostToolUse half (reader-compression.cjs — a foreground
// spawn's tool result) and its UserPromptSubmit half (reader-notification.cjs — a background
// spawn's task notification), so the same return is judged the same way whichever way it arrived.
// Only the three agents whose contract defines the field: any other subagent's return may quote one
// (a reviewer reading this repo's own tests would), and a figure from a run that never compressed
// anything is a lie told in the plugin's name.
const READER = /^(?:fnd:)?(?:jira|figma|doc)-reader$/;
exports.isReader = (name) => READER.test(String(name == null ? '' : name).trim());

// The readers print the contract's YAML-ish line (agents/jira-reader.md → output contract); a model
// may wrap the key in backticks or the value in quotes, and the field is never the first thing in
// the return — nor necessarily the only line that looks like it, since the fields above it carry
// raw ticket text. So: every match, in order, until one parses.
const FIELD = /^[ \t>*-]*`?compression`?[ \t]*:[ \t]*(.*)$/gim;
const FIELDS_MAX = 20;
// The compressors' printed grammars, whole-line: hooks/mcp-slim.cjs statsLine(), json-slim's
// `--stats` (plus the bracketed tag a refusal answers it with) and figma-node-slim's `--stats`.
// `log-slim` is deliberately absent — it prints no line of its own, it is reached through the
// json-slim CLI and answers in json-slim's grammar. A value is DATA composed by an agent, so a
// prefix test would forward whatever free text followed it: every `; `-joined part must parse whole,
// and one part that is anything else disqualifies the value rather than being trimmed off it.
const NUM = '\\d{1,3}(?:,\\d{3})*|\\d+';
const PCT = '[-+−]?\\d{1,3}(?:\\.\\d+)?%';
const FIGURE = [
  new RegExp(`^fnd-mcp-slim: (?:compressed|stub) (?:${NUM}) B → (?:${NUM}) B \\(${PCT}\\)$`),
  new RegExp(`^json-slim: \\d+ → \\d+ bytes \\(${PCT} reduction\\)(?: \\[[A-Za-z0-9 _-]{1,40}\\])?$`),
  new RegExp(`^figma-node-slim: \\d+ B → \\d+ B \\(${PCT}\\) nodes=\\d+ hidden=\\d+ folded=\\d+$`),
];
const PARTS_MAX = 4; // the field is `; `-joined; three compressors can speak for one read

function figures(value) {
  const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > PARTS_MAX) return null;
  if (!parts.every((p) => FIGURE.some((re) => re.test(p)))) return null;
  return parts.join('; ');
}

// → the relayable line found in a reader's returned text, or null.
exports.readerFigure = function readerFigure(text) {
  const t = String(text == null ? '' : text);
  FIELD.lastIndex = 0;
  for (let i = 0, m = null; i < FIELDS_MAX && (m = FIELD.exec(t)) !== null; i++) {
    const v = figures(m[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim());
    if (v) return v;
  }
  return null;
};

// → { systemMessage } | null. The caller places the field and passes the event's own
// `transcript_path`.
exports.notice = function notice(line, transcriptPath) {
  if (SUBAGENT_TRANSCRIPT.test(String(transcriptPath == null ? '' : transcriptPath))) return null;
  const s = String(line == null ? '' : line).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return { systemMessage: s.length > LINE_CAP ? `${s.slice(0, LINE_CAP - 1)}…` : s };
};
