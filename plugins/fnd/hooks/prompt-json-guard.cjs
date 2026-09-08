#!/usr/bin/env node
// UserPromptSubmit hook: keep a large pasted JSON blob out of the conversation forever.
// A prompt cannot be REWRITTEN by a hook, but UserPromptSubmit CAN block it — so when a
// prompt is big AND carries parseable JSON blob(s) past the gate, we spill EACH to a file
// and BLOCK the prompt with a reason naming the path(s). The developer resubmits their
// question referencing the file(s); the model reads them with jq/Read instead of carrying
// tens of KB of JSON in every future turn.
//
// Contract (Claude Code, verified against live docs 2026-07-19):
//   in  — UserPromptSubmit event JSON on stdin; the text is `prompt`, plus `cwd`.
//   out — top-level `{"decision":"block","reason":<text>}` (exit 0) erases the prompt: it
//         never reaches the model. `reason` is shown to the DEVELOPER ONLY (never added to
//         the model's context) — so it must tell the developer to re-reference the path.
//         Print nothing → the prompt proceeds untouched.
//
// Rails (any doubt → emit nothing, prompt proceeds):
//   - High thresholds (PROMPT_MIN / BLOB_MIN) so normal prompts never trip it;
//   - conservative extraction — each `{`/`[` is matched to its closer with string state tracked
//     from that opener, then JSON.parse; nothing parses past the gate → no block;
//   - if ANY blob cannot be SAVED, never block (a block erases the whole prompt, so an
//     unsaved blob would lose the developer's paste) — pass through instead;
//   - any parse/scan/IO failure → pass through.
//
// Runs inside hooks/user-prompt.cjs (the one node process the UserPromptSubmit event pays for),
// which calls promptJsonDecision() and prints what it returns; invoked directly, this file does
// the same for one event on stdin.
//
// Env: FND_PROMPT_JSON — 0 disables the guard (checked by that entry point AND here; node still
// spawns for the context monitor unless it is off too).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROMPT_MIN = 10240; // only inspect prompts larger than ~10 KB
const BLOB_MIN = 8192; //    only offload a JSON blob larger than ~8 KB

// EVERY JSON object/array embedded in `text` that clears BLOB_MIN, in order and non-overlapping.
// A block erases the WHOLE prompt, so we must save every offloadable blob, not just the biggest —
// a second ≥ gate blob left un-spilled would be lost. Every scan starts fresh at a `{`/`[`, so prose
// ahead of the paste (a stray quote, an unclosed brace, Liquid) cannot decide the outcome: match
// that opener's closer with string state tracked from it, JSON.parse the span, keep it when it
// clears the gate, and step over it either way — what is kept holds no separate blob, and what a
// block would erase unsaved must not be traded for a fragment of itself. Non-container JSON (bare
// strings/numbers) is ignored. Bytes are measured on the raw span (what leaves the prompt).
// So two shapes are stepped over rather than mined: a ≥ gate span that closes but is not JSON (a
// jsonc / JS-literal / trailing-comma paste), and — via the openAt rail below — a ≥ gate opener
// left unclosed at end of text whose own remainder clears the gate (a truncated paste; an unclosed
// brace in PROSE leaves a remainder of a few bytes, and is mined).
function collectJsonBlobs(text) {
  const blobs = [];
  let openAt = -1; // first ≥ gate opener that never closes
  // Each opener costs a match scan, so adversarial prose (`{"a":` × N) is quadratic — bound the
  // total and pass through if it is hit, since a partial read may miss a blob it must not lose.
  let budget = text.length * 8 + 65536;
  const matchEnd = (from) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      if (--budget < 0) return -1;
      const c = text[i];
      if (inString) {
        // No JSON string spans a raw line break, so one means this quote opened prose, not a value.
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
    const start = i;
    const end = matchEnd(start);
    if (budget < 0) return [];
    if (end < 0) {
      if (openAt < 0 && Buffer.byteLength(text.slice(start), 'utf8') >= BLOB_MIN) openAt = start;
      continue;
    }
    i = end - 1;
    const span = text.slice(start, end);
    const bytes = Buffer.byteLength(span, 'utf8');
    if (bytes < BLOB_MIN) continue;
    try {
      JSON.parse(span);
      blobs.push({ start, blob: span, bytes });
    } catch (_) {} // balanced but not valid JSON
  }

  if (openAt >= 0) {
    const rest = Buffer.byteLength(text.slice(openAt), 'utf8') -
      blobs.reduce((n, b) => (b.start > openAt ? n + b.bytes : n), 0);
    if (rest >= BLOB_MIN) return blobs.filter((b) => b.start < openAt);
  }
  return blobs;
}

