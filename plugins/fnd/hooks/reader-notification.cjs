// The BACKGROUND half of the reader relay. A subagent spawned in the background answers the Agent
// tool with launch metadata only; its return arrives later as a `<task-notification>` prompt the
// host queues on the developer's behalf — which fires UserPromptSubmit, not PostToolUse, so
// hooks/reader-compression.cjs never sees it. This module reads that prompt for the same
// `compression` field and hands hooks/user-prompt.cjs the same notice.
//
// The reader gate has no `subagent_type` here: the notification names only the task id, so the
// agent's identity is read off the host's own `agent-<id>.meta.json` beside the session transcript
// (`<dir>/<session>/subagents/`, written at spawn). No file → no relay: a figure with no proven
// reader behind it is not put in the plugin's mouth. Everything else fails to silence, never to a
// throw — the caller runs on every prompt.
'use strict';

const fs = require('fs');
const path = require('path');
const { notice, isReader, readerFigure } = require('./compression-notice.cjs');

const TASK_ID = /<task-id>\s*([A-Za-z0-9_-]{1,64})\s*<\/task-id>/;
const RESULT = /<result>([\s\S]*?)<\/result>/;
const META_MAX = 8192; // the host writes a few hundred bytes; anything larger is not that file

function metaFor(transcriptPath, id) {
  const t = String(transcriptPath || '');
  if (!t.endsWith('.jsonl')) return null;
  const file = path.join(t.slice(0, -'.jsonl'.length), 'subagents', `agent-${id}.meta.json`);
  try {
    if (fs.statSync(file).size > META_MAX) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

// → { systemMessage } | null
exports.notificationNotice = function notificationNotice(input) {
  const prompt = input && typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trimStart().startsWith('<task-notification>')) return null;
  const id = TASK_ID.exec(prompt);
  const result = RESULT.exec(prompt);
  if (!id || !result) return null;
  const meta = metaFor(input.transcript_path, id[1]);
  const who = meta && typeof meta.agentType === 'string' ? meta.agentType.trim() : '';
  if (!isReader(who)) return null;
  const value = readerFigure(result[1]);
  return value ? notice(`${who} → ${value}`, input.transcript_path) : null;
};
