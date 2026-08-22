#!/usr/bin/env node
// Codex PostToolUse adapter for hooks/mcp-slim.cjs — the ONE place the Codex wiring diverges
// from the Claude Code hooks block, and the thinnest form that divergence can take.
//
// Why it exists: mcp-slim's whole output contract is
// `hookSpecificOutput.updatedToolOutput`, i.e. REPLACING the tool result. Claude Code honors
// that; Codex's PostToolUse can add context or block, but cannot rewrite a tool result
// (researched 2026-08-22, HARNESS-PORT-PLAN.md Codex digest — verify at M1b). Wiring
// mcp-slim in raw on Codex would therefore spill whales to disk and then throw the only
// pointer to them away. This shim runs the CANONICAL script unchanged and re-labels the one
// outcome Codex can still act on.
//
// What it forwards, and what it deliberately drops:
//   - STUBBED result (mcp-slim could not shrink a whale under FND_MCP_SLIM_STUB_BYTES and wrote
//     the byte-exact original to a spill): the stub text — spill path, json-slim command, shape
//     hint — goes back as `additionalContext`, verbatim, so the wording stays single-copy.
//     This is the spill-and-stub half of mcp-slim, which survives without output rewrite.
//   - COMPRESSED result: dropped. Codex already delivered the full result to the model; adding
//     the compressed copy would GROW the context instead of shrinking it. Compression is a
//     no-op on this host until Codex gains output rewrite.
//   - anything else (passthrough, unparsable stdout, a crashing child): nothing on stdout.
//
// stdin: PostToolUse event JSON, handed to mcp-slim byte-for-byte.
// stdout: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}` or nothing.
// Exit: always 0. Fail-open — no MCP result may be lost because this adapter failed.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// __dirname, never CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT: Cursor leaks plugin-root env between concurrent
// hooks and Claude Code has its own source-vs-cache inconsistency, so the env is a cross-check at
// most (HARNESS-PORT-PLAN.md, hazards ledger).
const SLIM = path.join(__dirname, 'mcp-slim.cjs');
const STUB_MARK = '<<fnd-mcp-slim stub>>';
// One whale can produce one stub per over-limit block; the header plus a handful of stubs stays far
// under Codex's ~2500-token additionalContext budget, and anything past the cap is spilled by the
// host anyway. Truncating here keeps the FIRST stubs whole rather than half of every one.
const CONTEXT_CAP = 4096;
const HEADER =
  'fnd mcp-slim — the MCP result above was too large for context and was written to disk in full. ' +
  'This host cannot replace a tool result, so the raw result still stands: do not re-read it whole, ' +
  'work from the spill instead.';

function texts(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(value);
  return out;
}

function run(raw) {
  const child = spawnSync(process.execPath, [SLIM], {
    input: raw,
    // The child mirrors whatever arrived, so its stdout is bounded by the result the host already
    // held in memory. A blown buffer surfaces as an error → nothing emitted → original survives.
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (child.error || !child.stdout) return;
  const stdout = child.stdout.toString('utf8').trim();
  if (!stdout) return; // passthrough — mcp-slim prints nothing when it leaves a result alone

  const parsed = JSON.parse(stdout);
  const updated = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedToolOutput;
  if (updated === undefined) return;

  const stubs = texts(updated).filter((t) => t.includes(STUB_MARK));
  if (!stubs.length) return; // compressed body — useless here, see the header comment

  // Whole stubs only — a byte-cut tail would lose a spill path mid-token (and mangle a multibyte
  // character), and half a recovery command is worse than an honest "omitted".
  let context = HEADER;
  for (let i = 0; i < stubs.length; i++) {
    const next = context + '\n\n' + stubs[i];
    if (Buffer.byteLength(next, 'utf8') > CONTEXT_CAP) {
      context += '\n\n(' + (stubs.length - i) + ' further stub(s) omitted — over the context budget)';
      break;
    }
    context = next;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }));
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    run(Buffer.concat(chunks));
  } catch (_) {
    // Any failure → emit nothing; the tool result the host already delivered is untouched.
  }
});