// `wx` + 0600: the blob IS the developer's paste (API tokens, customer records) and the tmpdir
// fallback can be shared, where a plain write would leave it world-readable and would follow
// anything already sitting at the name. EEXIST retries ONCE under a fresh uuid instead of failing —
// the caller may not block without a saved file, so a collision must never cost the paste.
function writeBlobFile(dir, name, blob) {
  const opts = { flag: 'wx', mode: 0o600 };
  const p = path.join(dir, name);
  try {
    fs.writeFileSync(p, blob, opts);
    return p;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  const retry = path.join(dir, `fnd-prompt-json-${crypto.randomUUID()}.json`);
  fs.writeFileSync(retry, blob, opts);
  return retry;
}

// Spill the blob so the developer can re-reference it. Prefer the active task workspace
// (`.claude/tasks/<work-id>/tmp/`) when exactly one work-id dir exists — co-located with the
// task, durable across sessions — else fall back to a private tmp file. Returns the path,
// or null on any failure (caller must NOT block without a saved file).
function spillBlob(blob, cwd) {
  const name = `fnd-prompt-json-${crypto.randomUUID()}.json`;
  try {
    // `.claude/fnd` is the workspace's pre-rename home — honored until the repo migrates.
    const rel = ['.claude/tasks', '.claude/fnd'].find((r) => fs.existsSync(path.join(cwd, r)));
    if (!rel) throw new Error('no workspace');
    const wsRoot = path.join(cwd, rel);
    const dirs = fs
      .readdirSync(wsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (dirs.length === 1) {
      const tmp = path.join(wsRoot, dirs[0], 'tmp');
      fs.mkdirSync(tmp, { recursive: true });
      const p = writeBlobFile(tmp, name, blob);
      // This spill sits INSIDE the repo tree, where a clone with no workspace stamp yet would hand
      // the paste to the next `git add -A`. Required lazily — only a spill owes those two git forks,
      // never the prompt that passes through, and never the tmpdir fallback below.
      try { require('../scripts/scratch-hygiene.cjs').ensureFndTmpExcluded(cwd, rel); } catch (_) {}
      return p;
    }
  } catch (_) {} // no workspace, ambiguous, or unwritable → fall through to tmpdir
  try {
    return writeBlobFile(os.tmpdir(), name, blob);
  } catch (_) {
    return null;
  }
}

// The block decision for one UserPromptSubmit event, or null when the prompt proceeds untouched.
function promptJsonDecision(input) {
  if (process.env.FND_PROMPT_JSON === '0') return null; // belt-and-suspenders vs the entry-point gate
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') < PROMPT_MIN) return null;

  const blobs = collectJsonBlobs(prompt);
  if (!blobs.length) return null;

  // The block erases the whole prompt, so spill EVERY offloadable blob first — if any
  // spill fails, don't block (never lose a paste): pass through instead.
  const cwd = input.cwd || process.cwd();
  const paths = [];
  for (const b of blobs) {
    const p = spillBlob(b.blob, cwd);
    if (!p) return null;
    paths.push(p);
  }

  const kb = Math.round(blobs.reduce((n, b) => n + b.bytes, 0) / 1024);
  const single = paths.length === 1;
  const list = paths.map((p) => `  ${p}`).join('\n');
  const reason =
    `${single ? 'Large JSON' : paths.length + ' large JSON blobs'} (~${kb} KB) found in your prompt — ` +
    `saved to ${single ? 'this file' : 'these files'}:\n\n${list}\n\n` +
    `That JSON was NOT sent to the model. Resubmit your question and mention ${single ? 'this path' : 'these paths'}; ` +
    `it'll be read with jq/Read instead of carrying ~${kb} KB of JSON in context every turn.\n\n` +
    `(To send JSON inline instead, set FND_PROMPT_JSON=0.)`;
  return { decision: 'block', reason };
}

module.exports = { promptJsonDecision };

if (require.main === module) {
  // Standalone runs only — as a module, user-prompt.cjs (the merged entry) has already loaded.
  try { require('../scripts/env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps; absent in a partial install

  // Collect stdin as bytes, decode once — decoding per chunk would mangle a multibyte char
  // split across a read boundary, corrupting the spilled blob (U+FFFD).
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    try {
      const decision = promptJsonDecision(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (decision) process.stdout.write(JSON.stringify(decision));
    } catch (_) {
      // Any failure → emit nothing, the prompt proceeds untouched.
    }
  });
}
