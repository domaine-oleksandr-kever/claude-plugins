#!/usr/bin/env node
// UserPromptSubmit hook: the ONE node process this event pays for. It runs both halves of the
// prompt-time work — the context monitor (context-stats.cjs) and the large-JSON guard
// (prompt-json-guard.cjs) — because wiring them as two plugin.json commands meant two node
// startups (~18 ms each) on every prompt. Each half keeps its own switch (FND_CTX_MONITOR /
// FND_PROMPT_JSON) with unchanged meaning, its own require and its own try/catch, so a half that
// is off or that throws cannot touch the other. plugin.json still short-circuits: with BOTH
// switches at 0 no node spawns at all.
//
// Merged output contract — the event accepts exactly ONE JSON object on stdout:
//   - the guard runs FIRST and, when it returns a block, that object IS the whole output. A block
//     ERASES the prompt, so the monitor must not run at all: its notice would describe a prompt
//     that never happened, and its band-state file would record an additionalContext the model
//     never received, silencing the next prompt's real notice.
//   - otherwise the monitor's object goes out exactly as it did when it owned the process
//     (suppressOutput + systemMessage [+ hookSpecificOutput.additionalContext]), or nothing.
// Exit is always 0: neither half signals through the exit code, and a hook failure must never
// break a prompt.
'use strict';

try { require('../scripts/env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps (env > project > global); absent in a partial install
// FND_HOST_TRACE, the host-proof log. Stubbed on require failure: a partial install must not cost
// the prompt its guard.
let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
try { hostTrace = require('./host-trace.cjs'); } catch (_) {}

// The decision the trace line reports, which is the merged contract read back out: a guard block is
// `deny` (the prompt was erased), a monitor notice is `inject` (something reached the model), and a
// silent run is `pass`. `skip` never applies — a half that is switched off leaves the OTHER half
// speaking for the invocation, and the process still ran.
function run(raw) {
  const input = JSON.parse(raw);

  // Each half is required inside its own gate, so a switched-off half is never even loaded —
  // and, being inside the try, a half whose FILE is broken fails exactly like a half that
  // throws: silently, without taking the other one down with it.
  if (process.env.FND_PROMPT_JSON !== '0') {
    let decision = null;
    try {
      decision = require('./prompt-json-guard.cjs').promptJsonDecision(input);
    } catch (_) {} // guard failure → the prompt proceeds, the monitor still gets its turn
    if (decision) {
      process.stdout.write(JSON.stringify(decision));
      return 'deny';
    }
  }

  if (process.env.FND_CTX_MONITOR !== '0') {
    let notice = null;
    try {
      notice = require('./context-stats.cjs').contextNotice(input);
    } catch (_) {}
    if (notice) {
      console.log(JSON.stringify(notice));
      return 'inject';
    }
  }
  return 'pass';
}

// Collect stdin as bytes, decode once — decoding per chunk would mangle a multibyte character
// split across a read boundary, which the guard would then spill corrupted (U+FFFD).
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const t = hostTrace.start();
  let decision = 'pass';
  try {
    decision = run(Buffer.concat(chunks).toString('utf8')) || 'pass';
  } catch (_) {
    // Any failure → emit nothing, the prompt proceeds untouched.
    decision = 'error';
  }
  // After the output, never before: the trace is bookkeeping and may not delay what the model sees.
  hostTrace.trace({ event: 'UserPromptSubmit', hook: 'user-prompt', decision, startedAt: t });
});
