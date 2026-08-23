#!/usr/bin/env node
// UserPromptSubmit hook: one-line context notice in the Claude Code UI (hook
// `systemMessage`, rendered above the input box — never appended to the assistant's
// reply, never touching the status line). Mirrors /context: tokens used / window (%),
// active model, effort. Effort comes straight from the hook input; model and token
// counts are read verbatim from the transcript's last assistant `usage` entry —
// Claude Code does not expose /context's own numbers to hooks. Above the warn
// threshold the notice adds a /compact-or-/clear call-to-action on every prompt
// (UI-only, free); the additionalContext flag for skills is emitted ONLY when the
// usage BAND changes (ok → warn → 75 → 90, and back), tracked in a per-session
// tmpdir state file — steady-state prompts inject zero model context.
//
// Runs inside hooks/user-prompt.cjs (the one node process the UserPromptSubmit event pays
// for), which calls contextNotice() and prints what it returns; invoked directly, this file
// does the same for one event on stdin. Tunables:
//   FND_CTX_MONITOR on by default; set to 0 to disable (checked by that entry point AND here;
//                   node still spawns for the prompt-JSON guard unless it is off too)
//   FND_CTX_WINDOW  context window in tokens (default: resolved from the session model,
//                   200000 when the model is unknown)
//   FND_CTX_WARN    warn-from percentage (default 40; 0 = warn on every prompt)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 512 * 1024;
const ENV_WINDOW = parseInt(process.env.FND_CTX_WINDOW || '', 10) || 0;
const ENV_WARN = parseInt(process.env.FND_CTX_WARN || '', 10);
const WARN_AT = Number.isNaN(ENV_WARN) ? 40 : ENV_WARN;

// 1M-window families: Fable/Mythos, Opus ≥4.6, Sonnet ≥4.6. Haiku and anything
// unrecognized keep the conservative 200k default.
function windowFor(model) {
  return /fable|mythos|opus-4-[6-9]|opus-[5-9]|sonnet-4-[6-9]|sonnet-[5-9]/.test(model)
    ? 1000000
    : 200000;
}

// The notice for one UserPromptSubmit event, or null when there is nothing to say (no
// transcript, no usage entry yet). Never throws for a caller: any failure is a null.
function contextNotice(input) {
  try {
    if (process.env.FND_CTX_MONITOR === '0') return null; // belt-and-suspenders vs the entry-point gate
    const effort = (input.effort && input.effort.level) || '';
    const transcript = input.transcript_path;
    if (!transcript || !fs.existsSync(transcript)) return null;

    // Read only the tail — transcripts grow to tens of MB.
    const size = fs.statSync(transcript).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(transcript, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // drop the partial first line

    let usage = null;
    let model = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const u = entry.message && entry.message.usage;
        if (u && u.input_tokens != null && !entry.isSidechain) {
          const m = entry.message.model;
          // Synthetic (API-error) entries like "<synthetic>" carry zeroed usage —
          // skip them outright, or the monitor reads 0% right after an API error.
          if (m && m[0] === '<') continue;
          if (!usage) usage = u;
          if (m) {
            model = m;
            break;
          }
        }
      } catch (_) {}
    }
    if (!usage) return null;

    const WINDOW = ENV_WINDOW || windowFor(model);

    const used =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.output_tokens || 0);
    const pct = Math.round((used / WINDOW) * 100);

    const windowLabel =
      WINDOW >= 1000000 ? `${WINDOW / 1000000}M` : `${Math.round(WINDOW / 1000)}k`;
    const usedLabel = `${(used / 1000).toFixed(1)}k`;
    const icon = pct >= 90 ? '🔴' : pct >= 75 ? '🟠' : pct >= WARN_AT ? '🟡' : '🟢';

    let msg = [
      `${icon} Context ${usedLabel}/${windowLabel} (${pct}%)`,
      model,
      effort && `effort ${effort}`,
    ]
      .filter(Boolean)
      .join(' · ');

    // pct past 100 means the window guess is wrong (e.g. a 1M-beta session on a
    // model id the family table maps to 200k) — surface the override knob.
    if (pct >= 100 && !ENV_WINDOW) {
      msg += ' — over 100%? a bigger window is active: set FND_CTX_WINDOW=<tokens> to fix this readout';
    }

    // Band tracking: each unique additionalContext copy persists in the conversation,
    // so emit it only when the band CHANGES — the flag stays visible in history for
    // skills while steady-state warn-zone prompts stop paying ~40 tokens each.
    // Everything below WARN_AT is band 0: a custom threshold inside the 75/90 tiers
    // must not silently pre-record a band and swallow the warn-entry emission.
    const band = pct < WARN_AT ? 0 : pct >= 90 ? 3 : pct >= 75 ? 2 : 1;
    const sid = String(
      input.session_id || path.basename(transcript, '.jsonl'),
    ).replace(/[^A-Za-z0-9_.-]/g, '');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const stateFile = path.join(os.tmpdir(), `fnd-ctx-band-${uid}-${sid}`);
    let prevBand = null;
    try {
      prevBand = parseInt(fs.readFileSync(stateFile, 'utf8'), 10);
    } catch (_) {}
    if (Number.isNaN(prevBand)) prevBand = null;
    const bandChanged = band !== prevBand;
    if (bandChanged) {
      try {
        fs.writeFileSync(stateFile, String(band));
      } catch (_) {}
    }

    // systemMessage is user-facing only; additionalContext (warn-level and up) lets
    // skills condition on "the context monitor flagged this session" without the
    // model echoing a banner into its reply.
    const out = { suppressOutput: true, systemMessage: msg };
    if (pct >= WARN_AT) {
      out.systemMessage +=
        pct >= 75
          ? ' — /compact now (or /clear when the workspace is saved), auto-compact is close'
          : ' — /compact, or /clear when the workspace is saved, at the next step boundary';
      if (bandChanged) {
        out.hookSpecificOutput = {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            `fnd context monitor: ~${pct}% of the ~${windowLabel} context window used. ` +
            `The developer already sees this notice in the UI — do NOT append any context banner to your reply.`,
        };
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}

module.exports = { contextNotice };

if (require.main === module) {
  // Standalone runs only — as a module, user-prompt.cjs (the merged entry) has already loaded.
  try { require('../scripts/env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps; absent in a partial install

  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      const out = contextNotice(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch (_) {}
  });
}
